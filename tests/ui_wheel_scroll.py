"""Native wheel hit-target regression, including padding and sibling toolbars.

Run against the real HTTP app. No scrollTop assignments or synthetic wheel
events are used: every measured movement comes from page.mouse.wheel().
All cases continue after a failure and retain their actual event/scroll targets.
MINIPOST_WHEEL_CASES can restrict the case-name regex for a quick diagnostic.
"""
from __future__ import annotations

from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
from threading import Thread

from playwright.sync_api import expect, sync_playwright
from test_proxy import EchoHandler, proxy, start_server


class WheelEchoHandler(EchoHandler):
    def handle_request(self):
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        plain = self.path.split('?', 1)[0] == '/wheel-text'
        lines = [f'Response line {index:03d}: ' + 'readable text 日本語 ' * 8 for index in range(180)]
        content = '\n'.join(lines) if plain else json.dumps({'rows': lines}, ensure_ascii=False, indent=2)
        payload = content.encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain; charset=utf-8' if plain else 'application/json; charset=utf-8')
        for index in range(60):
            self.send_header(f'X-Wheel-{index:03d}', f'Header value {index:03d}')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass

    do_GET = do_POST = handle_request


def workspace_fixture(target):
    source = '\n'.join(f'// Source line {index:03d}: ' + 'horizontal content 日本語 ' * 8 for index in range(150))
    pairs = lambda prefix: [{'key': f'{prefix}-{index:03d}', 'value': f'value {index:03d}'} for index in range(72)]
    settings = {'timeout_ms': 30000, 'verify_tls': False, 'follow_redirects': True}
    raw = {'mode': 'raw', 'raw': json.dumps({'rows': [f'Body line {index:03d}: ' + 'content ' * 25 for index in range(150)]}, indent=2),
           'options': {'raw': {'language': 'json'}}}
    main = {'_mpId': 'wheel-main', 'name': 'Wheel main', 'settings': settings,
            'request': {'method': 'POST', 'url': {'raw': target + '/wheel-json', 'query': pairs('q')},
                        'header': pairs('X-Request'), 'body': raw,
                        '_minipost': {'enabled': False, 'before': source, 'after': source, 'timeoutMs': 5000, 'extractions': []}}}
    items = [main]
    for mode in ['urlencoded', 'formdata']:
        items.append({'_mpId': 'wheel-' + mode, 'name': 'Wheel ' + mode, 'settings': settings,
                      'request': {'method': 'POST', 'url': target + '/wheel-json', 'header': [],
                                  'body': {'mode': mode, mode: [{**row, **({'type': 'text'} if mode == 'formdata' else {})} for row in pairs('form')]}}})
    items.append({'_mpId': 'wheel-text', 'name': 'Wheel text response', 'settings': settings,
                  'request': {'method': 'GET', 'url': target + '/wheel-text', 'header': [], 'body': {'mode': 'none'}}})
    items.extend({'_mpId': f'wheel-item-{index}', 'name': f'Wheel list item {index:03d}', 'settings': settings,
                  'request': {'method': 'GET', 'url': target + '/wheel-json', 'header': []}} for index in range(85))
    main['ribbonState'] = {'id': 'wheel-scope', 'activeRibbonId': 'wheel-ribbon', 'ribbonBindings': {}, 'ribbons': [
        {'id': 'wheel-ribbon', 'key': 'wheel', 'name': 'Wheel ribbon', 'groups': [
            {'id': 'wheel-group', 'name': 'Code', 'controls': [
                {'id': 'wheel-control', 'key': 'run', 'label': 'Wheel script', 'type': 'button', 'value': None,
                 'visible': True, 'enabled': True, 'options': [], 'actions': [
                     {'id': 'wheel-action', 'type': 'script', 'scriptId': 'wheel-script'}]}]}]}]}
    scripts = [{'id': 'wheel-script', 'name': 'Wheel standalone script', 'source': source, 'input': 'null', 'inputFormat': 'json', 'timeoutMs': 0}]
    scripts.extend({'id': f'wheel-script-{index}', 'name': f'Wheel extra script {index:03d}', 'source': '', 'input': 'null', 'inputFormat': 'json', 'timeoutMs': 0} for index in range(40))
    return {'version': 2, 'collections': [{'_mpId': 'wheel-collection', 'info': {'name': 'Wheel cases'}, 'item': items}],
            'tabs': [], 'history': [], 'globals': [], 'environments': [], 'environmentId': '',
            'scripts': scripts, 'scriptData': {}, 'relations': [], 'relationRuns': [], 'collapsed': [], 'theme': 'light'}


