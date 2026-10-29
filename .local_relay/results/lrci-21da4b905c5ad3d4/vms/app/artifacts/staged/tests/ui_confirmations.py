"""Every destructive confirmation uses application UI, including nested history dialogs."""
import json, os, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from browser_app import BrowserApp
from test_proxy import proxy, start_server

def main():
    server=None;url=os.getenv('MINIPOST_REMOTE_URL')
    if not url:server,url=start_server(proxy.Handler)
    fixture=BrowserApp(url);out=Path(os.environ.get('ARTIFACT_DIR',tempfile.mkdtemp()))/'confirmations';out.mkdir(parents=True,exist_ok=True)
    checks=[];errors=[];native=[];shots=[]
    def passed(name):checks.append(name);print('PASS '+name,flush=True)
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM'),headless=True,args=['--no-sandbox']);page=browser.new_page(viewport={'width':1440,'height':920})
            page.on('pageerror',lambda e:errors.append(str(e)));page.on('dialog',lambda d:(native.append(d.type),d.dismiss()))
            fixture.open(page);expect(page.locator('#connectionStatus')).to_contain_text('connected')
            def load(value):
                page.locator('#import').click();page.get_by_label('インポートJSON').fill(json.dumps(value));page.locator('#modalSubmit').click();expect(page.locator('#modalTitle')).to_have_text('インポート完了');page.locator('#modalSubmit').click()
            def menu(button,action):
                page.get_by_role('button',name=button,exact=True).click();page.get_by_role('menuitem',name=action,exact=True).click()
            def side(value):page.locator(f'[data-sidebar={value}]').click()
            def accept():expect(page.locator('.confirm-dialog')).to_be_visible();page.locator('[data-confirm-accept]').click();expect(page.locator('.confirm-dialog')).to_have_count(0)
            def cancel():expect(page.locator('[data-confirm-cancel]')).to_be_focused();page.locator('[data-confirm-cancel]').click();expect(page.locator('.confirm-dialog')).to_have_count(0)
            def saved():expect(page.locator('#saveState')).to_have_text('ローカルに保存済み')
            load({'info':{'name':'Confirm API'},'item':[{'name':'Folder','item':[{'name':'Request','request':{'method':'GET','url':'http://example.test/original'}}]}]})
            menu('Untitled requestの下書き操作','下書きを削除');cancel();expect(page.get_by_role('button',name='Untitled requestの下書き操作',exact=True)).to_be_visible()
            menu('Untitled requestの下書き操作','下書きを削除');accept();expect(page.get_by_role('button',name='Untitled requestの下書き操作',exact=True)).to_have_count(0);passed('draft deletion preserves data on cancel and deletes on explicit confirmation')
            page.locator('#url').fill('http://example.test/edited');saved();page.locator('#requestHistory').click();entries=page.locator('.revision-entry');entry=entries.nth(1);entry.locator('summary').click();entry.get_by_role('button',name='この版を復元',exact=True).click();cancel();expect(page.locator('#modal')).to_be_visible()
            entry.get_by_role('button',name='この版を復元',exact=True).click();page.screenshot(path=str(out/'history-confirmation.png'));shots.append('history-confirmation.png');accept();page.locator('#closeModal').click();expect(page.locator('#url')).to_have_value('http://example.test/original');passed('history restore confirms above the drawer without closing it on cancel')
            # Generate a local validation failure, without contacting any external server.
            page.locator('#url').fill('{{missing}}');page.locator('#send').click();expect(page.locator('#responseStatus')).to_contain_text('ERROR');side('history');expect(page.locator('.history-entry')).to_have_count(1)
            page.locator('#clearHistory').click();cancel();expect(page.locator('.history-entry')).to_have_count(1);page.locator('#clearHistory').click();accept();expect(page.locator('.history-entry')).to_have_count(0);passed('send-history clearing is cancellable and never uses browser UI')
            load({'name':'Confirm Env','values':[{'key':'x','value':'1'}]});side('environments');menu('Confirm Envの操作','削除');cancel();expect(page.get_by_role('button',name='Confirm Env',exact=True)).to_be_visible();menu('Confirm Envの操作','削除');accept();expect(page.get_by_role('button',name='Confirm Env',exact=True)).to_have_count(0);passed('environment deletion uses the application dialog')
            page.locator('[data-scope=primary] .tree-open').click();page.locator('#workspacePage .table-add').click();page.get_by_label('Key 1',exact=True).fill('temp');page.get_by_label('Value 1',exact=True).fill('value')
            page.get_by_role('button',name='すべて消去',exact=True).click();cancel();expect(page.get_by_label('Value 1',exact=True)).to_have_value('value');page.get_by_role('button',name='すべて消去',exact=True).click();accept();expect(page.locator('#workspacePage .kv-data-row')).to_have_count(0);passed('primary variables toolbar confirmation respects cancel and accept')
            page.locator('#workspacePage .table-add').click();page.get_by_label('Key 1',exact=True).fill('context');menu('一次変数の操作','すべて消去');cancel();menu('一次変数の操作','すべて消去');accept();expect(page.locator('#workspacePage .kv-data-row')).to_have_count(0);passed('primary-variable context menu uses the same confirmation behavior')
            side('relations');page.locator('#sidebarAdd').click();page.get_by_role('menuitem',name='リレーションを作成',exact=True).click();page.get_by_label('リレーション名',exact=True).fill('Confirm Flow');page.locator('#modalSubmit').click();menu('Confirm Flowの操作','削除');cancel();menu('Confirm Flowの操作','削除');accept();expect(page.get_by_role('button',name='Confirm Flowの操作',exact=True)).to_have_count(0);passed('relation deletion uses the application dialog')
            side('collections');menu('Requestの操作','削除');cancel();menu('Requestの操作','削除');accept();expect(page.get_by_role('button',name='Requestの操作',exact=True)).to_have_count(0);passed('saved-request deletion uses the application dialog')
            menu('Folderの操作','削除');cancel();menu('Folderの操作','削除');accept();expect(page.get_by_role('button',name='Folderの操作',exact=True)).to_have_count(0);passed('folder deletion uses the application dialog')
            menu('Confirm APIの設定','削除');cancel();menu('Confirm APIの設定','削除');page.set_viewport_size({'width':320,'height':720});expect(page.locator('[data-confirm-accept]')).to_be_visible();assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');page.screenshot(path=str(out/'confirmation-320.png'));shots.append('confirmation-320.png');accept();expect(page.get_by_role('button',name='Confirm APIの設定',exact=True)).to_have_count(0);passed('collection deletion remains operable at 320px')
            assert not errors,errors;assert not native,native;passed('all confirmation paths run without native dialogs or JavaScript errors');browser.close()
    finally:
        (out/'results.json').write_text(json.dumps({'mode':'DOM fixture + Python HTTP bridge' if fixture.inline else 'native Chromium HTTP','checks':checks,'page_errors':errors,'native_dialogs':native,'screenshots':shots},ensure_ascii=False,indent=2))
        if server:server.shutdown();server.server_close()
if __name__=='__main__':main()
