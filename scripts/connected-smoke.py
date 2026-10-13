#!/usr/bin/env python3
"""Check authenticated delivery flows against the running local API and web app.

Requires a fresh demonstration QA database and the fixture accounts below. Start
the API on port 3001 and Vite on port 5173 before running this script. Override
UI_SMOKE_URL, QA_* credentials or CHROMIUM_EXECUTABLE as needed. Browser contexts
are isolated; no requests are mocked and no TLS verification is disabled.
Passwords and authentication tokens are never written to the report.
"""

import json
import os
from pathlib import Path
import re
import time
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright


BASE_URL = os.environ.get("UI_SMOKE_URL", "http://127.0.0.1:5173").rstrip("/")
OUTPUT = Path(os.environ.get("UI_SMOKE_OUTPUT", str(Path(__file__).resolve().parents[1] / ".local" / "connected-qa")))
ADMIN_EMAIL = os.environ.get("QA_ADMIN_EMAIL", "qa-admin@example.test")
ADMIN_PASSWORD = os.environ.get("QA_ADMIN_PASSWORD", "QaAdministrator!2468")
DRIVER_EMAIL = os.environ.get("QA_DRIVER_EMAIL", "entregador1@example.com")
DRIVER_PASSWORD = os.environ.get("QA_DRIVER_PASSWORD", "QaDeliverer!2468")
MANAGER_EMAIL = f"qa-manager-{time.time_ns()}@example.test"
MANAGER_PASSWORD = "QaManagerAccount!2468"
WRONG_PASSWORD = "QaWrongPassword!2468"
REDACTIONS = {ADMIN_PASSWORD, DRIVER_PASSWORD, MANAGER_PASSWORD, WRONG_PASSWORD}
CHECKS = []
PAGE_ERRORS = []
REQUEST_FAILURES = []
CANCELLED_REQUESTS = []
DOCUMENT_FAILURES = []
STATE_RESPONSES = {}
POLL_READS = {}
PAGES = []


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
    def request_failed(request):
        detail = {"url": redact(request.url), "failure": redact(request.failure)}
        # React StrictMode replays effects in development, and reload/sign-out
        # deliberately cancel session-bound requests. Keep these visible in the
        # report; actual connection failures still fail the check.
        cancelled_session_request = request.failure == "net::ERR_ABORTED" and urlsplit(request.url).path in {"/api/auth/me", "/api/state", "/api/auth/logout"}
        (CANCELLED_REQUESTS if cancelled_session_request else REQUEST_FAILURES).append(detail)

    page.on("requestfailed", request_failed)

    def response_seen(response):
        if response.request.resource_type == "document" and response.status >= 400:
            DOCUMENT_FAILURES.append({"url": redact(response.url), "status": response.status})
        if urlsplit(response.url).path == "/api/state" and response.status == 200:
            # Do not block this event callback while reading a response body;
            # Playwright can process UI assertions during that nested wait.
            STATE_RESPONSES[page] = response
            POLL_READS[page] = POLL_READS.get(page, 0) + 1

    page.on("response", response_seen)


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


def api_response(page, path):
    return page.expect_response(lambda response: urlsplit(response.url).path == path and response.request.method == "POST")


def state(page):
    return STATE_RESPONSES[page].json()["state"]


def login(page, email, password, expected_status=200):
    page.get_by_label("E-mail", exact=True).fill(email)
    page.get_by_label("Senha", exact=True).fill(password)
    with api_response(page, "/api/auth/login") as response_info:
        page.get_by_role("button", name="Entrar", exact=True).click()
    response = response_info.value
    assert response.status == expected_status, {"expected": expected_status, "actual": response.status}
    body = response.json()
    if expected_status == 200:
        REDACTIONS.add(body["token"])
        return body
    expect(page.get_by_role("alert")).to_be_visible()
    expect(page.get_by_role("button", name="Entrar", exact=True)).to_be_enabled()
    return None


