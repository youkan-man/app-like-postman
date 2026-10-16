#!/usr/bin/env bash
set -euo pipefail
mkdir -p .local_relay/output
export PLAYWRIGHT_BROWSERS_PATH=/opt/minipost-playwright
source /opt/minipost-e2e-venv/bin/activate
[[ -n "${LOCAL_RELAY_VM_APP_IP:-}" && -n "${LOCAL_RELAY_VM_BROWSER_IP:-}" ]] || { echo 'Missing authenticated cross-VM addresses' >&2; exit 2; }
export MINIPOST_REMOTE_URL="http://${LOCAL_RELAY_VM_APP_IP}:${LOCAL_RELAY_VM_APP_PORT:-8080}"
unset MINIPOST_INLINE_TEST || true
export ARTIFACT_DIR=.local_relay/output
python ci/relay_two_vm_probe.py >.local_relay/output/two-vm-network.log 2>&1 || { cat .local_relay/output/two-vm-network.log; exit 1; }
python tests/ui_focus.py >.local_relay/output/two-vm-ui-focus.log 2>&1 || { cat .local_relay/output/two-vm-ui-focus.log; exit 1; }
python tests/ui_extraction.py >.local_relay/output/two-vm-ui-extraction.log 2>&1 || { cat .local_relay/output/two-vm-ui-extraction.log; exit 1; }
python - <<'PY'
import json,os,pathlib
root=pathlib.Path('.local_relay/output')
focus=json.loads((root/'ui-focus-results.json').read_text())
extract=json.loads((root/'extraction/results.json').read_text())
network=json.loads((root/'two-vm-network.json').read_text())
assert focus['mode']=='native Chromium HTTP',focus['mode']
assert extract['mode']=='native Chromium HTTP',extract['mode']
assert network['ok'] and network['cross_vm_proxy'] and network['app_http']
(root/'two-vm-summary.json').write_text(json.dumps({'mode':'two-vm Chromium HTTP','focus_checks':len(focus['checks']),'extraction_checks':len(extract['checks']),'network':network,'screenshots':len(focus['screenshots'])+len(extract['screenshots'])},indent=2))
print((root/'two-vm-summary.json').read_text())
PY
