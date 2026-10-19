#!/usr/bin/env bash
set -euo pipefail
mkdir -p .local_relay/output
if [[ -z "${LOCAL_RELAY_VM_APP_IP:-}" ]]; then
  echo 'Missing injected LOCAL_RELAY_VM_APP_IP (no proven VM peer address)' >&2
  exit 2
fi
PORT="${LOCAL_RELAY_VM_APP_PORT:-8080}"
export HOST=0.0.0.0 PORT MINIPOST_WORKSPACE_FILE="/tmp/minipost-2vm-${LOCAL_RELAY_VM_APP_IP//./-}.json"
# The test instance is disposable and uses test-only storage.
if [[ -e .local_relay/output/app.pid ]]; then
  prior=$(cat .local_relay/output/app.pid)
  if kill -0 "$prior" 2>/dev/null; then
    echo "Managed MiniPost process already exists at PID ${prior}" >&2
    exit 2
  fi
fi
setsid python3 -u app.py </dev/null >.local_relay/output/app-server.log 2>&1 &
pid=$!
echo "$pid" >.local_relay/output/app.pid
python3 - <<'PY'
import json,os,time,urllib.request
base=f'http://127.0.0.1:{int(os.environ["PORT"])}'
for attempt in range(60):
  try:
    with urllib.request.urlopen(base+'/api/health',timeout=1.5) as response:
      payload=json.load(response)
      if response.status==200 and payload.get('ok'):
        print('Application VM HTTP server ready',base,flush=True)
        break
  except Exception:
    time.sleep(0.5)
else:
  raise SystemExit('Application VM HTTP readiness timeout; inspect app-server.log')
with open('.local_relay/output/app-readiness.json','w') as output:
  json.dump({'ready':True,'port':int(os.environ['PORT']),'test_only':True},output)
PY
