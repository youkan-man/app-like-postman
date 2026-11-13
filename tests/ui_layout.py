"""Native HTTP layout regressions for constrained panes and long request data.

The assertions measure readable controls and the space users can actually see.
They intentionally do not reproduce CSS breakpoints, pixel minima or split ratios.
"""
from __future__ import annotations

from contextlib import contextmanager
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import tempfile
from threading import Thread

from playwright.sync_api import expect, sync_playwright
from test_proxy import EchoHandler, proxy, start_server


RECT_HELPERS = r"""
const rect = element => {
  const r = element.getBoundingClientRect();
  return {x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom};
};
const lineHeight = element => {
  const s = getComputedStyle(element);
  return parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.4;
};
const visible = element => {
  let r = {x:0, y:0, right:innerWidth, bottom:innerHeight};
  for (let parent=element; parent; parent=parent.parentElement) {
    const b=rect(parent), s=getComputedStyle(parent);
    if (parent===element || /(hidden|auto|scroll|clip)/.test(s.overflowX)) {
      r.x=Math.max(r.x,b.x); r.right=Math.min(r.right,b.right);
    }
    if (parent===element || /(hidden|auto|scroll|clip)/.test(s.overflowY)) {
      r.y=Math.max(r.y,b.y); r.bottom=Math.min(r.bottom,b.bottom);
    }
  }
  return {...r,width:Math.max(0,r.right-r.x),height:Math.max(0,r.bottom-r.y)};
};
"""


def inside(inner, outer, tolerance=1.5):
    return (inner['x'] >= outer['x']-tolerance and inner['y'] >= outer['y']-tolerance
            and inner['right'] <= outer['right']+tolerance and inner['bottom'] <= outer['bottom']+tolerance)


def overlap(a, b):
    return min(a['right'], b['right'])-max(a['x'], b['x']) > 1 and min(a['bottom'], b['bottom'])-max(a['y'], b['y']) > 1


def workspace_fixture(target):
    body = json.dumps({'lines': [f'Editable request line {number:03d}' for number in range(80)]}, indent=2)
    request = {'method': 'POST', 'url': target+'/echo', 'header': [],
               'body': {'mode': 'raw', 'raw': body, 'options': {'raw': {'language': 'json'}}},
               '_minipost': {'enabled': False, 'timeoutMs': 3000,
                            'before': '\n'.join(f'// Editable script line {number:03d}' for number in range(80)),
                            'after': '', 'extractions': []}}
    settings = {'verify_tls': False, 'follow_redirects': True, 'timeout_ms': 30000}
    long_name = '長い送信履歴 / ' + '接続確認のリクエスト名-'*18
    long_url = target+'/echo?description='+'long-path-with-many-query-characters-'*50
    history = []
    for identifier, name, url in [('short', 'Short history', target+'/echo'), ('long', long_name, long_url)]:
        history.append({'id': 'layout-history-'+identifier, 'at': '2026-01-01T12:34:56Z', 'status': 200,
                        'sent_requests': [{'method': 'POST', 'url': url, 'headers': [], 'body_mode': 'none', 'transmission': 'sent'}],
                        'tab': {'id': 'sent-'+identifier, 'name': name, 'request': {**request, 'url': url},
                                'settings': settings, 'dirty': False}})
    draft = {'id': 'layout-draft', 'name': '未登録の長いリクエスト名 / '+'request-name-'*12,
             'request': request, 'settings': settings, 'dirty': True,
             'collectionId': 'layout-collection', 'pendingFolderId': 'layout-folder'}
    collection = {'_mpId': 'layout-collection', 'info': {'name': 'Collection context with a long name'},
                  'item': [{'_mpId': 'layout-folder', 'name': 'Nested folder context', 'item': []}]}
    workspace = {'version': 2, 'collections': [collection], 'environments': [], 'globals': [], 'tabs': [draft],
                 'activeId': draft['id'], 'environmentId': '', 'history': history,
                 'collapsed': [], 'theme': 'light', 'revisions': {}, 'relations': [], 'relationRuns': []}
    return workspace, long_name, long_url


