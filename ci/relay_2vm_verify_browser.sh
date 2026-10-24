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
paths=[root/'app.py',root/'network.py',*sorted((root/'static').iterdir())]
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
python tests/ui_script_editor.py >.local_relay/output/two-vm-script-editor.log 2>&1 || { cat .local_relay/output/two-vm-script-editor.log; exit 1; }
python tests/ui_focus.py >.local_relay/output/two-vm-ui-focus.log 2>&1 || { cat .local_relay/output/two-vm-ui-focus.log; exit 1; }
python tests/ui_extraction.py >.local_relay/output/two-vm-ui-extraction.log 2>&1 || { cat .local_relay/output/two-vm-ui-extraction.log; exit 1; }
python tests/ui_automation.py >.local_relay/output/native-ui-automation.log 2>&1 || { cat .local_relay/output/native-ui-automation.log; exit 1; }
python - <<'PY'
import json,pathlib
root=pathlib.Path('.local_relay/output')
focus=json.loads((root/'ui-focus-results.json').read_text())
extract=json.loads((root/'extraction/results.json').read_text())
script=json.loads((root/'script-editor/results.json').read_text())
automation=json.loads((root/'automation/results.json').read_text())
network=json.loads((root/'two-vm-network.json').read_text())
assert all(result['mode']=='native Chromium HTTP' for result in [focus,extract,script])
assert automation['transport']=='real browser HTTP'
assert network['ok'] and network['cross_vm_proxy'] and network['app_http']
summary={'mode':'two-vm Chromium HTTP','source_identity_verified':True,'focus_checks':len(focus['checks']),'extraction_checks':len(extract['checks']),'script_checks':len(script['checks']),'native_automation_checks':len(automation['checks']),'network':network,'screenshots':sum(len(result['screenshots']) for result in [focus,extract,script,automation])}
(root/'two-vm-summary.json').write_text(json.dumps(summary,indent=2))
print(json.dumps(summary,indent=2))
PY
