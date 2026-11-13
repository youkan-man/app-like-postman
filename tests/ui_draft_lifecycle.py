"""Real Chromium checks for temporary editors and draft/history list selection.

Fixtures enter through the workspace import UI. Persistence assertions read the
native IndexedDB record; sending uses a real HTTP receiver in either VM mode.
"""
from __future__ import annotations

import base64
import copy
from contextlib import contextmanager
import difflib
from email.parser import BytesParser
from email.policy import default
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import tempfile
from threading import Thread

from playwright.sync_api import expect, sync_playwright
from test_proxy import EchoHandler, proxy, start_server


READ_WORKSPACE = """() => new Promise((resolve, reject) => {
  const open = indexedDB.open('minipost.workspace.v1', 1);
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const db = open.result, tx = db.transaction('state');
    const request = tx.objectStore('state').get('workspace');
    tx.oncomplete = () => {db.close(); resolve(request.result ? JSON.parse(request.result.json) : null);};
    tx.onabort = () => {db.close(); reject(tx.error);};
  };
})"""

SETTINGS = {'verify_tls': False, 'follow_redirects': True, 'timeout_ms': 30000}
DRAFT_IDS = [f'legacy-draft-{index}' for index in range(1, 6)]
HISTORY_IDS = [f'history-{index}' for index in range(1, 5)]


def assert_drafts_equal(actual, expected, context):
    actual_ids = [tab['id'] for tab in actual]
    expected_ids = [tab['id'] for tab in expected]
    assert actual_ids == expected_ids, f'{context}: draft identities changed: {actual_ids!r} != {expected_ids!r}'
    if actual != expected:
        before = json.dumps(expected, ensure_ascii=False, sort_keys=True, indent=2).splitlines()
        after = json.dumps(actual, ensure_ascii=False, sort_keys=True, indent=2).splitlines()
        difference = '\n'.join(difflib.unified_diff(before, after, fromfile='expected drafts', tofile='actual drafts', lineterm=''))
        raise AssertionError(f'{context}: persisted draft contents changed\n{difference}')


