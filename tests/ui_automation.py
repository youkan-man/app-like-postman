"""Creation, full-page environments, metadata, isolated scripts and relation acceptance.

Default browser transport uses real HTTP. The explicitly selected inline mode
is a DOM fixture plus Python HTTP bridge, not a browser network acceptance test.
"""
import json
from relation_ui_helpers import relations
import os
from pathlib import Path
import tempfile
from playwright.sync_api import sync_playwright, expect
from browser_app import BrowserApp
from test_proxy import proxy, start_server
from ui_standalone_scripts import READ_WORKSPACE

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
                return page.evaluate('(key)=>JSON.parse(localStorage.getItem(key))', KEY) if fixture.inline else page.evaluate(READ_WORKSPACE)
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
                expect(page.locator('#send')).to_contain_text('送信')
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
            expect(page.get_by_role('menuitem',name='HTTPリクエスト',exact=True)).to_have_count(0)
            page.keyboard.press('Escape')
            capture('environment-desktop')
            passed('environment tab edits a full page, autosaves and scopes creation')

            request_menu('Seed')
            menu('HTTPリクエスト')
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
            run_script=page.locator('#script-panel-before').get_by_role('button',name='スクリプトを実行',exact=True)
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

            # Edit a shared hook in its request surface. Native keyboard history
            # must stay attached to the same editor across autosave and repaint.
            side('scripts');page.locator('#sidebarAdd').click();menu('スクリプトを作成')
            page.locator('#modal').get_by_label('スクリプト名',exact=True).fill('Embedded request hook')
            page.locator('#modalSubmit').click()
            hook_original="request.header.push({key:'X-Embedded-Hook',value:'initial'});"
            hook_changed="request.header.push({key:'X-Embedded-Hook',value:'edited'});"
            page.get_by_label('スクリプトのコード',exact=True).fill(hook_original)
            hook_id=next(script['id'] for script in stored()['scripts'] if script['name']=='Embedded request hook')
            choose('Seed');editor('scripts');page.locator('#script-tab-before').click()
            page.get_by_label('送信前に実行するスクリプト',exact=True).select_option(hook_id)
            hook=page.get_by_label('送信前スクリプト',exact=True)
            expect(hook).to_have_js_property('readOnly',True)
            hook.evaluate('node=>window.__embeddedHookEditor=node')
            page.locator('#script-panel-before').get_by_role('button',name='送信前スクリプトを編集',exact=True).click()
            expect(page.locator('html')).to_have_attribute('data-workspace-view','request')
            expect(page.locator('#requestName')).to_have_value('Seed')
            expect(hook).to_be_focused();expect(hook).to_have_js_property('readOnly',False)
            hook.press('Control+a');page.keyboard.insert_text(hook_changed)
            assert next(script['source'] for script in stored()['scripts'] if script['id']==hook_id)==hook_changed
            assert hook.evaluate('node=>node===window.__embeddedHookEditor && node.selectionStart===node.value.length && node.selectionEnd===node.value.length')
            hook.press('Control+z');expect(hook).to_have_value(hook_original);expect(hook).to_be_focused()
            assert next(script['source'] for script in stored()['scripts'] if script['id']==hook_id)==hook_original
            hook.press('Control+Shift+z');expect(hook).to_have_value(hook_changed);expect(hook).to_be_focused()
            assert next(script['source'] for script in stored()['scripts'] if script['id']==hook_id)==hook_changed
            assert hook.evaluate('node=>node===window.__embeddedHookEditor')
            capture('embedded-request-hook-desktop')
            page.set_viewport_size({'width':320,'height':720})
            hook.scroll_into_view_if_needed()
            expect(hook).to_be_visible()
            capture('embedded-request-hook-320')
            hook_bounds=hook.evaluate('''node=>{
                const bounds=element=>{const r=element.getBoundingClientRect();return {
                    left:r.left,right:r.right,width:r.width,clientWidth:element.clientWidth,
                    scrollWidth:element.scrollWidth,scrollLeft:element.scrollLeft};};
                return {viewportWidth:innerWidth,documentScrollWidth:document.documentElement.scrollWidth,
                    textarea:bounds(node),sourceEditor:bounds(node.closest('.source-editor')),
                    pane:bounds(node.closest('.editor-section-body'))};
            }''')
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),hook_bounds
            assert hook.evaluate('node=>{const r=node.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1}'),hook_bounds
            page.set_viewport_size({'width':1440,'height':1000})
            send()
            received=json.loads(page.locator('.response-code').inner_text())
            assert dict(received['headers'])['X-Embedded-Hook']=='edited',received
            fixture.reload(page);expect(page.locator('#connectionStatus')).to_contain_text('connected')
            choose('Seed');editor('scripts');page.locator('#script-tab-before').click()
            expect(page.get_by_label('送信前に実行するスクリプト',exact=True)).to_have_value(hook_id)
            expect(page.get_by_label('送信前スクリプト',exact=True)).to_have_value(hook_changed)
            page.get_by_label('送信前に実行するスクリプト',exact=True).select_option('')
            stored()
            passed('saved request hooks edit in place, keep native Undo and editor identity, persist and run the edited source over HTTP')

            page.locator('#extractResponse').click()
            expect(page.locator('.metadata-tree')).to_be_visible()
            page.get_by_label('抽出パス',exact=True).fill('/body/method')
            page.get_by_label('一次変数名',exact=True).fill('copiedMethod')
            page.get_by_label('受信時に抽出',exact=True).check()
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
            page.locator('#modal').get_by_label('リレーション名',exact=True).fill('Sequential flow')
            page.locator('#modalSubmit').click()
            expect(page.locator('#requestType')).to_have_value('relation')
            expect(page.locator('#relationSteps .relation-step')).to_have_count(1)
            for name in ['Next','Finish']:
                page.locator('#addRelationStep').click()
                menu('リクエスト')
                count=page.locator('.relation-step').count()
                pick=page.get_by_label(f'ステップ {count} のリクエスト',exact=True)
                options=pick.locator('option').evaluate_all('(nodes)=>nodes.map(n=>({value:n.value,label:n.textContent}))')
                pick.select_option(next(o['value'] for o in options if o['label'].endswith(' / '+name)))
            step=page.locator('.relation-step').first
            step.get_by_label('ステップ 1 の条件分岐',exact=True).check()
            step.get_by_label('ステップ 1 の比較元',exact=True).fill('/status')
            step.get_by_label('比較する値 / {{変数}}',exact=True).fill('200')
            target=relations(stored())[0]['steps'][2]['id']
            step.get_by_label('ステップ 1 の条件成立時',exact=True).select_option(target)
            page.get_by_role('button',name='実行設定',exact=True).click()
            page.locator('#modal').get_by_label('全体の回数',exact=True).fill('2')
            page.locator('#modalSubmit').click()
            step.get_by_label('開始前 ms',exact=True).fill('20')
            capture('relation-config-desktop')
            page.locator('#send').click()
            expect(page.locator('#responseStatus')).to_contain_text('完了',timeout=20000)
            ws=stored();run=ws['relationRuns'][-1]
            assert [v['requestName'] for v in run['entries']]==['Seed','Finish','Seed','Finish'],run
            assert run['status']=='succeeded'
            capture('relation-results-desktop')
            passed('relation sequential execution repeats the plan and branches on a response element')

            page.locator('.relation-step').first.get_by_label('開始前 ms',exact=True).fill('5000')
            page.locator('#send').click()
            expect(page.locator('#send')).to_contain_text('停止')
            page.locator('#send').click()
            expect(page.locator('#responseStatus')).to_contain_text('停止',timeout=5000)
            passed('relation stop interrupts an outstanding wait without sending another request')

            page.locator('#dataActions').click()
            with page.expect_download() as saved:
                menu('全体エクスポート')
            bundle=json.loads(Path(saved.value.path()).read_text())
            assert relations(bundle['workspace'])[0]['steps'][0]['onTrue']==target
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
            line_height=page.get_by_label('Raw body').evaluate('e => parseFloat(getComputedStyle(e).lineHeight)')
            assert min(body_box['y']+body_box['height'],request_box['y']+request_box['height'])-max(body_box['y'],request_box['y'])>=4*line_height
            assert page.locator('#responseContent').evaluate('e => e.clientHeight >= parseFloat(getComputedStyle(e).fontSize)*1.4')
            assert page.locator('.statusbar').evaluate('e => e.getBoundingClientRect().bottom <= innerHeight+1')
            capture('body-phone')
            passed('phone pages keep editable body lines, response content and footer visible without page overflow')

            # Build a real nested plan through the editor, then start that plan
            # from its context menu while a different relation is selected.
            page.set_viewport_size({'width':1440,'height':1000})
            side('scripts');page.locator('#sidebarAdd').click();menu('スクリプトを作成')
            page.locator('#modal').get_by_label('スクリプト名',exact=True).fill('Record loop')
            page.locator('#modalSubmit').click()
            page.get_by_label('スクリプトのコード',exact=True).fill("if(input?.reset){store.set('loopSeen',[]);vars.set('counter',0);return null;} const value=vars.get('item'); const index=vars.get('index'); const seen=store.get('loopSeen')||[]; seen.push({item:value===undefined?null:JSON.parse(value),index:index===undefined?null:Number(index)}); store.set('loopSeen',seen); vars.set('counter',Number(vars.get('counter')||0)+1); return {ready:true};")
            script_id=next(script['id'] for script in stored()['scripts'] if script['name']=='Record loop')
            side('collections');page.locator('#sidebarAdd').click();menu('リレーション')
            page.locator('#modal').get_by_label('追加する名前',exact=True).fill('Nested flow')
            page.locator('#modalSubmit').click()

            def add_control(kind,parent=None,branch='処理'):
                if parent is None:
                    page.locator('#addRelationStep').click()
                else:
                    page.get_by_role('button',name=f'ステップ {parent} の{branch}に追加',exact=True).click()
                menu(kind)

            def configure_condition(label,path,value,operator='eq'):
                page.get_by_label(f'ステップ {label} の分岐元',exact=True).select_option('primary')
                page.get_by_label(f'ステップ {label} の比較元',exact=True).fill(path)
                page.get_by_label(f'ステップ {label} の比較',exact=True).select_option(operator)
                branch=page.locator('.step-branch').filter(has=page.get_by_label(f'ステップ {label} の比較元',exact=True))
                branch.get_by_label('比較する値 / {{変数}}',exact=True).fill(value)

            add_control('スクリプト')
            page.get_by_label('ステップ 1 のスクリプト',exact=True).select_option(script_id)
            page.get_by_label('ステップ 1 の入力形式',exact=True).select_option('json')
            page.get_by_label('ステップ 1 の入力',exact=True).fill('{"reset":true}')
            add_control('繰り返し')
            add_control('配列ループ','2')
            page.get_by_label('ステップ 2.1 の配列',exact=True).fill('[1,2,3,4]')
            add_control('条件分岐','2.1');configure_condition('2.1.1','item','2')
            add_control('次の周へ','2.1.1','成立')
            add_control('スクリプト','2.1')
            page.get_by_label('ステップ 2.1.2 のスクリプト',exact=True).select_option(script_id)
            add_control('条件分岐','2.1');configure_condition('2.1.3','item','3')
            add_control('ループ終了','2.1.3','成立')
            add_control('条件ループ');configure_condition('3','counter','6','lt')
            add_control('スクリプト','3')
            page.get_by_label('ステップ 3.1 のスクリプト',exact=True).select_option(script_id)
            add_control('待機')
            page.get_by_label('待機 ms',exact=True).fill('0')
            add_control('リクエスト')
            pick=page.get_by_label('ステップ 5 のリクエスト',exact=True)
            options=pick.locator('option').evaluate_all('(nodes)=>nodes.map(n=>({value:n.value,label:n.textContent}))')
            pick.select_option(next(option['value'] for option in options if option['label'].endswith(' / Finish')))
            flow=next(relation for relation in relations(stored()) if relation['name']=='Nested flow')
            flow_id=flow['id'];wait_id=flow['steps'][3]['id']
            assert flow['steps'][1]['steps'][0]['steps'][0]['steps'][0]['type']=='continue',flow
            assert flow['steps'][1]['steps'][0]['steps'][2]['steps'][0]['type']=='break',flow
            page.locator('.request-title').scroll_into_view_if_needed()
            assert page.locator('#relationSteps').evaluate('''root => {
                const loops=[...root.querySelectorAll('[data-step-type="repeat"],[data-step-type="forEach"],[data-step-type="while"]')];
                return loops.every(row=>{
                    const block=row.querySelector(':scope > .relation-step-body > .relation-block[data-branch="steps"]');
                    const heading=block?.querySelector(':scope > .relation-block-heading');
                    return block?.dataset.parentStepId===row.dataset.stepId && heading?.textContent.includes('繰り返す処理') &&
                        heading.querySelector('button') && block.getBoundingClientRect().height>0;
                });
            }'''), 'each loop must have a visible body boundary with its own compact heading and add action'
            assert page.locator('.step-array-fields').evaluate('''fields => {
                const boxes=[...fields.children].slice(0,4).map(field=>field.getBoundingClientRect());
                return Math.max(...boxes.map(box=>box.bottom))-Math.min(...boxes.map(box=>box.bottom))<=1;
            }'''), 'array source, variable names and interval must share one desktop row'
            capture('relation-control-desktop')

            page.locator('#sidebarContent .tree-open').filter(has_text='Sequential flow').click()
            expect(page.locator('#requestName')).to_have_value('Sequential flow')
            page.locator(f'#sidebarContent [data-relation-id="{flow_id}"]').click(button='right')
            menu('実行')
            expect(page.locator('#requestName')).to_have_value('Nested flow')
            expect(page.locator('#responseStatus')).to_contain_text('完了',timeout=30000)
            ws=stored();run=ws['relationRuns'][-1]
            assert run['relationId']==flow_id and run['status']=='succeeded',run
            assert [entry['requestName'] for entry in run['entries'] if entry['type']=='request']==['Finish'],run
            assert [item['item'] for item in ws['scriptData']['loopSeen']]==[1,3,1,3,None,None],ws['scriptData']
            assert [item['index'] for item in ws['scriptData']['loopSeen']]==[0,2,0,2,None,None],ws['scriptData']
            primary={row['key']:row['value'] for row in primary_values()}
            assert primary['counter']=='6' and 'item' not in primary and 'index' not in primary,primary
            passed('context execution targets the clicked relation and runs nested repeat/forEach/if/continue/break/while with real saved scripts')

            # Duplication must give every nested node a fresh ID, while keeping
            # saved script and request references unchanged.
            page.get_by_label('ステップ 2 の操作',exact=True).click();menu('複製')
            duplicated=next(relation for relation in relations(stored()) if relation['id']==flow_id)
            def step_ids(steps):
                return {step['id'] for step in steps}.union(*(step_ids(step.get('steps',[]))|step_ids(step.get('elseSteps',[])) for step in steps))
            assert step_ids([duplicated['steps'][1]]).isdisjoint(step_ids([duplicated['steps'][2]]))
            assert duplicated['steps'][2]['steps'][0]['steps'][1]['scriptId']==script_id
            page.get_by_label('ステップ 3 の操作',exact=True).click();menu('削除')
            passed('nested duplication refreshes all control IDs and preserves referenced saved scripts')

            page.get_by_label('待機 ms',exact=True).fill('10000')
            page.locator('#send').click()
            expect(page.locator(f'[data-step-id="{wait_id}"].running')).to_be_visible(timeout=30000)
            page.locator('#sidebarContent .tree-open').filter(has_text='Sequential flow').click()
            expect(page.locator('#send')).to_contain_text('実行')
            page.locator('#sidebarContent .tree-row').filter(has=page.locator('.tree-label',has_text='Sequential flow')).click(button='right')
            expect(page.get_by_role('menuitem',name='実行',exact=True)).to_be_enabled()
            expect(page.get_by_role('menuitem',name='停止',exact=True)).to_have_count(0)
            page.keyboard.press('Escape')
            page.locator(f'#sidebarContent [data-relation-id="{flow_id}"]').click(button='right')
            menu('停止')
            expect(page.locator('#stopRelationGlobal')).not_to_be_visible(timeout=5000)
            page.locator('#sidebarContent .tree-open').filter(has_text='Nested flow').click()
            expect(page.locator('#responseStatus')).to_contain_text('停止')
            run=stored()['relationRuns'][-1]
            assert run['status']=='cancelled' and not any(entry['type']=='request' for entry in run['entries']),run
            passed('an unrelated relation remains independently runnable and context Stop cancels a pending wait before HTTP')
            page.get_by_label('待機 ms',exact=True).fill('0')

            page.locator('#dataActions').click()
            with page.expect_download() as saved:
                menu('全体エクスポート')
            nested_bundle=json.loads(Path(saved.value.path()).read_text())
            persisted=next(relation for relation in relations(nested_bundle['workspace']) if relation['id']==flow_id)
            assert persisted['steps'][1]['steps'][0]['steps'][1]['scriptId']==script_id
            assert persisted['steps'][2]['type']=='while'
            fixture.reload(page);expect(page.locator('#connectionStatus')).to_contain_text('connected')
            side('collections');page.locator('#sidebarContent .tree-open').filter(has_text='Nested flow').click()
            expect(page.get_by_label('ステップ 2.1 の配列',exact=True)).to_have_value('[1,2,3,4]')
            expect(page.get_by_label('ステップ 3.1 のスクリプト',exact=True)).to_have_value(script_id)
            passed('nested control settings and script references survive backup and reload')

            for width,height in [(390,844),(320,720)]:
                page.set_viewport_size({'width':width,'height':height})
                page.locator('.request-title').scroll_into_view_if_needed()
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
                assert page.locator('#relationSteps').evaluate('(root)=>[...root.querySelectorAll("input,select,button")].filter(node=>node.offsetParent!==null).every(node=>{const box=node.getBoundingClientRect();return box.left>=-1&&box.right<=innerWidth+1})')
                expect(page.locator('#addRelationStep')).to_be_in_viewport()
                capture(f'relation-control-{width}')
            passed('nested relation controls keep their labels and actions within 320px and 390px screens')

            # Reorganize existing operations through the public editor, then
            # verify the resulting tree by executing it over actual HTTP.
            page.set_viewport_size({'width':1440,'height':1000})
            side('collections');page.locator('#sidebarAdd').click();menu('リレーション')
            page.locator('#modal').get_by_label('追加する名前',exact=True).fill('Block edits')
            page.locator('#modalSubmit').click()
            expect(page.locator('#modal')).not_to_be_visible()
            expect(page.locator('#requestName')).to_have_value('Block edits')

            def block_flow():
                return next(relation for relation in relations(stored()) if relation['name']=='Block edits')

            def operation_menu(identifier):
                page.locator(f'[data-step-id="{identifier}"] > .relation-step-heading > button[aria-label$="の操作"]').click()

            add_control('スクリプト')
            page.get_by_label('ステップ 1 のスクリプト',exact=True).select_option(script_id)
            page.get_by_label('ステップ 1 の入力形式',exact=True).select_option('json')
            page.get_by_label('ステップ 1 の入力',exact=True).fill('{"reset":true}')
            relation_source=next(script['source'] for script in stored()['scripts'] if script['id']==script_id)
            edited_relation_source="store.set('relationEmbeddedEdit',true);\n"+relation_source
            page.get_by_role('button',name='ステップ 1 のスクリプトを編集',exact=True).click()
            relation_editor=page.get_by_label('ステップ 1 のコード',exact=True)
            expect(relation_editor).to_be_visible();expect(relation_editor).to_be_focused()
            expect(relation_editor).to_have_js_property('readOnly',False)
            expect(page.locator('html')).to_have_attribute('data-workspace-view','request')
            expect(page.locator('#requestName')).to_have_value('Block edits')
            relation_editor.evaluate('node=>window.__embeddedRelationEditor=node')
            relation_editor.press('Control+a');page.keyboard.insert_text(edited_relation_source)
            assert next(script['source'] for script in stored()['scripts'] if script['id']==script_id)==edited_relation_source
            assert relation_editor.evaluate('node=>node===window.__embeddedRelationEditor && node.selectionStart===node.value.length')
            expect(relation_editor).to_be_focused()
            capture('relation-inline-script-desktop')
            page.set_viewport_size({'width':320,'height':720})
            relation_editor.scroll_into_view_if_needed()
            expect(relation_editor).to_be_visible()
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            assert relation_editor.evaluate('node=>{const rect=node.getBoundingClientRect();return rect.left>=0&&rect.right<=innerWidth+1}')
            capture('relation-inline-script-320')
            page.set_viewport_size({'width':1440,'height':1000})
            add_control('繰り返し')
            block_id=block_flow()['steps'][1]['id']
            block=page.locator(f'.relation-block[data-parent-step-id="{block_id}"][data-branch="steps"]')
            expect(block).to_be_visible()
            expect(block.locator('.relation-step')).to_have_count(0)
            expect(block.get_by_role('button',name='ステップ 2 の処理に追加',exact=True)).to_be_visible()
            expect(block.locator(':scope > .relation-block-heading')).to_contain_text('繰り返す処理')
            assert block.bounding_box()['height']>=28
            capture('relation-empty-block-desktop')
            page.set_viewport_size({'width':320,'height':720})
            block.scroll_into_view_if_needed()
            expect(block.get_by_role('button',name='ステップ 2 の処理に追加',exact=True)).to_be_in_viewport()
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            capture('relation-empty-block-320')
            page.set_viewport_size({'width':1440,'height':1000})
            passed('new empty loops expose a visible nested body and add action at desktop and 320px')

            add_control('スクリプト')
            page.get_by_label('ステップ 3 のスクリプト',exact=True).select_option(script_id)
            page.get_by_label('ステップ 3 の入力形式',exact=True).select_option('json')
            page.get_by_label('ステップ 3 の入力',exact=True).fill('null')
            child_id=block_flow()['steps'][2]['id']
            operation_menu(child_id);menu('ブロックで囲む');menu('繰り返し')
            wrapped=block_flow()['steps'][2]
            assert wrapped['type']=='repeat' and wrapped['steps'][0]['id']==child_id,wrapped
            wrapper_id=wrapped['id']
            operation_menu(child_id);menu('ブロックへ移動');menu('ステップ 2 繰り返し')
            moved=block_flow()
            assert moved['steps'][1]['steps'][0]['id']==child_id and moved['steps'][2]['steps']==[],moved
            operation_menu(wrapper_id);menu('削除')
            operation_menu(child_id);menu('外へ移動')
            promoted=block_flow()
            assert promoted['steps'][1]['steps']==[] and promoted['steps'][2]['id']==child_id,promoted
            page.locator(f'[data-step-id="{child_id}"] > .relation-step-heading [data-step-action="move"]').press('Alt+ArrowRight')
            nested=block_flow()
            assert len(nested['steps'])==2 and nested['steps'][1]['steps'][0]['id']==child_id,nested
            passed('existing steps wrap into blocks, move across parents, promote outside and re-nest by keyboard without changing identity')

            add_control('リクエスト')
            pick=page.get_by_label('ステップ 3 のリクエスト',exact=True)
            options=pick.locator('option').evaluate_all('(nodes)=>nodes.map(node=>({value:node.value,label:node.textContent}))')
            pick.select_option(next(option['value'] for option in options if option['label'].endswith(' / Finish')))
            request_id=block_flow()['steps'][2]['id']
            page.locator(f'[data-step-id="{request_id}"] > .relation-step-heading [data-step-action="move"]').drag_to(block.locator(':scope > .relation-block-heading'))
            arranged=block_flow()
            assert len(arranged['steps'])==2 and [step['id'] for step in arranged['steps'][1]['steps']]==[child_id,request_id],arranged
            page.locator('#send').click()
            expect(page.locator('#responseStatus')).to_contain_text('完了',timeout=30000)
            ws=stored();run=ws['relationRuns'][-1]
            assert run['relationId']==arranged['id'] and run['status']=='succeeded',run
            assert [entry['type'] for entry in run['entries']]==['script','script','request','script','request'],run
            assert [entry['requestName'] for entry in run['entries'] if entry['type']=='request']==['Finish','Finish'],run
            assert ws['scriptData']['loopSeen']==[{'item':None,'index':None},{'item':None,'index':None}],ws['scriptData']
            assert {row['key']:row['value'] for row in primary_values()}['counter']=='2'
            passed('native dragging moves a request into a loop and execution follows the edited nested order over HTTP')
            assert ws['scriptData']['relationEmbeddedEdit'] is True
            page.get_by_role('button',name='ステップ 1 のスクリプトを編集',exact=True).click()
            page.get_by_label('ステップ 1 のコード',exact=True).fill(relation_source)
            assert next(script['source'] for script in stored()['scripts'] if script['id']==script_id)==relation_source
            passed('relation script Edit keeps the same plan and editor, persists the shared source and executes its in-place changes')

            for width,height in [(1440,1000),(320,720)]:
                page.set_viewport_size({'width':width,'height':height})
                page.locator(f'[data-step-id="{block_id}"]').scroll_into_view_if_needed()
                expect(block).to_be_visible()
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
                assert block.evaluate('''node=>{
                    const bounds=node.getBoundingClientRect();
                    return [...node.querySelectorAll('.relation-step')].every(child=>{
                        const box=child.getBoundingClientRect();
                        return box.left>=bounds.left&&box.right<=bounds.right+1&&box.top>=bounds.top&&box.bottom<=bounds.bottom+1;
                    });
                }''')
                assert page.locator('#relationSteps').evaluate('(root)=>[...root.querySelectorAll("input,select,button")].filter(node=>node.offsetParent!==null).every(node=>{const box=node.getBoundingClientRect();return box.left>=-1&&box.right<=innerWidth+1})')
                capture(f'relation-edited-block-{width}')
            passed('visible loop boundaries contain their child operations and controls at desktop and 320px')
            assert not errors,errors
            passed('no uncaught browser JavaScript errors')
            browser.close()
    except Exception:
        try:
            page.screenshot(path=str(out/'failure.png'),full_page=True)
            snapshot=page.evaluate('(key)=>JSON.parse(localStorage.getItem(key))',KEY) if fixture.inline else page.evaluate(READ_WORKSPACE)
            (out/'failure-workspace.json').write_text(json.dumps(snapshot,ensure_ascii=False,indent=2))
        except Exception:
            pass
        raise
    finally:
        report={'passed':len(checks),'checks':checks,'page_errors':errors,'screenshots':shots,'transport':'injected DOM fixture with Python HTTP bridge' if fixture.inline else 'real browser HTTP'}
        (out/'results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
        for server in [app,echo]:server.shutdown();server.server_close()

if __name__=='__main__':main()
