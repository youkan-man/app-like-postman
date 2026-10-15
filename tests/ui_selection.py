"""Real browser regression for single selection, stable rows and per-setting revisions."""
import json
import os
from pathlib import Path
import tempfile
from playwright.sync_api import sync_playwright, expect
from test_proxy import proxy, start_server

KEY = 'minipost.workspace.v2'


def main():
    echo, echo_url = start_server()
    app, app_url = start_server(proxy.Handler)
    out = Path(os.environ.get('ARTIFACT_DIR', tempfile.mkdtemp())) / 'selection'
    out.mkdir(parents=True, exist_ok=True)
    checks, errors = [], []

    def passed(name):
        checks.append(name)
        print('PASS ' + name, flush=True)

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM'), headless=True)
            page = browser.new_page(viewport={'width':1440, 'height':920})
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(app_url, wait_until='domcontentloaded')
            page.evaluate("localStorage.setItem('minipost.sections.v1', '[]')")
            page.reload(wait_until='domcontentloaded')
            expect(page.locator('#editorContent details, #editorContent summary')).to_have_count(0)
            for name in ['params', 'headers', 'authorization', 'body', 'settings', 'scripts']:
                expect(page.locator(f'section.editor-section[data-pane={name}] .editor-section-body')).to_be_visible()
            expect(page.locator('#connectionStatus')).to_contain_text('connected')

            def saved():
                expect(page.locator('#saveState')).to_have_text('ローカルに保存済み')

            def state():
                saved()
                return page.evaluate('(k)=>JSON.parse(localStorage.getItem(k))', KEY)

            def load(value):
                page.locator('#import').click()
                page.get_by_label('インポートJSON').fill(json.dumps(value))
                page.locator('#modalSubmit').click()
                expect(page.locator('#modalTitle')).to_have_text('インポート完了')
                page.locator('#modalSubmit').click()

            def choose(name):
                page.locator('.tree-open').filter(has=page.locator('.tree-label', has_text=name)).first.click()
                expect(page.locator('#requestName')).to_have_value(name)

            long = 'A very long request setting ' * 12
            collection = {'info':{'name':'Selection API','schema':'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'},'item':[
                {'name':long,'request':{'method':'POST','url':echo_url+'/echo','body':{'mode':'raw','raw':'before','options':{'raw':{'language':'text'}}}}},
                {'name':'Second request','request':{'method':'GET','url':echo_url+'/echo?second=1'}}]}
            load(collection)
            expect(page.locator('#requestTabs, .request-tab, #loopbackTarget, #networkDestination')).to_have_count(0)
            passed('no request-tab strip or routing selector')
            row = page.locator('.tree-row').filter(has=page.locator('.tree-label',has_text=long)).first
            choose('Second request')
            before = row.bounding_box()
            row.locator('.tree-open').click()
            after = row.bounding_box()
            assert abs(before['height']-after['height']) < .5 and abs(before['y']-after['y']) < .5
            # Selection replaces the list nodes. Focus the current trigger for a
            # keyboard context-menu test, rather than sending F10 to document.body.
            row.locator('.tree-open').focus()
            expect(row.locator('.tree-open')).to_be_focused()
            page.keyboard.press('Shift+F10')
            expect(page.locator('#itemMenu')).to_be_visible()
            page.keyboard.press('Escape')
            assert abs(before['height']-row.bounding_box()['height']) < .5
            passed('long labels keep row height and position on select, focus and context menu')
            expect(page.locator('section.editor-section[data-pane=body] .editor-section-body')).to_be_visible()
            page.get_by_label('Raw body').fill('after-one')
            saved()
            first = state()
            draft = next(t for t in first['tabs'] if t['id'] == first['activeId'])
            key = 'request:' + draft['collectionId'] + ':' + draft['itemId']
            assert first['revisions'][key][-1]['value']['request']['body']['raw'] == 'after-one'
            choose('Second request')
            choose(long)
            expect(page.get_by_label('Raw body')).to_have_value('after-one')
            count = len(state()['revisions'][key])
            choose('Second request')
            choose(long)
            assert len(state()['revisions'][key]) == count
            passed('switching selection retains each draft; selection alone does not add revisions')
            page.get_by_label('Raw body').fill('after-two')
            saved()
            page.locator('#requestHistory').click()
            history = page.locator('.revision-panel')
            expect(history).to_have_attribute('data-revision-key', key)
            expect(history).to_contain_text(long)
            entries = history.locator('.revision-entry')
            assert entries.count() >= 3
            entry = entries.nth(1)
            entry.locator('summary').click()
            before_send = len(state()['history'])
            page.once('dialog', lambda d:d.accept())
            entry.get_by_role('button',name='この版を復元').click()
            saved()
            assert len(state()['history']) == before_send
            assert state()['revisions'][key][-1]['reason'] == '復元'
            page.locator('#closeModal').click()
            expect(page.get_by_label('Raw body')).to_have_value('after-one')
            passed('per-request history can restore a previous version without sending')
            page.locator('#send').click()
            expect(page.locator('#responseStatus')).to_contain_text('200')
            received = json.loads(page.locator('.response-code').inner_text())
            assert received['body'] == 'after-one'
            passed('restored request body reaches the real HTTP server on explicit Send')
            page.locator('#requestHistory').click()
            page.locator('.revision-entry').first.locator('summary').click()
            page.screenshot(path=str(out/'request-history.png'), full_page=True)
            page.locator('#closeModal').click()
            env = {'name':'Dev','_postman_variable_scope':'environment','values':[{'key':'x','value':'1','enabled':True}]}
            load(env)
            page.locator('details.sidebar-group[data-group=environments]').evaluate('el => el.open = true')
            page.get_by_role('button',name='◫  Dev',exact=True).click()
            modal = page.locator('#modal')
            env_id = modal.get_attribute('data-settings-id')
            before = state()['revisions'].get('environment:'+env_id,[])
            page.locator('#closeModal').click()
            page.get_by_role('button',name='◫  Dev',exact=True).click()
            assert state()['revisions'].get('environment:'+env_id,[]) == before
            modal.get_by_label('Value 1',exact=True).fill('2')
            saved()
            modal.get_by_role('button',name='変更履歴',exact=True).click()
            expect(page.locator('.revision-panel')).to_have_attribute('data-revision-key','environment:'+env_id)
            assert state()['revisions'][key][-1]['value']['request']['body']['raw'] == 'after-one'
            passed('environment revisions are independent; merely reopening does not create an edit')
            page.locator('#closeModal').click()
            page.reload(wait_until='domcontentloaded')
            # Reload does not persist another edit. Read the existing record only.
            restored = page.evaluate('(k)=>JSON.parse(localStorage.getItem(k))', KEY)
            assert restored['revisions'][key][-1]['reason'] == '復元'
            page.locator('details.sidebar-group[data-group=collections]').evaluate('el => el.open = true')
            choose(long)
            expect(page.locator('section.editor-section[data-pane=body] .editor-section-body')).to_be_visible()
            expect(page.get_by_label('Raw body')).to_have_value('after-one')
            page.screenshot(path=str(out/'single-selection.png'), full_page=True)
            passed('drafts and revisions survive reload')
            page.locator('#addTab').click()
            page.locator('#requestName').fill('Unsaved work')
            page.locator('#url').fill(echo_url+'/echo?draft=1')
            saved()
            choose('Second request')
            choose('Unsaved work')
            expect(page.locator('#url')).to_have_value(echo_url+'/echo?draft=1')
            page.locator('#requestHistory').click()
            assert page.locator('.revision-entry').count() > 0
            page.locator('#closeModal').click()
            page.locator('#saveRequest').click()
            page.locator('#modalSubmit').click()
            saved()
            current = state()
            active = next(t for t in current['tabs'] if t['id'] == current['activeId'])
            newkey = 'request:'+active['collectionId']+':'+active['itemId']
            assert current['revisions'][newkey]
            assert 'draft:'+active['id'] not in current['revisions']
            passed('unsaved work stays in the list and its history follows the first collection save')
            expect(page.locator('section.editor-section[data-pane=settings] .editor-section-body')).to_be_visible()
            page.get_by_label('TLS証明書を検証する', exact=True).check()
            page.get_by_label('リダイレクトを追従する', exact=True).uncheck()
            page.get_by_label('Timeout ms', exact=True).fill('12500')
            saved()
            current = next(t for t in state()['tabs'] if t['id'] == state()['activeId'])
            assert current['settings'] == {'verify_tls':True,'follow_redirects':False,'timeout_ms':12500}
            passed('consecutive TLS redirect and timeout edits all persist')
            page.set_viewport_size({'width':390,'height':844})
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            expect(page.locator('#send')).to_be_visible()
            page.locator('#requestHistory').click()
            expect(page.locator('#modal')).to_have_attribute('aria-modal','true')
            page.screenshot(path=str(out/'mobile-history.png'), full_page=True)
            passed('phone layout keeps single editor and history accessible')
            assert not errors, errors
            passed('no uncaught JavaScript errors')
            browser.close()
    finally:
        (out/'results.json').write_text(json.dumps({'passed':len(checks),'checks':checks,'page_errors':errors,'target':'real HTTP'},ensure_ascii=False,indent=2))
        for server in (app,echo):
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    main()