def main():
    if os.environ.get('MINIPOST_INLINE_TEST') == '1':
        raise RuntimeError('ui_layout requires native Chromium and a real HTTP origin')
    app_url, app = os.environ.get('MINIPOST_REMOTE_URL'), None
    if app_url:
        peer = os.environ['LOCAL_RELAY_VM_BROWSER_IP']
        port = int(os.environ.get('LOCAL_RELAY_VM_BROWSER_PORT') or '18081')
        receiver = ThreadingHTTPServer(('0.0.0.0', port), EchoHandler)
        Thread(target=receiver.serve_forever, daemon=True).start()
        target = f'http://{peer}:{port}'
    else:
        receiver, target = start_server()
        app, app_url = start_server(proxy.Handler)
    out = Path(os.environ.get('ARTIFACT_DIR', tempfile.mkdtemp(prefix='minipost-layout-'))) / 'layout'
    out.mkdir(parents=True, exist_ok=True)
    checks, errors, dialogs, crashes, screenshots, measurements = [], [], [], [], [], []
    page, failure, current_case, completed = None, None, 'initialization', False

    def passed(name):
        checks.append(name)
        print('PASS '+name, flush=True)

    @contextmanager
    def capture_failure():
        nonlocal failure
        try:
            yield
        except Exception as error:
            failure = {'case': current_case, 'error': str(error)}
            try:
                if page and not page.is_closed():
                    page.screenshot(path=str(out/'failure.png'), full_page=True)
                    screenshots.append('failure.png')
            except Exception as shot_error:
                print('Could not capture failure screenshot: '+str(shot_error), flush=True)
            raise

    try:
        with sync_playwright() as playwright, capture_failure():
            browser = playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM') or shutil.which('chromium'),
                                                 headless=True, args=['--no-sandbox'])
            page = browser.new_page(viewport={'width': 1440, 'height': 920})
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('dialog', lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))
            page.on('crash', lambda: crashes.append('page crashed'))

            def settle():
                page.evaluate('''async () => {
                    await document.fonts.ready;
                    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                }''')

            def capture(name):
                settle()
                page.screenshot(path=str(out/(name+'.png')), full_page=True)
                screenshots.append(name+'.png')

            def ready():
                expect(page.locator('#connectionStatus')).to_contain_text('connected')
                expect(page.locator('#requestName')).to_be_visible()
                expect(page.locator('#saveState')).not_to_have_text('ローカルデータを読込中…')

            def controls(container, selector):
                data = page.evaluate('''({container,selector}) => {'''+RECT_HELPERS+r'''
                  const root=document.querySelector(container);
                  const items=[...root.querySelectorAll(selector)].filter(e => {
                    const r=rect(e),s=getComputedStyle(e);
                    return r.width>0 && r.height>0 && s.visibility!=='hidden' && s.display!=='none';
                  }).map(e => {
                    const r=rect(e), top=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
                    return {id:e.id||e.getAttribute('aria-label')||e.textContent.trim(),rect:r,
                      reachable:top===e||e.contains(top)};
                  });
                  return {container:rect(root),items,viewport:{x:0,y:0,right:innerWidth,bottom:innerHeight}};
                }''', {'container': container, 'selector': selector})
                assert data['items'], (current_case, container, data)
                for item in data['items']:
                    assert inside(item['rect'], data['container']), (current_case, 'control outside container', container, item, data)
                    assert inside(item['rect'], data['viewport']), (current_case, 'control outside viewport', item, data)
                    assert item['reachable'], (current_case, 'control obscured at its center', item, data)
                for index, item in enumerate(data['items']):
                    for other in data['items'][index+1:]:
                        assert not overlap(item['rect'], other['rect']), (current_case, 'overlapping controls', item, other)
                return data

            def request_header():
                settle()
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1'), current_case
                controls('.topbar', 'button,select')
                controls('.request-title', 'input,button,#requestDirty,#breadcrumb')
                controls('.urlbar', 'input,select,button')
                label = page.locator('#saveRequest').evaluate('''e => {'''+RECT_HELPERS+r'''
                  const s=getComputedStyle(e), range=document.createRange(); range.selectNodeContents(e);
                  const lines=[...range.getClientRects()].filter(r=>r.width&&r.height);
                  return {rect:rect(e),line:lineHeight(e),textHeight:lines.length?Math.max(...lines.map(r=>r.bottom))-Math.min(...lines.map(r=>r.top)):0,
                    clientWidth:e.clientWidth,scrollWidth:e.scrollWidth};
                }''')
                assert 0 < label['textHeight'] <= label['line']*2+2, (current_case, 'registration label is a vertical column', label)
                assert label['scrollWidth'] <= label['clientWidth']+1, (current_case, 'registration label clipped', label)
                name = page.locator('#requestName').evaluate('e => ({width:e.clientWidth,font:parseFloat(getComputedStyle(e).fontSize)})')
                assert name['width'] >= name['font']*4, (current_case, 'request name cannot show a useful prefix', name)

            def geometry(editor):
                data = page.evaluate('''label => {'''+RECT_HELPERS+r'''
                  const input=document.querySelector(`textarea[aria-label="${label}"]`);
                  const content=document.querySelector('#responseContent'), code=content.querySelector('.response-code');
                  const inputStyle=getComputedStyle(input), contentStyle=getComputedStyle(content);
                  const result={viewport:{x:0,y:0,right:innerWidth,bottom:innerHeight},layout:document.documentElement.dataset.layout};
                  for(const [name,selector] of Object.entries({main:'.main',exchange:'#exchange',request:'.request-editor',separator:'#responseResize',response:'.response-panel',footer:'.statusbar',responseContent:'#responseContent'}))result[name]=rect(document.querySelector(selector));
                  const main=document.querySelector('.main');
                  return {...result,mainScroll:main.scrollHeight-main.clientHeight,pageScroll:document.documentElement.scrollWidth-innerWidth,
                    editor:{rect:rect(input),visible:visible(input),clientHeight:input.clientHeight,scrollHeight:input.scrollHeight,
                      minimum:lineHeight(input)+parseFloat(inputStyle.paddingTop)+parseFloat(inputStyle.paddingBottom)},
                    responseText:{visible:visible(content),minimum:lineHeight(code||content)+parseFloat(contentStyle.paddingTop)+parseFloat(contentStyle.paddingBottom)}};
                }''', 'Raw body' if editor == 'body' else '送信前スクリプト')
                measurements.append({'case': current_case, 'geometry': data})
                assert data['mainScroll'] <= 1, (current_case, 'whole workbench scrolls outside viewport', data)
                assert data['pageScroll'] <= 1, (current_case, 'horizontal page overflow', data)
                for name in ['exchange', 'request', 'response', 'footer']:
                    assert inside(data[name], data['viewport']), (current_case, name+' outside viewport', data)
                assert abs(data['exchange']['bottom']-data['footer']['y']) <= 2, (current_case, 'unused space before footer', data)
                assert abs(data['response']['bottom']-data['exchange']['bottom']) <= 2, (current_case, 'response leaves unused space', data)
                if data['layout'] == 'stack':
                    assert abs(data['request']['bottom']-data['separator']['y']) <= 2, (current_case, 'gap before split', data)
                    assert abs(data['separator']['bottom']-data['response']['y']) <= 2, (current_case, 'gap after split', data)
                else:
                    assert abs(data['request']['right']-data['separator']['x']) <= 2, (current_case, 'gap before side split', data)
                    assert abs(data['separator']['right']-data['response']['x']) <= 2, (current_case, 'gap after side split', data)
                assert data['editor']['visible']['height'] >= data['editor']['minimum']-1, (current_case, 'no editable line visible', data)
                assert data['editor']['visible']['width'] > 0, (current_case, 'editor has no visible width', data)
                assert data['responseText']['visible']['height'] >= data['responseText']['minimum']-1, (current_case, 'no response line visible', data)
                return data

            def split_drag(fraction):
                handle, exchange = page.locator('#responseResize').bounding_box(), page.locator('#exchange').bounding_box()
                page.mouse.move(handle['x']+handle['width']/2, handle['y']+handle['height']/2)
                page.mouse.down()
                if page.locator('html').get_attribute('data-layout') == 'side':
                    page.mouse.move(exchange['x']+exchange['width']*fraction, handle['y']+handle['height']/2, steps=6)
                else:
                    page.mouse.move(handle['x']+handle['width']/2, exchange['y']+exchange['height']*fraction, steps=6)
                page.mouse.up()
                settle()

            page.goto(app_url, wait_until='domcontentloaded')
            ready()
            page.locator('#requestName').fill('新規未登録リクエスト / '+'long-name-'*15)
            page.locator('#url').fill(target+'/echo?name='+'long-url-'*60)
            for width, height in [(320, 720), (390, 844)]:
                current_case = f'new-request-{width}'
                page.set_viewport_size({'width': width, 'height': height})
                request_header()
                page.locator('#saveRequest').click()
                expect(page.locator('#modal')).to_be_visible()
                controls('#modal', 'button,input,select')
                capture(current_case+'-registration')
                page.locator('#cancelModal').click()
                expect(page.locator('#modal')).not_to_be_visible()
                capture(current_case)
                passed(f'new unregistered request and registration dialog remain readable and operable at {width}px')

            current_case = 'workspace-fixture'
            page.set_viewport_size({'width': 1440, 'height': 920})
            workspace, long_name, long_url = workspace_fixture(target)
            page.locator('#import').click()
            bundle = {'kind': 'minipost.workspace', 'version': 1, 'workspace': workspace,
                      'layout': {'navigation': {'editor': 'body', 'sidebar': 'collections', 'response': 'pretty'}}}
            page.get_by_label('インポートJSON', exact=True).fill(json.dumps(bundle, ensure_ascii=False))
            page.locator('#modalSubmit').click()
            expect(page.locator('#modalTitle')).to_contain_text('全体バックアップ')
            with page.expect_navigation(wait_until='domcontentloaded'):
                page.locator('#modalSubmit').click()
            ready()
            expect(page.locator('#toast')).to_be_hidden(timeout=12000)

            for editor in ['body', 'scripts']:
                for width, height in [(1366, 768), (1440, 920), (320, 720), (390, 844)]:
                    current_case = f'{editor}-sent-{width}x{height}'
                    page.set_viewport_size({'width': width, 'height': height})
                    page.locator(f'#editor-tab-{editor}').click()
                    expect(page.locator('html')).to_have_attribute('data-layout', 'stack')
                    page.locator('#send').click()
                    expect(page.locator('#responseStatus')).to_contain_text('200', timeout=15000)
                    expect(page.locator('#send')).to_contain_text('Send')
                    settle()
                    request_header()
                    geometry(editor)
                    capture(current_case)
                    passed(f'{editor} after a real send fills the workbench and exposes both panes at {width}x{height}')

                current_case = editor+'-split-resize'
                page.set_viewport_size({'width': 1440, 'height': 920})
                separator = page.locator('#responseResize')
                separator.press('Home')
                settle()
                small = geometry(editor)
                separator.press('End')
                settle()
                large = geometry(editor)
                assert large['request']['height'] > small['request']['height']+1, (current_case, 'keyboard split did not move', small, large)
                assert large['editor']['rect']['height'] > small['editor']['rect']['height']+1, (current_case, 'editor did not grow with pane', small, large)
                split_drag(.5)
                middle = geometry(editor)
                assert small['request']['height']-1 <= middle['request']['height'] < large['request']['height']-1, (current_case, 'pointer split did not move', small, middle, large)
                page.set_viewport_size({'width': 1440, 'height': 768})
                settle()
                shorter = geometry(editor)
                assert shorter['exchange']['height'] < middle['exchange']['height']-1, (current_case, 'viewport height ignored', middle, shorter)
                page.set_viewport_size({'width': 1440, 'height': 920})
                settle()
                restored = geometry(editor)
                assert abs(restored['exchange']['height']-middle['exchange']['height']) <= 2, (current_case, 'height resize did not restore', middle, restored)
                area = page.get_by_label('Raw body' if editor == 'body' else '送信前スクリプト', exact=True)
                area.press('Control+End')
                scroll = area.evaluate('''e => ({top:e.scrollTop,client:e.clientHeight,height:e.scrollHeight,
                    atEnd:e.selectionEnd===e.value.length,line:parseFloat(getComputedStyle(e).lineHeight),
                    padding:parseFloat(getComputedStyle(e).paddingBottom)})''')
                assert scroll['atEnd'] and scroll['top'] > 0, (current_case, 'editor end is unreachable', scroll)
                assert scroll['height']-scroll['top']-scroll['client'] <= scroll['padding']+scroll['line'], (current_case, 'last editor line remains below view', scroll)
                geometry(editor)
                area.press('Control+Home')
                capture(current_case)
                passed(f'{editor} split keyboard, pointer and viewport resizing move actual panels while preserving readable content')

            current_case = 'running-script-header'
            page.locator('#editor-tab-scripts').click()
            script = page.get_by_label('送信前スクリプト', exact=True)
            timeout = page.get_by_label('スクリプト制限時間', exact=True)
            original_script, original_timeout = script.input_value(), timeout.input_value()
            script.fill('await new Promise(() => {});')
            timeout.fill('0')
            run_script = page.locator('#script-panel-before').get_by_role('button', name='このスクリプトを実行', exact=True)
            run_script.click()
            expect(page.locator('#stopRelationGlobal')).to_be_visible()
            expect(run_script).to_be_disabled()
            for width, height in [(320, 720), (390, 844), (768, 1024)]:
                current_case = f'running-script-header-{width}'
                page.set_viewport_size({'width': width, 'height': height})
                settle()
                expect(page.locator('#stopRelationGlobal')).to_be_visible()
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1'), current_case
                controls('.topbar', 'button,select')
                capture(current_case)
            page.locator('#stopRelationGlobal').click()
            expect(page.locator('#stopRelationGlobal')).to_be_hidden()
            expect(run_script).to_be_enabled()
            script.fill(original_script)
            timeout.fill(original_timeout)
            expect(script).to_have_value(original_script)
            expect(timeout).to_have_value(original_timeout)
            expect(page.locator('#toast')).to_be_hidden(timeout=12000)
            passed('running manual script keeps every header action reachable without overlap at 320, 390 and 768px, and stops normally')

            current_case = 'side-title-context-1280'
            page.set_viewport_size({'width': 1280, 'height': 920})
            page.locator('#editor-tab-body').click()
            page.locator('#layoutToggle').click()
            expect(page.locator('html')).to_have_attribute('data-layout', 'side')
            expect(page.locator('#breadcrumb')).to_be_visible()
            expect(page.locator('#requestDirty')).not_to_have_text('')
            request_header()
            geometry('body')
            capture(current_case)
            passed('side request title keeps a readable name beside a long breadcrumb and unsaved state near its wrapping boundary')

            current_case = 'side-narrow-request'
            page.set_viewport_size({'width': 1440, 'height': 920})
            page.locator('#responseResize').press('Home')
            settle()
            request_header()
            narrow_request = geometry('body')
            assert narrow_request['request']['width'] < narrow_request['response']['width'], (current_case, narrow_request)
            capture(current_case)
            passed('narrow desktop request pane preserves the complete registration label and URL controls')

            current_case = 'side-narrow-response'
            page.locator('#responseResize').press('End')
            settle()
            narrow_response = geometry('body')
            assert narrow_response['response']['width'] < narrow_response['request']['width'], (current_case, narrow_response)
            controls('.response-heading', 'button,#responseStatus,#responseTime,#responseSize')
            controls('.response-toolbar', '#responseTabs,#responseSearch')
            for key in ['End', 'Home']:
                page.locator('#responseTabs [aria-selected=true]').press(key)
                settle()
                selected = page.locator('#responseTabs [aria-selected=true]')
                bounds = selected.evaluate('e => { '+RECT_HELPERS+' return {tab:rect(e),strip:rect(e.parentElement)}; }')
                assert inside(bounds['tab'], bounds['strip']), (current_case, 'selected response tab clipped', bounds)
            geometry('body')
            capture(current_case)
            passed('narrow desktop response pane keeps status, actions, search and keyboard-selected tabs visible without overlap')

            page.locator('#layoutToggle').click()
            expect(page.locator('html')).to_have_attribute('data-layout', 'stack')
            for width, height in [(1440, 520), (844, 390)]:
                current_case = f'short-window-{width}x{height}'
                page.set_viewport_size({'width': width, 'height': height})
                settle()
                page.locator('.urlbar').scroll_into_view_if_needed()
                controls('.urlbar', 'input,select,button')
                page.get_by_label('Raw body', exact=True).scroll_into_view_if_needed()
                page.locator('#responseContent').scroll_into_view_if_needed()
                settle()
                geometry('body')
                capture(current_case)
                passed(f'short {width}x{height} window keeps request controls and both content panes reachable without hiding the footer')

            for width, height in [(1440, 920), (1024, 768), (390, 844), (320, 720)]:
                current_case = f'history-{width}'
                page.set_viewport_size({'width': width, 'height': height})
                if page.locator('#toggleSidebar').get_attribute('aria-expanded') != 'true':
                    page.locator('#toggleSidebar').click()
                page.locator('[data-sidebar=history]').click()
                long_row = page.locator('#sidebarContent .history-entry[data-history-id="layout-history-long"]')
                short_row = page.locator('#sidebarContent .history-entry[data-history-id="layout-history-short"]')
                long_row.scroll_into_view_if_needed()
                settle()
                row_data = long_row.evaluate('''e => {'''+RECT_HELPERS+r'''
                  const name=e.querySelector('.history-name'), detail=e.querySelector('.history-detail');
                  return {row:rect(e),name:rect(name),detail:rect(detail),nameLine:lineHeight(name),detailLine:lineHeight(detail),
                    label:rect(e.querySelector('.tree-label')),method:rect(e.querySelector('.method-label')),status:rect(e.querySelector('.history-code'))};
                }''')
                short_height = short_row.bounding_box()['height']
                assert abs(row_data['row']['height']-short_height) <= 1, (current_case, 'long data expands history row', row_data, short_height)
                assert row_data['name']['height'] <= row_data['nameLine']+1 and row_data['detail']['height'] <= row_data['detailLine']+1, (current_case, 'history text wraps into a tall row', row_data)
                for name in ['label', 'method', 'status']:
                    assert inside(row_data[name], row_data['row']), (current_case, 'history content clipped', name, row_data)
                assert not overlap(row_data['method'], row_data['label']) and not overlap(row_data['label'], row_data['status']), (current_case, 'history status overlaps label', row_data)
                opened = long_row.locator('.history-open')
                tooltip = opened.get_attribute('title')
                assert long_name in tooltip and long_url in tooltip, (current_case, 'full history value lost from accessible detail')
                opened.click(modifiers=['Control'])
                assert abs(long_row.bounding_box()['height']-short_height) <= 1, current_case
                opened.press('Shift+F10')
                expect(page.locator('#itemMenu')).to_be_visible()
                controls('#itemMenu', 'button')
                capture(current_case)
                page.keyboard.press('Escape')
                opened.click()
                expect(page.locator('#historyPage')).to_have_attribute('data-history-id', 'layout-history-long')
                expect(page.locator('#historyPage')).to_contain_text(long_url)
                passed(f'long history names and URLs retain compact stable rows, readable status and working menus at {width}px')

            assert not errors and not dialogs and not crashes, (errors, dialogs, crashes)
            passed('no uncaught browser errors, native dialogs or browser crashes')
            completed = True
            browser.close()
    finally:
        (out/'results.json').write_text(json.dumps({'ok': completed, 'mode': 'native Chromium HTTP',
            'checks': checks, 'page_errors': errors, 'native_dialogs': dialogs, 'crashes': crashes,
            'screenshots': screenshots, 'measurements': measurements, 'failure': failure}, ensure_ascii=False, indent=2))
        for server in (app, receiver):
            if server:
                server.shutdown()
                server.server_close()


if __name__ == '__main__':
    main()