def driver_scope(page, user):
    snapshot = state(page)
    driver_id = user["driverId"]
    assert [item["id"] for item in snapshot["users"]] == [user["id"]], "Driver received another account"
    assert [item["id"] for item in snapshot["drivers"]] == [driver_id], "Driver received another driver"
    assert all(item["driverId"] == driver_id for item in snapshot["deliveries"]), "Driver received another driver's delivery"
    assert all(item["driverId"] == driver_id for item in snapshot["trips"]), "Driver received another driver's trip"
    forbidden = {"password", "passwordHash", "password_hash", "token", "tokenHash", "token_hash", "salt"}

    def scan(value):
        if isinstance(value, dict):
            assert not forbidden.intersection(value), "State payload contains authentication material"
            for item in value.values():
                scan(item)
        elif isinstance(value, list):
            for item in value:
                scan(item)

    scan(snapshot)
    return {"users": len(snapshot["users"]), "drivers": len(snapshot["drivers"]), "deliveries": len(snapshot["deliveries"]), "trips": len(snapshot["trips"])}


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        executable = os.environ.get("CHROMIUM_EXECUTABLE", "/usr/bin/chromium")
        browser = playwright.chromium.launch(executable_path=executable, headless=True, args=["--no-sandbox"])
        contexts = []

        def context(width=1440):
            result = browser.new_context(viewport={"width": width, "height": 1000}, locale="pt-BR", timezone_id="America/Sao_Paulo")
            result.set_default_timeout(15000)
            contexts.append(result)
            return result

        admin_context = context()
        driver_context = context(390)
        manager_context = context()
        layout_context = context()
        admin = admin_context.new_page()
        driver = driver_context.new_page()
        manager = manager_context.new_page()
        layout = layout_context.new_page()
        for page in [admin, driver, manager, layout]:
            observe(page)
        sessions = {}

        try:
            def login_responsive():
                details = []
                for screen, suffix in [("admin", ""), ("driver", "/entregador")]:
                    layout.goto(BASE_URL + suffix)
                    expect(layout.get_by_label("E-mail", exact=True)).to_be_visible()
                    for width in [320, 390, 768, 1440]:
                        layout.set_viewport_size({"width": width, "height": 900})
                        details.append({"screen": screen, "width": width, "sizes": no_overflow(layout)})
                        if width == 390:
                            layout.screenshot(path=str(OUTPUT / f"login-{screen}.png"), full_page=True)
                return details

            record("login: duas telas sem overflow em 320/390/768/1440", login_responsive)

            def admin_login():
                admin.goto(BASE_URL)
                login(admin, ADMIN_EMAIL, WRONG_PASSWORD, 401)
                sessions["admin"] = login(admin, ADMIN_EMAIL, ADMIN_PASSWORD)
                expect(admin.get_by_role("heading", name=re.compile("Cada entrega"))).to_be_visible()
                assert sessions["admin"]["user"]["role"] == "admin"
                initial = state(admin)
                first = next(item for item in initial["deliveries"] if item["id"] == "e1")
                unassigned = next(item for item in initial["deliveries"] if item["id"] == "e5")
                assert first["status"] == "pending" and unassigned["driverId"] is None, "Use a fresh demonstration QA database: e1 must be pending and e5 unassigned."
                admin.screenshot(path=str(OUTPUT / "painel-conectado.png"), full_page=True)
                return "Senha incorreta recusada pela API; acesso administrativo válido abre o painel."

            if not record("admin: login incorreto e correto pela API real", admin_login):
                raise RuntimeError("O login administrativo é necessário para os demais fluxos.")

            def driver_login():
                driver.goto(BASE_URL + "/entregador")
                sessions["driver"] = login(driver, DRIVER_EMAIL, DRIVER_PASSWORD)
                expect(driver.get_by_role("heading", name="Minha rota", exact=True)).to_be_visible()
                assert sessions["driver"]["user"]["role"] == "driver"
                expect(driver.get_by_role("button", name=re.compile("Trocar entregador"))).to_have_count(0)
                expect(driver.get_by_text("Camila Santos", exact=True)).to_have_count(0)
                expect(driver.get_by_text("Bruno Ferreira", exact=True)).to_have_count(0)
                driver.screenshot(path=str(OUTPUT / "entregador-conectado.png"), full_page=True)
                return driver_scope(driver, sessions["driver"]["user"])

            if not record("driver: contexto isolado recebe somente seu perfil e entregas", driver_login):
                raise RuntimeError("O login do entregador é necessário para o percurso.")

            def create_manager():
                admin_tab(admin, "Usuários")
                admin.get_by_role("button", name="Novo usuário", exact=True).click()
                dialog = admin.get_by_role("dialog")
                dialog.get_by_label("Nome completo", exact=True).fill("Gestora Connected QA")
                dialog.get_by_label("E-mail", exact=True).fill(MANAGER_EMAIL)
                dialog.get_by_role("combobox", name=re.compile("^Perfil na operação")).select_option("manager")
                password = dialog.get_by_label(re.compile("^Senha inicial"))
                password.fill("curta")
                dialog.get_by_role("button", name="Adicionar usuário", exact=True).click()
                expect(dialog).to_be_visible()
                assert not password.evaluate("element => element.checkValidity()"), "Short password accepted by the form"
                password.fill(MANAGER_PASSWORD)
                with api_response(admin, "/api/users") as response_info:
                    dialog.get_by_role("button", name="Adicionar usuário", exact=True).click()
                assert response_info.value.status == 200
                expect(dialog).not_to_be_visible()
                row = admin.get_by_role("row").filter(has=admin.get_by_text(MANAGER_EMAIL, exact=True))
                expect(row.get_by_text("Gestor", exact=True)).to_be_visible()
                manager.goto(BASE_URL)
                sessions["manager"] = login(manager, MANAGER_EMAIL, MANAGER_PASSWORD)
                expect(manager.get_by_role("heading", name=re.compile("Cada entrega"))).to_be_visible()
                expect(manager.get_by_role("navigation", name="Navegação administrativa").get_by_role("button", name="Usuários", exact=True)).to_have_count(0)
                expect(manager.get_by_role("button", name="Novo usuário", exact=True)).to_have_count(0)
                admin_tab(manager, "Entregas")
                expect(manager.get_by_role("heading", name=re.compile("Gestão de entregas"))).to_be_visible()
                admin_tab(manager, "Relatórios")
                expect(manager.get_by_role("heading", name=re.compile("Quilômetros e resultados"))).to_be_visible()
                manager.screenshot(path=str(OUTPUT / "gestor-relatorios.png"), full_page=True)
                return "Cadastro pelo painel com senha mínima; nova conta entra como gestor e não oferece gestão de usuários."

            record("admin/manager: cadastro e acesso conforme perfil", create_manager)

            def assignment_polling():
                driver_tab(driver, "Entregas")
                expect(driver.get_by_text("Carolina Mendes", exact=True)).to_have_count(0)
                before_reads = POLL_READS.get(driver, 0)
                admin_tab(admin, "Entregas")
                with api_response(admin, "/api/commands") as response_info:
                    admin.get_by_label("Entregador do pedido RT-1045", exact=True).select_option("d1")
                assert response_info.value.status == 200
                driver.bring_to_front()
                expect(driver.get_by_text("Carolina Mendes", exact=True)).to_be_visible(timeout=20000)
                assert POLL_READS.get(driver, 0) > before_reads, "Assignment appeared without a new server state read"
                snapshot = state(driver)
                assert any(item["id"] == "e5" and item["driverId"] == "d1" for item in snapshot["deliveries"])
                return {"assignment": "RT-1045 → Rafael Costa", "automaticServerReads": POLL_READS[driver] - before_reads, "scope": driver_scope(driver, sessions["driver"]["user"])}

            record("admin/driver: atribuição chega automaticamente em outro contexto", assignment_polling)

            def start_route():
                driver_tab(driver, "Minha rota")
                with api_response(driver, "/api/commands") as response_info:
                    driver.get_by_role("button", name="Iniciar rota", exact=True).click()
                assert response_info.value.status == 200
                expect(driver.get_by_role("heading", name="Navegação", exact=True)).to_be_visible()
                expect(driver.get_by_role("progressbar", name="Progresso do percurso simulado")).to_have_attribute("value", "0")
                admin_tab(admin, "Entregas")
                row = admin.get_by_role("row").filter(has=admin.get_by_text("RT-1041", exact=True))
                expect(row.get_by_text("Em rota", exact=True)).to_be_visible(timeout=20000)
                driver.screenshot(path=str(OUTPUT / "navegacao-conectada.png"), full_page=True)
                return "RT-1041 iniciado no app; painel recebe o estado Em rota pela sincronização."

            record("driver/admin: início de percurso compartilhado", start_route)

            def advance_route():
                driver.bring_to_front()
                for progress in [.25, .5, .75, 1]:
                    with api_response(driver, "/api/commands") as response_info:
                        driver.get_by_role("button", name="Avançar simulação", exact=True).click()
                    assert response_info.value.status == 200
                    expect(driver.get_by_role("progressbar", name="Progresso do percurso simulado")).to_have_attribute("value", str(progress).rstrip("0").rstrip(".") if progress != 1 else "1")
                expect(driver.get_by_role("button", name="Confirmar entrega", exact=True)).to_be_visible()
                return "Quatro avanços, 25%/50%/75%/100%, persistidos pela API."

            record("driver: quatro etapas do percurso simulado", advance_route)

            def complete_and_sync():
                driver.get_by_role("button", name="Confirmar entrega", exact=True).click()
                dialog = driver.get_by_role("dialog", name="Confirmar entrega", exact=True)
                expect(dialog.get_by_role("button", name="Confirmar entrega", exact=True)).to_be_disabled()
                dialog.get_by_label("Nome de quem recebeu", exact=True).fill("Recebedor Connected QA")
                with api_response(driver, "/api/commands") as response_info:
                    dialog.get_by_role("button", name="Confirmar entrega", exact=True).click()
                assert response_info.value.status == 200
                expect(dialog).not_to_be_visible()
                before_reads = POLL_READS.get(admin, 0)
                admin.bring_to_front()
                row = admin.get_by_role("row").filter(has=admin.get_by_text("RT-1041", exact=True))
                expect(row.get_by_text("Entregue", exact=True)).to_be_visible(timeout=20000)
                assert POLL_READS.get(admin, 0) > before_reads, "Delivery status did not arrive by a new server read"
                admin.get_by_role("button", name="Ver detalhes do pedido RT-1041", exact=True).click()
                detail = admin.get_by_role("dialog", name="Pedido RT-1041", exact=True)
                expect(detail.get_by_text("Recebedor Connected QA", exact=True)).to_be_visible()
                detail.get_by_role("button", name="Concluir", exact=True).click()
                snapshot = state(admin)
                rafael = next(item for item in snapshot["drivers"] if item["id"] == "d1")
                assert rafael["kmToday"] == 11.3, rafael["kmToday"]
                trip = next(item for item in snapshot["trips"] if item["deliveryId"] == "e1")
                assert trip["km"] == 3.8 and trip["finishedAt"], "Completed trip distance missing"
                admin_tab(admin, "Relatórios")
                admin.get_by_role("combobox", name="Entregador", exact=True).select_option("d1")
                report_row = admin.get_by_role("row").filter(has=admin.get_by_text("Rafael Costa", exact=True))
                expect(report_row.locator(".admin-km-value")).to_contain_text("11,3")
                driver_tab(driver, "Histórico")
                expect(driver.locator(".driver-history-list").get_by_text("Mariana Oliveira", exact=True)).to_be_visible()
                expect(driver.locator(".driver-history-hero")).to_contain_text("11,3")
                return {"receivedBy": "Recebedor Connected QA", "tripKmSimulated": 3.8, "driverKmTodaySimulated": 11.3, "automaticServerReads": POLL_READS[admin] - before_reads}

            record("driver/admin: recebedor, conclusão e quilômetros sincronizados", complete_and_sync)

            def restored_sessions():
                admin.reload()
                expect(admin.get_by_role("heading", name=re.compile("Cada entrega"))).to_be_visible()
                expect(admin.locator(".admin-profile")).to_have_attribute("title", re.compile(re.escape(sessions["admin"]["user"]["name"])))
                driver.reload()
                expect(driver.get_by_role("heading", name="Minha rota", exact=True)).to_be_visible()
                driver_tab(driver, "Perfil")
                expect(driver.get_by_role("heading", name=sessions["driver"]["user"]["name"], exact=True)).to_be_visible()
                expect(driver.get_by_text(DRIVER_EMAIL, exact=True)).to_be_visible()
                return {"adminRole": sessions["admin"]["user"]["role"], "driverRole": sessions["driver"]["user"]["role"], "driverScope": driver_scope(driver, sessions["driver"]["user"])}

            record("sessões: recarregar restaura somente o próprio perfil", restored_sessions)

            def connected_responsive():
                details = []
                for width in [320, 390, 768, 1440]:
                    admin.set_viewport_size({"width": width, "height": 900})
                    for tab in ["Visão geral", "Entregas", "Relatórios", "Usuários"]:
                        admin_tab(admin, tab)
                        details.append({"screen": "admin", "tab": tab, "width": width, "sizes": no_overflow(admin)})
                    driver.set_viewport_size({"width": width, "height": 900})
                    for tab in ["Minha rota", "Entregas", "Histórico", "Perfil"]:
                        driver_tab(driver, tab)
                        details.append({"screen": "driver", "tab": tab, "width": width, "sizes": no_overflow(driver)})
                    if width == 320:
                        admin.screenshot(path=str(OUTPUT / "painel-320.png"), full_page=True)
                        driver.screenshot(path=str(OUTPUT / "entregador-320.png"), full_page=True)
                return details

            record("interfaces conectadas: oito abas sem overflow em quatro larguras", connected_responsive)

            def inactive_account():
                manager.bring_to_front()
                with api_response(manager, "/api/auth/logout") as response_info:
                    manager.get_by_role("button", name="Sair", exact=True).click()
                assert response_info.value.status == 204
                expect(manager.get_by_role("button", name="Entrar", exact=True)).to_be_visible()
                admin_tab(admin, "Usuários")
                row = admin.get_by_role("row").filter(has=admin.get_by_text(MANAGER_EMAIL, exact=True))
                with api_response(admin, "/api/commands") as response_info:
                    row.get_by_role("switch", name="Desativar Gestora Connected QA", exact=True).click()
                assert response_info.value.status == 200
                expect(row.get_by_role("switch", name="Ativar Gestora Connected QA", exact=True)).to_have_attribute("aria-checked", "false")
                login(manager, MANAGER_EMAIL, MANAGER_PASSWORD, 401)
                expect(manager.get_by_role("navigation", name="Navegação administrativa")).to_have_count(0)
                return "Conta desativada pelo administrador não volta a entrar com a senha válida."

            if "manager" in sessions:
                record("segurança: usuário desativado não entra", inactive_account)

            def logout_revocation():
                driver_tab(driver, "Perfil")
                with api_response(driver, "/api/auth/logout") as response_info:
                    driver.get_by_role("button", name="Sair", exact=True).click()
                assert response_info.value.status == 204
                expect(driver.get_by_role("button", name="Entrar", exact=True)).to_be_visible()
                revoked = driver_context.request.get(BASE_URL + "/api/state", headers={"Authorization": "Bearer " + sessions["driver"]["token"]})
                assert revoked.status == 401, revoked.status
                driver.reload()
                expect(driver.get_by_role("button", name="Entrar", exact=True)).to_be_visible()
                admin.bring_to_front()
                with api_response(admin, "/api/auth/logout") as response_info:
                    admin.get_by_role("button", name="Sair", exact=True).click()
                assert response_info.value.status == 204
                expect(admin.get_by_role("button", name="Entrar", exact=True)).to_be_visible()
                revoked_admin = admin_context.request.get(BASE_URL + "/api/state", headers={"Authorization": "Bearer " + sessions["admin"]["token"]})
                assert revoked_admin.status == 401, revoked_admin.status
                return {"driverOldTokenStatus": revoked.status, "adminOldTokenStatus": revoked_admin.status, "signedOutReload": True}

            record("logout: volta ao login e a API revoga sessões anteriores", logout_revocation)

        except Exception as error:
            CHECKS.append({"name": "execução dos fluxos", "status": "fail", "detail": redact(str(error))})
            print(f"FAIL execução dos fluxos: {redact(str(error))}", flush=True)
        finally:
            record("navegador: nenhum erro JavaScript ou falha de rede", lambda: runtime_health())
            report = {"url": BASE_URL, "checks": CHECKS, "pageErrors": PAGE_ERRORS, "requestFailures": REQUEST_FAILURES, "cancelledSessionRequests": CANCELLED_REQUESTS, "documentFailures": DOCUMENT_FAILURES, "separateBrowserContexts": True, "mockedRequests": False, "tlsVerificationDisabled": False}
            (OUTPUT / "connected-smoke.json").write_text(json.dumps(redact(report), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            for item in contexts:
                item.close()
            browser.close()

    return 1 if any(check["status"] == "fail" for check in CHECKS) else 0


def runtime_health():
    assert not PAGE_ERRORS, PAGE_ERRORS
    assert not REQUEST_FAILURES, REQUEST_FAILURES
    assert not DOCUMENT_FAILURES, DOCUMENT_FAILURES
    return {"pageErrors": 0, "requestFailures": 0, "documentFailures": 0, "cancelledSessionRequests": len(CANCELLED_REQUESTS)}


if __name__ == "__main__":
    raise SystemExit(main())
