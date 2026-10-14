#!/usr/bin/env python3
"""Check operational GPS flows through the running API and web interface.

Start a fresh, empty operational QA API on port 3001 and Vite on port 5173
before running this script. The administrator must use the QA account below;
the driver's account is created through the actual administrative interface.
Override UI_SMOKE_URL, UI_SMOKE_OUTPUT, QA_* or CHROMIUM_EXECUTABLE as needed.

The browser does not capture Android GPS. Two explicitly synthetic locations
are uploaded to the real HTTP API, and independent browser sessions observe
the result. Only OpenStreetMap tile images use a transparent fixture so these
checks do not depend on an external map provider or a browser's proxy CA.
Application documents, scripts, fonts and API requests are never mocked. TLS
verification stays enabled. Passwords and bearer tokens remain in memory.
"""

import base64
import csv
from datetime import datetime, timedelta, timezone
import io
import json
import math
import os
from pathlib import Path
import re
from urllib.parse import urlsplit
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright


BASE_URL = os.environ.get("UI_SMOKE_URL", "http://127.0.0.1:5173").rstrip("/")
OUTPUT = Path(os.environ.get("UI_SMOKE_OUTPUT", str(Path(__file__).resolve().parents[1] / ".local" / "qa-gps")))
ADMIN_EMAIL = os.environ.get("QA_ADMIN_EMAIL", "qa-gps-admin@example.test")
ADMIN_PASSWORD = os.environ.get("QA_ADMIN_PASSWORD", "QaGpsAdministrator!2468")
DRIVER_EMAIL = os.environ.get("QA_DRIVER_EMAIL", "qa-gps-driver@example.test")
DRIVER_PASSWORD = os.environ.get("QA_DRIVER_PASSWORD", "QaGpsDeliverer!2468")
DRIVER_NAME = "Entregador GPS QA"
REDACTIONS = {ADMIN_PASSWORD, DRIVER_PASSWORD}
CHECKS = []
PAGE_ERRORS = []
REQUEST_FAILURES = []
CANCELLED_REQUESTS = []
DOCUMENT_FAILURES = []
STATE_RESPONSES = {}
POLL_READS = {}
TILE_REQUESTS = []
PAGES = []
TRANSPARENT_TILE = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCJ0AAAAASUVORK5CYII=")


def redact(value):
    if isinstance(value, dict):
        return {key: redact(item) for key, item in value.items()}
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, str):
        for secret in REDACTIONS:
            if secret:
                value = value.replace(secret, "[redacted]")
    return value


def record(name, function):
    try:
        detail = function()
        CHECKS.append({"name": name, "status": "pass", "detail": redact(detail)})
        print(f"PASS {name}", flush=True)
        return True
    except Exception as error:
        detail = redact(str(error))
        CHECKS.append({"name": name, "status": "fail", "detail": detail})
        print(f"FAIL {name}: {detail}", flush=True)
        for index, page in enumerate(PAGES):
            if not page.is_closed():
                try:
                    page.screenshot(path=str(OUTPUT / f"failure-{len(CHECKS)}-{index}.png"), full_page=True)
                    page.keyboard.press("Escape")
                except Exception:
                    pass
        return False


def observe(page):
    PAGES.append(page)
    page.on("pageerror", lambda error: PAGE_ERRORS.append(redact(str(error))))

    def failed(request):
        detail = {"url": redact(request.url), "failure": redact(request.failure)}
        cancelled = request.failure == "net::ERR_ABORTED" and urlsplit(request.url).path in {
            "/api/auth/me", "/api/state", "/api/auth/logout",
        }
        (CANCELLED_REQUESTS if cancelled else REQUEST_FAILURES).append(detail)

    page.on("requestfailed", failed)

    def response_seen(response):
        if response.request.resource_type == "document" and response.status >= 400:
            DOCUMENT_FAILURES.append({"url": redact(response.url), "status": response.status})
        if urlsplit(response.url).path == "/api/state" and response.status == 200:
            # Read bodies in the main flow, never during the response callback.
            STATE_RESPONSES[page] = response
            POLL_READS[page] = POLL_READS.get(page, 0) + 1

    page.on("response", response_seen)


