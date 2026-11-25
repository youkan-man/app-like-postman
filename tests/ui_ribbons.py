"""Request-owned ribbon authoring, real Worker actions and native persistence.

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
    density_metrics = []
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
                try:
                    snapshot = page.evaluate(READ_WORKSPACE)
                    (out / 'failure-workspace.json').write_text(json.dumps(snapshot, ensure_ascii=False, indent=2))
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

            def request_records(workspace):
                def descend(items):
                    for item in items:
                        if 'request' in item:
                            yield item
                        yield from descend(item.get('item', []))
                for collection in workspace['collections']:
                    yield from descend(collection.get('item', []))
                yield from workspace['tabs']

            def ribbon_states(workspace):
                result = {}
                for record in request_records(workspace):
                    state = record.get('ribbonState')
                    if state:
                        result.setdefault(state['id'], state)
                return result

            def scope(workspace, owner):
                return ribbon_states(workspace)[owner]

            def owner_state(name):
                return next(record['ribbonState'] for record in request_records(saved())
                            if record['name'] == name and record.get('ribbonState'))

            def close_navigation():
                if page.locator('#navClose').is_visible() and page.locator('#toggleSidebar').get_attribute('aria-expanded') == 'true':
                    page.locator('#navClose').click()

            def operate():
                if page.locator('#ribbonBackToRequest').is_visible():
                    page.locator('#ribbonBackToRequest').click()
                elif not page.locator('#exchange').is_visible():
                    sidebar('collections')
                close_navigation()
                expect(page.locator('#exchange')).to_be_visible()

            def edit_ribbons():
                if not page.locator('#ribbonOwnerSelect').is_visible():
                    operate()
                    page.locator('#requestRibbonEdit').click()
                expect(page.locator('#ribbonOwnerSelect')).to_be_visible()
                expect(page.locator('#customRibbon')).not_to_be_visible()

            def select_request(name):
                edit_ribbons()
                options = page.locator('#ribbonOwnerSelect option').evaluate_all(
                    '(options) => options.map(option => ({value: option.value, label: option.textContent}))')
                matches = [option for option in options if name in option['label']]
                exact = [option for option in matches if name + ' copy' not in option['label']]
                choice = exact if len(exact) == 1 else matches
                assert len(choice) == 1, (name, options)
                page.locator('#ribbonOwnerSelect').select_option(choice[0]['value'])
                operate()
                expect(page.locator('#requestName')).to_have_value(name)

            def create_draft(name, suffix, initial=False):
                if not initial:
                    operate()
                    sidebar('collections')
                    page.locator('#addTab').click()
                    page.get_by_role('menuitem', name='HTTPリクエスト', exact=True).click()
                close_navigation()
                page.locator('#requestName').fill(name)
                page.locator('#url').fill('https://example.invalid/' + suffix)
                return next(item['id'] for item in saved()['tabs'] if item['name'] == name)

            def create_ribbon(name, key):
                edit_ribbons()
                sidebar('ribbons')
                page.locator('#sidebarAdd').click()
                page.get_by_role('menuitem', name='リボンを作成', exact=True).click()
                page.locator('#modal').get_by_label('リボン名', exact=True).fill(name)
                page.locator('#modalSubmit').click()
                expect(page.locator('#modal')).not_to_be_visible()
                close_navigation()
                page.get_by_role('button', name='リボンの操作', exact=True).click()
                page.get_by_role('menuitem', name='リボンの設定', exact=True).click()
                page.locator('#modal').get_by_label('リボンの参照キー', exact=True).fill(key)
                page.locator('#modalSubmit').click()
                expect(page.locator('#modal')).not_to_be_visible()
                return next(item['id'] for item in current_scope()['ribbons'] if item['key'] == key)

            def open_ribbon(identifier):
                edit_ribbons()
                sidebar('ribbons')
                page.locator(f'[data-ribbon-id="{identifier}"] .tree-open').click()
                expect(page.locator('.ribbons-page')).to_be_visible()
                close_navigation()

            def choose(identifier):
                if page.locator('#ribbonCanvas').is_hidden():
                    page.locator('#ribbonMobileContext [data-ribbon-back-to-list]').click()
                page.locator(f'#ribbonCanvas [data-control-id="{identifier}"]').click()
                expect(props).to_be_visible()

            def control_state(workspace, identifier, owner):
                return next(control for ribbon in scope(workspace, owner)['ribbons'] for group in ribbon['groups']
                            for control in group['controls'] if control['id'] == identifier)

            def current_scope():
                workspace = saved()
                selected = page.locator('#ribbonOwnerSelect').input_value()
                if selected.startswith('draft:'):
                    return next(tab['ribbonState'] for tab in workspace['tabs'] if selected == 'draft:' + tab['id'])
                for record in request_records(workspace):
                    if record.get('ribbonState') and record.get('_mpId') and record['_mpId'] in selected:
                        return record['ribbonState']
                raise AssertionError('Unknown request owner: ' + selected)

            def add_control(kind, key, label):
                page.locator('.ribbon-editor-tools').get_by_role('button', name='項目を追加 ▾', exact=True).click()
                page.get_by_role('menuitem', name=kind, exact=True).click()
                props.get_by_label('項目のラベル', exact=True).fill(label)
                reference = props.locator('.ribbon-reference-settings')
                if not reference.evaluate('node=>node.open'):
                    reference.locator('summary').click()
                props.get_by_label('項目の参照キー', exact=True).fill(key)
                props.get_by_label('項目の参照キー', exact=True).press('Tab')
                if reference.evaluate('node=>node.open'):
                    reference.locator('summary').click()
                return next(control['id'] for ribbon in current_scope()['ribbons'] for group in ribbon['groups']
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
            request_a = 'リクエストA'
            request_b = 'リクエストB'
            draft_a = create_draft(request_a, 'request-a', initial=True)
            main_id = create_ribbon('操作パネル', 'main')
            owner_a = owner_state(request_a)['id']
            page.locator('.ribbon-editor-tools').get_by_role('button', name='項目を追加 ▾', exact=True).click()
            page.get_by_role('menuitem', name='グループを追加', exact=True).click()
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
            assert [item['type'] for item in scope(workspace, owner_a)['ribbons'][0]['groups'][0]['controls']] == ['toggle', 'number', 'text', 'select', 'display', 'button']
            assert workspace['collections'] == [] and [tab['id'] for tab in workspace['tabs']] == [draft_a]
            expect(page.locator('#customRibbon')).not_to_be_visible()
            passed('a visible request draft owns its named ribbon, group and six typed controls; the editor has no duplicate live ribbon')

            control_sections = [('button', run_id, None), ('text', query_id, 'input'),
                                ('number', count_id, 'input'), ('select', mode_id, 'options'),
                                ('toggle', toggle_id, 'state'), ('display', output_id, 'display')]
            for width, height in [(1440, 900), (320, 720)]:
                page.set_viewport_size({'width': width, 'height': height})
                for kind, identifier, section in control_sections:
                    choose(identifier)
                    expect(props).to_have_attribute('data-object-type', kind)
                    expect(props.get_by_label('項目の参照キー', exact=True)).not_to_be_visible()
                    assert not props.locator('.ribbon-reference-settings').evaluate('node=>node.open')
                    for candidate in ['input', 'state', 'options', 'display']:
                        target = props.locator(f'[data-property-section="{candidate}"]')
                        if candidate == section:
                            expect(target).to_be_visible()
                        else:
                            expect(target).to_have_count(0)
                    if kind == 'display':
                        expect(props.locator('.ribbon-actions-editor')).to_have_count(0)
                        expect(props.get_by_label('操作を許可', exact=True)).to_have_count(0)
                        expect(props.get_by_role('button', name='有効条件を追加', exact=True)).to_have_count(0)
                    else:
                        expect(props.locator('.ribbon-actions-editor')).to_be_visible()
                    if kind == 'button':
                        expect(props.get_by_label('項目の値', exact=True)).to_have_count(0)
                        expect(props.get_by_label('表示する値', exact=True)).to_have_count(0)
                    elif kind in ['text', 'number']:
                        expect(props.get_by_label('項目の値', exact=True)).to_have_attribute('type', kind)
                    elif kind == 'select':
                        options = props.locator('[data-property-section="options"]')
                        expect(options.get_by_role('radio')).to_have_count(2)
                        expect(options.locator('select')).to_have_count(0)
                        options.get_by_role('radio').nth(1).check()
                        assert control_state(saved(), mode_id, owner_a)['value'] == 'detail'
                        options.get_by_role('radio').first.check()
                        assert control_state(saved(), mode_id, owner_a)['value'] == 'normal'
                    props.locator('.ribbon-property-heading').scroll_into_view_if_needed()
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (kind, width)
                    assert props.evaluate('''node=>[...node.querySelectorAll('input,select,textarea,button')]
                        .filter(control=>control.offsetParent!==null).every(control=>{
                            const rect=control.getBoundingClientRect();return rect.left>=-1&&rect.right<=innerWidth+1;
                        })'''), (kind, width)
                    capture(f'ribbon-type-{kind}-{width}')
            page.set_viewport_size({'width': 1440, 'height': 900})
            passed('six control types expose relevant bounded settings, direct selection radios and compact hidden reference details at desktop and 320px')

            operate()
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
            assert control_state(saved(), mode_id, owner_a)['value'] == 'detail'
            passed('request ribbon typing retains focus and conditions react to numeric, selected and checkbox values')

            child_id = create_script('子集計', "const value=ribbon.get('main.count')*2; ribbon.set('main.result',{value}); return value;")
            script_id = create_script('リボン集計', 'const value=await scripts.run(' + json.dumps(child_id) + ',input); store.set("event",input); store.set("runs",(store.get("runs")||0)+1); return value;')
            self_id = create_script('変更を一度だけ処理', "store.set('changes',(store.get('changes')||0)+1); store.set('previousCount',input.previousValue); ribbon.set('main.count',input.value+1);")
            fail_id = create_script('失敗する処理', "ribbon.set('main.count',999); store.set('failedWrite',true); throw Error('ribbon failure');")
            expect(page.locator('#customRibbon')).not_to_be_visible()
            open_ribbon(main_id)
            choose(run_id)
            script_action = action('script', script_id)
            original_source = next(script['source'] for script in saved()['scripts'] if script['id'] == script_id)
            edited_source = "store.set('embeddedRibbonEdited',true);\n" + original_source
            selected_owner = page.locator('#ribbonOwnerSelect').input_value()
            expect(script_action.locator('.embedded-script-editor')).not_to_be_visible()
            script_action.locator('.ribbon-action-target').get_by_role('button', name='編集', exact=True).click()
            source = script_action.get_by_label('リボンのスクリプト', exact=True)
            expect(source).to_be_visible();expect(source).to_be_focused()
            source.evaluate('node=>window.__embeddedRibbonEditor=node')
            expect(page.locator('html')).to_have_attribute('data-workspace-view', 'ribbons')
            expect(page.locator('#ribbonOwnerSelect')).to_have_value(selected_owner)
            expect(props.get_by_label('項目のラベル', exact=True)).to_have_value('集計を実行')
            source.press('Control+a');page.keyboard.insert_text(edited_source)
            assert next(script['source'] for script in saved()['scripts'] if script['id'] == script_id) == edited_source
            assert source.evaluate('node=>node===window.__embeddedRibbonEditor && node.selectionStart===node.value.length')
            source.press('Control+z');expect(source).to_have_value(original_source);expect(source).to_be_focused()
            assert next(script['source'] for script in saved()['scripts'] if script['id'] == script_id) == original_source
            source.press('Control+Shift+z');expect(source).to_have_value(edited_source);expect(source).to_be_focused()
            assert next(script['source'] for script in saved()['scripts'] if script['id'] == script_id) == edited_source
            assert source.evaluate('node=>node===window.__embeddedRibbonEditor')
            capture('ribbon-embedded-script-desktop')
            page.set_viewport_size({'width': 320, 'height': 720})
            source.scroll_into_view_if_needed()
            expect(source).to_be_visible()
            expect(page.locator('#ribbonMobileContext')).to_contain_text(request_a)
            expect(page.locator('#ribbonMobileContext')).to_contain_text('集計を実行')
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            capture('ribbon-embedded-script-320')
            page.set_viewport_size({'width': 1440, 'height': 900})
            operate()
            live(run_id).click()
            expect(live(output_id)).to_have_text('{"value":6}')
            expect(page.locator('#ribbonLiveResult')).to_have_attribute('data-state', 'success')
            workspace = saved()
            event = workspace['scriptData']['event']
            assert event['type'] == 'click' and event['controlId'] == run_id and event['ribbonId'] == main_id
            assert event['values']['count'] == 3 and event['values']['query'] == 'alpha' and workspace['scriptData']['runs'] == 1
            passed('the request ribbon runs parent and child Workers with typed event input and shared writes in its owner')
            assert workspace['scriptData']['embeddedRibbonEdited'] is True
            open_ribbon(main_id);choose(run_id)
            script_action = props.locator('.ribbon-action').first
            script_action.locator('.ribbon-action-target').get_by_role('button', name='編集', exact=True).click()
            script_action.get_by_label('リボンのスクリプト', exact=True).fill(original_source)
            assert next(script['source'] for script in saved()['scripts'] if script['id'] == script_id) == original_source
            passed('ribbon action Edit retains its owner and control, native Undo and saved source; execution uses the in-place edited script')

            open_ribbon(main_id)
            choose(count_id)
            action('script', self_id)
            operate()
            live(count_id).fill('5')
            live(count_id).press('Tab')
            expect(live(count_id)).to_have_value('6')
            expect(page.locator('#ribbonLiveResult')).to_have_attribute('data-state', 'success')
            assert saved()['scriptData']['changes'] == 1 and saved()['scriptData']['previousCount'] == 3
            passed('user change runs once and script-driven updates do not recursively fire change actions')

            details_id = create_ribbon('結果パネル', 'details')
            details_value = add_control('値表示', 'details_result', '状態')
            typed(props, '表示する値', 'text', '待機中')
            operate()
            page.get_by_label('表示するリボン', exact=True).select_option(main_id)
            open_ribbon(main_id)
            chain_id = add_control('ボタン', 'switch', '結果へ切り替え')
            action('set', output_id, {'chain': True})
            action('toggle', toggle_id)
            condition(action('activate', details_id), '実行条件', toggle_id, 'falsy')
            operate()
            live(chain_id).click()
            expect(page.get_by_label('表示するリボン', exact=True)).to_have_value(details_id)
            expect(live(details_value)).to_have_text('待機中')
            workspace = saved()
            assert control_state(workspace, output_id, owner_a)['value'] == {'chain': True}
            assert control_state(workspace, toggle_id, owner_a)['value'] is False
            page.get_by_label('表示するリボン', exact=True).select_option(main_id)
            expect(live(output_id)).not_to_be_visible()
            passed('ordered set, toggle and conditional activation observe prior changes within the same request')

            open_ribbon(main_id)
            choose(query_id)
            action('set', output_id, {'should': 'rollback'})
            action('script', fail_id)
            operate()
            live(query_id).fill('beta')
            live(query_id).press('Tab')
            expect(page.locator('#ribbonLiveResult')).to_have_attribute('data-state', 'error')
            expect(page.locator('#ribbonLiveResult')).to_contain_text('ribbon failure')
            workspace = saved()
            assert control_state(workspace, query_id, owner_a)['value'] == 'beta'
            assert control_state(workspace, count_id, owner_a)['value'] == 6
            assert control_state(workspace, output_id, owner_a)['value'] == {'chain': True}
            assert 'failedWrite' not in workspace['scriptData']
            expect(live(query_id)).to_be_enabled()
            passed('a failed action rolls back script writes while retaining the direct input and visible execution error')

            standalone_id = create_script('リボンAPI確認', "const count=minipost.ribbon.get('main.count'); ribbon.set('details.details_result',{count}); ribbon.activate('details'); return ribbon.values('details');")
            page.locator('#runStandaloneScript').click()
            expect(page.locator('#standaloneScriptStatus')).to_have_attribute('data-state', 'success')
            assert json.loads(page.locator('#standaloneScriptResult').inner_text()) == {'details_result': {'count': 6}}
            expect(page.locator('#customRibbon')).not_to_be_visible()
            operate()
            expect(live(details_value)).to_have_text('{"count":6}')
            page.get_by_label('表示するリボン', exact=True).select_option(main_id)
            passed('standalone scripts use the selected request context while the script page has no global live ribbon')

            create_script('キー操作の分離確認', "store.set('unrelatedShortcutRuns',(store.get('unrelatedShortcutRuns')||0)+1); return store.get('unrelatedShortcutRuns');")
            expect(page.locator('#standaloneScriptStatus')).to_have_attribute('data-state', 'idle')
            operate()
            previous_changes = saved()['scriptData']['changes']
            live(count_id).fill('8')
            live(count_id).press('Control+Enter')
            expect(live(count_id)).to_have_value('9')
            workspace = saved()
            assert workspace['scriptData']['changes'] == previous_changes + 1
            assert workspace['scriptData']['previousCount'] == 6
            assert 'unrelatedShortcutRuns' not in workspace['scriptData']
            live(mode_id).press('Control+Enter')
            assert 'unrelatedShortcutRuns' not in saved()['scriptData']
            assert not requests, requests
            passed('ribbon Ctrl+Enter commits its change once without executing another script or sending the request')

            live(count_id).press('Control+s')
            expect(page.locator('#modal')).not_to_be_visible()
            workspace = saved()
            assert workspace['collections'] == [] and [tab['id'] for tab in workspace['tabs']] == [draft_a]
            assert control_state(workspace, count_id, owner_a)['value'] == 9
            passed('ribbon Ctrl+S saves its owner without registering a request or creating another draft')

            # Create B from the visible request UI; same keys are intentionally
            # reused to prove that definitions and live values belong to requests.
            draft_b = create_draft(request_b, 'request-b')
            expect(page.locator('#customRibbon')).not_to_be_visible()
            edit_ribbons()
            expect(page.locator(f'[data-ribbon-id="{main_id}"]')).to_have_count(0)
            b_main = create_ribbon('Bの操作パネル', 'main')
            owner_b = owner_state(request_b)['id']
            assert owner_b != owner_a
            b_count = add_control('数値入力', 'count', 'Bの件数')
            props.get_by_label('項目の値', exact=True).fill('3')
            b_output = add_control('値表示', 'result', 'Bの計算結果')
            typed(props, '表示する値', 'json', {'value': 0})
            b_run = add_control('ボタン', 'run', 'Bで集計を実行')
            action('script', script_id)
            b_secondary = create_ribbon('Bの補助パネル', 'secondary')
            operate()
            expect(page.get_by_label('表示するリボン', exact=True)).to_have_value(b_secondary)
            select_request(request_a)
            expect(page.get_by_label('表示するリボン', exact=True)).to_have_value(main_id)
            expect(live(count_id)).to_have_value('9')
            expect(live(b_count)).to_have_count(0)
            select_request(request_b)
            expect(page.get_by_label('表示するリボン', exact=True)).to_have_value(b_secondary)
            assert scope(saved(), owner_a)['activeRibbonId'] == main_id
            assert scope(saved(), owner_b)['activeRibbonId'] == b_secondary
            page.get_by_label('表示するリボン', exact=True).select_option(b_main)
            expect(live(count_id)).to_have_count(0)
            expect(live(b_count)).to_have_value('3')
            live(b_run).click()
            expect(live(b_output)).to_have_text('{"value":6}')
            workspace = saved()
            assert control_state(workspace, output_id, owner_a)['value'] == {'chain': True}
            assert control_state(workspace, count_id, owner_a)['value'] == 9
            assert control_state(workspace, b_count, owner_b)['value'] == 3
            passed('two requests reuse identical ribbon keys while keeping definitions, active selection, values and child-script writes independent')

            select_request(request_a)
            delayed_id = create_script('遅延した所有者への書き込み', "await new Promise(resolve=>setTimeout(resolve,1800)); const count=ribbon.get('main.count'); ribbon.set('main.result',{owner:'A',count}); return count;")
            page.locator('#runStandaloneScript').click()
            expect(page.locator('#standaloneScriptStatus')).to_have_attribute('data-state', 'running')
            expect(page.locator('#stopRelationGlobal')).to_be_visible()
            select_request(request_b)
            expect(live(b_count)).to_have_value('3')
            # Wait for the real operation to end, then read the committed state.
            # An async wait_for_function predicate resolves its Promise once;
            # a false resolved value does not trigger another predicate poll.
            expect(page.locator('#stopRelationGlobal')).not_to_be_visible()
            workspace = saved()
            actual = control_state(workspace, output_id, owner_a)['value']
            assert actual == {'owner': 'A', 'count': 9}, {
                'actual': actual, 'owner_count': control_state(workspace, count_id, owner_a)['value'],
                'script': next(script['source'] for script in workspace['scripts'] if script['id'] == delayed_id)}
            assert control_state(workspace, b_output, owner_b)['value'] == {'value': 6}
            assert any(script['id'] == delayed_id for script in workspace['scripts'])
            passed('a script completing after request navigation commits to the captured owner and leaves the new request untouched')

            select_request(request_a)
            page.locator('#duplicateRequest').click()
            copy_name = request_a + ' copy'
            expect(page.locator('#requestName')).to_have_value(copy_name)
            copy_state = owner_state(copy_name)
            owner_copy = copy_state['id']
            assert owner_copy not in [owner_a, owner_b]
            copy_count = next(control['id'] for ribbon in copy_state['ribbons'] if ribbon['key'] == 'main'
                              for group in ribbon['groups'] for control in group['controls'] if control['key'] == 'count')
            assert copy_count == count_id
            live(copy_count).fill('20')
            live(copy_count).press('Tab')
            expect(live(copy_count)).to_have_value('21')
            workspace = saved()
            assert control_state(workspace, count_id, owner_a)['value'] == 9
            assert control_state(workspace, b_count, owner_b)['value'] == 3
            assert control_state(workspace, copy_count, owner_copy)['value'] == 21
            passed('request duplication creates an independent ribbon owner, preserves script references and isolates copied values')

            select_request(request_a)
            before_registration = scope(saved(), owner_a)
            page.locator('#saveRequest').click()
            page.get_by_label('Request name', exact=True).fill(request_a)
            page.locator('#modalSubmit').click()
            expect(page.locator('#modal')).not_to_be_visible()
            workspace = saved()
            assert workspace['collections']
            registered = next(record for record in request_records(workspace) if record.get('_mpId') and record['name'] == request_a)
            assert registered['ribbonState'] == before_registration
            expect(live(count_id)).to_have_value('9')
            assert control_state(workspace, b_count, owner_b)['value'] == 3
            assert control_state(workspace, copy_count, owner_copy)['value'] == 21
            passed('registering a draft in a collection preserves its ribbon owner and references without altering other requests')

            before = saved()
            page.reload(wait_until='domcontentloaded')
            ready()
            operate()
            after = saved()
            assert ribbon_states(after) == ribbon_states(before)
            for key in ['scripts', 'scriptData']:
                assert after[key] == before[key], key
            assert any(item['id'] == standalone_id for item in after['scripts'])
            expect(page.locator('#requestName')).to_have_value(request_a)
            expect(live(count_id)).to_have_value('9')
            passed('saved-request and draft ribbons, independent values and linked scripts survive native IndexedDB reload')

            page.locator('#dataActions').click()
            with page.expect_download() as download:
                page.get_by_role('menuitem', name='全体エクスポート', exact=True).click()
            backup = out / 'ribbon-workspace.json'
            download.value.save_as(backup)
            bundle = json.loads(backup.read_text())
            assert ribbon_states(bundle['workspace']) == ribbon_states(after)
            assert scope(bundle['workspace'], owner_a)['activeRibbonId'] == main_id
            page.locator('#dataActions').click()
            page.get_by_role('menuitem', name='サーバーへ保存', exact=True).click()
            expect(page.locator('#serverSaveState')).to_have_class('saved')
            response = page.request.get(url.rstrip('/') + '/api/workspace')
            assert response.ok and ribbon_states(response.json()['workspace']) == ribbon_states(after)
            passed('whole export and explicit server save contain each request-owned ribbon definition and typed value')

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
            operate()
            expect(live(query_id)).to_have_value('beta')
            assert ribbon_states(saved()) == ribbon_states(after)
            select_request(request_b)
            expect(live(b_count)).to_have_value('3')
            expect(live(count_id)).to_have_count(0)
            select_request(request_a)
            expect(live(count_id)).to_have_value('9')
            passed('actual import-and-replace restores each request scope and preserves cross-request separation')

            for width, height in [(1440, 900), (390, 844), (320, 720)]:
                page.set_viewport_size({'width': width, 'height': height})
                operate()
                close_navigation()
                expect(page.locator('#customRibbon')).to_be_visible()
                live(toggle_id).check()
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (width, height)
                strip = page.locator('#customRibbon .ribbon-live-groups')
                assert strip.evaluate('node => node.scrollWidth <= node.clientWidth'), (width, height)
                live(chain_id).scroll_into_view_if_needed()
                assert live(chain_id).evaluate('node => {const b=node.getBoundingClientRect();return b.left>=0 && b.right<=innerWidth;}')
                capture(f'request-ribbon-{width}x{height}')
                live(chain_id).click()
                expect(page.get_by_label('表示するリボン', exact=True)).to_have_value(details_id)
                expect(live(details_value)).to_have_text('{"count":6}')
                assert control_state(saved(), toggle_id, owner_a)['value'] is False
                page.get_by_label('表示するリボン', exact=True).select_option(main_id)
                if width < 740:
                    passed(f'{width} px mobile reaches and executes the last ribbon action without horizontal scrolling')

                open_ribbon(main_id)
                expect(page.locator('#customRibbon')).not_to_be_visible()
                expect(page.locator('#ribbonOwnerSelect')).to_be_visible()
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (width, height)
                page.locator('.ribbon-page-title').scroll_into_view_if_needed()
                capture(f'ribbon-overview-{width}x{height}')
                page.locator('#ribbonCanvas').scroll_into_view_if_needed()
                capture(f'ribbon-editor-{width}x{height}')
                choose(run_id)
                expect(props.get_by_label('項目のラベル', exact=True)).to_have_value('集計を実行')
                props.scroll_into_view_if_needed()
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (width, height)
                if width < 740:
                    mobile_context = page.locator('#ribbonMobileContext')
                    expect(mobile_context).to_be_visible()
                    expect(mobile_context).to_contain_text(request_a)
                    expect(mobile_context).to_contain_text('集計を実行')
                    assert mobile_context.evaluate('node => {const b=node.getBoundingClientRect();return b.left>=0 && b.top>=0 && b.right<=innerWidth && b.bottom<=innerHeight;}'), (width, height)
                capture(f'ribbon-settings-{width}x{height}')
                if width < 740:
                    mobile_context.locator('[data-ribbon-back-to-list]').click()
                    expect(page.locator('#ribbonCanvas')).to_be_in_viewport()
                    expect(page.locator('#ribbonOwnerSelect')).to_be_visible()
                    expect(props).not_to_be_visible()
                    choose(run_id)
                    expect(props).to_be_in_viewport()
                    expect(page.locator('#ribbonCanvas')).not_to_be_visible()
                    expect(mobile_context).to_be_visible()
                    expect(mobile_context).to_contain_text(request_a)
                    expect(mobile_context).to_contain_text('集計を実行')
            passed('desktop and narrow mobile separate execution from editing and keep request identity, selected settings and controls within width')

            # Recreate an old global-ribbon backup through the supported import
            # UI. B and the copied request remain as independent current data.
            page.set_viewport_size({'width': 1440, 'height': 900})
            operate()
            legacy_bundle = json.loads(json.dumps(bundle))
            legacy_workspace = legacy_bundle['workspace']
            legacy_state = scope(legacy_workspace, owner_a)
            legacy_workspace['ribbons'] = legacy_state['ribbons']
            legacy_workspace['activeRibbonId'] = legacy_state['activeRibbonId']
            legacy_workspace['ribbonBindings'] = legacy_state.get('ribbonBindings', {})
            for record in request_records(legacy_workspace):
                if record.get('ribbonState', {}).get('id') == owner_a:
                    record.pop('ribbonState')
            legacy_original = json.loads(json.dumps(legacy_workspace['ribbons']))
            page.locator('#import').click()
            page.get_by_label('インポートJSON', exact=True).fill(json.dumps(legacy_bundle, ensure_ascii=False))
            page.locator('#modalSubmit').click()
            expect(page.locator('#modalTitle')).to_contain_text('全体バックアップ')
            with page.expect_navigation(wait_until='domcontentloaded'):
                page.locator('#modalSubmit').click()
            ready()
            operate()
            expect(page.locator('#requestName')).to_have_value(request_a)
            expect(page.locator('#customRibbon')).not_to_be_visible()
            create_script('旧共通リボンへ参照しない', "return {list:ribbon.list(),active:ribbon.active(),values:ribbon.values()};")
            page.locator('#runStandaloneScript').click()
            expect(page.locator('#standaloneScriptStatus')).to_have_attribute('data-state', 'success')
            assert json.loads(page.locator('#standaloneScriptResult').inner_text()) == {'list': [], 'active': None, 'values': {}}
            assert saved()['ribbons'] == legacy_original
            passed('legacy global ribbons remain preserved but do not appear or become an implicit script fallback for a request')

            edit_ribbons()
            page.get_by_role('button', name='以前のリボンを取り込む', exact=True).click()
            migrated = owner_state(request_a)
            migrated_count = next(control['id'] for ribbon in migrated['ribbons'] if ribbon['key'] == 'main'
                                  for group in ribbon['groups'] for control in group['controls'] if control['key'] == 'count')
            assert migrated_count == count_id
            assert migrated['id'] not in [owner_b, owner_copy]
            operate()
            expect(live(migrated_count)).to_have_value('9')
            live(migrated_count).fill('11')
            live(migrated_count).press('Tab')
            expect(live(migrated_count)).to_have_value('12')
            workspace = saved()
            assert workspace['ribbons'] == legacy_original
            assert control_state(workspace, b_count, owner_b)['value'] == 3
            assert control_state(workspace, copy_count, owner_copy)['value'] == 21
            passed('explicit legacy import creates an independently executable request copy without changing the archive or other requests')

            # A one-button ribbon exposes framing overhead that a full panel can
            # hide. Create it through the current request menu and measure the
            # rendered controls without shrinking their text or touch target.
            page.set_viewport_size({'width': 1440, 'height': 900})
            operate()
            sidebar('collections')
            page.locator('#addTab').click()
            new_request = page.get_by_role('menuitem', name='HTTPリクエスト', exact=True)
            single_request = '単一ボタンのリクエスト'
            if new_request.is_visible():
                new_request.click()
            else:
                page.get_by_role('menuitem', name='HTTPリクエスト', exact=True).click()
                page.locator('#modal').get_by_label('追加する名前', exact=True).fill(single_request)
                page.locator('#modalSubmit').click()
                expect(page.locator('#modal')).not_to_be_visible()
            close_navigation()
            page.locator('#requestName').fill(single_request)
            page.locator('#url').fill('https://example.invalid/single-button')
            saved()
            single_ribbon = create_ribbon('実行', 'single')
            single_button = add_control('ボタン', 'run', '実行')
            for width, height in [(1440, 900), (390, 844), (320, 720), (844, 390)]:
                page.set_viewport_size({'width': width, 'height': height})
                operate()
                expect(page.locator('#requestName')).to_have_value(single_request)
                bar = page.locator('#customRibbon')
                expect(bar).to_be_visible()
                expect(bar.get_by_role('button')).to_have_count(1)
                expect(bar.locator('.ribbon-live-heading')).not_to_be_visible()
                expect(bar.locator('.ribbon-live-group-name')).not_to_be_visible()
                expect(page.get_by_label('表示するリボン', exact=True)).not_to_be_visible()
                live(single_button).scroll_into_view_if_needed()
                metrics = bar.evaluate('''node => {
                    const ribbon = node.getBoundingClientRect();
                    const button = node.querySelector('[data-ribbon-input]');
                    const control = button.getBoundingClientRect();
                    return {width:innerWidth, height:innerHeight,
                        ribbon_height:ribbon.height, button_height:control.height,
                        overhead:ribbon.height-control.height,
                        space_above:control.top-ribbon.top, space_below:ribbon.bottom-control.bottom,
                        button_font_size:parseFloat(getComputedStyle(button).fontSize),
                        document_width:document.documentElement.scrollWidth};
                }''')
                density_metrics.append(metrics)
                assert metrics['ribbon_height'] <= metrics['button_height'] + 18, metrics
                assert metrics['button_height'] >= (36 if width < 740 else 32), metrics
                assert metrics['button_font_size'] >= 13, metrics
                assert metrics['document_width'] <= width, metrics
                expect(live(single_button)).to_be_in_viewport(ratio=1)
                capture(f'single-button-live-{width}x{height}')

                open_ribbon(single_ribbon)
                first_item = page.locator(f'#ribbonCanvas [data-control-id="{single_button}"]')
                expect(first_item).to_be_in_viewport(ratio=1)
                expect(page.locator('#ribbonOwnerSelect')).to_be_visible()
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (width, height)
                metrics['editor_item'] = first_item.evaluate('node => {const b=node.getBoundingClientRect();return {top:b.top,bottom:b.bottom,height:b.height};}')
                capture(f'single-button-editor-{width}x{height}')
            passed('one-button ribbons keep framing within 18 px of the readable button and show the first editor item immediately on desktop and mobile')

            page.set_viewport_size({'width': 1440, 'height': 900})
            log_script = create_script('ログのスクロール確認', """
