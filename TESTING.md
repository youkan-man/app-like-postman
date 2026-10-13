# Tests

## GitHub Actions

`.github/workflows/verify.yml` runs on pull requests to `main`, pushes to `main`, and manual dispatch. It uses hosted Ubuntu 24.04 runners, Python 3.12 and Node.js 22. It neither deploys the app nor publishes a Docker image.

| Job | Coverage | Artifact |
| --- | --- | --- |
| Import and HTTP regression | Postman import, request compilation, real loopback HTTP and self-signed HTTPS | `regression-<attempt>` |
| Chromium live HTTP E2E | Real imports/sends/files/persistence, UI interactions and screenshots | `browser-<attempt>` |
| Docker build and HTTP smoke | Image build, startup, health, static UI, bundled Collection and HTTP proxy | `docker-<attempt>` |

Artifacts are retained for 14 days and uploaded even when a test fails. Failed tests fail the job; piping output does not hide the exit status. Docker readiness polls the read-only health endpoint for up to 30 seconds, including connection resets during startup. It never retries mutating requests.

**COM Gateway integration runs separately in the Gateway repository**, using `.github/workflows/minipost-integration.yml`. That workflow checks out its own source plus a pinned public MiniPost commit. This avoids cross-repository credentials and keeps Gateway evidence there. Update that pin when changing the tested MiniPost revision; success here alone is not a Gateway result.

## Browser coverage and evidence

The browser job runs these independently so an earlier failure still preserves later diagnostics:

| Script | Coverage |
| --- | --- |
| `tests/browser_smoke.py` | 18 original scenarios: imports, authentication, body modes, files, storage, tab isolation, preview restrictions, cancellation and responsive layout |
| `tests/ui_workbench.py` | 21 groups: menus, drawers, focus/cancel, keyboard/touch, splitter persistence, many tabs, 48 saved requests, long names/URLs, errors and responsive layouts |
| `tests/ui_edgecases.py` | 5 groups: editing v2.0 auth at request/collection scope, inherited HTTP auth, dated history, enlarged method labels and JavaScript errors |

Counts above describe the suite, not the status of an arbitrary revision. Check its Actions run and result JSON for actual results. These scripts use real browser navigation, real localStorage and real loopback HTTP; fetch is not mocked.

Screenshots include empty and populated workspaces, dark/light themes, side-by-side layout, context menus, variable editing, errors, many/long entries, 1440/1024/768/390px widths, 200% root text enlargement and emulated touch. `ui/ui-results.json` records viewport, state and captured files. `edgecases/` adds history and enlarged POST/DELETE labels. A human or reviewing agent must open and inspect the images; successful file creation or passing DOM checks is not visual approval.

`tested-commit.txt` and `tested-source.zip` identify the exact tested checkout, including UI, tests and workflow. The ZIP has a SHA-256 record. A PR run may check out GitHub's synthetic merge commit rather than the branch head. Compare the archived files when validating that distinction. The allowlisted archive contains tracked app/test sources, not Git credentials or environment values.

Screenshots show an echo-server response, **not** a Gateway response. Physical COM/USB, actual phone hardware, Firefox/Safari and assistive-technology interoperability are not covered by these Chromium tests. The 200% check enlarges root text; it is not a test of every browser zoom configuration.

## Local regression

Python 3.12+, Node.js 20+, and `openssl` for self-signed TLS:

```bash
node --test tests/*.test.mjs
python -m unittest discover -s tests -p 'test_*.py' -v
```

`test_import_proxy.py` fails when Node.js is missing rather than silently skipping. To run only the Python proxy tests, use `-p 'test_proxy.py'`.

## Local browser reproduction

```bash
python -m pip install -r requirements-test.txt
python -m playwright install --with-deps chromium
export CHROMIUM="$(python -c "from playwright.sync_api import sync_playwright; p = sync_playwright().start(); print(p.chromium.executable_path); p.stop()")"
ARTIFACT_DIR=artifacts/browser python tests/browser_smoke.py
ARTIFACT_DIR=artifacts/browser python tests/ui_workbench.py
ARTIFACT_DIR=artifacts/browser python tests/ui_edgecases.py
```

`CHROMIUM` selects the executable; `ARTIFACT_DIR` receives screenshots, logs and result JSON. `tests/dom_smoke.py` is an optional legacy offline test with mocked fetch/localStorage, not a replacement for these live tests. No browser management policy is changed.

## Local real-Gateway integration

Check out `youkan-man/app-com-transport-gateway` alongside this project:

```bash
python -m pip install ../app-com-transport-gateway
GATEWAY_CHECKOUT=../app-com-transport-gateway python tests/gateway_integration.py
```

The test starts Gateway on an unused loopback port with temporary storage and a random test-only token. Ambient `GATEWAY_*` and `USB_AGENT_*` settings are removed from the child process. No existing deployment or physical device is used.

The actual `core.mjs` imports and compiles the sample Collection, and MiniPost sends its 12 requests to Gateway. Assertions cover health/session/listing, Demo create/start/events/policy/stop/delete, unauthenticated 401 and login Set-Cookie. Missing source/dependencies fail the test. The child process and temporary data are cleaned up on exit.
