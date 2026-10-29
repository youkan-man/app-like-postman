"""Single-row sidebar regression. Native HTTP by default; inline mode is reported."""
import json
import os
from pathlib import Path
import tempfile
from playwright.sync_api import expect, sync_playwright
from browser_app import BrowserApp
from test_proxy import proxy, start_server

CATEGORIES = ['collections', 'environments', 'history', 'relations']
LABELS = ['コレクション', '環境', '送信履歴', 'リレーション']


def main():
    server, url = start_server(proxy.Handler)
    out = Path(os.environ.get('ARTIFACT_DIR', tempfile.mkdtemp(prefix='minipost-sidebar-'))) / 'sidebar-tabs'
    out.mkdir(parents=True, exist_ok=True)
    checks, errors, screenshots = [], [], []
    fixture = BrowserApp(url)
    def passed(name):
        checks.append(name)
        print('PASS ' + name, flush=True)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM'), headless=True, args=['--no-sandbox'])
            page = browser.new_page(viewport={'width': 1440, 'height': 920})
            page.on('pageerror', lambda error: errors.append(str(error)))
            fixture.open(page)
            expect(page.locator('#connectionStatus')).to_contain_text('connected')
            page.wait_for_function('document.fonts.status === "loaded"')
            expect(page.locator('#toast')).to_be_hidden(timeout=12000)
            def tab(name):
                return page.locator(f'#sidebarTabs [data-sidebar="{name}"]')
            def settle():
                page.evaluate('() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
            def one_row():
                settle()
                rows = page.locator('#sidebarTabs [role=tab]').evaluate_all('nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,text:n.textContent,nowrap:getComputedStyle(n).whiteSpace,scroll:n.scrollWidth,client:n.clientWidth}})')
                assert [r['text'] for r in rows] == LABELS, rows
                assert max(r['y'] for r in rows)-min(r['y'] for r in rows) < 1, rows
                assert all(r['nowrap']=='nowrap' and r['scroll']<=r['client']+1 for r in rows), rows
                assert all(rows[i]['x']>=rows[i-1]['x']+rows[i-1]['width']-1 for i in range(1,4)), rows
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            def selected(name):
                expect(tab(name)).to_have_attribute('aria-selected', 'true')
                settle()
                assert page.locator('#sidebarTabs').evaluate('e=>{const r=e.getBoundingClientRect(),t=e.querySelector("[aria-selected=true]").getBoundingClientRect();return t.left>=r.left-1&&t.right<=r.left+e.clientWidth+1}'), name
            def capture(name):
                page.screenshot(path=str(out/(name+'.png')), full_page=True)
                screenshots.append(name+'.png')
            one_row()
            strip=page.locator('#sidebarTabs')
            assert strip.bounding_box()['height']<=40
            assert strip.evaluate('e=>e.scrollWidth<=e.clientWidth'), 'all four labels must fit at the default width'
            expect(strip).to_have_attribute('aria-orientation','horizontal')
            capture('desktop-single-row')
            passed('four complete labels fit in one compact row at the unchanged default pane width')
            top=page.locator('.sidebar-tools').bounding_box()['y']
            for name in CATEGORIES:
                tab(name).click();selected(name);one_row()
                expect(page.locator('#sidebarContent')).to_have_attribute('aria-labelledby','sidebarTabs-'+name)
                if name in ['environments','relations']:
                    expect(page.locator('#workspacePage')).to_be_visible()
                else:
                    expect(page.locator('#exchange')).to_be_visible()
                assert abs(page.locator('.sidebar-tools').bounding_box()['y']-top)<1
            passed('every category opens the matching page without shifting the search/list position')
            tab('collections').click()
            page.locator('#url').fill('https://example.test/kept-draft')
            expect(page.locator('#saveState')).to_have_text('ローカルに保存済み')
            before=page.evaluate('localStorage.getItem("minipost.workspace.v2")')
            for name in CATEGORIES: tab(name).click()
            assert page.evaluate('localStorage.getItem("minipost.workspace.v2")')==before
            passed('category navigation changes neither request data nor revisions')
            page.locator('#sidebarResize').focus();page.keyboard.press('Home');one_row();selected('relations')
            assert strip.evaluate('e=>e.scrollWidth>e.clientWidth&&e.scrollLeft>0')
            capture('narrow-pane-relations')
            passed('shrinking to 200px reveals the selected last tab without a second row')
            tab('relations').focus()
            for key,name in [('Home','collections'),('End','relations'),('ArrowRight','collections'),('ArrowLeft','relations')]:
                page.keyboard.press(key);selected(name);expect(tab(name)).to_be_focused()
            passed('Home/End and arrow keys focus and reveal tabs through overflow and wraparound')
            strip.hover();page.mouse.wheel(0,-180)
            page.wait_for_function('document.querySelector("#sidebarTabs").scrollLeft<1')
            strip.evaluate('e=>e.querySelectorAll("[role=tab]").forEach(t=>t.setAttribute("aria-selected",t.getAttribute("aria-selected")))')
            settle();assert strip.evaluate('e=>e.scrollLeft<1')
            expect(tab('relations')).to_have_attribute('aria-selected','true')
            passed('mouse-wheel scrolling preserves selection and survives unchanged selection attributes')
            tab('collections').click();tab('relations').evaluate('e=>e.click()');selected('relations')
            fixture.reload(page);expect(page.locator('#connectionStatus')).to_contain_text('connected')
            selected('relations');one_row();tab('collections').click()
            expect(page.locator('#url')).to_have_value('https://example.test/kept-draft')
            passed('reload restores the overflowed category and unchanged request draft')
            for width in [200,260,360,520]:
                page.evaluate('w=>document.documentElement.style.setProperty("--sidebar",w+"px")',width)
                for name in CATEGORIES:
                    tab(name).evaluate('e=>e.click()');one_row();selected(name)
            passed('200/260/360/520px sidebar widths retain one row and accessible full labels')
            page.add_style_tag(content='#sidebarTabs [role=tab] {font-size:24px!important}')
            page.evaluate('document.documentElement.style.setProperty("--sidebar","260px")')
            for name in CATEGORIES:
                tab(name).evaluate('e=>e.click()');one_row();selected(name)
            capture('enlarged-labels')
            passed('200% tab text stays in one row without truncation or font shrinking')
            page.close()
            for width in [390,320]:
                context=browser.new_context(viewport={'width':width,'height':844},has_touch=True,is_mobile=True)
                page=context.new_page();page.on('pageerror',lambda error:errors.append(str(error)))
                fixture=BrowserApp(url);fixture.open(page)
                expect(page.locator('#connectionStatus')).to_contain_text('connected')
                expect(page.locator('#toast')).to_be_hidden(timeout=12000)
                page.locator('#toggleSidebar').tap()
                for name in CATEGORIES:
                    tab(name).tap();selected(name);one_row()
                    expect(page.locator('#navigation')).to_have_attribute('aria-modal','true')
                capture('phone-'+str(width))
                page.locator('#navClose').tap();page.locator('#toggleSidebar').tap();selected('relations')
                passed(f'{width}px touch navigation stays single-row and preserves selection on reopening')
                context.close()
            assert not errors,errors
            passed('no uncaught browser JavaScript errors')
            browser.close()
    finally:
        (out/'results.json').write_text(json.dumps({'mode':'Chromium DOM fixture + Python HTTP bridge' if fixture.inline else 'native Chromium HTTP','checks':checks,'errors':errors,'screenshots':screenshots},ensure_ascii=False,indent=2))
        server.shutdown();server.server_close()


if __name__=='__main__':
    main()
