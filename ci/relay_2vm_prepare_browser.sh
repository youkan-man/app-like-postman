#!/usr/bin/env bash
set -euo pipefail
mkdir -p .local_relay/output
export PLAYWRIGHT_BROWSERS_PATH=/opt/minipost-playwright
python3 -m venv /opt/minipost-e2e-venv
source /opt/minipost-e2e-venv/bin/activate
python -m pip install --disable-pip-version-check --quiet -r requirements-test.txt >.local_relay/output/browser-pip.log 2>&1 || { cat .local_relay/output/browser-pip.log; exit 1; }
python -m playwright install --with-deps chromium >.local_relay/output/browser-install.log 2>&1 || { tail -80 .local_relay/output/browser-install.log; exit 1; }
python - <<'PY'
from pathlib import Path
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    executable=Path(p.chromium.executable_path)
    assert executable.is_file(), executable
    print('Playwright Chromium installed at',executable)
PY