def workspace_fixture(receiver_url):
    def request(body):
        return {'method': 'POST', 'url': receiver_url+'/echo', 'header': [], 'auth': None,
                'body': {'mode': 'raw', 'raw': body, 'options': {'raw': {'language': 'text'}}}}

    drafts = [{'id': identifier, 'name': f'Legacy draft {index}', 'request': request(f'legacy-{index}'),
               'settings': copy.deepcopy(SETTINGS), 'dirty': True}
              for index, identifier in enumerate(DRAFT_IDS, 1)]
    collection = {'_mpId': 'collection-main', 'info': {'name': 'Lifecycle collection',
                  'schema': 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'},
                  'variable': [], 'item': [{'_mpId': 'folder-main', 'name': 'Saved requests', 'item': [
                      {'_mpId': 'saved-a', 'name': 'Saved A', 'request': request('saved-a'), 'settings': copy.deepcopy(SETTINGS)},
                      {'_mpId': 'saved-b', 'name': 'Saved B', 'request': request('saved-b'), 'settings': copy.deepcopy(SETTINGS)},
                  ]}]}
    history = [{'id': identifier, 'at': f'2026-01-0{index}T00:00:00Z', 'status': 200,
                'environmentId': '', 'environmentName': '', 'tab': {
                    'id': f'old-editor-{index}', 'name': f'History {index}',
                    'collectionId': 'collection-main', 'itemId': 'saved-a',
                    'request': request(f'history-body-{index}'), 'settings': copy.deepcopy(SETTINGS), 'dirty': False}}
               for index, identifier in enumerate(HISTORY_IDS, 1)]
    revisions = {'draft:'+tab['id']: [{'id': 'revision-'+tab['id'], 'at': '2026-01-01T00:00:00Z',
                  'reason': '変更', 'changed': ['request'], 'value': {
                      'name': tab['name'], 'request': copy.deepcopy(tab['request']), 'settings': copy.deepcopy(tab['settings'])}}]
                 for tab in drafts}
    return {'version': 2, 'collections': [collection], 'environments': [], 'globals': [],
            'tabs': drafts, 'activeId': drafts[0]['id'], 'environmentId': '', 'history': history,
            'collapsed': [], 'theme': 'light', 'revisions': revisions, 'relations': [], 'relationRuns': []}


def main():
    if os.environ.get('MINIPOST_INLINE_TEST') == '1':
        raise RuntimeError('ui_draft_lifecycle requires a real HTTP browser origin')
    app_url = os.environ.get('MINIPOST_REMOTE_URL')
    app = None
    if app_url:
        peer = os.environ['LOCAL_RELAY_VM_BROWSER_IP']
        port = int(os.environ.get('LOCAL_RELAY_VM_BROWSER_PORT') or '18081')
        receiver = ThreadingHTTPServer(('0.0.0.0', port), EchoHandler)
        Thread(target=receiver.serve_forever, daemon=True).start()
        receiver_url = f'http://{peer}:{port}'
    else:
        receiver, receiver_url = start_server()
        app, app_url = start_server(proxy.Handler)
    out = Path(os.environ.get('ARTIFACT_DIR', tempfile.mkdtemp(prefix='minipost-drafts-'))) / 'draft-lifecycle'
    out.mkdir(parents=True, exist_ok=True)
    checks, errors, dialogs, crashes, screenshots = [], [], [], [], []
    page = None
    completed = False

    def passed(name):
        checks.append(name)
        print('PASS '+name, flush=True)

    @contextmanager
    def capture_failure():
        try:
            yield
        except Exception:
            try:
                if page and not page.is_closed():
                    page.screenshot(path=str(out/'failure.png'), full_page=True)
                    screenshots.append('failure.png')
            except Exception as error:
                print('Could not capture failure screenshot: '+str(error), flush=True)
            raise

    try:
        with sync_playwright() as playwright, capture_failure():
            browser = playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM') or shutil.which('chromium'),
                                                 headless=True, args=['--no-sandbox'])
            page = browser.new_page(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('dialog', lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))
            page.on('crash', lambda: crashes.append('page crashed'))

            def ready():
                expect(page.locator('#connectionStatus')).to_contain_text('connected')
                expect(page.locator('#requestName')).to_have_count(1)
                expect(page.locator('#saveState')).not_to_have_text('ローカルデータを読込中…')

            def state():
                expect(page.locator('#saveState')).not_to_have_text('保存中…')
                return page.evaluate(READ_WORKSPACE)

            def reload():
                page.reload(wait_until='domcontentloaded')
                ready()

            def side(name):
                if page.locator('#toggleSidebar').get_attribute('aria-expanded') != 'true':
                    page.locator('#toggleSidebar').click()
                page.locator(f'#sidebarTabs [data-sidebar="{name}"]').click()
                expect(page.locator('#sidebarContent')).to_have_attribute('data-side', name)

            def load_workspace(value):
                if page.locator('#navClose').is_visible() and page.locator('#toggleSidebar').get_attribute('aria-expanded') == 'true':
                    page.locator('#navClose').click()
                page.locator('#import').click()
                bundle = {'kind': 'minipost.workspace', 'version': 1, 'workspace': value,
                          'layout': {'navigation': {'editor': 'body', 'sidebar': 'collections', 'response': 'pretty'}}}
                page.get_by_label('インポートJSON', exact=True).fill(json.dumps(bundle, ensure_ascii=False))
                page.locator('#modalSubmit').click()
                expect(page.locator('#modalTitle')).to_contain_text('全体バックアップ')
                with page.expect_navigation(wait_until='domcontentloaded'):
                    page.locator('#modalSubmit').click()
                ready()
                expect(page.locator('#modal')).not_to_be_visible()
                side('collections')

            def draft(identifier):
                return page.locator(f'[data-draft-id="{identifier}"][data-select-id="draft:{identifier}"]')

            def history(identifier):
                return page.locator(f'[data-history-id="{identifier}"][data-select-id="history:{identifier}"]')

            def open_saved(identifier, name):
                side('collections')
                page.locator(f'[data-item-id="{identifier}"] .tree-open').click()
                expect(page.locator('#requestName')).to_have_value(name)

            def open_history(identifier, edit=False):
                side('history')
                history(identifier).locator('.history-open[data-select-open]').click()
                expect(page.locator('#historyPage')).to_have_attribute('data-history-id', identifier)
                if edit:
                    page.locator('[data-history-edit]').click()
                    expect(page.locator('#exchange')).to_be_visible()

            def selected(identifiers):
                rows = page.locator('#sidebarContent [data-select-id][aria-selected="true"]')
                expect(rows).to_have_count(len(identifiers))
                assert set(rows.evaluate_all('(rows)=>rows.map(row=>row.dataset.selectId)')) == set(identifiers)
                expect(page.locator('#sidebarContent [data-select-id].list-selected')).to_have_count(len(identifiers))

            def clear_selection():
                rows = page.locator('#sidebarContent [data-select-id][aria-selected="true"]')
                if rows.count():
                    rows.first.locator('[data-select-open]').press('Escape')
                selected([])

            def confirmation(accept=True):
                dialog = page.locator('#appConfirm')
                expect(dialog).to_have_count(1)
                expect(dialog).to_be_visible()
                dialog.get_by_role('button', name='削除' if accept else 'キャンセル', exact=True).click()
                expect(dialog).to_have_count(0)

            def capture(name):
                expect(page.locator('#toast')).to_be_hidden(timeout=12000)
                page.screenshot(path=str(out/(name+'.png')), full_page=True)
                screenshots.append(name+'.png')

            page.goto(app_url, wait_until='domcontentloaded')
            ready()
            assert (state() or {}).get('tabs', []) == []
            expect(page.locator('[data-draft-id]')).to_have_count(0)
            page.locator('#url').fill(receiver_url+'/echo?first-input=1')
            first = state()
            assert len(first['tabs']) == 1
            initial_id = first['tabs'][0]['id']
            reload()
            assert [tab['id'] for tab in state()['tabs']] == [initial_id]
            expect(page.locator('#url')).to_have_value(receiver_url+'/echo?first-input=1')
            passed('fresh blank is temporary; its first user edit creates exactly one durable draft')

            fixture = workspace_fixture(receiver_url)
            load_workspace(fixture)
            reload()
            baseline = state()
            assert [tab['id'] for tab in baseline['tabs']] == DRAFT_IDS
            assert all('draft:'+identifier in baseline['revisions'] for identifier in DRAFT_IDS)
            passed('pre-existing drafts and their revisions survive import and reload unchanged')

            for identifier, name in [('saved-a', 'Saved A'), ('saved-b', 'Saved B'), ('saved-a', 'Saved A')]:
                open_saved(identifier, name)
                assert_drafts_equal(state()['tabs'], baseline['tabs'], 'open saved request '+identifier)
            passed('opening and switching saved requests never creates persisted editor copies')

            open_history('history-1', edit=True)
            expect(page.locator('#requestName')).to_have_value('History 1')
            expect(page.locator('#saveDraft')).to_have_text('下書きに保存')
            edited_url = receiver_url+'/echo?temporary=1'
            edited_body = 'edited history body — 日本語'
            page.locator('#url').fill(edited_url)
            page.get_by_label('Raw body', exact=True).fill(edited_body)
            assert_drafts_equal(state()['tabs'], baseline['tabs'], 'edit temporary history request')
            assert state()['history'] == baseline['history']
            open_saved('saved-b', 'Saved B')
            open_history('history-1', edit=True)
            expect(page.locator('#url')).to_have_value(edited_url)
            expect(page.get_by_label('Raw body', exact=True)).to_have_value(edited_body)
            assert_drafts_equal(state()['tabs'], baseline['tabs'], 'reopen temporary history request')
            passed('history edits stay in session memory when reopened and do not mutate source history or drafts')

            with page.expect_response(lambda response: response.url.endswith('/api/request')) as sent_response:
                page.locator('#send').click()
            response = sent_response.value.json()
            assert response['ok'], response
            expect(page.locator('#responseStatus')).to_contain_text('200')
            expect(page.locator('#send')).to_contain_text('Send')
            received = json.loads(response['body'])
            assert received['path'] == '/echo?temporary=1' and received['body'] == edited_body
            sent = state()
            assert_drafts_equal(sent['tabs'], baseline['tabs'], 'send temporary history request')
            assert len(sent['history']) == len(baseline['history'])+1
            assert sent['history'][-1]['sent_requests'][0]['body'] == edited_body
            passed('sending a temporary history editor reaches real HTTP and saves only transmitted history')

            open_history('history-2', edit=True)
            page.locator('#saveRequest').click()
            expect(page.locator('#modalTitle')).to_have_text('Save request')
            page.locator('#cancelModal').click()
            assert_drafts_equal(state()['tabs'], baseline['tabs'], 'cancel collection save')
            assert state()['collections'] == baseline['collections']
            page.locator('#saveRequest').click()
            page.get_by_label('Request name', exact=True).fill('Registered from history')
            page.locator('#modalSubmit').click()
            expect(page.locator('#modal')).not_to_be_visible()
            registered = state()
            assert_drafts_equal(registered['tabs'], baseline['tabs'], 'register temporary request in collection')
            saved_items = registered['collections'][0]['item'][0]['item']
            assert len(saved_items) == 3 and saved_items[-1]['name'] == 'Registered from history'
            assert saved_items[-1]['request']['body']['raw'] == 'history-body-2'
            passed('collection-save cancellation and confirmation create no drafts; confirmation registers one request')

            open_history('history-3', edit=True)
            page.locator('#saveDraft').click()
            explicit = state()
            assert len(explicit['tabs']) == len(DRAFT_IDS)+1
            explicit_id = explicit['activeId']
            assert explicit_id not in DRAFT_IDS
            expect(page.locator('#saveDraft')).to_be_hidden()
            page.locator('#url').fill(receiver_url+'/echo?explicit-draft=1')
            explicit = state()
            reload()
            expect(page.locator('#url')).to_have_value(receiver_url+'/echo?explicit-draft=1')
            assert_drafts_equal(state()['tabs'], explicit['tabs'], 'reload explicitly saved draft')
            passed('explicit Save draft persists one editor and subsequent edits survive reload')

            open_history('history-4', edit=True)
            page.locator('#duplicateRequest').click()
            duplicated = state()
            assert len(duplicated['tabs']) == len(DRAFT_IDS)+2
            assert duplicated['activeId'] not in [*DRAFT_IDS, explicit_id]
            passed('explicit duplication creates one durable draft without persisting the opened history editor')
            page.locator('#dataActions').click()
            with page.expect_download() as downloaded:
                page.get_by_role('menuitem', name='全体エクスポート', exact=True).click()
            archive_path = out/'explicit-drafts-backup.json'
            downloaded.value.save_as(archive_path)
            archived = json.loads(archive_path.read_text())['workspace']
            assert_drafts_equal(archived['tabs'], duplicated['tabs'], 'export durable drafts')
            draft_keys = {'draft:'+tab['id'] for tab in archived['tabs']}
            assert all(key in draft_keys for key in archived['revisions'] if key.startswith('draft:'))
            capture('explicit-drafts-desktop')
            passed('full backup contains only durable drafts and no orphan revisions from temporary editors')

            # Reproduce response cleanup with actual sends, including an
            # untouched response that must survive deleting the other drafts.
            load_workspace(fixture)
            def response_snapshots():
                return page.evaluate("Object.fromEntries(JSON.parse(sessionStorage.getItem('minipost.responses.v1') || '[]'))")

            for index, identifier in enumerate(DRAFT_IDS[:3], 1):
                draft(identifier).locator('[data-select-open]').click()
                with page.expect_response(lambda response: response.url.endswith('/api/request')) as sent_response:
                    page.locator('#send').click()
                response = sent_response.value.json()
                assert response['ok'], response
                expect(page.locator('#responseStatus')).to_contain_text('200')
                expect(page.locator('#send')).to_contain_text('Send')
                received = json.loads(response['body'])
                assert received['method'] == 'POST' and received['path'] == '/echo'
                assert received['body'] == f'legacy-{index}'
            before_delete = state()
            before_responses = response_snapshots()
            assert len(before_delete['history']) == len(HISTORY_IDS)+3
            for index, identifier in enumerate(DRAFT_IDS[:3], 1):
                snapshot = before_responses['draft:'+identifier]
                assert snapshot['status'] == 200 and json.loads(snapshot['body'])['body'] == f'legacy-{index}'

            clear_selection()
            for identifier in DRAFT_IDS[:2]:
                draft(identifier).locator('[data-select-open]').click(modifiers=['Control'])
            selected(['draft:'+identifier for identifier in DRAFT_IDS[:2]])
            draft(DRAFT_IDS[0]).locator('[data-select-open]').click(button='right')
            page.get_by_role('menuitem', name='選択した2件を削除', exact=True).click()
            confirmation(accept=False)
            cancelled = state()
            assert_drafts_equal(cancelled['tabs'], before_delete['tabs'], 'cancel sent-draft deletion')
            assert cancelled['revisions'] == before_delete['revisions']
            assert cancelled['history'] == before_delete['history']
            assert response_snapshots() == before_responses
            selected(['draft:'+identifier for identifier in DRAFT_IDS[:2]])

            draft(DRAFT_IDS[0]).locator('[data-select-open]').click(button='right')
            page.get_by_role('menuitem', name='選択した2件を削除', exact=True).click()
            confirmation()
            deleted = state()
            removed_keys = {'draft:'+identifier for identifier in DRAFT_IDS[:2]}
            assert [tab['id'] for tab in deleted['tabs']] == DRAFT_IDS[2:]
            assert all(key not in deleted['revisions'] for key in removed_keys)
            assert deleted['revisions']['draft:'+DRAFT_IDS[2]] == before_delete['revisions']['draft:'+DRAFT_IDS[2]]
            assert deleted['history'] == before_delete['history']
            retained_responses = {key: value for key, value in before_responses.items() if key not in removed_keys}
            assert response_snapshots() == retained_responses
            expect(page.locator('#requestName')).to_have_value('Legacy draft 3')
            expect(page.locator('#responseStatus')).to_contain_text('200')
            assert json.loads(page.locator('.response-code').inner_text())['body'] == 'legacy-3'
            reload()
            assert [tab['id'] for tab in state()['tabs']] == DRAFT_IDS[2:]
            assert response_snapshots() == retained_responses
            expect(page.locator('#requestName')).to_have_value('Legacy draft 3')
            expect(page.locator('#responseStatus')).to_contain_text('200')
            assert json.loads(page.locator('.response-code').inner_text())['body'] == 'legacy-3'
            assert not errors, errors
            passed('deleting two real sent drafts removes only their response snapshots and revisions; cancellation and the third response remain intact after reload')

            # Restore a controlled set before testing destructive list actions.
            load_workspace(fixture)
            expect(page.locator('input[data-select-toggle], #selectionToolbar, #deleteSelection, #selectAllEntries, #clearSelection')).to_have_count(0)
            draft(DRAFT_IDS[4]).locator('[data-select-open]').click()
            clear_selection()
            draft(DRAFT_IDS[0]).locator('[data-select-open]').press('Space')
            selected(['draft:'+DRAFT_IDS[0]])
            expect(page.locator('#requestName')).to_have_value('Legacy draft 5')
            draft(DRAFT_IDS[2]).locator('[data-select-open]').click(modifiers=['Control'])
            draft(DRAFT_IDS[3]).locator('[data-select-open]').click(modifiers=['Meta'])
            selected(['draft:'+DRAFT_IDS[index] for index in [0, 2, 3]])
            expect(page.locator('#requestName')).to_have_value('Legacy draft 5')
            draft(DRAFT_IDS[3]).locator('[data-select-open]').click(modifiers=['Meta'])
            selected(['draft:'+DRAFT_IDS[index] for index in [0, 2]])
            passed('Space, Control and Meta toggle draft selection without opening requests or adding visible controls')

            clear_selection()
            draft(DRAFT_IDS[1]).locator('[data-select-open]').click()
            draft(DRAFT_IDS[3]).locator('[data-select-open]').click(modifiers=['Shift'])
            selected(['draft:'+identifier for identifier in DRAFT_IDS[1:4]])
            expect(page.locator('#requestName')).to_have_value('Legacy draft 2')
            draft(DRAFT_IDS[1]).locator('[data-select-open]').press('Control+a')
            selected(['draft:'+identifier for identifier in DRAFT_IDS])
            draft(DRAFT_IDS[1]).locator('[data-select-open]').press('Escape')
            selected([])
            passed('Shift selects a contiguous range; list Control+A selects drafts only and Escape clears selection')

            page.locator('#search').fill('Legacy draft 2')
            expect(page.locator('[data-draft-id]')).to_have_count(1)
            draft(DRAFT_IDS[1]).locator('[data-select-open]').press('Control+a')
            selected(['draft:'+DRAFT_IDS[1]])
            clear_selection()
            page.locator('#search').fill('')
            expect(page.locator('[data-draft-id]')).to_have_count(len(DRAFT_IDS))
            passed('Control+A is restricted to currently filtered list entries')

            for identifier in DRAFT_IDS[:2]:
                draft(identifier).locator('[data-select-open]').click(modifiers=['Control'])
            selected(['draft:'+identifier for identifier in DRAFT_IDS[:2]])
            url = page.locator('#url')
            url.fill(receiver_url+'/echo?typing=1')
            url.press('Control+a')
            assert url.evaluate('e=>e.selectionStart===0 && e.selectionEnd===e.value.length')
            url.press('Backspace')
            url.press('Delete')
            expect(page.locator('#appConfirm')).to_have_count(0)
            assert len(state()['tabs']) == len(DRAFT_IDS) and len(state()['history']) == len(HISTORY_IDS)
            selected(['draft:'+identifier for identifier in DRAFT_IDS[:2]])
            url.fill(receiver_url+'/echo')
            passed('Control+A, Backspace and Delete inside text inputs edit text without deleting selected entries')

            clear_selection()
            for identifier in [DRAFT_IDS[0], DRAFT_IDS[2], DRAFT_IDS[4]]:
                draft(identifier).locator('[data-select-open]').click(modifiers=['Control'])
            draft(DRAFT_IDS[0]).locator('[data-select-open]').click(button='right')
            expect(page.get_by_role('menuitem', name='選択した3件を削除', exact=True)).to_be_visible()
            selected(['draft:'+DRAFT_IDS[index] for index in [0, 2, 4]])
            page.keyboard.press('Escape')
            expect(draft(DRAFT_IDS[0]).locator('[aria-haspopup="menu"]')).to_be_focused()
            selected(['draft:'+DRAFT_IDS[index] for index in [0, 2, 4]])
            draft(DRAFT_IDS[0]).locator('[aria-haspopup="menu"]').click()
            page.get_by_role('menuitem', name='選択した3件を削除', exact=True).click()
            confirmation(accept=False)
            assert [tab['id'] for tab in state()['tabs']] == DRAFT_IDS
            expect(draft(DRAFT_IDS[0]).locator('[aria-haspopup="menu"]')).to_be_focused()
            selected(['draft:'+DRAFT_IDS[index] for index in [0, 2, 4]])
            passed('right-click and row menus keep the group; cancelling its deletion restores focus and preserves selection and data')
            draft(DRAFT_IDS[0]).locator('[data-select-open]').press('Delete')
            page.keyboard.press('Delete')
            confirmation()
            remainder = state()
            assert [tab['id'] for tab in remainder['tabs']] == [DRAFT_IDS[1], DRAFT_IDS[3]]
            assert len(remainder['history']) == len(HISTORY_IDS)
            for identifier in [DRAFT_IDS[0], DRAFT_IDS[2], DRAFT_IDS[4]]:
                assert 'draft:'+identifier not in remainder['revisions']
            assert all('draft:'+identifier in remainder['revisions'] for identifier in [DRAFT_IDS[1], DRAFT_IDS[3]])
            expect(page.locator('#appConfirm')).to_have_count(0)
            capture('draft-bulk-delete-desktop')
            passed('Delete confirms once and removes only selected drafts plus their own revision records')

            draft(DRAFT_IDS[1]).locator('[data-select-open]').press('Control+a')
            selected(['draft:'+DRAFT_IDS[index] for index in [1, 3]])
            draft(DRAFT_IDS[1]).locator('[data-select-open]').press('Backspace')
            confirmation()
            assert state()['tabs'] == []
            assert not any(key.startswith('draft:') for key in state()['revisions'])
            reload()
            assert state()['tabs'] == []
            expect(page.locator('[data-draft-id]')).to_have_count(0)
            passed('Backspace can delete the last drafts; reload keeps the list empty without replacement drafts')

            open_history('history-4')
            clear_selection()
            for identifier in ['history-1', 'history-3']:
                history(identifier).locator('[data-select-open]').click(modifiers=['Control'])
            selected(['history:history-1', 'history:history-3'])
            expect(page.locator('#historyPage')).to_have_attribute('data-history-id', 'history-4')
            clear_selection()
            history('history-4').locator('[data-select-open]').click()
            history('history-2').locator('[data-select-open]').click(modifiers=['Shift'])
            selected(['history:history-4', 'history:history-3', 'history:history-2'])
            history('history-4').locator('[data-select-open]').press('Control+a')
            selected(['history:'+identifier for identifier in HISTORY_IDS])
            history('history-4').locator('[data-select-open]').press('Escape')
            selected([])
            assert state()['tabs'] == []
            passed('history modifier clicks, range selection and keyboard selection do not create or switch request drafts')

            page.locator('#search').fill('History 2')
            expect(page.locator('[data-select-id^="history:"]')).to_have_count(1)
            history('history-2').locator('[data-select-open]').press('Control+a')
            selected(['history:history-2'])
            history('history-2').locator('[data-select-open]').press('Shift+F10')
            page.get_by_role('menuitem', name='送信履歴を削除', exact=True).click()
            confirmation()
            assert {entry['id'] for entry in state()['history']} == {'history-1', 'history-3', 'history-4'}
            assert state()['tabs'] == []
            page.locator('#search').fill('')
            passed('filtered history deletion removes only the visible selected entry and leaves drafts empty')

            page.set_viewport_size({'width': 320, 'height': 720})
            side('history')
            history('history-4').locator('[data-select-open]').press('Control+a')
            selected(['history:history-1', 'history:history-3', 'history:history-4'])
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            expect(page.locator('input[data-select-toggle], #selectionToolbar')).to_have_count(0)
            capture('history-selection-320')
            history('history-4').locator('[data-select-open]').press('Shift+F10')
            menu = page.locator('#itemMenu').bounding_box()
            assert menu and menu['x'] >= 0 and menu['x']+menu['width'] <= 321
            page.get_by_role('menuitem', name='選択した3件を削除', exact=True).click()
            expect(page.locator('#appConfirm')).to_be_visible()
            bounds = page.locator('#appConfirm').bounding_box()
            assert bounds and bounds['x'] >= 0 and bounds['x']+bounds['width'] <= 321
            capture('history-delete-confirmation-320')
            confirmation()
            assert state()['history'] == [] and state()['tabs'] == []
            page.set_viewport_size({'width': 1440, 'height': 1000})
            reload()
            assert state()['history'] == [] and state()['tabs'] == []
            passed('320px rows, context menu and one application confirmation fit the viewport without a selection toolbar; deletion persists after reload')

            # Invalid imported rows are omitted from the displayed form-data.
            # A file chosen for that displayed index must reach the same field.
            multipart_id = 'multipart-imported-rows'
            multipart_body = {'mode': 'formdata', 'formdata': [None,
                {'key': 'note', 'type': 'text', 'value': 'unchanged metadata'},
                {'key': 'upload', 'type': 'file', 'src': 'original.bin'}]}
            multipart_tab = {'id': multipart_id, 'name': 'Imported multipart', 'request': {
                'method': 'POST', 'url': receiver_url+'/echo?formdata-index=1', 'header': [], 'auth': None,
                'body': copy.deepcopy(multipart_body)}, 'settings': copy.deepcopy(SETTINGS), 'dirty': True}
            multipart_workspace = {'version': 2, 'collections': [], 'environments': [], 'globals': [],
                'tabs': [multipart_tab], 'activeId': multipart_id, 'environmentId': '', 'history': [],
                'collapsed': [], 'theme': 'light', 'revisions': {}, 'relations': [], 'relationRuns': []}
            load_workspace(multipart_workspace)
            draft(multipart_id).locator('[data-select-open]').click()
            file_slot = page.locator('[data-file-slot="form-1"]')
            expect(file_slot.locator('.file-pick')).to_contain_text('original.bin')
            assert_drafts_equal(state()['tabs'], [multipart_tab], 'open imported form-data containing a null row')
            file_bytes = b'\x00\x01\xffmultipart-row-index\r\n'
            with page.expect_file_chooser() as chooser:
                file_slot.locator('.file-pick').click()
            chooser.value.set_files([{'name': 'selected-row.bin', 'mimeType': 'application/octet-stream',
                                     'buffer': file_bytes}])
            expect(file_slot.locator('.file-pick')).to_have_attribute('aria-busy', 'false')
            expect(file_slot.locator('.file-pick')).to_have_text('selected-row.bin')
            selected_rows = state()['tabs'][0]['request']['body']['formdata']
            assert [row['key'] for row in selected_rows] == ['note', 'upload']
            assert selected_rows[0]['value'] == 'unchanged metadata' and 'src' not in selected_rows[0]
            assert selected_rows[1]['src'] == ['selected-row.bin']
            with page.expect_response(lambda response: response.url.endswith('/api/request')) as sent_response:
                page.locator('#send').click()
            response = sent_response.value.json()
            assert response['ok'], response
            expect(page.locator('#responseStatus')).to_contain_text('200')
            expect(page.locator('#send')).to_contain_text('Send')
            received = json.loads(response['body'])
            assert received['method'] == 'POST' and received['path'] == '/echo?formdata-index=1'
            content_type = next(value for key, value in received['headers'] if key.lower() == 'content-type')
            message = BytesParser(policy=default).parsebytes(
                b'Content-Type: '+content_type.encode()+b'\r\nMIME-Version: 1.0\r\n\r\n'
                +base64.b64decode(received['body_base64']))
            assert [(part.get_param('name', header='content-disposition'), part.get_filename(),
                     part.get_payload(decode=True)) for part in message.iter_parts()] == [
                         ('note', None, b'unchanged metadata'), ('upload', 'selected-row.bin', file_bytes)]
            # Exercise Clear directly from the unnormalized import as well.
            load_workspace(multipart_workspace)
            expect(file_slot.locator('.file-pick')).to_contain_text('original.bin')
            file_slot.locator('.file-clear').click()
            expect(file_slot.locator('.file-pick')).to_have_text('ファイルを選択')
            cleared_rows = state()['tabs'][0]['request']['body']['formdata']
            assert [row['key'] for row in cleared_rows] == ['note', 'upload']
            assert cleared_rows[0]['value'] == 'unchanged metadata' and 'src' not in cleared_rows[1]
            passed('imported invalid form-data rows stay unchanged on open; explicit file selection and clear address the displayed row and real HTTP preserves its bytes')

            assert not errors, errors
            assert not dialogs, dialogs
            assert not crashes, crashes
            passed('no uncaught browser errors, native dialogs or crashes')
            completed = True
            browser.close()
            page = None
    finally:
        (out/'results.json').write_text(json.dumps({'ok': completed, 'mode': 'native Chromium HTTP',
            'native_indexeddb': True, 'checks': checks, 'page_errors': errors, 'native_dialogs': dialogs,
            'crashes': crashes, 'screenshots': screenshots}, ensure_ascii=False, indent=2))
        if app:
            app.shutdown()
            app.server_close()
        receiver.shutdown()
        receiver.server_close()


if __name__ == '__main__':
    main()
