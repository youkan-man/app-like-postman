#!/usr/bin/env bash
set -euo pipefail
mkdir -p .local_relay/output
export PLAYWRIGHT_BROWSERS_PATH=/opt/minipost-playwright
source /opt/minipost-e2e-venv/bin/activate
export ARTIFACT_DIR=.local_relay/output
export CHROMIUM=$(python -c 'from playwright.sync_api import sync_playwright; p=sync_playwright().start(); print(p.chromium.executable_path); p.stop()')
unset MINIPOST_INLINE_TEST || true
python tests/ui_public_entry.py >.local_relay/output/public-entry.log 2>&1 || { cat .local_relay/output/public-entry.log; exit 1; }
cat .local_relay/output/public-entry.log