def tile_fixture(route):
    assert urlsplit(route.request.url).hostname == "tile.openstreetmap.org"
    assert route.request.resource_type == "image", "Only provider tile images may be stubbed"
    TILE_REQUESTS.append(route.request.url)
    route.fulfill(status=200, content_type="image/png", body=TRANSPARENT_TILE)


def no_overflow(page):
    page.evaluate("document.fonts.ready")
    sizes = page.evaluate("({viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth})")
    assert sizes["document"] <= sizes["viewport"] + 1, sizes
    assert sizes["body"] <= sizes["viewport"] + 1, sizes
    return sizes


def admin_tab(page, name):
    page.bring_to_front()
    menu = page.get_by_role("button", name="Abrir menu", exact=True)
    if menu.is_visible():
        menu.click()
    page.get_by_role("navigation", name="Navegação administrativa").get_by_role("button", name=re.compile(f"^{re.escape(name)}(?:\\s|$)")).click()


def driver_tab(page, name):
    page.bring_to_front()
    page.get_by_role("navigation", name="Navegação do entregador").get_by_role("button", name=name, exact=True).click()


def post_response(page, path):
    return page.expect_response(lambda response: urlsplit(response.url).path == path and response.request.method == "POST")


def login(page, email, password):
    page.get_by_label("E-mail", exact=True).fill(email)
    page.get_by_label("Senha", exact=True).fill(password)
    with post_response(page, "/api/auth/login") as result:
        page.get_by_role("button", name="Entrar", exact=True).click()
    assert result.value.status == 200, {"loginStatus": result.value.status}
    body = result.value.json()
    REDACTIONS.add(body["token"])
    return body


def authenticated(context, session, method, path, body=None):
    # Never attach authentication headers, sessions or the login payload to logs.
    response = context.request.fetch(BASE_URL + path, method=method,
                                     headers={"Authorization": "Bearer " + session["token"]},
                                     data=body)
    assert response.status == 200, {"endpoint": path, "status": response.status}
    return response.json()


def ui_state(page):
    return STATE_RESPONSES[page].json()


def scope(snapshot, session):
    state = snapshot["state"]
    user = session["user"]
    driver_id = user["driverId"]
    assert [item["id"] for item in state["users"]] == [user["id"]], "Driver received another account"
    assert [item["id"] for item in state["drivers"]] == [driver_id], "Driver received another driver"
    for collection in ["deliveries", "trips", "trackingSessions", "gpsDays"]:
        assert all(item["driverId"] == driver_id for item in state.get(collection, [])), f"Unrelated {collection} visible to driver"
    forbidden = {"password", "passwordHash", "password_hash", "token", "tokenHash", "token_hash", "salt"}

    def scan(value):
        if isinstance(value, dict):
            assert not forbidden.intersection(value), "State contains authentication material"
            for item in value.values():
                scan(item)
        elif isinstance(value, list):
            for item in value:
                scan(item)

    scan(state)
    return {key: len(state.get(key, [])) for key in ["users", "drivers", "deliveries", "trips", "trackingSessions", "gpsDays"]}


