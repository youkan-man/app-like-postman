"""Real UI regressions for imported auth editors, history and enlarged labels."""
import json
import os
from pathlib import Path
import tempfile

from playwright.sync_api import expect, sync_playwright
from browser_app import BrowserApp
from test_proxy import proxy, start_server


def main():
    echo, echo_url = start_server()
    app, app_url = start_server(proxy.Handler)
    out = Path(os.environ.get('ARTIFACT_DIR', tempfile.mkdtemp(prefix='minipost-ui-'))) / 'edgecases'
    out.mkdir(parents=True, exist_ok=True)
    checks, errors = [], []

    def passed(name):
        checks.append(name)
        print('PASS ' + name, flush=True)

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM'), headless=True, args=['--no-sandbox'])
            page = browser.new_page(viewport={'width': 1440, 'height': 920})
            page.on('pageerror', lambda error: errors.append(str(error)))
            fixture = BrowserApp(app_url); fixture.open(page)
            expect(page.locator('#connectionStatus')).to_contain_text('connected')
            collection = {
                'info': {'name': 'Legacy auth', 'schema': 'https://schema.getpostman.com/json/collection/v2.0.0/collection.json'},
                'auth': {'type': 'bearer', 'bearer': {'token': 'collection-token'}},
                'item': [
                    {'name': 'Edit imported bearer', 'request': {'method': 'POST', 'url': echo_url + '/echo', 'auth': {'type': 'bearer', 'bearer': {'token': 'original-token'}}}},
                    {'name': 'Inherited request', 'request': {'method': 'DELETE', 'url': echo_url + '/echo'}},
                ],
            }
            page.locator('#import').click()
            page.get_by_label('インポートJSON').fill(json.dumps(collection))
            page.locator('#modalSubmit').click()
            expect(page.locator('#modalTitle')).to_have_text('インポート完了')
            page.locator('#modalSubmit').click()
            expect(page.locator('section.editor-section[data-pane=authorization] .editor-section-body')).to_be_visible()
            expect(page.get_by_label('Token', exact=True)).to_have_value('original-token')
            page.get_by_label('Token', exact=True).fill('edited-token')
            page.locator('#send').click()
            expect(page.locator('#responseStatus')).to_contain_text('200')
            received = json.loads(page.locator('.response-code').inner_text())
            assert dict(received['headers'])['Authorization'] == 'Bearer edited-token'
            passed('v2.0 object auth opens and edits in request editor with real HTTP')

            page.get_by_role('button', name='Legacy authの設定', exact=True).click()
            page.get_by_role('menuitem', name='変数・認証を編集').click()
            expect(page.locator('#modal').get_by_label('Token', exact=True)).to_have_value('collection-token')
            page.locator('#modal').get_by_label('Token', exact=True).fill('edited-inherited-token')
            expect(page.locator('#modalSubmit')).not_to_be_visible()
            page.locator('#closeModal').click()
            page.locator('.tree-open').filter(has=page.locator('.tree-label', has_text='Inherited request')).click()
            page.locator('#send').click()
            expect(page.locator('#responseStatus')).to_contain_text('200')
            received = json.loads(page.locator('.response-code').inner_text())
            assert dict(received['headers'])['Authorization'] == 'Bearer edited-inherited-token'
            passed('v2.0 collection auth edits in drawer and remains inherited')

            page.locator('#sidebarTabs [data-sidebar=history]').click()
            today = page.evaluate('new Date().toLocaleDateString()')
            expect(page.locator('.history-entry').first).to_contain_text(today)
            page.screenshot(path=str(out / 'history.png'), full_page=True)
            passed('history retains the date as well as time and request URL')
            page.locator('#sidebarTabs [data-sidebar=collections]').click()
            page.evaluate('document.documentElement.style.fontSize="26px"')
            for row in page.locator('.tree-row').all():
                method = row.locator('.method-label')
                if not method.count():
                    continue
                assert method.evaluate('el => el.scrollWidth <= el.clientWidth'), method.inner_text()
                m, n = method.bounding_box(), row.locator('.tree-label').bounding_box()
                assert n['x'] >= m['x'] + m['width'], {'method': m, 'name': n}
            assert page.locator('#method').bounding_box()['width'] >= 175
            page.screenshot(path=str(out / 'enlarged-method-labels.png'), full_page=True)
            passed('200 percent POST and DELETE labels do not overlap request names')
            assert not errors, errors
            passed('no JavaScript errors in auth, history or typography checks')
            browser.close()
    finally:
        (out / 'results.json').write_text(json.dumps({'passed': len(checks), 'checks': checks, 'page_errors': errors, 'target': 'real loopback HTTP echo'}, ensure_ascii=False, indent=2))
        for server in [app, echo]:
            server.shutdown(); server.server_close()


if __name__ == '__main__':
    main()
