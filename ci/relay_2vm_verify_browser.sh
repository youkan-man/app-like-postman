#!/usr/bin/env bash
set -euo pipefail
mkdir -p .local_relay/output
export PLAYWRIGHT_BROWSERS_PATH=/opt/minipost-playwright
source /opt/minipost-e2e-venv/bin/activate
[[ -n "${LOCAL_RELAY_VM_APP_IP:-}" && -n "${LOCAL_RELAY_VM_BROWSER_IP:-}" ]] || { echo 'Missing authenticated cross-VM addresses' >&2; exit 2; }
export MINIPOST_REMOTE_URL="http://${LOCAL_RELAY_VM_APP_IP}:${LOCAL_RELAY_VM_APP_PORT:-8080}"
export CHROMIUM=$(python -c 'from playwright.sync_api import sync_playwright; p=sync_playwright().start(); print(p.chromium.executable_path); p.stop()')
[[ -x "$CHROMIUM" ]] || { echo 'Installed Chromium executable is unavailable' >&2; exit 2; }
unset MINIPOST_INLINE_TEST || true
export ARTIFACT_DIR=.local_relay/output
python - <<'PY'
import hashlib,json,os,pathlib,urllib.request
root=pathlib.Path.cwd()
with urllib.request.urlopen(os.environ['MINIPOST_REMOTE_URL']+'/__relay_test_identity',timeout=8) as response:
    identity=json.load(response)
paths=[root/'app.py',root/'network.py',root/'url_codec.py',root/'upload_stream.py',root/'workspace_codec.py',*sorted((root/'static').iterdir())]
expected={str(path.relative_to(root)):hashlib.sha256(path.read_bytes()).hexdigest() for path in paths if path.is_file()}
assert identity.get('instance') and identity.get('files')==expected,'App process source differs from browser checkout'
for path in sorted((root/'static').iterdir()):
    if path.is_file():
        with urllib.request.urlopen(os.environ['MINIPOST_REMOTE_URL']+'/'+path.name,timeout=8) as response:
            assert hashlib.sha256(response.read()).hexdigest()==expected['static/'+path.name],path.name
(root/'.local_relay/output/source-identity.json').write_text(json.dumps(identity,indent=2))
print('PASS process identity and every served static asset match the pinned source')
PY
python ci/relay_two_vm_probe.py >.local_relay/output/two-vm-network.log 2>&1 || { cat .local_relay/output/two-vm-network.log; exit 1; }
# Each UI suite uses its own browser context. Collect every failure so one
# regression does not hide the remaining native verification evidence.
failed_suites=()
run_ui_suite() {
  local suite="$1" log="$2"
  if timeout --verbose --signal=TERM --kill-after=15s 600s python "tests/${suite}.py" >".local_relay/output/${log}" 2>&1; then
    echo "PASS ${suite}"
  else
    failed_suites+=("$suite")
    echo "FAIL ${suite}" >&2
    tail -80 ".local_relay/output/${log}" >&2
  fi
}
run_ui_suite ui_ribbons two-vm-ribbons.log
run_ui_suite ui_script_workspace_api two-vm-script-workspace-api.log
run_ui_suite ui_script_editor two-vm-script-editor.log
run_ui_suite ui_script_response two-vm-script-response.log
run_ui_suite ui_script_intelligence two-vm-script-intelligence.log
run_ui_suite ui_standalone_scripts two-vm-standalone-scripts.log
run_ui_suite ui_layout two-vm-layout.log
run_ui_suite ui_wheel_scroll two-vm-wheel-scroll.log
run_ui_suite ui_scroll_sync two-vm-scroll-sync.log
run_ui_suite ui_asset_update two-vm-asset-update.log
run_ui_suite ui_sent_values two-vm-sent-values.log
run_ui_suite ui_draft_lifecycle two-vm-draft-lifecycle.log
run_ui_suite ui_transfer_progress two-vm-transfer-progress.log
run_ui_suite ui_large_binary two-vm-large-binary.log
run_ui_suite ui_text_url_navigation two-vm-text-url-navigation.log
run_ui_suite ui_binary_workflows two-vm-binary-workflows.log
run_ui_suite ui_focus two-vm-ui-focus.log
run_ui_suite ui_extraction two-vm-ui-extraction.log
run_ui_suite ui_automation native-ui-automation.log
run_ui_suite ui_relation_requests two-vm-relation-requests.log
for suite in browser_smoke ui_workbench ui_edgecases ui_settings ui_selection ui_backup ui_storage ui_paging; do
  run_ui_suite "$suite" "native-${suite}.log"
