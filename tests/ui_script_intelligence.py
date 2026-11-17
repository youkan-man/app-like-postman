"""Semantic completion against the real application, language Worker and live data."""
from __future__ import annotations

from contextlib import contextmanager
import json
import os
from pathlib import Path
import tempfile

from playwright.sync_api import expect, sync_playwright
from test_proxy import proxy, start_server


def main():
    if os.environ.get('MINIPOST_INLINE_TEST') == '1':
        raise RuntimeError('Semantic IntelliSense acceptance requires a real HTTP origin')
    server = None
    url = os.environ.get('MINIPOST_REMOTE_URL')
    if not url:
        server, url = start_server(proxy.Handler)
    out = Path(os.environ.get('ARTIFACT_DIR', tempfile.mkdtemp(prefix='minipost-intelligence-'))) / 'script-intelligence'
    out.mkdir(parents=True, exist_ok=True)
    checks, screenshots, errors, dialogs, crashes, forbidden_requests = [], [], [], [], [], []
    page = None
    completed = False

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

    orders = {'orders': [{'id': 1, 'customer': {'name': 'Ada', 'active': True}, 'price': 12},
                         {'id': 2, 'customer': {'name': 'Lin', 'active': False}, 'price': 8}], 'currency': 'JPY'}
    helper_source = 'return input.orders.map(order => ({name: order.customer.name, amount: order.price * 2}));'
    workspace = {
        'version': 2, 'collections': [{'_mpId': 'intel-collection', 'info': {'name': 'Catalog',
            'schema': 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'}, 'variable': [],
            'item': [{'_mpId': 'intel-request', 'name': 'Fetch orders', 'request': {'method': 'GET',
                'url': 'https://example.invalid/orders', 'header': [], 'body': {'mode': 'none'}}, 'settings': {}}]}],
        'tabs': [], 'history': [], 'globals': [{'key': 'globalRegion', 'value': 'private-global-value'}],
        'environmentId': 'intel-env', 'environments': [{'id': 'intel-env', 'name': 'Staging API',
            'values': [{'key': 'apiToken', 'value': 'private-test-token'}, {'key': 'apiUrl', 'value': 'https://example.invalid'}]}],
        'scripts': [
            {'id': 'intel-main', 'name': '注文を集計', 'source': '', 'input': json.dumps(orders), 'inputFormat': 'json', 'timeoutMs': 0},
            {'id': 'intel-helper', 'name': '注文を変換', 'source': helper_source, 'input': json.dumps(orders), 'inputFormat': 'json', 'timeoutMs': 0},
        ],
        'scriptData': {'lastSummary': {'total': 20, 'items': [{'code': 'A', 'quantity': 2}]}, 'preferences': {'compact': True}},
    }
    bundle = {'kind': 'minipost.workspace', 'version': 1, 'workspace': workspace}

    try:
        with sync_playwright() as playwright, capture_failure():
            browser = playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM'), headless=True, args=['--no-sandbox'])
            context = browser.new_context(viewport={'width': 1440, 'height': 900})
            page = context.new_page()
            page.set_default_timeout(15000)
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('dialog', lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))
            page.on('crash', lambda: crashes.append('page crashed'))
            context.on('request', lambda request: forbidden_requests.append(request.url)
                       if '/__intelligence_should_not_execute' in request.url or '/api/request' in request.url else None)

            def ready():
                expect(page.locator('#connectionStatus')).to_contain_text('connected')
                expect(page.locator('#saveState')).not_to_have_text('ローカルデータを読込中…')

            def save():
                expect(page.locator('#saveState')).to_have_text('ローカルに保存済み')

            def open_script(identifier):
                if page.locator('#toggleSidebar').get_attribute('aria-expanded') != 'true':
                    page.locator('#toggleSidebar').click()
                page.locator('[data-sidebar="scripts"]').click()
                page.locator(f'[data-script-id="{identifier}"] .tree-open').click()
                expect(page.locator('.scripts-page')).to_be_visible()

            def editor():
                area = page.get_by_label('スクリプトのコード', exact=True)
                return area, page.locator('.standalone-script-code .source-editor')

            def analyze(source):
                before, marker, after = source.partition('¦')
                text = before + after if marker else source
                # DOM textarea selections and the language service use UTF-16
                # code units, while Python len() counts Unicode code points.
                position = len((before if marker else text).encode('utf-16-le')) // 2
                area, root = editor()
                area.fill(text)
                area.evaluate('(element, position) => element.setSelectionRange(position, position)', position)
                area.press('Control+Space')
                try:
                    expect(root).to_have_attribute('data-intelligence', 'ready', timeout=20000)
                except AssertionError as error:
                    raise AssertionError('Language Worker failed: ' + (root.locator('.source-intelligence-retry').get_attribute('title') or '')) from error
                return area, root, root.locator('.source-suggestions')

            def offer(source, name):
                area, root, suggestions = analyze(source)
                expect(suggestions).to_be_visible()
                option = suggestions.get_by_role('option', name=name, exact=True)
                expect(option).to_be_attached()
                option.scroll_into_view_if_needed()
                expect(option).to_be_visible()
                return area, root, suggestions, option

            def capture(name):
                page.screenshot(path=str(out / (name + '.png')), full_page=True)
                screenshots.append(name + '.png')

            page.goto(url, wait_until='domcontentloaded')
            ready()
            page.locator('#import').click()
            page.get_by_label('インポートJSON', exact=True).fill(json.dumps(bundle, ensure_ascii=False))
            page.locator('#modalSubmit').click()
            expect(page.locator('#modalTitle')).to_contain_text('全体バックアップ')
            with page.expect_navigation(wait_until='domcontentloaded'):
                page.locator('#modalSubmit').click()
            ready()
            # A failed module fetch must not strand the editor in a loading
            # state or discard the user's code. Retry against the actual Worker.
            context.route('**/script-intelligence-worker.mjs', lambda route: route.abort('failed'))
            open_script('intel-main')
            area, root = editor()
            area.fill('input.orders[0].customer.na')
            area.press('Control+Space')
            expect(root).to_have_attribute('data-intelligence', 'error')
            retry = root.get_by_role('button', name='コード補完を再試行', exact=True)
            expect(retry).to_be_visible()
            expect(area).to_have_value('input.orders[0].customer.na')
            context.unroute('**/script-intelligence-worker.mjs')
            retry.click()
            expect(root).to_have_attribute('data-intelligence', 'ready', timeout=30000)
            expect(root.locator('.source-suggestions').get_by_role('option', name='name', exact=True)).to_be_visible()
            expect(area).to_be_focused()
            passed('a failed language Worker fetch exposes retry and recovers without losing source or textarea focus')

            area, root, suggestions, option = offer('input.orders[0].customer.na', 'name')
            expect(option).to_contain_text('string')
            area.press('Tab')
            expect(area).to_have_value('input.orders[0].customer.name')
            area.press('Control+z')
            expect(area).to_have_value('input.orders[0].customer.na')
            passed('live JSON input supplies nested property types and semantic completion preserves native Undo')

            area, root, suggestions, option = offer('const 𐐀customer = input.orders[0].customer;\n𐐀customer.na¦me', 'name')
            option.click()
            expect(area).to_have_value('const 𐐀customer = input.orders[0].customer;\n𐐀customer.name')
            passed('completion inside an identifier preserves UTF-16 positions after supplementary Unicode characters')

            offer('input.orders.map(order => order.customer.¦)', 'name')
            offer('const {orders} = input; const [first] = orders; first.pr', 'price')
            offer('const customer = input.orders[0].customer; customer.name.toU', 'toUpperCase')
            passed('array callback, destructuring and aliases propagate input types into standard method completion')

            area, root, suggestions, option = offer('store.get("lastSummary").items[0].qu', 'quantity')
            expect(option).to_contain_text('number')
            area, root, suggestions, option = offer('const read = store.get; read("last¦")', 'lastSummary')
            option.click()
            expect(area).to_have_value('const read = store.get; read("lastSummary")')
            passed('shared data contributes typed member and quoted-key completions through an API alias')

            offer('const scope = minipost.environment; scope.get("apiT¦")', 'apiToken')
            offer('pm.globals.get("globalR¦")', 'globalRegion')
            offer('const {get} = minipost.requests; await get("Fetch¦")', 'Fetch orders')
            offer('await minipost.environments.get("Stag¦")', 'Staging API')
            assert 'private-test-token' not in root.inner_text()
            assert 'private-global-value' not in root.inner_text()
            passed('variable, request and environment dictionaries use actual workspace names without displaying secret values')

            area, root, suggestions, option = offer('await scripts.run("注文¦", input)', '注文を変換')
            option.click()
            expect(area).to_have_value('await scripts.run("注文を変換", input)')
            offer('const records = await scripts.run("注文を変換", input); records[0].am', 'amount')
            offer('const records = await scripts.run("intel-helper", input); records[0].amount.toF', 'toFixed')
            passed('saved script references complete by name and ID, and their inferred return types continue through await and indexing')

            area, root = editor()
            area.fill('input.orders[0].customer.na')
            area.fill('const newest = {onlyLatest: 1}; newest.only')
            area.press('Control+Space')
            expect(root).to_have_attribute('data-intelligence', 'ready')
            suggestions = root.locator('.source-suggestions')
            expect(suggestions.get_by_role('option', name='onlyLatest', exact=True)).to_be_visible()
            assert suggestions.get_by_role('option', name='name', exact=True).count() == 0
            area.press('Enter')
            expect(area).to_have_value('const newest = {onlyLatest: 1}; newest.onlyLatest')
            passed('rapid edits discard stale language-service answers and accept only the current source completion')

            page.get_by_label('スクリプトの入力', exact=True).fill('{"clients":[{"displayName":"Sara"}],"limit":2}')
            offer('input.clients[0].dis', 'displayName')
            _, _, suggestions = analyze('input.or')
            expect(suggestions).to_be_hidden()
            page.get_by_label('入力形式', exact=True).select_option('text')
            page.get_by_label('スクリプトの入力', exact=True).fill('text input')
            offer('input.toU', 'toUpperCase')
            page.get_by_label('入力形式', exact=True).select_option('json')
            page.get_by_label('スクリプトの入力', exact=True).fill(json.dumps(orders))
            passed('changing JSON fields or switching to text updates the same live Worker dictionary without a reload')

            page.get_by_role('button', name='スクリプトの操作', exact=True).click()
            page.get_by_role('menuitem', name='共有データ', exact=True).click()
            page.get_by_label('スクリプト共有データ', exact=True).fill('{"newSummary":{"label":"updated","count":4}}')
            page.locator('#modalSubmit').click()
            expect(page.locator('#modal')).not_to_be_visible()
            offer('store.get("newS¦")', 'newSummary')
            offer('store.get("newSummary").la', 'label')
            _, _, suggestions = analyze('store.get("last¦")')
            expect(suggestions).to_be_hidden()
            passed('edited shared data adds new keys and types and removes stale keys from completion')

            save()
            open_script('intel-helper')
            page.locator('.scripts-page').get_by_label('スクリプト名', exact=True).fill('更新した変換')
            page.get_by_label('スクリプトのコード', exact=True).fill('return {changedField: input.currency, count: input.orders.length};')
            save()
            open_script('intel-main')
            offer('await scripts.run("更新¦", input)', '更新した変換')
            offer('const changed = await scripts.run("更新した変換", input); changed.cha', 'changedField')
            _, _, suggestions = analyze('await scripts.run("注文を変¦", input)')
            expect(suggestions).to_be_hidden()
            passed('renaming and editing another saved script refreshes reference names and its return type in the existing editor')

            offer('fetch("/__intelligence_should_not_execute"); input.orders[0].customer.na', 'name')
            assert forbidden_requests == [], forbidden_requests
            passed('completion analyzes source without executing edited code or sending HTTP requests')

            page.get_by_label('スクリプトのコード', exact=True).fill('return {total: input.orders.reduce((sum, item) => sum + item.price, 0)};')
            page.locator('#runStandaloneScript').click()
            expect(page.locator('#standaloneScriptStatus')).to_have_attribute('data-state', 'success')
            assert json.loads(page.locator('#standaloneScriptResult').inner_text()) == {'total': 20}
            save()
            passed('the same source editor still executes JavaScript normally when the user explicitly runs it')

            if page.locator('#toggleSidebar').get_attribute('aria-expanded') == 'true':
                page.locator('#toggleSidebar').click()
            area, root, suggestions, option = offer(' ' * 60 + 'input.orders[0].customer.na', 'name')
            wide_box, wide_editor = suggestions.bounding_box(), root.bounding_box()
            assert wide_box and wide_editor and wide_box['x'] - wide_editor['x'] > 200, (wide_box, wide_editor)
            page.set_viewport_size({'width': 390, 'height': 844})
            # Keep the existing popup open: no focus call, typing or Ctrl+Space
            # may disguise a resize-placement failure by re-creating it.
            expect(suggestions).to_be_visible()
            page.wait_for_function('''() => {
                const root = document.querySelector('.standalone-script-code .source-editor');
                const popup = root.querySelector('.source-suggestions');
                const editor = root.getBoundingClientRect(), box = popup.getBoundingClientRect();
                return !popup.hidden && box.left >= editor.left && box.right <= editor.right + 1 &&
                    box.top >= editor.top && box.bottom <= editor.bottom + 1;
            }''')
            capture('intelligence-live-resize-390')
            option.click()
            expect(area).to_have_value(' ' * 60 + 'input.orders[0].customer.name')
            page.set_viewport_size({'width': 1440, 'height': 900})
            passed('an already-open completion popup follows a live viewport resize and remains pointer-selectable')

            source = 'const customer = input.orders[0].customer;\nconst total = input.orders.reduce(\n  (sum, order) => sum + order.price, 0\n);\n\ncustomer.'
            for width, height in [(1440, 900), (390, 844), (320, 720)]:
                page.set_viewport_size({'width': width, 'height': height})
                if page.locator('#navClose').is_visible() and page.locator('#toggleSidebar').get_attribute('aria-expanded') == 'true':
                    page.locator('#navClose').click()
                _, _, suggestions, _ = offer(source, 'name')
                box = suggestions.bounding_box()
                assert box and box['x'] >= 0 and box['x'] + box['width'] <= width + 1, box
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                capture(f'intelligence-{width}x{height}')
            passed('typed completion remains usable inside the desktop and 390/320 px editor without horizontal overflow')
            assert not errors, errors
            assert not dialogs, dialogs
            assert not crashes, crashes
            passed('semantic editing produces no uncaught browser errors, native dialogs or page crashes')
            completed = True
            browser.close()
    finally:
        (out / 'results.json').write_text(json.dumps({'ok': completed, 'mode': 'native Chromium HTTP',
            'engine': 'TypeScript Language Service', 'checks': checks, 'screenshots': screenshots,
            'page_errors': errors, 'native_dialogs': dialogs, 'crashes': crashes,
            'unexpected_requests': forbidden_requests}, ensure_ascii=False, indent=2))
        if server:
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    main()
