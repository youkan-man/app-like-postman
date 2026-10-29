#!/usr/bin/env bash
set -euo pipefail
mkdir -p .local_relay/output
export PLAYWRIGHT_BROWSERS_PATH=/opt/minipost-playwright
source /opt/minipost-e2e-venv/bin/activate
[[ -n "${LOCAL_RELAY_VM_APP_IP:-}" && -n "${LOCAL_RELAY_VM_BROWSER_IP:-}" ]] || { echo 'Missing authenticated cross-VM addresses' >&2; exit 2; }
export MINIPOST_REMOTE_URL="http://${LOCAL_RELAY_VM_APP_IP}:${LOCAL_RELAY_VM_APP_PORT:-8080}"
export CHROMIUM=$(python -c 'from playwright.sync_api import sync_playwright; p=sync_playwright().start(); print(p.chromium.executable_path); p.stop()')
export ARTIFACT_DIR=.local_relay/output
unset MINIPOST_INLINE_TEST || true
python tests/ui_chunked_ingress.py >.local_relay/output/chunked-ingress.log 2>&1 || { cat .local_relay/output/chunked-ingress.log; exit 1; }
cat .local_relay/output/chunked-ingress/results.json