OBSERVE = r"""() => {
  const ids = new WeakMap(); let next = 0;
  const id = node => {if (!ids.has(node)) ids.set(node, ++next); return ids.get(node);};
  const describe = node => {
    if (!(node instanceof Element)) return String(node?.nodeName || '');
    return node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') +
      (node.classList.length ? '.' + [...node.classList].slice(0, 3).join('.') : '') +
      (node.getAttribute('aria-label') ? '[' + node.getAttribute('aria-label') + ']' : '');
  };
  const measure = node => {
    const box = node.getBoundingClientRect(), style = getComputedStyle(node);
    return {id:id(node),node:describe(node),connected:node.isConnected,top:node.scrollTop,left:node.scrollLeft,
      height:node.clientHeight,width:node.clientWidth,scrollHeight:node.scrollHeight,scrollWidth:node.scrollWidth,
      overflowY:style.overflowY,overflowX:style.overflowX,rect:{x:box.x,y:box.y,width:box.width,height:box.height},
      focused:document.activeElement===node,
      ...(node instanceof HTMLTextAreaElement ? {selection:[node.selectionStart,node.selectionEnd,node.selectionDirection]} : {})};
  };
  window.__wheelDiagnostic = {describe,measure,current:null};
  document.addEventListener('wheel', event => {
    const current = window.__wheelDiagnostic.current;if (!current) return;
    const entry = {target:describe(event.target),path:event.composedPath().filter(node=>node instanceof Element).map(describe),
      deltaX:event.deltaX,deltaY:event.deltaY,ctrlKey:event.ctrlKey,x:event.clientX,y:event.clientY,prevented:event.defaultPrevented};
    current.wheels.push(entry);requestAnimationFrame(()=>entry.prevented=event.defaultPrevented);
  }, {capture:true,passive:true});
  document.addEventListener('scroll', event => {
    const current=window.__wheelDiagnostic.current;
    const node=event.target===document?document.scrollingElement:event.target;
    if (current&&node instanceof Element&&current.scrolls.length<80)current.scrolls.push(measure(node));
  }, {capture:true,passive:true});
}"""


POINT = r"""(node, mode) => {
  let box=node.getBoundingClientRect(),left=Math.max(0,box.left),right=Math.min(innerWidth,box.right),
      top=Math.max(0,box.top),bottom=Math.min(innerHeight,box.bottom);
  for(let parent=node.parentElement;parent;parent=parent.parentElement){
    const r=parent.getBoundingClientRect(),s=getComputedStyle(parent);
    if(/hidden|auto|scroll|clip/.test(s.overflowX)){left=Math.max(left,r.left);right=Math.min(right,r.right);}
    if(/hidden|auto|scroll|clip/.test(s.overflowY)){top=Math.max(top,r.top);bottom=Math.min(bottom,r.bottom);}
  }
  if(right-left<4||bottom-top<4)throw new Error('No visible hit area for '+node.tagName+'#'+node.id);
  const x=mode==='padding'?left+2:mode==='first-line'?Math.min(right-3,left+90):(left+right)/2;
  const y=mode==='first-line'?Math.min(bottom-3,top+16):(top+bottom)/2;
  return {x,y,hit:window.__wheelDiagnostic.describe(document.elementFromPoint(x,y)),visible:{left,right,top,bottom}};
}"""