for(let index=0;index<40;index++)console.log('initial '+index);
for(let index=0;index<120;index++){
  console.log('stream '+index);
  await tools.flow.delay(80);
}
return {lines:160};
""")
            page.get_by_role('button', name='スクリプトの操作', exact=True).click()
            page.get_by_role('menuitem', name='実行設定', exact=True).click()
            page.locator('#modal').get_by_label('スクリプト制限時間', exact=True).fill('30000')
            page.locator('#modalSubmit').click()
            expect(page.locator('#modal')).not_to_be_visible()
            assert next(script['timeoutMs'] for script in saved()['scripts'] if script['id'] == log_script) == 30000
            open_ribbon(single_ribbon)
            choose(single_button)
            action('script', log_script)
            operate()
            live(single_button).click()
            expect(page.locator('#ribbonLiveResult')).to_have_attribute('data-state', 'running')
            open_ribbon(single_ribbon)
            choose(single_button)
            log = props.locator('#ribbonOperationResult [data-ribbon-result="logs"]')
            expect(log).to_be_visible()
            log.scroll_into_view_if_needed()
            log.evaluate('node=>window.__ribbonScrollingLog=node')
            page.wait_for_function('''()=>{
                const node=window.__ribbonScrollingLog;
                return node?.isConnected && node.textContent.split('\\n').length>=50 &&
                    node.scrollHeight-node.clientHeight>600 &&
                    node.scrollHeight-node.clientHeight-node.scrollTop<=2;
            }''', timeout=30000)
            initial_log_top = log.evaluate('node=>node.scrollTop')
            log.hover()
            page.mouse.wheel(0, -360)
            page.wait_for_function('''before=>{
                const node=window.__ribbonScrollingLog;
                return node?.isConnected && node.scrollTop>20 && node.scrollTop<before-200;
            }''', arg=initial_log_top, timeout=30000)
            reading = log.evaluate('''node=>({top:node.scrollTop,left:node.scrollLeft,
                lines:node.textContent.split('\\n').length,page:document.querySelector('#workspacePage').scrollTop})''')
            page.wait_for_function('''count=>window.__ribbonScrollingLog?.textContent.split('\\n').length>=count+8''', arg=reading['lines'], timeout=30000)
            assert log.evaluate('node=>node===window.__ribbonScrollingLog')
            assert log.evaluate('(node,top)=>Math.abs(node.scrollTop-top)<=2', reading['top']), reading
            assert log.evaluate('(node,left)=>node.scrollLeft===left', reading['left'])
            assert page.locator('#workspacePage').evaluate('(node,top)=>Math.abs(node.scrollTop-top)<=2', reading['page'])
            capture('ribbon-stream-log-reading')
            log.hover()
            # Logs keep arriving while Playwright positions the pointer. Scroll
            # a full log height so the real wheel reaches the moving tail.
            page.mouse.wheel(0, log.evaluate('node=>node.scrollHeight'))
            page.wait_for_function('''()=>{
                const node=window.__ribbonScrollingLog;
                return node?.isConnected && node.scrollHeight-node.clientHeight-node.scrollTop<=2;
            }''', timeout=30000)
            tail_count = log.evaluate("node=>node.textContent.split('\\n').length")
            page.wait_for_function('''count=>window.__ribbonScrollingLog?.textContent.split('\\n').length>=count+8''', arg=tail_count, timeout=30000)
            assert log.evaluate('node=>node===window.__ribbonScrollingLog && node.scrollHeight-node.clientHeight-node.scrollTop<=2')
            expect(props.locator('#ribbonOperationResult')).to_have_attribute('data-state', 'success', timeout=35000)
            expect(log).to_contain_text('stream 119')
            assert log.evaluate('node=>node===window.__ribbonScrollingLog && node.scrollHeight-node.clientHeight-node.scrollTop<=2')
            expect(props.locator('[data-ribbon-result="value"]')).to_contain_text('160')
            capture('ribbon-stream-log-complete')
            passed('native wheel scrolling retains the same ribbon log and reading position during streamed updates, resumes tail following only at the bottom, and survives completion')
            assert not errors and not dialogs and not crashes, (errors, dialogs, crashes)
            assert not requests, requests
            passed('request-owned ribbon scenarios produce no uncaught errors, native dialogs, crashes or unintended HTTP sends')
            completed = True
            browser.close()
    finally:
        (out / 'results.json').write_text(json.dumps({'ok': completed, 'mode': 'native Chromium HTTP', 'native_indexeddb': True,
            'checks': checks, 'screenshots': screenshots, 'density_metrics': density_metrics, 'page_errors': errors, 'native_dialogs': dialogs, 'crashes': crashes,
            'unexpected_requests': requests}, ensure_ascii=False, indent=2))
        if server:
            server.shutdown()
            server.server_close()
        proxy.WORKSPACE_FILE = original_file
        temp.cleanup()


if __name__ == '__main__':
    main()
