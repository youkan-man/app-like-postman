"""Real wheel movement must move the visible source, including at both edges.

The textarea is transparent, so its scrollTop/scrollLeft alone are not evidence
that the user can read the new position. Track real glyph rectangles in the
highlight tree as well as the input and mirror viewports. No scroll offsets or
synthetic wheel events are assigned by this test.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import tempfile

from playwright.sync_api import expect, sync_playwright
from test_proxy import proxy, start_server
from ui_wheel_scroll import OBSERVE, POINT, workspace_fixture


MEASURE = r"""area => {
  const pre=area.closest('.source-editor').querySelector('.source-highlight');
  function box(node){
    const r=node.getBoundingClientRect(),s=getComputedStyle(node);
    return {x:r.x,y:r.y,width:node.clientWidth,height:node.clientHeight,
      top:node.scrollTop,left:node.scrollLeft,scrollWidth:node.scrollWidth,scrollHeight:node.scrollHeight,
      font:s.font,fontSize:s.fontSize,lineHeight:s.lineHeight,padding:s.padding};
  }
  // Track the same glyphs, even after they move outside the clipped viewport.
  const lines=area.value.split('\n'),offsets=[0,Math.floor(area.value.length/2),area.value.length-1];
  const nodes=[],walker=document.createTreeWalker(pre,NodeFilter.SHOW_TEXT);let total=0;
  for(let node;(node=walker.nextNode());){nodes.push({node,start:total,end:total+node.length});total+=node.length;}
  const viewport=pre.getBoundingClientRect();
  const glyphs=offsets.map(offset=>{
    // A newline has no useful width; choose the next visible source character.
    while(offset<area.value.length-1&&/\s/.test(area.value[offset]))offset++;
    const item=nodes.find(entry=>entry.start<=offset&&entry.end>offset);
    if(!item)return null;
    const range=document.createRange();range.setStart(item.node,offset-item.start);range.setEnd(item.node,offset-item.start+1);
    const r=range.getBoundingClientRect();
    return {offset,text:area.value[offset],x:r.x-viewport.x,y:r.y-viewport.y,width:r.width,height:r.height};
  });
  return {input:box(area),highlight:box(pre),glyphs,
    sameText:pre.textContent===area.value+'\n',selection:[area.selectionStart,area.selectionEnd,area.selectionDirection],
    lineCount:lines.length,connected:area.isConnected};
}"""


def main():
    if os.environ.get('MINIPOST_INLINE_TEST') == '1':
        raise RuntimeError('Source scroll synchronization requires native Chromium over HTTP')
    app_url, app = os.environ.get('MINIPOST_REMOTE_URL'), None
    if not app_url:
        app, app_url = start_server(proxy.Handler)
    out = Path(os.environ.get('ARTIFACT_DIR', tempfile.mkdtemp(prefix='minipost-scroll-sync-'))) / 'scroll-sync'
    out.mkdir(parents=True, exist_ok=True)
    cases, errors, dialogs, screenshots = [], [], [], []
    pattern = re.compile(os.environ.get('MINIPOST_SCROLL_SYNC_CASES', '.'))
    completed = False

    workspace = workspace_fixture('http://example.test')
    workspace['collections'][0]['item'] = workspace['collections'][0]['item'][:1]
    workspace['scripts'] = workspace['scripts'][:1]
    workspace['relations'] = [{'id': 'sync-relation', 'name': 'Source synchronization', 'repeat': 1,
        'steps': [{'id': 'sync-step', 'type': 'script', 'scriptId': 'wheel-script', 'inputFormat': 'json', 'input': 'null'}]}]

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM') or shutil.which('chromium'),
                                                 headless=True, args=['--no-sandbox'])
            page = browser.new_page(viewport={'width': 1440, 'height': 920})
            page.set_default_timeout(8000)
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('dialog', lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))

            def settle():
                page.evaluate('''async()=>{await document.fonts.ready;
                    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));}''')

            def ready():
                expect(page.locator('#connectionStatus')).to_contain_text('connected', timeout=15000)
                expect(page.locator('#saveState')).not_to_have_text('ローカルデータを読込中…')

            def sidebar(kind):
                if page.locator('#toggleSidebar').get_attribute('aria-expanded') != 'true':
                    page.locator('#toggleSidebar').click()
                page.locator(f'[data-sidebar="{kind}"]').click()

            def close_navigation():
                close = page.locator('#navClose')
                if close.is_visible() and page.locator('#toggleSidebar').get_attribute('aria-expanded') == 'true':
                    close.click()

            def request(pane='scripts'):
                sidebar('collections')
                page.locator('[data-item-id="wheel-main"] .tree-open').click()
                close_navigation()
                page.locator('#editor-tab-' + pane).click()

            def prepare(kind, width):
                page.set_viewport_size({'width': width, 'height': 920 if width > 650 else 844})
                if kind == 'body':
                    request('body')
                    return page.get_by_label('Raw body', exact=True)
                if kind in ['hook', 'saved-hook']:
                    request()
                    page.locator('#script-tab-before').click()
                    page.get_by_label('送信前に実行するスクリプト', exact=True).select_option('wheel-script' if kind == 'saved-hook' else '')
                    if kind == 'saved-hook':
                        page.get_by_role('button', name='送信前スクリプトを編集', exact=True).click()
                    return page.get_by_label('送信前スクリプト', exact=True)
                if kind == 'ribbon':
                    request('body')
                    page.locator('#requestRibbonEdit').click()
                    expect(page.locator('#ribbonOwnerSelect')).to_be_visible()
                    page.locator('#ribbonCanvas [data-control-id="wheel-control"]').click()
                    page.locator('#ribbonProperties .ribbon-action-target').get_by_role('button', name='編集', exact=True).click()
                    return page.get_by_label('リボンのスクリプト', exact=True)
                if kind == 'relation':
                    sidebar('collections')
                    page.locator('[data-relation-id="sync-relation"] .tree-open').click()
                    close_navigation()
                    page.get_by_role('button', name='ステップ 1 のスクリプトを編集', exact=True).click()
                    return page.get_by_label('ステップ 1 のコード', exact=True)
                sidebar('scripts')
                page.locator('[data-script-id="wheel-script"] .tree-open').click()
                close_navigation()
                return page.get_by_label('スクリプトのコード', exact=True)

            def capture(name):
                filename = name + '.png'
                page.screenshot(path=str(out / filename), full_page=True)
                screenshots.append(filename)

            def run_case(kind, width, resize=None):
                name = f'{kind}-{width}' + (f'-resize-{resize}' if resize else '')
                if not pattern.search(name):
                    return
                case = {'name': name, 'ok': False, 'pulses': [], 'failures': []}
                cases.append(case)
                try:
                    area = prepare(kind, width)
                    expect(area).to_be_visible()
                    area.press('Control+Home')
                    page.keyboard.press('Escape')
                    area.scroll_into_view_if_needed()
                    settle()
                    if resize:
                        area.evaluate('node=>window.__resizeScrollInput=node')
                        page.set_viewport_size({'width': resize, 'height': 844})
                        settle()
                        assert area.evaluate('node=>node===window.__resizeScrollInput'), 'Resize rebuilt the source editor'
                        area.scroll_into_view_if_needed()
                    before = area.evaluate(MEASURE)
                    case['before'] = before
                    assert before['input']['scrollHeight'] > before['input']['height'] + 200, 'Fixture has no vertical range'
                    assert before['input']['scrollWidth'] > before['input']['width'] + 200, 'Fixture has no horizontal range'
                    for key in ['fontSize', 'lineHeight', 'padding']:
                        if before['input'][key] != before['highlight'][key]:
                            case['failures'].append(f'Input and visible source differ in {key}: {before["input"][key]} / {before["highlight"][key]}')
                    if not before['sameText']:
                        case['failures'].append('Visible source does not retain every input character')

                    def pulse(label, dx, dy):
                        point = area.evaluate(POINT, 'center')
                        assert point['hit'].startswith('textarea'), 'Source is covered by ' + point['hit']
                        old = area.evaluate(MEASURE)
                        page.mouse.move(point['x'], point['y'])
                        page.mouse.wheel(dx, dy)
                        page.wait_for_timeout(160)
                        settle()
                        new = area.evaluate(MEASURE)
                        deltas = {axis: new['input'][axis] - old['input'][axis] for axis in ['top', 'left']}
                        movement = []
                        for initial, final in zip(old['glyphs'], new['glyphs']):
                            if not initial or not final:
                                case['failures'].append(label + ': source glyph disappeared')
                                continue
                            movement.append({'offset': initial['offset'],
                                'x': final['x'] - initial['x'], 'y': final['y'] - initial['y']})
                            for axis, coordinate in [('left', 'x'), ('top', 'y')]:
                                if abs(final[coordinate] - initial[coordinate] + deltas[axis]) > 1.5:
                                    case['failures'].append(f'{label}: visible glyph {initial["offset"]} does not follow {axis} by {deltas[axis]:.2f}px')
                        if new['selection'] != before['selection']:
                            case['failures'].append(label + ': reading changed the selection')
                        for axis in ['top', 'left']:
                            if abs(new['input'][axis] - new['highlight'][axis]) > 1.5:
                                case['failures'].append(label + ': visible source is clamped before input at ' + axis)
                        case['pulses'].append({'label': label, 'point': point, 'delta': deltas, 'glyphMovement': movement,
                                               'before': old, 'after': new})
                        return new

                    middle = pulse('middle', 160, 240)
                    assert middle['input']['top'] > 100 and middle['input']['left'] > 50, 'Native wheel did not move both input axes'
                    end = pulse('right-edge', 100000, 0)
                    assert abs(end['input']['scrollWidth'] - end['input']['width'] - end['input']['left']) <= 1.5, 'Input right edge was not reached'
                    pulse('back-from-right-edge', -80, 0)
                    end = pulse('bottom-edge', 0, 100000)
                    assert abs(end['input']['scrollHeight'] - end['input']['height'] - end['input']['top']) <= 1.5, 'Input bottom edge was not reached'
                    pulse('back-from-bottom-edge', 0, -80)
                    case['after'] = area.evaluate(MEASURE)
                    if kind in ['saved-hook', 'ribbon', 'relation'] and width in [1440, 390]:
                        capture(name)
                    assert not case['failures'], '; '.join(case['failures'])
                    case['ok'] = True
                    print('PASS ' + name, flush=True)
                except Exception as error:
                    case['error'] = str(error)
                    print('FAIL ' + name + ': ' + str(error).split('\n')[0], flush=True)
                    if sum(not item['ok'] for item in cases) <= 6:
                        try:
                            capture(name + '-failure')
                        except Exception as shot_error:
                            case['screenshotError'] = str(shot_error)
                finally:
                    page.keyboard.press('Escape')

            page.goto(app_url, wait_until='domcontentloaded')
            ready()
            page.locator('#import').click()
            page.get_by_label('インポートJSON', exact=True).fill(json.dumps({'kind': 'minipost.workspace', 'version': 1, 'workspace': workspace}, ensure_ascii=False))
            page.locator('#modalSubmit').click()
            expect(page.locator('#modalTitle')).to_contain_text('全体バックアップ')
            with page.expect_navigation(wait_until='domcontentloaded'):
                page.locator('#modalSubmit').click()
            ready()
            page.evaluate(OBSERVE)
            for kind in ['body', 'hook', 'saved-hook', 'ribbon', 'relation', 'standalone']:
                for width in ([1440, 650, 390, 320] if kind in ['saved-hook', 'ribbon'] else [1440, 390]):
                    run_case(kind, width)
            run_case('saved-hook', 1440, resize=390)
            completed = bool(cases) and all(case['ok'] for case in cases) and not errors and not dialogs
            browser.close()
    finally:
        result = {'ok': completed, 'mode': 'native Chromium HTTP wheel', 'cases': cases, 'page_errors': errors,
                  'dialogs': dialogs, 'screenshots': screenshots,
                  'passed': sum(case['ok'] for case in cases), 'failed': sum(not case['ok'] for case in cases)}
        (out / 'results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
        if app:
            app.shutdown()
            app.server_close()
    if not completed:
        raise AssertionError(f'Source scroll cases: {result["passed"]} passed, {result["failed"]} failed; see {out / "results.json"}')


if __name__ == '__main__':
    main()
