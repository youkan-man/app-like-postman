#!/usr/bin/env bash
set -euo pipefail
mkdir -p .local_relay/output
[[ -n "${LOCAL_RELAY_VM_APP_IP:-}" ]] || { echo 'Missing injected app peer address' >&2; exit 2; }
root=$(pwd)
unit=minipost-relay-ci-test
instance=$(python3 -c 'import uuid; print(uuid.uuid4().hex)')
port=${LOCAL_RELAY_VM_APP_PORT:-8080}
# Only stop the unit owned by this test. Never kill arbitrary port owners.
systemctl stop "${unit}.service" 2>/dev/null || true
systemctl reset-failed "${unit}.service" 2>/dev/null || true
systemd-run --unit="$unit" --collect --property=RuntimeMaxSec=1800s \
  --property="WorkingDirectory=$root" \
  --property="StandardOutput=append:$root/.local_relay/output/app-server.log" \
  --property="StandardError=append:$root/.local_relay/output/app-server.log" \
  --setenv=HOST=0.0.0.0 --setenv="PORT=$port" \
  --setenv="MINIPOST_TEST_INSTANCE=$instance" \
  --setenv="MINIPOST_WORKSPACE_FILE=/tmp/minipost-relay-$instance.json" \
  /usr/bin/python3 -u "$root/ci/relay_fixture_server.py"
export MINIPOST_TEST_INSTANCE="$instance" PORT="$port"
if ! python3 - <<'PY'
import json, os, time, urllib.request, subprocess
from pathlib import Path
base=f'http://127.0.0.1:{os.environ["PORT"]}'
for attempt in range(60):
    if subprocess.run(['systemctl','is-active','--quiet','minipost-relay-ci-test.service']).returncode:
        raise SystemExit('The test process exited; an unrelated healthy server is not acceptance evidence')
    try:
        with urllib.request.urlopen(base+'/__relay_test_identity',timeout=2) as response:
            identity=json.load(response)
        if identity.get('instance')!=os.environ['MINIPOST_TEST_INSTANCE']:
            raise SystemExit('Port belongs to a different application instance')
        with urllib.request.urlopen(base+'/api/health',timeout=2) as response:
            assert json.load(response)['ok']
        Path('.local_relay/output/app-readiness.json').write_text(json.dumps({'ready':True,'instance':identity['instance'],'files':identity['files']}))
        print('PASS exact newly launched MiniPost instance',flush=True)
        break
    except (OSError,ValueError,AssertionError):
        time.sleep(.5)
else:
    raise SystemExit('Application identity/readiness timeout')
PY
then
  systemctl stop "${unit}.service" || true
  cat .local_relay/output/app-server.log >&2
  exit 1
fi
