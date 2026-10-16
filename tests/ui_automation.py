"""Creation, full-page environments, metadata, isolated scripts and relation acceptance.

Default browser transport uses real HTTP. The explicitly selected inline mode
is a DOM fixture plus Python HTTP bridge, not a browser network acceptance test.
"""
import json
import os
from pathlib import Path
import tempfile
from playwright.sync_api import sync_playwright, expect
from browser_app import BrowserApp
from test_proxy import proxy, start_server

KEY = 'minipost.workspace.v2'


def main():
    echo, echo_url = start_server()
    app, app_url = start_server(proxy.Handler)
    out = Path(os.environ.get('ARTIFACT_DIR', tempfile.mkdtemp(prefix='minipost-automation-'))) / 'automation'
    out.mkdir(parents=True, exist_ok=True)
    checks, errors, shots = [], [], []
    fixture = BrowserApp(app_url)
    def passed(name):
        checks.append(name)
        print('PASS ' + name, flush=True)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM'), headless=True, args=['--no-sandbox'])
            page = browser.new_page(viewport={'width':1440, 'height':1000}, accept_downloads=True)
            page.on('pageerror', lambda error: errors.append(str(error)))
            fixture.open(page)
            expect(page.locator('#connectionStatus')).to_contain_text('connected')
            def capture(name):
                page.screenshot(path=str(out/(name+'.png')), full_page=True)
                shots.append(name+'.png')
            def stored():
                expect(page.locator('#saveState')).to_have_text('ローカルに保存済み')
                return page.evaluate('(key)=>JSON.parse(localStorage.getItem(key))', KEY)
            def load(value):
                page.locator('#import').click()
                page.get_by_label('インポートJSON').fill(json.dumps(value))
                page.locator('#modalSubmit').click()
                expect(page.locator('#modalTitle')).to_have_text('インポート完了')
                page.locator('#modalSubmit').click()
            def side(name):
                if page.locator('#sidebarTabs').is_hidden(): page.locator('#toggleSidebar').click()
                page.locator(f'#sidebarTabs [data-sidebar={name}]').click()
            def choose(name):
                side('collections')
                page.locator('.tree-open').filter(has=page.locator('.tree-label', has_text=name)).first.click()
                expect(page.locator('#requestName')).to_have_value(name)
            def editor(name):
                page.locator(f'#editorTabs [data-editor={name}]').click()
            def send():
                page.locator('#send').click()
                expect(page.locator('#responseStatus')).to_contain_text('200', timeout=15000)
                expect(page.locator('#send')).to_contain_text('Send')
            def primary_values():
                return page.evaluate("JSON.parse(sessionStorage.getItem('minipost.primary.v1')||'[]')")
            def menu(name): page.get_by_role('menuitem', name=name, exact=True).click()
            def request_menu(name):
                choose(name)
                page.get_by_role('button', name=name+'の操作', exact=True).click()

            sample={'info':{'name':'Flow API','schema':'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'},'item':[
                {'name':'Pipeline','item':[
                    {'name':'Seed','request':{'method':'POST','url':echo_url+'/echo', 'auth':{'type':'bearer','bearer':[{'key':'token','value':'{{token}}'}]},'body':{'mode':'raw','raw':'{\n  "message": "{{token}}",\n  "enabled": true,\n  "count": 3\n}', 'options':{'raw':{'language':'json'}}}}},
                    {'name':'Next','request':{'method':'GET','url':echo_url+'/echo?from={{method}}'}},
                    {'name':'Finish','request':{'method':'GET','url':echo_url+'/echo?finish=yes'}}]}]}
            load(sample)
            load({'name':'Development','_postman_variable_scope':'environment','values':[{'key':'token','value':'environment-token','enabled':True}]})
            expect(page.locator('#gatewayExample')).to_have_count(0)
            expect(page.locator('#requestTabs, .request-tab')).to_have_count(0)
            passed('no injected sample UI or accumulating request tabs')

            side('environments')
            page.locator('#sidebarContent [data-environment-id] .tree-open').click()
            expect(page.locator('#workspacePage')).to_be_visible()
            expect(page.locator('#exchange')).not_to_be_visible()
            expect(page.locator('#modal')).not_to_be_visible()
            expect(page.locator('#environmentName')).to_have_value('Development')
            values=page.locator('#workspacePage')
            values.get_by_label('Value 1', exact=True).fill('edited-environment-token')
            before=stored()
            assert before['environments'][0]['values'][0]['value']=='edited-environment-token'
            page.locator('#addTab').click()
            expect(page.get_by_role('menuitem',name='環境を作成',exact=True)).to_be_visible()
            expect(page.get_by_role('menuitem',name='リクエストを作成',exact=True)).to_have_count(0)
            page.keyboard.press('Escape')
            capture('environment-desktop')
            passed('environment tab edits a full page, autosaves and scopes creation')

            request_menu('Seed')
            menu('この位置にリクエストを追加')
            page.get_by_label('追加する名前').fill('Inserted sibling')
            page.locator('#modalSubmit').click()
            ws=stored()
            assert [v['name'] for v in ws['collections'][0]['item'][0]['item']]==['Seed','Inserted sibling','Next','Finish']
            folder=page.locator('.tree-row').filter(has=page.get_by_role('button',name='Pipelineの操作',exact=True))
            folder.click(button='right')
            menu('フォルダーを追加')
            page.get_by_label('追加する名前').fill('Child folder')
            page.locator('#modalSubmit').click()
            ws=stored()
            assert ws['collections'][0]['item'][0]['item'][-1]['name']=='Child folder'
            passed('right-click creation inserts after a request or under the clicked folder')

            request_menu('Seed')
            menu('環境変数を抽出')
            page.get_by_label('抽出先環境').select_option('__new__')
            page.get_by_label('新しい環境名').fill('Extracted')
            page.get_by_label('tokenの値',exact=True).fill('extracted-token')
            page.locator('#modalSubmit').click()
            expect(page.locator('#environmentName')).to_have_value('Extracted')
            ws=stored();assert ws['environments'][-1]['values'][0]['key']=='token'
            assert ws['environmentId']==ws['environments'][-1]['id']
            passed('request placeholder extraction creates a selected editable environment')

            choose('Seed');editor('body')
            area=page.get_by_label('Raw body',exact=True)
            expect(area).to_be_visible()
            assert area.bounding_box()['height']>=230
            expect(page.locator('.source-highlight .syntax-key').first).to_be_visible()
            expect(page.locator('.source-highlight .syntax-number').first).to_be_visible()
            code=area.input_value();area.evaluate('el=>window.__bodyNode=el')
            editor('headers');editor('body');assert area.evaluate('el=>el===window.__bodyNode')
            page.get_by_label('本文のフォーマット').select_option('xml')
            area.fill('<root enabled="yes">value</root>')
            expect(page.locator('.source-highlight .syntax-tag').first).to_be_visible()
            page.get_by_label('本文のフォーマット').select_option('json');area.fill(code)
            capture('body-highlight-desktop')
            passed('large body editor highlights JSON/XML and retains editing DOM across categories')

            editor('scripts')
            before_script=page.get_by_label('送信前スクリプト',exact=True)
            run_script=page.locator('#script-panel-before').get_by_role('button',name='このスクリプトを実行',exact=True)
            before_script.fill("vars.set('must_not_commit', 'bad'); throw Error('atomic failure');")
            run_script.click()
            expect(page.locator('#scriptLog')).to_contain_text('atomic failure')
            assert 'must_not_commit' not in {v['key'] for v in primary_values()}
            passed('failed scripts do not commit partial variable writes')
            before_script.fill("if(typeof document !== 'undefined' || typeof localStorage !== 'undefined') throw Error('unexpected DOM access'); try {await fetch('https://example.invalid/no-network')} catch {throw Error('network denied as expected')} throw Error('network unexpectedly allowed');")
            run_script.click()
            expect(page.locator('#scriptLog')).to_contain_text('network denied as expected')
            passed('script workers have no application DOM and CSP blocks direct network calls')
            page.get_by_label('スクリプト制限時間',exact=True).fill('350')
            before_script.fill('while(true) {}')
            run_script.click()
            expect(page.locator('#scriptLog')).to_contain_text('制限時間',timeout=5000)
            passed('infinite script terminates at the configured timeout without freezing the UI')
            page.get_by_label('スクリプト制限時間',exact=True).fill('0')
            run_script.click()
            expect(page.locator('#stopRelationGlobal')).to_be_visible()
            page.locator('#stopRelationGlobal').click()
            expect(page.locator('#scriptLog')).to_contain_text('停止')
            page.get_by_label('スクリプト制限時間',exact=True).fill('5000')
            passed('global Stop terminates an unlimited manual script')

            editor('scripts')
            page.get_by_label('送信前スクリプト',exact=True).fill("vars.set('token', 'primary-token'); console.log('before complete');")
            page.locator('#script-tab-after').click()
            page.get_by_label('受信後スクリプト',exact=True).fill("vars.set('method', response.body.method); vars.set('httpStatus', response.status); console.log('after complete');")
            stored();send();editor('body')
            received=json.loads(page.locator('.response-code').inner_text())
            assert dict(received['headers'])['Authorization']=='Bearer primary-token'
            assert json.loads(received['body'])['message']=='primary-token'
            primary={v['key']:v['value'] for v in primary_values()}
            assert primary['method']=='POST' and primary['httpStatus']=='200'
            passed('pre/post scripts execute and primary variables override environment values in HTTP')

            page.locator('#extractResponse').click()
            expect(page.locator('.metadata-tree')).to_be_visible()
            page.get_by_label('抽出パス',exact=True).fill('/body/method')
            page.get_by_label('一次変数名',exact=True).fill('copiedMethod')
            page.get_by_label('次回以降の受信時にも自動で抽出',exact=True).check()
            capture('response-extraction')
            page.locator('#modalSubmit').click()
            assert {v['key']:v['value'] for v in primary_values()}['copiedMethod']=='POST'
            ws=stored();assert ws['collections'][0]['item'][0]['item'][0]['request']['_minipost']['extractions'][0]['path']=='/body/method'
            fixture.reload(page);expect(page.locator('#connectionStatus')).to_contain_text('connected')
            expect(page.locator('#extractResponse')).to_be_enabled()
            expect(page.locator('#responseStatus')).to_contain_text('200')
            passed('post-hoc metadata extraction and automatic rule survive reload of the received response')

            side('environments');page.locator('[data-scope=primary] .tree-open').click()
            expect(page.locator('#workspacePage')).to_contain_text('一次変数')
            primary_list=page.locator('#workspacePage .kv-data-row')
            token_row=primary_list.first
            expect(token_row.get_by_label('Value 1',exact=True)).to_have_value('primary-token')
            capture('primary-variables')
            passed('primary variables have an editable session-scoped page')

            request_menu('Seed');menu('リレーションに追加')
            page.get_by_label('リレーション名',exact=True).fill('Sequential flow')
            page.locator('#modalSubmit').click()
            expect(page.locator('#workspacePage')).to_contain_text('リレーション')
            expect(page.locator('#relationSteps .relation-step')).to_have_count(1)
            for name in ['Next','Finish']:
                page.locator('#addRelationStep').click()
                count=page.locator('.relation-step').count()
                pick=page.get_by_label(f'ステップ {count} のリクエスト',exact=True)
                options=pick.locator('option').evaluate_all('(nodes)=>nodes.map(n=>({value:n.value,label:n.textContent}))')
                pick.select_option(next(o['value'] for o in options if o['label'].endswith(' / '+name)))
            step=page.locator('.relation-step').first
            step.get_by_label('ステップ 1 の条件分岐',exact=True).check()
            step.get_by_label('ステップ 1 の比較元',exact=True).fill('/status')
            step.get_by_label('比較する値 / {{変数}}',exact=True).fill('200')
            target=stored()['relations'][0]['steps'][2]['id']
            step.get_by_label('ステップ 1 の条件成立時',exact=True).select_option(target)
            page.get_by_label('全体の回数',exact=True).fill('2')
            step.get_by_label('開始前 ms',exact=True).fill('20')
            capture('relation-config-desktop')
            page.locator('#runRelation').click()
            expect(page.locator('#relationRunLog h2')).to_contain_text('完了',timeout=20000)
            ws=stored();run=ws['relationRuns'][-1]
            assert [v['requestName'] for v in run['entries']]==['Seed','Finish','Seed','Finish'],run
            assert run['status']=='succeeded'
            capture('relation-results-desktop')
            passed('relation sequential execution repeats the plan and branches on a response element')

            page.locator('.relation-step').first.get_by_label('開始前 ms',exact=True).fill('5000')
            page.locator('#runRelation').click()
            expect(page.locator('#stopRelationGlobal')).to_be_visible()
            page.locator('#stopRelationGlobal').click()
            expect(page.locator('#relationRunLog h2')).to_contain_text('停止',timeout=5000)
            passed('relation stop interrupts an outstanding wait without sending another request')

            page.locator('#dataActions').click()
            with page.expect_download() as saved:
                menu('全体エクスポート')
            bundle=json.loads(Path(saved.value.path()).read_text())
            assert bundle['workspace']['relations'][0]['steps'][0]['onTrue']==target
            assert 'primary-token' in bundle['workspace']['collections'][0]['item'][0]['item'][0]['request']['_minipost']['before']
            assert 'primary' not in bundle['workspace']
            assert bundle['workspace']['relationRuns'][-1]['status']=='cancelled'
            passed('whole backup includes relation references, scripts and run logs but not session primary values')

            page.set_viewport_size({'width':390,'height':844})
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            capture('relation-phone')
            side('environments');page.locator('[data-scope=primary] .tree-open').click()
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            capture('environment-phone')
            choose('Seed');editor('body')
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            body_box=page.get_by_label('Raw body').bounding_box()
            request_box=page.locator('.request-editor').bounding_box()
            assert min(body_box['y']+body_box['height'],request_box['y']+request_box['height'])-max(body_box['y'],request_box['y'])>=230
            capture('body-phone')
            passed('phone creation, variable page, source editor and relation layout have no page overflow')
            assert not errors,errors
            passed('no uncaught browser JavaScript errors')
            browser.close()
    finally:
        report={'passed':len(checks),'checks':checks,'page_errors':errors,'screenshots':shots,'transport':'injected DOM fixture with Python HTTP bridge' if fixture.inline else 'real browser HTTP'}
        (out/'results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
        for server in [app,echo]:server.shutdown();server.server_close()

if __name__=='__main__':main()
