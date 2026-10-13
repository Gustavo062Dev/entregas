#!/usr/bin/env python3
"""Exercise the local demonstration through Chromium; restore test storage afterwards.

Run with the Vite server already running: python scripts/ui-smoke.py
Artifacts are written only to .local/qa. No external service is contacted.
"""

import json
import os
from pathlib import Path
import re
import traceback
import csv
import io
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

BASE_URL = os.environ.get("UI_SMOKE_URL", "http://127.0.0.1:5173").rstrip("/")
PORTABLE = BASE_URL.startswith("file:") or urlsplit(BASE_URL).path.endswith(".html")
OUTPUT = Path(os.environ.get("UI_SMOKE_OUTPUT", str(Path(__file__).resolve().parents[1] / ".local" / "qa")))
STATE_KEY = "rota.demo.state.v1"
CHECKS = []
ERRORS = []
REQUEST_FAILURES = []
HTTP_FAILURES = []
OBSERVED_PAGES = []


def record(name, function):
    try:
        result = function()
        CHECKS.append({"name": name, "status": "pass", "detail": result})
        print(f"PASS {name}", flush=True)
        return True
    except Exception as error:
        CHECKS.append({"name": name, "status": "fail", "detail": str(error)})
        print(f"FAIL {name}: {error}", flush=True)
        for page in OBSERVED_PAGES:
            if not page.is_closed():
                page.keyboard.press("Escape")
        return False


def observe(page):
    OBSERVED_PAGES.append(page)
    page.on("pageerror", lambda error: ERRORS.append(str(error)))
    page.on("requestfailed", lambda request: REQUEST_FAILURES.append({"url": request.url, "failure": request.failure}))
    page.on("response", lambda response: HTTP_FAILURES.append({"url": response.url, "status": response.status}) if response.status >= 400 else None)


def dismiss_notice(page):
    button = page.get_by_role("button", name="Fechar aviso", exact=True)
    if button.is_visible():
        button.click()


def state(page):
    return page.evaluate("key => JSON.parse(localStorage.getItem(key))", STATE_KEY)


def wait_state(page, expression):
    page.wait_for_function(f"() => {{ const s = JSON.parse(localStorage.getItem('{STATE_KEY}')); return s && ({expression}); }}")


def no_horizontal_overflow(page):
    page.evaluate("document.fonts.ready")
    sizes = page.evaluate("({viewport: window.innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth})")
    assert sizes["document"] <= sizes["viewport"] + 1, sizes
    assert sizes["body"] <= sizes["viewport"] + 1, sizes
    return sizes


def driver_tab(page, name):
    page.get_by_role("navigation", name="Navegação do entregador").get_by_role("button", name=name, exact=True).click()


def choose_driver(page, name):
    page.get_by_role("button", name=re.compile("^Trocar entregador\\. Perfil atual:")).click()
    page.get_by_role("dialog", name="Escolher entregador").get_by_role("button", name=re.compile(name)).click()


def admin_tab(page, name):
    open_menu = page.get_by_role("button", name="Abrir menu", exact=True)
    if open_menu.is_visible():
        open_menu.click()
    page.get_by_role("navigation", name="Navegação administrativa").get_by_role("button", name=re.compile(f"^{re.escape(name)}(?:\\s|$)")).click()


def add_user(page, name, email, role):
    page.get_by_role("button", name="Novo usuário", exact=True).click()
    dialog = page.get_by_role("dialog")
    dialog.get_by_label("Nome completo", exact=True).fill(name)
    dialog.get_by_label("E-mail", exact=True).fill(email)
    dialog.get_by_role("combobox", name=re.compile("^Perfil na operação")).select_option(role)
    dialog.get_by_role("button", name="Adicionar usuário", exact=True).click()
    expect(dialog).not_to_be_visible()
    return page.get_by_role("row").filter(has=page.get_by_text(email, exact=True))


