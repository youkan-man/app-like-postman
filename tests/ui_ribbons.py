"""Custom ribbon authoring, real Worker actions and persistence over native HTTP.

Fixtures are authored through the visible UI. IndexedDB and HTTP reads inspect
committed results without replacing storage, script execution or app state.
"""
from __future__ import annotations

from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import tempfile

from playwright.sync_api import expect, sync_playwright
from test_proxy import proxy, start_server
from ui_standalone_scripts import READ_WORKSPACE


def main():
    if os.environ.get('MINIPOST_INLINE_TEST') == '1':
        raise RuntimeError('Ribbon acceptance requires a real HTTP origin')
    out = Path(os.environ.get('ARTIFACT_DIR', tempfile.mkdtemp(prefix='minipost-ribbons-'))) / 'ribbons'
    out.mkdir(parents=True, exist_ok=True)
    temp = tempfile.TemporaryDirectory(prefix='minipost-ribbon-server-')
    original_file, server, url = proxy.WORKSPACE_FILE, None, os.environ.get('MINIPOST_REMOTE_URL')
    checks, screenshots, errors, dialogs, crashes, requests = [], [], [], [], [], []
    page, completed = None, False

    def passed(message):
        checks.append(message)
        print('PASS ' + message, flush=True)

    @contextmanager
    def capture_failure():
        try:
            yield
        except Exception:
            if page and not page.is_closed():
                try:
                    page.screenshot(path=str(out / 'failure.png'), full_page=True)
                    screenshots.append('failure.png')
                except Exception:
                    pass
            raise

    try:
        if not url:
            proxy.WORKSPACE_FILE = Path(temp.name) / 'workspace.json'
            server, url = start_server(proxy.Handler)
        with sync_playwright() as playwright, capture_failure():
            browser = playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM') or shutil.which('chromium'),
                                                 headless=True, args=['--no-sandbox'])
            page = browser.new_page(viewport={'width': 1440, 'height': 900}, accept_downloads=True)
            page.set_default_timeout(15000)
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('dialog', lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))
            page.on('crash', lambda: crashes.append('page crashed'))
            page.on('request', lambda request: requests.append(request.url) if '/api/request' in request.url else None)
            props = page.locator('#ribbonProperties')

            def ready():
                expect(page.locator('#connectionStatus')).to_contain_text('connected')
                expect(page.locator('#saveState')).not_to_have_text('ローカルデータを読込中…')

            def saved():
                expect(page.locator('#saveState')).to_have_text('ローカルに保存済み')
                return page.evaluate(READ_WORKSPACE)

            def sidebar(kind):
                if page.locator('#toggleSidebar').get_attribute('aria-expanded') != 'true':
                    page.locator('#toggleSidebar').click()
                page.locator(f'[data-sidebar="{kind}"]').click()
                expect(page.locator('#sidebarContent')).to_have_attribute('data-side', kind)

            def create_ribbon(name, key):
                sidebar('ribbons')
                page.locator('#sidebarAdd').click()
                page.get_by_role('menuitem', name='リボンを作成', exact=True).click()
                page.locator('#modal').get_by_label('リボン名', exact=True).fill(name)
                page.locator('#modalSubmit').click()
                expect(page.locator('#modal')).not_to_be_visible()
                page.get_by_label('リボンの参照キー', exact=True).fill(key)
                page.get_by_label('リボンの参照キー', exact=True).press('Tab')
                return next(item['id'] for item in saved()['ribbons'] if item['key'] == key)

            def open_ribbon(identifier):
                sidebar('ribbons')
                page.locator(f'[data-ribbon-id="{identifier}"] .tree-open').click()
                expect(page.locator('.ribbons-page')).to_be_visible()

            def choose(identifier):
                page.locator(f'#ribbonCanvas [data-control-id="{identifier}"]').click()
                expect(props).to_be_visible()

            def control_state(workspace, identifier):
                return next(control for ribbon in workspace['ribbons'] for group in ribbon['groups']
                            for control in group['controls'] if control['id'] == identifier)

            def add_control(kind, key, label):
                page.locator('.ribbon-editor-tools').get_by_role('button', name='項目を追加 ▾', exact=True).click()
                page.get_by_role('menuitem', name=kind, exact=True).click()
                props.get_by_label('項目のラベル', exact=True).fill(label)
                props.get_by_label('項目の参照キー', exact=True).fill(key)
                props.get_by_label('項目の参照キー', exact=True).press('Tab')
                return next(control['id'] for ribbon in saved()['ribbons'] for group in ribbon['groups']
                            for control in group['controls'] if control['key'] == key)

            def typed(scope, label, kind, value):
                scope.get_by_label(label + 'の型', exact=True).select_option(kind)
                node = scope.get_by_label(label, exact=True)
                if kind == 'boolean':
                    node.select_option('true' if value else 'false')
                else:
                    node.fill(json.dumps(value, ensure_ascii=False) if kind == 'json' else str(value))
                    node.press('Tab')

            def condition(scope, title, target, operator, value=None):
                scope.get_by_role('button', name=title + 'を追加', exact=True).click()
                scope.get_by_label(title + 'の参照項目', exact=True).last.select_option(target)
                scope.get_by_label(title + 'の比較', exact=True).last.select_option(operator)
                if value is not None:
                    typed(scope, title + 'の比較値', 'number' if isinstance(value, (int, float)) else 'text', value)

            def action(kind, target, value=None):
                props.get_by_role('button', name='処理を追加', exact=True).click()
                row = props.locator('.ribbon-action').last
                row.get_by_label('処理の種類', exact=True).select_option(kind)
                row.get_by_label('実行するスクリプト' if kind == 'script' else '処理の対象', exact=True).select_option(target)
                if kind == 'set':
                    typed(row, '設定する値', 'json', value)
                return row

            def create_script(name, source):
                sidebar('scripts')
                page.locator('#sidebarAdd').click()
                page.get_by_role('menuitem', name='スクリプトを作成', exact=True).click()
                page.locator('#modal').get_by_label('スクリプト名', exact=True).fill(name)
                page.locator('#modalSubmit').click()
                expect(page.locator('#modal')).not_to_be_visible()
                page.get_by_label('スクリプトのコード', exact=True).fill(source)
                return next(item['id'] for item in saved()['scripts'] if item['name'] == name)

            def live(identifier):
                return page.locator(f'#customRibbon [data-ribbon-input="{identifier}"]')

            def capture(name):
                page.screenshot(path=str(out / (name + '.png')), full_page=True)
                screenshots.append(name + '.png')

            page.goto(url, wait_until='domcontentloaded')
            ready()
            expect(page.locator('#customRibbon')).not_to_be_visible()
            main_id = create_ribbon('操作パネル', 'main')
            page.locator('.ribbon-editor-tools').get_by_role('button', name='グループを追加', exact=True).click()
            page.locator('#modal').get_by_label('グループ名', exact=True).fill('操作')
            page.locator('#modalSubmit').click()
            toggle_id = add_control('チェック', 'ready', '結果を表示')
            count_id = add_control('数値入力', 'count', '件数')
            props.get_by_label('項目の値', exact=True).fill('2')
            query_id = add_control('文字入力', 'query', '検索語')
            mode_id = add_control('選択欄', 'mode', 'モード')
            for index, (value, label) in enumerate([('normal', '標準'), ('detail', '詳細')], 1):
                props.get_by_role('button', name='選択肢を追加', exact=True).click()
                props.get_by_label(f'選択肢{index}の値', exact=True).fill(value)
                props.get_by_label(f'選択肢{index}の値', exact=True).press('Tab')
                props.get_by_label(f'選択肢{index}のラベル', exact=True).fill(label)
            output_id = add_control('値表示', 'result', '計算結果')
            typed(props, '表示する値', 'json', {'value': 0})
            condition(props, '表示条件', toggle_id, 'truthy')
            run_id = add_control('ボタン', 'run', '集計を実行')
            condition(props, '有効条件', count_id, 'gt', 0)
            workspace = saved()
            assert [item['type'] for item in workspace['ribbons'][0]['groups'][0]['controls']] == ['toggle', 'number', 'text', 'select', 'display', 'button']
            assert workspace['collections'] == [] and workspace['tabs'] == []
            passed('empty workspace authors a named ribbon, group and all six typed controls through the UI')

            expect(live(output_id)).not_to_be_visible()
            live(count_id).fill('0')
            expect(live(run_id)).to_be_disabled()
            expect(live(count_id)).to_be_focused()
            live(count_id).fill('3')
            expect(live(run_id)).to_be_enabled()
            expect(live(count_id)).to_be_focused()
            live(count_id).press('Tab')
            live(query_id).fill('alpha')
            live(query_id).press('Tab')
            live(mode_id).select_option('detail')
            live(toggle_id).check()
            expect(live(output_id)).to_be_visible()
            assert control_state(saved(), mode_id)['value'] == 'detail'
            passed('live typing retains focus and conditions react to numeric, selected and checkbox values')

            child_id = create_script('子集計', "const value=ribbon.get('main.count')*2; ribbon.set('main.result',{value}); return value;")
            script_id = create_script('リボン集計', 'const value=await scripts.run(' + json.dumps(child_id) + ',input); store.set("event",input); store.set("runs",(store.get("runs")||0)+1); return value;')
            self_id = create_script('変更を一度だけ処理', "store.set('changes',(store.get('changes')||0)+1); store.set('previousCount',input.previousValue); ribbon.set('main.count',input.value+1);")
            fail_id = create_script('失敗する処理', "ribbon.set('main.count',999); store.set('failedWrite',true); throw Error('ribbon failure');")
            open_ribbon(main_id)
            choose(run_id)
            action('script', script_id)
            live(run_id).click()
            expect(live(output_id)).to_have_text('{"value":6}')
            expect(page.locator('#ribbonOperationResult')).to_have_attribute('data-state', 'success')
            workspace = saved()
            event = workspace['scriptData']['event']
            assert event['type'] == 'click' and event['controlId'] == run_id and event['ribbonId'] == main_id
            assert event['values']['count'] == 3 and event['values']['query'] == 'alpha' and workspace['scriptData']['runs'] == 1
            passed('actual live button runs parent and child Workers with typed event input and shared ribbon writes')

            choose(count_id)
            action('script', self_id)
            live(count_id).fill('5')
            live(count_id).press('Tab')
            expect(live(count_id)).to_have_value('6')
            expect(page.locator('#ribbonOperationResult')).to_have_attribute('data-state', 'success')
            assert saved()['scriptData']['changes'] == 1 and saved()['scriptData']['previousCount'] == 3
            passed('user change runs once and script-driven value updates do not recursively fire change actions')

            details_id = create_ribbon('結果パネル', 'details')
            details_value = add_control('値表示', 'details_result', '状態')
            typed(props, '表示する値', 'text', '待機中')
            page.get_by_label('表示するリボン', exact=True).select_option(main_id)
            open_ribbon(main_id)
            chain_id = add_control('ボタン', 'switch', '結果へ切り替え')
            action('set', output_id, {'chain': True})
            action('toggle', toggle_id)
            condition(action('activate', details_id), '実行条件', toggle_id, 'falsy')
            live(chain_id).click()
            expect(page.get_by_label('表示するリボン', exact=True)).to_have_value(details_id)
            expect(live(details_value)).to_have_text('待機中')
            workspace = saved()
            assert control_state(workspace, output_id)['value'] == {'chain': True}
            assert control_state(workspace, toggle_id)['value'] is False
            page.get_by_label('表示するリボン', exact=True).select_option(main_id)
            expect(live(output_id)).not_to_be_visible()
            passed('ordered set, toggle and conditional activation actions observe earlier staged changes and retain both ribbons')

            choose(query_id)
            action('set', output_id, {'should': 'rollback'})
            action('script', fail_id)
            live(query_id).fill('beta')
            live(query_id).press('Tab')
            expect(page.locator('#ribbonOperationResult')).to_have_attribute('data-state', 'error')
            expect(page.locator('#ribbonOperationResult')).to_contain_text('ribbon failure')
            workspace = saved()
            assert control_state(workspace, query_id)['value'] == 'beta'
            assert control_state(workspace, count_id)['value'] == 6
            assert control_state(workspace, output_id)['value'] == {'chain': True}
            assert 'failedWrite' not in workspace['scriptData']
            expect(live(query_id)).to_be_enabled()
            passed('a later script failure rolls back the entire action list while preserving the direct input and releasing busy state')

            standalone_id = create_script('リボンAPI確認', "const count=minipost.ribbon.get('main.count'); ribbon.set('details.details_result',{count}); ribbon.activate('details'); return ribbon.values('details');")
            page.locator('#runStandaloneScript').click()
            expect(live(details_value)).to_have_text('{"count":6}')
            expect(page.locator('#standaloneScriptStatus')).to_have_attribute('data-state', 'success')
            assert json.loads(page.locator('#standaloneScriptResult').inner_text()) == {'details_result': {'count': 6}}
            page.get_by_label('表示するリボン', exact=True).select_option(main_id)
            passed('independent scripts read and write ribbon values and activate another ribbon through the same public API')

            before = saved()
            page.reload(wait_until='domcontentloaded')
            ready()
            after = saved()
            for key in ['ribbons', 'activeRibbonId', 'scripts', 'scriptData']:
                assert after[key] == before[key], key
            assert any(item['id'] == standalone_id for item in after['scripts'])
            passed('ribbon definitions, values, selection, actions and linked scripts survive native IndexedDB reload')

            page.locator('#dataActions').click()
            with page.expect_download() as download:
                page.get_by_role('menuitem', name='全体エクスポート', exact=True).click()
            backup = out / 'ribbon-workspace.json'
            download.value.save_as(backup)
            bundle = json.loads(backup.read_text())
            assert bundle['workspace']['ribbons'] == after['ribbons']
            assert bundle['workspace']['activeRibbonId'] == main_id
            page.locator('#dataActions').click()
            page.get_by_role('menuitem', name='サーバーへ保存', exact=True).click()
            expect(page.locator('#serverSaveState')).to_have_class('saved')
            response = page.request.get(url.rstrip('/') + '/api/workspace')
            assert response.ok and response.json()['workspace']['ribbons'] == after['ribbons']
            passed('whole export and explicit server save contain complete ribbon definitions and current typed values')

            live(query_id).fill('changed after backup')
            live(query_id).press('Tab')
            expect(page.locator('#customRibbon .ribbon-control-error')).to_be_visible()
            page.locator('#import').click()
            page.get_by_label('インポートJSON', exact=True).fill(json.dumps(bundle, ensure_ascii=False))
            page.locator('#modalSubmit').click()
            expect(page.locator('#modalTitle')).to_contain_text('全体バックアップ')
            with page.expect_navigation(wait_until='domcontentloaded'):
                page.locator('#modalSubmit').click()
            ready()
            expect(live(query_id)).to_have_value('beta')
            assert saved()['ribbons'] == after['ribbons']
            passed('actual import-and-replace restores ribbon values and executable action references from the exported backup')

            open_ribbon(main_id)
            choose(run_id)
            for width, height in [(1440, 900), (390, 844), (320, 720)]:
                page.set_viewport_size({'width': width, 'height': height})
                if page.locator('#navClose').is_visible() and page.locator('#toggleSidebar').get_attribute('aria-expanded') == 'true':
                    page.locator('#navClose').click()
                expect(page.locator('#customRibbon')).to_be_visible()
                expect(page.locator('#ribbonCanvas')).to_be_visible()
                expect(props.get_by_label('項目のラベル', exact=True)).to_have_value('集計を実行')
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (width, height)
                page.locator('#ribbonCanvas').scroll_into_view_if_needed()
                capture(f'ribbon-builder-{width}x{height}')
                props.scroll_into_view_if_needed()
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (width, height)
                capture(f'ribbon-settings-{width}x{height}')
            passed('1440 px desktop and 390/320 px mobile keep the live ribbon and builder within the viewport width')
            assert not errors and not dialogs and not crashes, (errors, dialogs, crashes)
            assert not requests, requests
            passed('ribbon scenarios produce no uncaught errors, native dialogs, crashes or unintended HTTP sends')
            completed = True
            browser.close()
    finally:
        (out / 'results.json').write_text(json.dumps({'ok': completed, 'mode': 'native Chromium HTTP', 'native_indexeddb': True,
            'checks': checks, 'screenshots': screenshots, 'page_errors': errors, 'native_dialogs': dialogs, 'crashes': crashes,
            'unexpected_requests': requests}, ensure_ascii=False, indent=2))
        if server:
            server.shutdown()
            server.server_close()
        proxy.WORKSPACE_FILE = original_file
        temp.cleanup()


if __name__ == '__main__':
    main()