done
if ((${#failed_suites[@]})); then
  printf 'Failed native suite: %s\n' "${failed_suites[@]}" >&2
  exit 1
fi
python - <<'PY'
import json,pathlib
root=pathlib.Path('.local_relay/output')
focus=json.loads((root/'ui-focus-results.json').read_text())
extract=json.loads((root/'extraction/results.json').read_text())
script=json.loads((root/'script-editor/results.json').read_text())
standalone=json.loads((root/'standalone-scripts/results.json').read_text())
workspace_api=json.loads((root/'script-workspace-api/results.json').read_text())
intelligence=json.loads((root/'script-intelligence/results.json').read_text())
response_scripts=json.loads((root/'script-response/results.json').read_text())
ribbons=json.loads((root/'ribbons/results.json').read_text())
assert ribbons['ok'] and ribbons['mode']=='native Chromium HTTP' and ribbons['native_indexeddb']
assert not any(ribbons[key] for key in ['page_errors','native_dialogs','crashes','unexpected_requests'])
assert response_scripts['ok'] and response_scripts['mode']=='native Chromium HTTP'
assert not any(response_scripts[key] for key in ['page_errors','native_dialogs','crashes'])
assert intelligence['ok'] and intelligence['mode']=='native Chromium HTTP' and intelligence['engine']=='TypeScript Language Service'
assert not any(intelligence[key] for key in ['page_errors','native_dialogs','crashes','unexpected_requests'])
assert standalone['ok'] and standalone['mode']=='native Chromium HTTP' and standalone['native_indexeddb']
assert not any(standalone[key] for key in ['page_errors','native_dialogs','crashes'])
assert workspace_api['ok'] and workspace_api['mode']=='native Chromium HTTP' and workspace_api['native_indexeddb']
assert not any(workspace_api[key] for key in ['page_errors','native_dialogs','crashes'])
automation=json.loads((root/'automation/results.json').read_text())
relation_requests=json.loads((root/'relation-requests/results.json').read_text())
assert relation_requests['ok'] and relation_requests['mode']=='native Chromium HTTP'
assert not relation_requests['page_errors'] and not relation_requests['native_dialogs']
network=json.loads((root/'two-vm-network.json').read_text())
layout=json.loads((root/'layout/results.json').read_text())
assert layout['ok'] and layout['mode']=='native Chromium HTTP'
assert not any(layout[key] for key in ['page_errors','native_dialogs','crashes'])
wheel=json.loads((root/'wheel-scroll/results.json').read_text())
assert wheel['ok'] and wheel['mode']=='native Chromium HTTP wheel' and wheel['cases']
assert all(case['ok'] for case in wheel['cases']) and not wheel['page_errors'] and not wheel['dialogs']
scroll_sync=json.loads((root/'scroll-sync/results.json').read_text())
assert scroll_sync['ok'] and scroll_sync['mode']=='native Chromium HTTP wheel' and scroll_sync['cases']
assert all(case['ok'] for case in scroll_sync['cases']) and not scroll_sync['page_errors'] and not scroll_sync['dialogs']
asset_update=json.loads((root/'asset-update/results.json').read_text())
assert asset_update['ok'] and asset_update['mode']=='native Chromium HTTP'
assert not any(asset_update[key] for key in ['page_errors','native_dialogs','crashes'])
sent_values=json.loads((root/'sent-values/results.json').read_text())
assert sent_values['mode']=='native Chromium HTTP' and not sent_values['page_errors'] and not sent_values['native_dialogs']
drafts=json.loads((root/'draft-lifecycle/results.json').read_text())
assert drafts['ok'] and drafts['mode']=='native Chromium HTTP' and drafts['native_indexeddb']
assert not any(drafts[key] for key in ['page_errors','native_dialogs','crashes'])
progress=json.loads((root/'transfer-progress/results.json').read_text())
assert progress['mode']=='native Chromium HTTP' and not progress['page_errors'] and not progress['native_dialogs']
large=json.loads((root/'large-binary/results.json').read_text())
assert not any(large[key] for key in ['page_errors','native_dialogs','crashes'])
text_url=json.loads((root/'text-url-navigation/results.json').read_text())
assert text_url['mode']=='native Chromium HTTP' and not text_url['page_errors'] and not text_url['native_dialogs']
binary=json.loads((root/'binary-workflows/results.json').read_text())
assert all(result['mode']=='native Chromium HTTP' for result in [focus,extract,script,binary])
assert automation['transport']=='real browser HTTP'
assert network['ok'] and network['cross_vm_proxy'] and network['app_http']
regression_paths=['browser-results.json','ui/ui-results.json','edgecases/results.json','settings/results.json','selection/results.json','backup/result.json','storage/result.json','paging/results.json']
regressions={path:json.loads((root/path).read_text()) for path in regression_paths}
assert not any(result.get('page_errors') or result.get('errors') for result in regressions.values())
assert regressions['storage/result.json']['native_indexeddb'] is True
summary={'transfer_progress_checks':len(progress['checks']),'large_binary_checks':len(large['checks']),'text_url_navigation_checks':len(text_url['checks']),'native_regression_checks':{path:len(result['checks']) for path,result in regressions.items()},'mode':'two-vm Chromium HTTP','source_identity_verified':True,'focus_checks':len(focus['checks']),'extraction_checks':len(extract['checks']),'script_checks':len(script['checks']),'binary_workflow_checks':len(binary['checks']),'native_automation_checks':len(automation['checks']),'network':network,'screenshots':sum(len(result['screenshots']) for result in [focus,extract,script,automation,binary,large])}
summary['sent_values_checks']=len(sent_values['checks'])
summary['screenshots']+=len(sent_values['screenshots'])
summary['draft_lifecycle_checks']=len(drafts['checks'])
summary['screenshots']+=len(drafts['screenshots'])
summary['asset_update_checks']=len(asset_update['checks'])
summary['screenshots']+=len(asset_update['screenshots'])
summary['layout_checks']=len(layout['checks'])
summary['screenshots']+=len(layout['screenshots'])
summary['wheel_scroll_checks']=len(wheel['cases'])
summary['screenshots']+=len(wheel['screenshots'])
summary['scroll_sync_checks']=len(scroll_sync['cases'])
summary['screenshots']+=len(scroll_sync['screenshots'])
summary['standalone_script_checks']=len(standalone['checks'])
summary['screenshots']+=len(standalone['screenshots'])
summary['script_intelligence_checks']=len(intelligence['checks'])
summary['screenshots']+=len(intelligence['screenshots'])
summary['script_response_checks']=len(response_scripts['checks'])
summary['screenshots']+=len(response_scripts['screenshots'])
summary['ribbon_checks']=len(ribbons['checks'])
summary['screenshots']+=len(ribbons['screenshots'])
summary['script_workspace_api_checks']=len(workspace_api['checks'])
summary['screenshots']+=len(workspace_api['screenshots'])
summary['relation_request_checks']=len(relation_requests['checks'])
summary['screenshots']+=len(relation_requests['screenshots'])
(root/'two-vm-summary.json').write_text(json.dumps(summary,indent=2))
print(json.dumps(summary,indent=2))
PY