def main():
    if os.environ.get('MINIPOST_INLINE_TEST') == '1':
        raise RuntimeError('Wheel diagnostics require a real HTTP origin')
    app_url, app = os.environ.get('MINIPOST_REMOTE_URL'), None
    if app_url:
        port = int(os.environ.get('LOCAL_RELAY_VM_BROWSER_PORT') or '18081')
        receiver = ThreadingHTTPServer(('0.0.0.0', port), WheelEchoHandler)
        Thread(target=receiver.serve_forever, daemon=True).start()
        target = f'http://{os.environ["LOCAL_RELAY_VM_BROWSER_IP"]}:{port}'
    else:
        receiver, target = start_server(WheelEchoHandler)
        app, app_url = start_server(proxy.Handler)
    out = Path(os.environ.get('ARTIFACT_DIR', tempfile.mkdtemp(prefix='minipost-wheel-'))) / 'wheel-scroll'
    out.mkdir(parents=True, exist_ok=True)
    cases, errors, dialogs, screenshots = [], [], [], []
    pattern = re.compile(os.environ.get('MINIPOST_WHEEL_CASES', '.'))
    completed, page = False, None

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM') or shutil.which('chromium'), headless=True, args=['--no-sandbox'])
            page = browser.new_page(viewport={'width': 1440, 'height': 920})
            page.set_default_timeout(6000)
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('dialog', lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))

            def ready():
                expect(page.locator('#connectionStatus')).to_contain_text('connected', timeout=15000)
                expect(page.locator('#saveState')).not_to_have_text('ローカルデータを読込中…')

            def sidebar(kind):
                if page.locator('#toggleSidebar').get_attribute('aria-expanded') != 'true':
                    page.locator('#toggleSidebar').click()
                page.locator(f'[data-sidebar="{kind}"]').click()

            def close_mobile_navigation():
                close = page.locator('#navClose')
                if close.is_visible() and page.locator('#toggleSidebar').get_attribute('aria-expanded') == 'true':
                    close.click()

            def request(identifier='wheel-main', pane='headers', size=(1440, 920), layout='stack'):
                page.set_viewport_size({'width': size[0], 'height': size[1]})
                sidebar('collections')
                page.locator(f'[data-item-id="{identifier}"] .tree-open').click()
                close_mobile_navigation()
                if size[0] >= 1180 and page.locator('html').get_attribute('data-layout') != layout:
                    page.locator('#layoutToggle').click()
                page.locator('#editor-tab-' + pane).click()

            def send():
                page.locator('#send').click()
                expect(page.locator('#responseStatus')).to_contain_text('200', timeout=20000)
                expect(page.locator('#send')).to_be_enabled(timeout=20000)

            def source(pane='body', focused=False, selected=False, size=(1440, 920), layout='stack'):
                request(pane=pane, size=size, layout=layout)
                area = page.get_by_label('Raw body' if pane == 'body' else '送信前スクリプト', exact=True)
                if focused or selected:
                    area.press('Control+Home')
                    if selected:
                        area.press('Shift+ArrowDown')
                else:
                    page.locator('#requestName').click()
                return area

            def response(view='pretty', plain=False, size=(1440, 920), layout='stack'):
                request('wheel-text' if plain else 'wheel-main', size=size, layout=layout)
                if not page.locator('#responseStatus').inner_text().strip().startswith('200'):
                    send()
                page.locator('#response-tab-' + view).click()

            def standalone():
                page.set_viewport_size({'width': 1440, 'height': 920})
                sidebar('scripts')
                page.locator('[data-script-id="wheel-script"] .tree-open').click()
                close_mobile_navigation()
                page.get_by_label('スクリプトのコード', exact=True).press('Control+Home')

            def ribbon():
                request()
                page.locator('#requestRibbonEdit').click()
                expect(page.locator('#ribbonOwnerSelect')).to_be_visible()
                page.locator('#ribbonCanvas [data-control-id="wheel-control"]').click()
                page.locator('#ribbonProperties .ribbon-action-target').get_by_role('button', name='編集', exact=True).click()
                page.get_by_label('リボンのスクリプト', exact=True).press('Control+Home')

            def completion():
                area = source('scripts', focused=True)
                area.fill('pm.\n' + workspace_fixture(target)['scripts'][0]['source'])
                area.press('Control+Home')
                area.press('ArrowRight'); area.press('ArrowRight'); area.press('ArrowRight')
                area.press('Control+Space')
                expect(page.locator('#script-panel-before .source-suggestions')).to_be_visible(timeout=20000)

            def capture(name):
                path = re.sub(r'[^a-zA-Z0-9_-]', '-', name) + '.png'
                page.screenshot(path=str(out / path), full_page=True)
                screenshots.append(path)

            def wheel_case(name, prepare, selector, expected, hit='center', selection=False, native=False, control=False):
                if not pattern.search(name):
                    return
                case = {'name': name, 'ok': False, 'selector': selector, 'expected': expected, 'hitMode': hit}
                cases.append(case)
                try:
                    prepare()
                    node = page.locator(selector + ':visible').first
                    expect(node).to_be_visible()
                    try:
                        point = node.evaluate(POINT, hit)
                    except Exception:
                        node.scroll_into_view_if_needed()
                        point = node.evaluate(POINT, hit)
                    case['point'] = point
                    page.evaluate('''selectors=>{
                      const observer=window.__wheelDiagnostic;
                      const expected=[...document.querySelectorAll(selectors)].filter(node=>node.getClientRects().length);
                      const extra=[document.scrollingElement,...document.querySelectorAll('#workspacePage,#sidebarContent,#editorContent,.request-editor,.response-panel,.source-input,.source-suggestions')].filter(node=>node?.getClientRects().length);
                      observer.current={expected,nodes:[...new Set([...expected,...extra])],wheels:[],scrolls:[]};
                    }''', expected)
                    snapshot = lambda: page.evaluate('''()=>{const d=window.__wheelDiagnostic,c=d.current;return {expected:c.expected.map(d.measure),all:c.nodes.map(d.measure)};}''')
                    before = snapshot()
                    case['before'] = before
                    overflowing = [item for item in before['expected'] if item['scrollHeight'] - item['height'] > 20]
                    if not overflowing:
                        raise AssertionError('The intended content has no vertical scroll range')
                    direction = 1 if any(item['scrollHeight'] - item['height'] - item['top'] > 140 for item in overflowing) else -1
                    page.mouse.move(point['x'], point['y'])
                    pulses = []
                    if control:
                        page.keyboard.down('Control')
                    for _ in range(1 if control else 3):
                        previous = snapshot()
                        hit_target = page.evaluate('p=>window.__wheelDiagnostic.describe(document.elementFromPoint(p.x,p.y))', point)
                        page.mouse.wheel(0, direction * 140)
                        page.wait_for_timeout(130)
                        current = snapshot()
                        old = {item['id']: item for item in previous['expected']}
                        moved = any(item['id'] in old and (item['top'] - old[item['id']]['top']) * direction > 4 for item in current['expected'])
                        room = any((item['scrollHeight'] - item['height'] - item['top'] if direction > 0 else item['top']) > 10 for item in previous['expected'])
                        pulses.append({'hit': hit_target, 'moved': moved, 'room': room, 'before': previous['expected'], 'after': current['expected']})
                    if control:
                        page.keyboard.up('Control')
                    case['pulses'] = pulses
                    case['after'] = snapshot()
                    case['events'] = page.evaluate('''()=>{const c=window.__wheelDiagnostic.current;return {wheels:c.wheels,scrolls:c.scrolls};}''')
                    assert case['events']['wheels'], 'No native wheel event reached the page'
                    if not control:
                        assert all(pulse['moved'] or not pulse['room'] for pulse in pulses), 'Wheel stopped moving the intended content while it still had room'
                    if native or control:
                        assert all(event['target'].startswith('textarea') and not event['prevented'] for event in case['events']['wheels']), 'Native textarea wheel was intercepted'
                    if control:
                        assert all(event['ctrlKey'] for event in case['events']['wheels']), 'Control modifier did not reach the native wheel event'
                    if selection:
                        initial = {item['id']: item.get('selection') for item in before['expected']}
                        assert all(item.get('selection') == initial.get(item['id']) for item in case['after']['expected']), 'Wheel changed the text selection'
                    case['ok'] = True
                    print('PASS ' + name, flush=True)
                except Exception as error:
                    case['error'] = str(error)
                    print('FAIL ' + name + ': ' + str(error).split('\n')[0], flush=True)
                    if sum(not item['ok'] for item in cases) <= 6:
                        try:
                            capture(name)
                        except Exception as screenshot_error:
                            case['screenshotError'] = str(screenshot_error)
                finally:
                    if control:
                        page.keyboard.up('Control'); page.keyboard.press('Control+0')
                    page.evaluate('if(window.__wheelDiagnostic)window.__wheelDiagnostic.current=null')
                    page.keyboard.press('Escape')

            page.goto(app_url, wait_until='domcontentloaded'); ready()
            page.locator('#import').click()
            page.get_by_label('インポートJSON', exact=True).fill(json.dumps({'kind': 'minipost.workspace', 'version': 1, 'workspace': workspace_fixture(target)}, ensure_ascii=False))
            page.locator('#modalSubmit').click()
            expect(page.locator('#modalTitle')).to_contain_text('全体バックアップ')
            with page.expect_navigation(wait_until='domcontentloaded'):
                page.locator('#modalSubmit').click()
            ready(); page.evaluate(OBSERVE)
            request(); send()

            tables = '#editorContent,#request-fields-headers,#request-fields-params,#request-fields-body'
            wheel_case('query-input', lambda: request(pane='params'), '#request-fields-params input[aria-label="Value 1"]', tables)
            wheel_case('headers-input', request, '#request-fields-headers input[aria-label="Value 1"]', tables)
            wheel_case('headers-table-text', request, '#request-fields-headers th', tables)
            wheel_case('headers-content-padding', request, '#editorContent', tables, 'padding')
            wheel_case('request-title-over-table', request, '#requestName', tables)
            wheel_case('request-tabs-over-table', request, '#editor-tab-headers', tables)
            for mode in ['urlencoded', 'formdata']:
                wheel_case(mode + '-input', lambda mode=mode: request('wheel-' + mode, 'body'), '#request-fields-body input[aria-label="Value 1"]', tables)

            raw = 'textarea[aria-label="Raw body"]'
            hook = 'textarea[aria-label="送信前スクリプト"]'
            for focused in [False, True]:
                wheel_case('raw-' + ('focused' if focused else 'unfocused'), lambda focused=focused: source(focused=focused), raw, raw, selection=True, native=True)
                wheel_case('hook-' + ('focused' if focused else 'unfocused'), lambda focused=focused: source('scripts', focused), hook, hook, selection=True)
            wheel_case('raw-selected-text', lambda: source(selected=True), raw, raw, selection=True)
            wheel_case('raw-control-wheel', lambda: source(focused=True), raw, raw, native=True, control=True)
            wheel_case('raw-status-footer', lambda: source(focused=True), '#request-fields-body .source-status', raw, selection=True)
            wheel_case('hook-status-footer', lambda: source('scripts', True), '#script-panel-before .source-status', hook, selection=True)
            wheel_case('hook-open-completion', completion, hook, hook, 'first-line', selection=True)

            wheel_case('response-pretty-code', response, '#responseContent .response-code', '#responseContent')
            wheel_case('response-raw-code', lambda: response('raw'), '#responseContent .response-code', '#responseContent')
            wheel_case('response-header-list', lambda: response('headers'), '#responseContent .kv-readonly td', '#responseContent')
            wheel_case('response-heading', response, '.response-heading', '#responseContent')
            wheel_case('response-toolbar', response, '.response-toolbar', '#responseContent')
            wheel_case('response-plain-text', lambda: response(plain=True), '#responseContent .response-code', '#responseContent')

            standalone_area = 'textarea[aria-label="スクリプトのコード"]'
            wheel_case('standalone-source', standalone, standalone_area, standalone_area, selection=True)
            wheel_case('standalone-status-footer', standalone, '.standalone-script-code .source-status', standalone_area, selection=True)
            ribbon_area = 'textarea[aria-label="リボンのスクリプト"]'
            wheel_case('ribbon-inline-source', ribbon, ribbon_area, ribbon_area, selection=True)
            wheel_case('ribbon-inline-status-footer', ribbon, '#ribbonProperties .embedded-script-editor .source-status', ribbon_area, selection=True)

            wheel_case('sidebar-row', lambda: (page.set_viewport_size({'width': 1440, 'height': 920}), sidebar('collections')), '#sidebarContent .tree-open', '#sidebarContent')
            wheel_case('sidebar-heading', lambda: sidebar('collections'), '#sidebarTitle', '#sidebarContent')
            wheel_case('side-request-title', lambda: request(layout='side'), '#requestName', tables)
            wheel_case('mobile-raw-source', lambda: source(focused=True, size=(390, 844)), raw, raw, selection=True)
            wheel_case('mobile-raw-status-footer', lambda: source(focused=True, size=(390, 844)), '#request-fields-body .source-status', raw, selection=True)
            wheel_case('landscape-hook-status-footer', lambda: source('scripts', True, size=(844, 390)), '#script-panel-before .source-status', hook, selection=True)
            wheel_case('landscape-response-heading', lambda: response(size=(844, 390)), '.response-heading', '#responseContent')
            capture('wheel-final-state')
            completed = bool(cases) and all(case['ok'] for case in cases) and not errors and not dialogs
            browser.close()
    finally:
        result = {'ok': completed, 'mode': 'native Chromium HTTP wheel', 'cases': cases, 'page_errors': errors,
                  'dialogs': dialogs, 'screenshots': screenshots, 'passed': sum(case['ok'] for case in cases), 'failed': sum(not case['ok'] for case in cases)}
        (out / 'results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
        receiver.shutdown(); receiver.server_close()
        if app:
            app.shutdown(); app.server_close()
    if not completed:
        raise AssertionError(f'Wheel cases: {result["passed"]} passed, {result["failed"]} failed; see {out / "results.json"}')


if __name__ == '__main__':
    main()
