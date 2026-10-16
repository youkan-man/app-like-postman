"""Finite category paging coexists with one selected request and flat disclosure."""
import json
import os
from pathlib import Path
import tempfile
from playwright.sync_api import sync_playwright, expect
from browser_app import BrowserApp
from test_proxy import proxy, start_server


def main():
    echo, echo_url = start_server()
    app, app_url = start_server(proxy.Handler)
    out = Path(os.environ.get('ARTIFACT_DIR', tempfile.mkdtemp())) / 'paging'
    out.mkdir(parents=True, exist_ok=True)
    checks, errors = [], []

    def passed(name):
        checks.append(name)
        print('PASS ' + name, flush=True)

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM'), headless=True, args=['--no-sandbox'])
            page = browser.new_page(viewport={'width':1440, 'height':920}, accept_downloads=True)
            page.on('pageerror', lambda e: errors.append(str(e)))
            fixture = BrowserApp(app_url); fixture.open(page)
            expect(page.locator('#connectionStatus')).to_contain_text('connected')

            def import_one(value):
                page.locator('#import').click()
                page.get_by_label('インポートJSON').fill(json.dumps(value))
                page.locator('#modalSubmit').click()
                expect(page.locator('#modalTitle')).to_have_text('インポート完了')
                page.locator('#modalSubmit').click()

            def stored():
                expect(page.locator('#saveState')).to_have_text('ローカルに保存済み')
                return page.evaluate('localStorage.getItem("minipost.workspace.v2")')

            def editor(name):
                page.locator(f'#editorTabs [data-editor={name}]').click()

            # Preserve the page preference introduced by the already merged PR10.
            page.evaluate("localStorage.setItem('minipost.editor.page.v1','headers'); localStorage.removeItem('minipost.navigation.v1')")
            fixture.reload(page)
            expect(page.locator('#editorTabs [data-editor=headers]')).to_have_attribute('aria-selected','true')
            editor('all')
            passed('existing editor-page preference migrates without losing the selected page')

            collection = {'info':{'name':'Paging API','schema':'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'}, 'item':[
                {'name':f'Request {i:02d}', 'request':{'method':'POST','url':echo_url+'/echo','body':{'mode':'raw','raw':'original','options':{'raw':{'language':'text'}}}}}
                for i in range(12)]}
            import_one(collection)
            import_one({'name':'Test environment','_postman_variable_scope':'environment','values':[{'key':'token','value':'test-only'}]})
            for i in range(12):
                page.locator('.tree-open').filter(has=page.locator('.tree-label', has_text=f'Request {i:02d}')).click()
                expect(page.locator('#requestName')).to_have_value(f'Request {i:02d}')
                expect(page.locator('#requestTabs, .request-tab')).to_have_count(0)
                expect(page.locator('#editorTabs [role=tab]')).to_have_count(7)
            passed('opening twelve requests never adds request tabs or changes the category count')

            editor('body')
            expect(page.locator('#editorContent .editor-section:not([hidden])')).to_have_count(1)
            area=page.get_by_label('Raw body')
            area.fill('kept across categories')
            stored()
            area.evaluate('el => window.__pagingInput = el')
            before=stored()
            editor('headers')
            expect(page.locator('#request-fields-body')).not_to_be_visible()
            editor('body')
            expect(area).to_have_value('kept across categories')
            assert area.evaluate('el => el === window.__pagingInput')
            editor('all')
            body=page.locator('section.editor-section[data-pane=body]')
            before_box=body.locator('.editor-section-body').bounding_box()
            body.locator('.editor-section-toggle').click()
            expect(area).not_to_be_visible()
            body.locator('.editor-section-toggle').click()
            assert body.locator('.editor-section-body').bounding_box()['x']==before_box['x']
            assert area.evaluate('el => el === window.__pagingInput')
            assert stored()==before
            expect(body).to_have_css('border-radius','0px')
            expect(body.locator('.editor-section-body')).to_have_css('padding-left','0px')
            passed('category switches and disclosure preserve the same input, flat spacing and revision state')

            # Moving to a single category must not silently expand a section
            # previously collapsed in the all-settings view.
            headers_section = page.locator('section.editor-section[data-pane=headers]')
            headers_section.locator('.editor-section-toggle').click()
            expect(headers_section.locator('.editor-section-body')).not_to_be_visible()
            sections_before = page.evaluate("localStorage.getItem('minipost.sections.v1')")
            editor('headers')
            expect(headers_section.locator('.editor-section-body')).to_be_visible()
            editor('all')
            expect(headers_section.locator('.editor-section-body')).not_to_be_visible()
            assert page.evaluate("localStorage.getItem('minipost.sections.v1')") == sections_before
            headers_section.locator('.editor-section-toggle').click()
            passed('switching individual categories preserves the all-settings collapse preference')

            page.locator('#editorTabs [data-editor=all]').focus()
            page.keyboard.press('ArrowRight')
            expect(page.locator('#editorTabs [data-editor=params]')).to_be_focused()
            page.keyboard.press('End')
            expect(page.locator('#editorTabs [data-editor=scripts]')).to_have_attribute('aria-selected','true')
            page.keyboard.press('Home')
            expect(page.locator('#editorTabs [data-editor=all]')).to_have_attribute('aria-selected','true')
            assert stored()==before
            passed('keyboard paging does not change request values or append revisions')

            page.locator('#search').fill('Request 11')
            page.locator('#sidebarTabs [data-sidebar=environments]').click()
            expect(page.locator('#globalVariables')).to_be_visible()
            expect(page.locator('#sidebarContent .tree-label', has_text='Request 11')).to_have_count(0)
            page.locator('#search').fill('Test')
            page.locator('#sidebarTabs [data-sidebar=collections]').click()
            expect(page.locator('#search')).to_have_value('Request 11')
            page.locator('#sidebarTabs [data-sidebar=environments]').click()
            expect(page.locator('#search')).to_have_value('Test')
            page.locator('#sidebarTabs [data-sidebar=collections]').click()
            page.locator('#search').fill('')
            passed('sidebar pages are independent and preserve each category search')

            page.get_by_role('button',name='Request 11の操作',exact=True).click()
            page.get_by_role('menuitem',name='送信',exact=True).click()
            expect(page.locator('#responseStatus')).to_contain_text('200')
            response_before=stored()
            page.locator('#responseTabs [data-response=headers]').click()
            expect(page.locator('.kv-readonly')).to_be_visible()
            page.locator('#responseTabs [data-response=raw]').click()
            expect(page.locator('.response-code')).to_contain_text('kept across categories')
            page.locator('#responseTabs [data-response=pretty]').click()
            expect(page.locator('#responseContent')).to_have_attribute('aria-labelledby','response-tab-pretty')
            assert stored()==response_before
            passed('response paging keeps actual response data and never resends a request')

            editor('body')
            fixture.reload(page)
            expect(page.locator('#editorTabs [data-editor=body]')).to_have_attribute('aria-selected','true')
            expect(page.get_by_label('Raw body')).to_have_value('kept across categories')
            editor('all')
            page.screenshot(path=str(out/'paging-desktop-all.png'),full_page=True)
            editor('body')
            page.locator('#send').click()
            expect(page.locator('#responseStatus')).to_contain_text('200')
            page.screenshot(path=str(out/'paging-desktop-body.png'),full_page=True)
            passed('page choice and autosaved content survive reload')

            for width in (768,390):
                page.set_viewport_size({'width':width,'height':920 if width==768 else 844})
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                for root in ('editorTabs','responseTabs'):
                    for tab in page.locator(f'#{root} button').all():
                        tab.scroll_into_view_if_needed()
                        b=tab.bounding_box()
                        assert b and b['x']>=0 and b['x']+b['width']<=width+1, (root,b)
                editor('headers')
                editor('body')
                expect(page.get_by_label('Raw body')).to_have_value('kept across categories')
                page.locator('#responseTabs [aria-selected=true]').scroll_into_view_if_needed()
                page.screenshot(path=str(out/f'paging-{width}.png'),full_page=True)
            passed('tablet and phone retain usable category controls without horizontal page overflow')
            assert not errors,errors
            passed('no uncaught browser errors')
            browser.close()
    finally:
        (out/'results.json').write_text(json.dumps({'passed':len(checks),'checks':checks,'page_errors':errors},ensure_ascii=False,indent=2))
        for server in (app,echo):
            server.shutdown();server.server_close()


if __name__ == '__main__':
    main()