def smoke_admin(page):
    page.evaluate("document.fonts.ready")
    page.screenshot(path=str(OUTPUT / "painel.png"), full_page=True)

    def tabs_and_map():
        headings = {"Visão geral": "Cada entrega", "Entregas": "Gestão de entregas", "Relatórios": "Quilômetros e resultados", "Usuários": "Um time, vários caminhos"}
        for tab, heading in headings.items():
            admin_tab(page, tab)
            expect(page.get_by_role("heading", name=re.compile(heading))).to_be_visible()
        admin_tab(page, "Visão geral")
        stage = page.locator(".rota-map-stage")
        expect(stage).to_have_attribute("style", re.compile("scale\\(1\\)"))
        page.get_by_role("button", name="Ampliar mapa", exact=True).click()
        expect(stage).to_have_attribute("style", re.compile("scale\\(1\\.2\\)"))
        page.get_by_role("button", name="Reduzir mapa", exact=True).click()
        expect(stage).to_have_attribute("style", re.compile("scale\\(1\\)"))
        expect(page.get_by_role("button", name="Reduzir mapa", exact=True)).to_be_disabled()
        page.get_by_role("button", name="Ampliar mapa", exact=True).click()
        page.get_by_role("button", name="Restaurar visão do mapa", exact=True).click()
        expect(stage).to_have_attribute("style", re.compile("scale\\(1\\)"))
        page.get_by_role("button", name="Rafael Costa, Disponível", exact=True).click()
        expect(page.get_by_text("Acompanhando Rafael Costa", exact=True)).to_be_visible()
        return "Quatro abas; zoom aumenta/reduz/restaura e marcador seleciona Rafael."

    record("admin: abas e controles do mapa", tabs_and_map)

    def filters_and_assignment():
        admin_tab(page, "Entregas")
        expect(page.locator("tbody tr")).to_have_count(12)
        page.get_by_label("Buscar entregas", exact=True).fill("Mariana")
        expect(page.locator("tbody tr")).to_have_count(1)
        expect(page.get_by_text("RT-1041", exact=True)).to_be_visible()
        page.get_by_label("Buscar entregas", exact=True).fill("Não existe QA")
        expect(page.get_by_text("Nenhuma entrega encontrada", exact=True)).to_be_visible()
        page.get_by_role("button", name="Limpar filtros", exact=True).click()
        page.get_by_role("combobox", name="Status", exact=True).select_option("pending")
        expect(page.locator("tbody tr")).to_have_count(5)
        page.get_by_role("combobox", name="Status", exact=True).select_option("in_transit")
        expect(page.locator("tbody tr")).to_have_count(1)
        page.get_by_role("combobox", name="Status", exact=True).select_option("delivered")
        expect(page.locator("tbody tr")).to_have_count(6)
        page.get_by_role("combobox", name="Status", exact=True).select_option("all")
        page.get_by_role("combobox", name="Entregador", exact=True).select_option("d1")
        expect(page.locator("tbody tr")).to_have_count(4)
        page.get_by_role("combobox", name="Entregador", exact=True).select_option("unassigned")
        expect(page.locator("tbody tr")).to_have_count(1)
        expect(page.get_by_text("Carolina Mendes", exact=True)).to_be_visible()
        page.get_by_role("combobox", name="Entregador", exact=True).select_option("all")
        page.get_by_label("Entregador do pedido RT-1045", exact=True).select_option("d3")
        wait_state(page, "s.deliveries.find(d => d.id === 'e5').driverId === 'd3'")
        page.get_by_role("button", name="Ver detalhes do pedido RT-1045", exact=True).click()
        dialog = page.get_by_role("dialog", name="Pedido RT-1045", exact=True)
        expect(dialog.locator(".admin-detail-grid").get_by_text("Lucas Almeida", exact=True)).to_be_visible()
        dialog.get_by_role("button", name="Concluir", exact=True).click()
        page.get_by_label("Entregador do pedido RT-1045", exact=True).select_option("")
        wait_state(page, "s.deliveries.find(d => d.id === 'e5').driverId === null")
        return "Busca e estado vazio; filtros com 5 pendentes/1 em rota/6 entregues; atribuição e remoção de Lucas em e5."

    record("admin: filtros e atribuição de entregas", filters_and_assignment)

    def users():
        admin_tab(page, "Usuários")
        manager_row = add_user(page, "Gestora Smoke QA", "gestora-qa@example.com", "manager")
        expect(manager_row.get_by_text("Gestor", exact=True)).to_be_visible()
        manager_row.get_by_role("button", name="Editar", exact=True).click()
        dialog = page.get_by_role("dialog", name="Editar usuário", exact=True)
        dialog.get_by_label("Nome completo", exact=True).fill("Gestora QA Atualizada")
        dialog.get_by_role("button", name="Salvar alterações", exact=True).click()
        expect(manager_row.get_by_text("Gestora QA Atualizada", exact=True)).to_be_visible()
        page.get_by_role("switch", name="Desativar Gestora QA Atualizada", exact=True).click()
        expect(page.get_by_role("switch", name="Ativar Gestora QA Atualizada", exact=True)).to_have_attribute("aria-checked", "false")
        driver_row = add_user(page, "Entregador Smoke QA", "entregador-qa@example.com", "driver")
        expect(driver_row.get_by_text("Entregador", exact=True)).to_be_visible()
        wait_state(page, "s.drivers.some(d => d.name === 'Entregador Smoke QA')")
        driver_row.get_by_role("button", name="Editar", exact=True).click()
        dialog = page.get_by_role("dialog", name="Editar usuário", exact=True)
        dialog.get_by_label("Nome completo", exact=True).fill("Entregador QA Atualizado")
        dialog.get_by_role("button", name="Salvar alterações", exact=True).click()
        wait_state(page, "s.drivers.some(d => d.name === 'Entregador QA Atualizado')")
        page.get_by_role("switch", name="Desativar Entregador QA Atualizado", exact=True).click()
        expect(page.get_by_role("switch", name="Ativar Entregador QA Atualizado", exact=True)).to_have_attribute("aria-checked", "false")
        page.get_by_label("Buscar usuários", exact=True).fill("gestora-qa")
        expect(page.locator("tbody tr")).to_have_count(1)
        page.get_by_role("button", name="Limpar busca de usuários", exact=True).click()
        page.get_by_role("button", name="Novo usuário", exact=True).click()
        dialog = page.get_by_role("dialog")
        dialog.get_by_label("Nome completo", exact=True).fill("Duplicado QA")
        dialog.get_by_label("E-mail", exact=True).fill("GESTOR@example.com")
        dialog.get_by_role("button", name="Adicionar usuário", exact=True).click()
        expect(dialog.get_by_role("alert")).to_have_text("Este e-mail já está cadastrado.")
        expect(dialog).to_be_visible()
        dialog.get_by_role("button", name="Cancelar", exact=True).click()
        page.get_by_role("switch", name="Desativar Gustavo Oliveira", exact=True).click()
        expect(page.get_by_role("switch", name="Desativar Gustavo Oliveira", exact=True)).to_have_attribute("aria-checked", "true")
        expect(page.get_by_role("status")).to_contain_text("Mantenha pelo menos um administrador ativo.")
        return "Criou/renomeou/desativou gestor e entregador; busca; e-mail duplicado e último administrador protegidos."

    record("admin: cadastro, edição e validação de usuários", users)

    def reports():
        admin_tab(page, "Relatórios")
        page.get_by_role("combobox", name="Entregador", exact=True).select_option("d1")
        expect(page.locator("tbody tr")).to_have_count(1)
        expect(page.locator("tbody tr").get_by_text("Rafael Costa", exact=True)).to_be_visible()
        with page.expect_download() as download_info:
            page.get_by_role("button", name="Exportar CSV", exact=True).click()
        download = download_info.value
        target = OUTPUT / download.suggested_filename
        download.save_as(str(target))
        rows = list(csv.reader(io.StringIO(target.read_text(encoding="utf-8-sig")), delimiter=";"))
        assert rows[0] == ["Data", "Entregador", "Pedido", "Início", "Fim", "Quilômetros simulados", "Status"], rows[0]
        assert len(rows) == 3, rows
        assert all(row[1] == "Rafael Costa" for row in rows[1:]), rows
        assert sum(float(row[5].replace(",", ".")) for row in rows[1:]) == 7.5, rows
        initial = page.get_by_label("Data inicial", exact=True).input_value()
        page.get_by_label("Data inicial", exact=True).fill("2099-12-31")
        expect(page.get_by_role("alert")).to_have_text("A data inicial deve ser anterior ou igual à data final.")
        expect(page.get_by_role("button", name="Exportar CSV", exact=True)).to_be_disabled()
        page.get_by_label("Data inicial", exact=True).fill(initial)
        page.get_by_role("combobox", name="Entregador", exact=True).select_option("all")
        return {"download": str(target), "rows": len(rows) - 1, "kmRafael": 7.5, "invalidDateRejected": True}

    record("admin: relatório filtrado e download CSV", reports)
    admin_tab(page, "Entregas")