def timestamp(value):
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_time(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def sample(moment, latitude=-23.56):
    return {"id": str(uuid4()), "latitude": latitude, "longitude": -46.65,
            "accuracy": 5, "recordedAt": timestamp(moment)}


def gps_summary(snapshot, driver_id):
    driver = next(item for item in snapshot["state"]["drivers"] if item["id"] == driver_id)
    day = next(item for item in snapshot["state"].get("gpsDays", []) if item["driverId"] == driver_id)
    return {"kmToday": driver["kmToday"], "dailyMeters": day["meters"],
            "acceptedPoints": day["acceptedPoints"], "gaps": day["gaps"], "date": day["date"]}


def runtime_health():
    assert not PAGE_ERRORS, PAGE_ERRORS
    assert not REQUEST_FAILURES, REQUEST_FAILURES
    assert not DOCUMENT_FAILURES, DOCUMENT_FAILURES
    return {"pageErrors": 0, "requestFailures": 0, "documentFailures": 0,
            "cancelledSessionRequests": len(CANCELLED_REQUESTS)}


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        executable = os.environ.get("CHROMIUM_EXECUTABLE", "/usr/bin/chromium")
        browser = playwright.chromium.launch(executable_path=executable, headless=True, args=["--no-sandbox"])
        contexts = []

        def context(width):
            result = browser.new_context(viewport={"width": width, "height": 1000},
                                         locale="pt-BR", timezone_id="America/Sao_Paulo")
            result.set_default_timeout(15000)
            result.route("https://tile.openstreetmap.org/**", tile_fixture)
            contexts.append(result)
            return result

        admin_context = context(1440)
        driver_context = context(390)
        admin = admin_context.new_page()
        driver = driver_context.new_page()
        observe(admin)
        observe(driver)
        sessions = {}
        tracking = {}

        try:
            def admin_login():
                admin.goto(BASE_URL)
                sessions["admin"] = login(admin, ADMIN_EMAIL, ADMIN_PASSWORD)
                expect(admin.get_by_role("heading", name=re.compile("Cada entrega"))).to_be_visible()
                snapshot = ui_state(admin)
                assert snapshot["simulation"] is False, "Use an operational API, without ROTA_DEMO_SEED"
                assert snapshot["state"]["drivers"] == [], "Use a fresh, empty operational QA database"
                assert snapshot["state"]["deliveries"] == [] and snapshot["state"]["trips"] == []
                expect(admin.get_by_text("Aguardando localização", exact=True)).to_be_visible()
                return {"operationalApi": True, "initialDrivers": 0, "initialDeliveries": 0, "initialTrips": 0}

            if not record("admin: login real em operação vazia, sem demonstração", admin_login):
                raise RuntimeError("O login administrativo e uma base QA vazia são necessários para os demais fluxos.")

            def create_driver():
                admin_tab(admin, "Usuários")
                admin.get_by_role("button", name="Novo usuário", exact=True).click()
                dialog = admin.get_by_role("dialog")
                dialog.get_by_label("Nome completo", exact=True).fill(DRIVER_NAME)
                dialog.get_by_label("E-mail", exact=True).fill(DRIVER_EMAIL)
                dialog.get_by_role("combobox", name=re.compile("^Perfil na operação")).select_option("driver")
                dialog.get_by_role("combobox", name="Entregador vinculado", exact=True).select_option("")
                dialog.get_by_label(re.compile("^Senha inicial")).fill(DRIVER_PASSWORD)
                with post_response(admin, "/api/users") as response:
                    dialog.get_by_role("button", name="Adicionar usuário", exact=True).click()
                assert response.value.status == 200
                expect(dialog).not_to_be_visible()
                row = admin.get_by_role("row").filter(has=admin.get_by_text(DRIVER_EMAIL, exact=True))
                expect(row.get_by_text("Entregador", exact=True)).to_be_visible()
                return "Conta e novo entregador criados pelo formulário e API reais."

            if not record("admin: cadastra novo entregador pela interface", create_driver):
                raise RuntimeError("O cadastro do entregador é necessário para os demais fluxos.")

            def driver_login():
                driver.goto(BASE_URL + "/entregador")
                sessions["driver"] = login(driver, DRIVER_EMAIL, DRIVER_PASSWORD)
                expect(driver.get_by_role("heading", name="Minha rota", exact=True)).to_be_visible()
                assert sessions["driver"]["user"]["role"] == "driver"
                snapshot = ui_state(driver)
                assert snapshot["simulation"] is False
                assert snapshot["state"]["drivers"][0]["status"] == "offline"
                expect(driver.get_by_text("A captura de GPS está disponível no aplicativo Android.", exact=True)).to_be_visible()
                expect(driver.get_by_role("button", name="Ativar GPS", exact=True)).to_have_count(0)
                expect(driver.get_by_role("button", name="Avançar simulação", exact=True)).to_have_count(0)
                expect(driver.get_by_role("progressbar")).to_have_count(0)
                return {"scope": scope(snapshot, sessions["driver"]), "webGpsCaptureEnabled": False, "fakeNavigationVisible": False}

            if not record("driver: login isolado, escopo próprio e aviso de GPS Android", driver_login):
                raise RuntimeError("O login do entregador é necessário para os demais fluxos.")

            def start_shift():
                with post_response(driver, "/api/commands") as response:
                    driver.get_by_role("button", name="Iniciar turno", exact=True).click()
                assert response.value.status == 200
                expect(driver.get_by_text("Seu turno está em andamento", exact=True)).to_be_visible()
                snapshot = authenticated(driver_context, sessions["driver"], "GET", "/api/state")
                own = snapshot["state"]["drivers"][0]
                assert own["status"] == "available" and own["shiftStartedAt"]
                return {"driverStatus": own["status"], "scope": scope(snapshot, sessions["driver"])}

            if not record("driver: inicia turno pela interface e API reais", start_shift):
                raise RuntimeError("O turno é necessário para registrar os pontos QA.")

            def upload_points():
                started = authenticated(driver_context, sessions["driver"], "POST", "/api/tracking/start", {"deviceId": "qa-browser"})
                tracking["session"] = started["trackingSession"]
                beginning = parse_time(tracking["session"]["startedAt"])
                # Send promptly: both samples stay inside the API's +30 s bound.
                points = [sample(beginning + timedelta(seconds=1)), sample(beginning + timedelta(seconds=11), -23.559)]
                tracking["points"] = points
                body = {"sessionId": tracking["session"]["id"], "points": points}
                result = authenticated(driver_context, sessions["driver"], "POST", "/api/tracking/points", body)
                assert result["accepted"] == 2 and result["rejected"] == 0 and result["duplicates"] == 0
                assert result["ackIds"] == [point["id"] for point in points] and result["active"] is True
                own = result["state"]["drivers"][0]
                assert all(own["gps"][key] == points[-1][key] for key in points[-1]), "API location differs from the submitted sample"
                assert own["gps"]["receivedAt"]
                summary = gps_summary(result, sessions["driver"]["user"]["driverId"])
                assert abs(summary["dailyMeters"] - 111.1949266) < 0.001, summary
                assert abs(summary["kmToday"] - 0.1111949266) < 0.000001, summary
                assert summary["acceptedPoints"] == 2 and summary["gaps"] == 0
                tracking["accepted"] = result
                return {"syntheticGps": True, "acknowledgedSamples": 2, "lastCoordinates": {
                    "latitude": own["gps"]["latitude"], "longitude": own["gps"]["longitude"], "accuracy": own["gps"]["accuracy"]}, **summary}

            if not record("API GPS: confirma duas amostras sintéticas e calcula 111 m", upload_points):
                raise RuntimeError("O lote QA confirmado é necessário para os demais fluxos.")

            def panel_polling():
                before_reads = POLL_READS.get(admin, 0)
                admin_tab(admin, "Visão geral")
                driver_id = sessions["driver"]["user"]["driverId"]
                marker = admin.locator(f".gps-map-marker[data-driver-id='{driver_id}']")
                expect(marker).to_be_visible(timeout=20000)
                icon = admin.locator(".leaflet-marker-icon").filter(has=marker)
                expect(icon).to_have_attribute("aria-label", re.compile(DRIVER_NAME + r".*precisão ±5 m"))
                assert POLL_READS.get(admin, 0) > before_reads, "Map did not receive a new automatic server read"
                snapshot = ui_state(admin)
                own = next(item for item in snapshot["state"]["drivers"] if item["id"] == driver_id)
                expected = tracking["points"][-1]
                assert all(own["gps"][key] == expected[key] for key in expected)
                expect(admin.locator(".admin-driver-card").filter(has=admin.get_by_text(DRIVER_NAME, exact=True))).to_contain_text("0,1")
                expect(driver.locator(".driver-stats")).to_contain_text("0,1", timeout=20000)
                expect(driver.locator(".driver-tracking-point")).to_contain_text("Precisão ±5 m")
                # Single-location fit centres the map on the actual coordinate.
                # Check the requested centre tile without inspecting React internals.
                zoom = 16
                tile_x = math.floor((expected["longitude"] + 180) / 360 * 2 ** zoom)
                lat = math.radians(expected["latitude"])
                tile_y = math.floor((1 - math.asinh(math.tan(lat)) / math.pi) / 2 * 2 ** zoom)
                expected_tile = f"/{zoom}/{tile_x}/{tile_y}.png"
                assert any(urlsplit(url).path == expected_tile for url in TILE_REQUESTS), "Map was not centred on the received GPS coordinate"
                admin.screenshot(path=str(OUTPUT / "painel-gps.png"), full_page=True)
                driver.screenshot(path=str(OUTPUT / "entregador-gps.png"), full_page=True)
                return {"automaticServerReads": POLL_READS[admin] - before_reads, "markerVisible": True,
                        "coordinatesMatchUploadedSample": True, "centreTile": expected_tile,
                        "displayedKm": "0,1", "tileTransport": "fixture"}

            record("admin/driver: polling recebe posição, marcador e quilômetros", panel_polling)

            def duplicate_batch():
                before = authenticated(driver_context, sessions["driver"], "GET", "/api/state")
                result = authenticated(driver_context, sessions["driver"], "POST", "/api/tracking/points", {
                    "sessionId": tracking["session"]["id"], "points": tracking["points"]})
                assert result["accepted"] == 0 and result["rejected"] == 0 and result["duplicates"] == 2
                assert result["ackIds"] == [point["id"] for point in tracking["points"]]
                assert result["revision"] == before["revision"] and result["state"] == before["state"]
                return {"duplicateSamples": 2, "revisionUnchanged": True,
                        "distanceUnchanged": True, "scope": scope(result, sessions["driver"])}

            record("API GPS: reenvio confirmado não duplica distância nem revisão", duplicate_batch)

            def stop_and_late_point():
                last_capture = parse_time(tracking["points"][-1]["recordedAt"])
                stopped_at = max(datetime.now(timezone.utc), last_capture + timedelta(seconds=1))
                result = authenticated(driver_context, sessions["driver"], "POST", "/api/tracking/stop", {
                    "sessionId": tracking["session"]["id"], "stoppedAt": timestamp(stopped_at)})
                stopped = result["trackingSession"]
                assert parse_time(stopped["endedAt"]) >= last_capture
                late = sample(parse_time(stopped["endedAt"]) + timedelta(seconds=1), -23.558)
                rejected = authenticated(driver_context, sessions["driver"], "POST", "/api/tracking/points", {
                    "sessionId": stopped["id"], "points": [late]})
                assert rejected["active"] is False and rejected["accepted"] == 0 and rejected["rejected"] == 1
                assert rejected["duplicates"] == 0 and rejected["ackIds"] == [late["id"]]
                assert gps_summary(rejected, sessions["driver"]["user"]["driverId"]) == gps_summary(result, sessions["driver"]["user"]["driverId"])
                assert rejected["state"]["drivers"][0]["gps"] == result["state"]["drivers"][0]["gps"]
                tracking["stopped"] = rejected
                return {"sessionEnded": True, "endedAfterLastCapture": True,
                        "outsideWindowAcknowledged": True, "outsideWindowRejected": True,
                        "active": False, "gpsAndDistanceUnchanged": True}

            record("API GPS: encerra coleta e confirma rejeição fora da janela", stop_and_late_point)

            def reports_and_csv():
                admin_tab(admin, "Relatórios")
                admin.get_by_role("combobox", name="Entregador", exact=True).select_option(sessions["driver"]["user"]["driverId"])
                row = admin.get_by_role("row").filter(has=admin.get_by_text(DRIVER_NAME, exact=True))
                expect(row.locator(".admin-km-value")).to_contain_text("0,1", timeout=20000)
                expect(admin.get_by_text("GPS do turno", exact=True)).to_be_visible()
                with admin.expect_download() as download_info:
                    admin.get_by_role("button", name="Exportar CSV", exact=True).click()
                path = OUTPUT / "gps-turno.csv"
                download_info.value.save_as(str(path))
                raw = path.read_bytes()
                assert raw.startswith(b"\xef\xbb\xbf"), "CSV must preserve the UTF-8 BOM"
                rows = list(csv.reader(io.StringIO(raw.decode("utf-8-sig")), delimiter=";"))
                assert "Origem de distância" in rows[0]
                assert len(rows) == 2, "Empty QA operation must export one daily GPS row and no delivery rows"
                data = dict(zip(rows[0], rows[1]))
                assert data["Origem de distância"] == "GPS"
                assert data["Pedido / registro"] == "Total do turno no dia"
                assert data["Quilômetros"] == "0,11" and data["Status"] == "2 posições aceitas"
                assert data["Interrupções de GPS"] == "0" and data["Entregador"] == DRIVER_NAME
                assert not any(secret and secret in raw.decode("utf-8-sig") for secret in REDACTIONS)
                driver_tab(driver, "Histórico")
                expect(driver.locator(".driver-history-hero")).to_contain_text("0,1", timeout=20000)
                expect(driver.get_by_text("2 posições aceitas", exact=True)).to_be_visible()
                expect(driver.get_by_text("Inclui deslocamentos entre entregas", exact=True)).to_be_visible()
                snapshot = authenticated(driver_context, sessions["driver"], "GET", "/api/state")
                assert snapshot["state"]["trips"] == [] and snapshot["state"]["deliveries"] == []
                admin.screenshot(path=str(OUTPUT / "relatorio-gps.png"), full_page=True)
                driver.screenshot(path=str(OUTPUT / "historico-gps.png"), full_page=True)
                return {"dailyGpsRows": 1, "deliveryRows": 0, "csvOrigin": "GPS", "csvKm": "0,11",
                        "dailyDistanceIncludesBetweenDeliveries": True, "utf8Bom": True}

            record("relatórios: quilômetros do turno sem entregas e CSV com origem GPS", reports_and_csv)

            def responsive():
                details = []
                for width in [320, 390, 768]:
                    admin.set_viewport_size({"width": width, "height": 900})
                    for tab in ["Visão geral", "Entregas", "Relatórios", "Usuários"]:
                        admin_tab(admin, tab)
                        details.append({"screen": "admin", "tab": tab, "width": width, "sizes": no_overflow(admin)})
                    driver.set_viewport_size({"width": width, "height": 900})
                    for tab in ["Minha rota", "Entregas", "Histórico", "Perfil"]:
                        driver_tab(driver, tab)
                        details.append({"screen": "driver", "tab": tab, "width": width, "sizes": no_overflow(driver)})
                    if width == 320:
                        admin_tab(admin, "Visão geral")
                        driver_tab(driver, "Minha rota")
                        admin.screenshot(path=str(OUTPUT / "painel-gps-320.png"), full_page=True)
                        driver.screenshot(path=str(OUTPUT / "entregador-gps-320.png"), full_page=True)
                return details

            record("interfaces GPS: oito abas sem overflow em 320/390/768", responsive)

            def logout_revocation():
                statuses = {}
                for name, page, owner_context in [("driver", driver, driver_context), ("admin", admin, admin_context)]:
                    if name == "driver":
                        driver_tab(page, "Perfil")
                    page.bring_to_front()
                    with post_response(page, "/api/auth/logout") as response:
                        page.get_by_role("button", name="Sair", exact=True).click()
                    assert response.value.status == 204
                    expect(page.get_by_role("button", name="Entrar", exact=True)).to_be_visible()
                    revoked = owner_context.request.get(BASE_URL + "/api/state", headers={"Authorization": "Bearer " + sessions[name]["token"]})
                    assert revoked.status == 401
                    statuses[name + "OldTokenStatus"] = revoked.status
                    page.reload()
                    expect(page.get_by_role("button", name="Entrar", exact=True)).to_be_visible()
                return statuses

            record("logout: duas sessões revogadas pela API e não restauradas", logout_revocation)

        except Exception as error:
            CHECKS.append({"name": "execução dos fluxos", "status": "fail", "detail": redact(str(error))})
            print(f"FAIL execução dos fluxos: {redact(str(error))}", flush=True)
        finally:
            record("navegador: nenhum erro JavaScript ou falha de rede", runtime_health)
            report = {"url": BASE_URL, "checks": CHECKS, "pageErrors": PAGE_ERRORS,
                      "requestFailures": REQUEST_FAILURES, "cancelledSessionRequests": CANCELLED_REQUESTS,
                      "documentFailures": DOCUMENT_FAILURES, "separateBrowserContexts": True,
                      "syntheticGps": True, "physicalAndroidGpsTested": False,
                      "applicationRequestsMocked": False, "tileTransport": "fixture",
                      "tileRequestCount": len(TILE_REQUESTS), "tlsVerificationDisabled": False}
            (OUTPUT / "gps-smoke.json").write_text(json.dumps(redact(report), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            for item in contexts:
                item.close()
            browser.close()
    return 1 if any(check["status"] == "fail" for check in CHECKS) else 0


if __name__ == "__main__":
    raise SystemExit(main())