def smoke_driver(context, admin):
    page = context.new_page()
    observe(page)
    page.set_viewport_size({"width": 390, "height": 844})
    page.goto(f"{BASE_URL}?tela=entregador" if PORTABLE else f"{BASE_URL}/entregador")
    expect(page.get_by_role("heading", name="Minha rota", exact=True)).to_be_visible()
    expect(page.get_by_role("button", name="Iniciar rota", exact=True)).to_be_enabled()
    page.evaluate("document.fonts.ready")
    page.screenshot(path=str(OUTPUT / "entregador.png"), full_page=True)

    def start_route():
        page.get_by_role("button", name="Iniciar rota", exact=True).click()
        expect(page.get_by_role("heading", name="Navegação", exact=True)).to_be_visible()
        wait_state(page, "s.deliveries.find(d => d.id === 'e1').status === 'in_transit'")
        expect(page.get_by_role("button", name="Encerrar", exact=True)).to_be_disabled()
        dismiss_notice(page)
        page.screenshot(path=str(OUTPUT / "navegacao.png"), full_page=True)
        return "Rafael iniciou e1; turno bloqueado durante rota."

    record("driver: iniciar rota Rafael/e1", start_route)

    def advance_route():
        for progress in [0.25, 0.5, 0.75, 1]:
            page.get_by_role("button", name="Avançar simulação", exact=True).click()
            wait_state(page, f"s.trips.find(t => t.deliveryId === 'e1' && !t.finishedAt).progress === {progress}")
            expect(page.get_by_role("progressbar", name="Progresso do percurso simulado")).to_have_attribute("value", str(progress))
        expect(page.get_by_role("button", name="Confirmar entrega", exact=True)).to_be_visible()
        current = state(page)
        trip = next(trip for trip in current["trips"] if trip["deliveryId"] == "e1")
        assert trip["km"] == 3.8, trip
        return "Quatro avanços até 100%; percurso registra 3,8 km."

    record("driver: avançar percurso e quilômetros", advance_route)

    def confirm_delivery():
        page.get_by_role("button", name="Confirmar entrega", exact=True).click()
        dialog = page.get_by_role("dialog", name="Confirmar entrega")
        expect(dialog.get_by_role("button", name="Confirmar entrega", exact=True)).to_be_disabled()
        dialog.get_by_label("Nome de quem recebeu", exact=True).fill("Recebedor Smoke QA")
        dialog.get_by_role("button", name="Confirmar entrega", exact=True).click()
        expect(dialog).not_to_be_visible()
        wait_state(page, "s.deliveries.find(d => d.id === 'e1').status === 'delivered' && s.deliveries.find(d => d.id === 'e1').receivedBy === 'Recebedor Smoke QA'")
        current = state(page)
        rafael = next(driver for driver in current["drivers"] if driver["id"] == "d1")
        assert rafael["status"] == "available", rafael
        assert rafael["kmToday"] == 11.3, rafael
        return "Recebedor obrigatório; entrega concluída, Rafael disponível, total 11,3 km."

    record("driver: confirmação e total de quilômetros", confirm_delivery)

    def admin_sync():
        admin_tab(admin, "Entregas")
        row = admin.get_by_role("row").filter(has=admin.get_by_text("RT-1041", exact=True))
        expect(row.get_by_text("Entregue", exact=True)).to_be_visible()
        admin.get_by_role("button", name="Ver detalhes do pedido RT-1041", exact=True).click()
        dialog = admin.get_by_role("dialog", name="Pedido RT-1041", exact=True)
        expect(dialog.get_by_text("Recebedor Smoke QA", exact=True)).to_be_visible()
        dialog.get_by_role("button", name="Concluir", exact=True).click()
        admin.reload()
        admin_tab(admin, "Entregas")
        row = admin.get_by_role("row").filter(has=admin.get_by_text("RT-1041", exact=True))
        expect(row.get_by_text("Entregue", exact=True)).to_be_visible()
        return "Outra aba do mesmo navegador atualiza e1 automaticamente; painel mantém entrega após recarregar."

    record("integração local: atualização no painel e persistência", admin_sync)

    def history_and_persistence():
        driver_tab(page, "Entregas")
        page.get_by_role("button", name=re.compile("^Concluídas")).click()
        expect(page.get_by_text("Recebido por Recebedor Smoke QA", exact=True)).to_be_visible()
        driver_tab(page, "Histórico")
        expect(page.get_by_role("heading", name="Meu histórico", exact=True)).to_be_visible()
        expect(page.locator(".driver-history-list").get_by_text("Mariana Oliveira", exact=True)).to_be_visible()
        page.reload()
        expect(page.get_by_role("heading", name="Minha rota", exact=True)).to_be_visible()
        wait_state(page, "s.deliveries.find(d => d.id === 'e1').status === 'delivered'")
        return "Entrega e recebedor aparecem nas concluídas/histórico e persistem após recarregar."

    record("driver: histórico e persistência", history_and_persistence)

    def switch_profile():
        driver_tab(page, "Perfil")
        expect(page.get_by_role("heading", name="Rafael Costa", exact=True)).to_be_visible()
        choose_driver(page, "Camila Santos")
        expect(page.get_by_role("button", name="Trocar entregador. Perfil atual: Camila Santos", exact=True)).to_be_visible()
        expect(page.get_by_role("heading", name="Navegação", exact=True)).to_be_visible()
        page.reload()
        expect(page.get_by_role("button", name="Trocar entregador. Perfil atual: Camila Santos", exact=True)).to_be_visible()
        choose_driver(page, "Rafael Costa")
        return "Troca para Camila mantém sua rota e perfil após recarregar; volta para Rafael."

    record("driver: seleção de perfis", switch_profile)
    return page


def responsiveness(admin, driver):
    details = []
    failures = []
    for width in [320, 390, 768]:
        driver.set_viewport_size({"width": width, "height": 844})
        for tab in ["Minha rota", "Entregas", "Histórico", "Perfil"]:
            driver_tab(driver, tab)
            try:
                details.append({"screen": "driver", "tab": tab, "width": width, "sizes": no_horizontal_overflow(driver)})
            except AssertionError as error:
                failures.append({"screen": "driver", "tab": tab, "width": width, "sizes": str(error)})
        admin.set_viewport_size({"width": width, "height": 844})
        for tab in ["Visão geral", "Entregas", "Relatórios", "Usuários"]:
            admin_tab(admin, tab)
            try:
                details.append({"screen": "admin", "tab": tab, "width": width, "sizes": no_horizontal_overflow(admin)})
            except AssertionError as error:
                failures.append({"screen": "admin", "tab": tab, "width": width, "sizes": str(error)})
    assert not failures, failures
    return details


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.environ.get("CHROMIUM_EXECUTABLE", "/usr/bin/chromium"), args=["--no-sandbox"], headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 1000}, locale="pt-BR", timezone_id="America/Sao_Paulo", accept_downloads=True)
        context.set_default_timeout(10000)
        admin = context.new_page()
        observe(admin)
        try:
            admin.goto(BASE_URL)
            admin.wait_for_selector(".admin-app, .admin-shell, .admin-layout, .admin-page", timeout=15000)
            if PORTABLE:
                def portable_links():
                    with admin.expect_popup() as popup_info:
                        admin.get_by_role("link", name="App do entregador", exact=True).click()
                    popup = popup_info.value
                    observe(popup)
                    expect(popup.get_by_role("heading", name="Minha rota", exact=True)).to_be_visible()
                    assert popup.url.startswith(BASE_URL), popup.url
                    assert "tela=entregador" in popup.url, popup.url
                    popup.get_by_role("link", name="Abrir painel administrativo", exact=True).click()
                    expect(popup.get_by_role("heading", name=re.compile("Cada entrega"))).to_be_visible()
                    assert popup.url == BASE_URL, popup.url
                    popup.close()
                    return "O mesmo HTML abre painel, app em nova aba e volta ao painel sem rotas de servidor."
                record("arquivo portátil: links entre painel e entregador", portable_links)
            smoke_admin(admin)
            driver = smoke_driver(context, admin)
            record("responsividade: painel e entregador 320/390/768", lambda: responsiveness(admin, driver))
        except Exception as error:
            CHECKS.append({"name": "execução do smoke test", "status": "fail", "detail": str(error), "traceback": traceback.format_exc()})
            print(traceback.format_exc(), flush=True)
        finally:
            for page in context.pages:
                if not page.is_closed() and page.url.startswith(BASE_URL):
                    page.evaluate("localStorage.removeItem('rota.demo.state.v1'); localStorage.removeItem('rota.demo.driver');")
            report = {"checks": CHECKS, "pageErrors": ERRORS, "failedRequests": REQUEST_FAILURES, "httpFailures": HTTP_FAILURES, "restoredDemo": True}
            (OUTPUT / "ui-smoke.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
            browser.close()
    failures = [check for check in CHECKS if check["status"] == "fail"]
    print(json.dumps({"passed": len(CHECKS) - len(failures), "failed": len(failures), "pageErrors": len(ERRORS), "failedRequests": len(REQUEST_FAILURES), "httpFailures": len(HTTP_FAILURES)}, ensure_ascii=False), flush=True)
    raise SystemExit(1 if failures or ERRORS or REQUEST_FAILURES or HTTP_FAILURES else 0)


if __name__ == "__main__":
    main()
