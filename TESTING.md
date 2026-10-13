# Tests

## GitHub Actions

`.github/workflows/verify.yml` runs on pull requests to `main`, pushes to `main`, and manual dispatch after the workflow is available on the default branch. It uses hosted Ubuntu 24.04 runners, Python 3.12 and Node.js 22. It neither deploys the app nor publishes a Docker image.

| Job | Coverage | Artifact |
| --- | --- | --- |
| Import and HTTP regression | Postman import, request compilation, real loopback HTTP and self-signed HTTPS | `regression-<attempt>` |
| Chromium live HTTP E2E | Actual browser navigation, imports, sends, files, persistence, tab isolation and responsive layout | `browser-<attempt>` |
| Docker build and HTTP smoke | Image build, startup, health, static UI, bundled Collection and HTTP proxy | `docker-<attempt>` |

Artifacts are retained for 14 days and uploaded even when a test fails. A failed test still fails its job; piping output to the log does not hide the exit status. Docker readiness polls the read-only health endpoint for up to 30 seconds, including connection resets during startup. It does not retry mutating requests.

**COM Gateway integration runs separately in the Gateway repository**, using `.github/workflows/minipost-integration.yml`. That workflow checks out its own source plus a pinned public MiniPost commit. This avoids cross-repository credentials and keeps Gateway evidence in that repository. When changing MiniPost integration code, update the pinned MiniPost ref there and rerun that workflow; success here alone is not a Gateway result.

## Verified on 2026-10-13

| Layer | Result | Target |
| --- | --- | --- |
| Node core and import compatibility | 49 / 49 passed | Collection v2.0/v2.1, variables, inherited auth, bodies, archive index and export |
| Python proxy | 22 / 22 passed | Real loopback HTTP and self-signed HTTPS |
| Import → compile → proxy → HTTP | 4 / 4 passed | Separate echo server; 13 requests within these tests |
| Chromium live E2E | 18 / 18 passed | Real browser and loopback HTTP; no mocked fetch/localStorage |
| COM Gateway integration | 12 / 12 requests passed | Actual Gateway process with a disposable Demo port |
| Docker build and HTTP smoke | Passed | Built image, HTTP startup, static UI, Collection and proxy |

The browser screenshot shows an echo-server response, **not** a Gateway response. Gateway success is established by its separate integration log. Physical COM/USB devices are not tested. Earlier offline DOM results are not included in the counts above.

## Local regression

Python 3.12+, Node.js 20+, and `openssl` for the self-signed TLS tests:

```bash
node --test tests/*.test.mjs
python -m unittest discover -s tests -p 'test_*.py' -v
```

`test_import_proxy.py` fails when Node.js is missing rather than silently skipping. To run only the Python proxy tests, use `-p 'test_proxy.py'`.

## Local browser E2E

```bash
python -m pip install -r requirements-test.txt
python -m playwright install --with-deps chromium
export CHROMIUM="$(python -c "from playwright.sync_api import sync_playwright; p = sync_playwright().start(); print(p.chromium.executable_path); p.stop()")"
ARTIFACT_DIR=artifacts/browser python tests/browser_smoke.py
```

`CHROMIUM` selects the browser executable. `ARTIFACT_DIR` receives the screenshot, result JSON, and downloaded response. `tests/dom_smoke.py` remains an optional offline test with explicitly mocked fetch/localStorage and is not a replacement for live E2E. No browser management policy is changed.

## Local real-Gateway integration

Check out `youkan-man/app-com-transport-gateway` alongside this project, then install its package and dependencies:

```bash
python -m pip install ../app-com-transport-gateway
GATEWAY_CHECKOUT=../app-com-transport-gateway python tests/gateway_integration.py
```

The test starts Gateway on an unused loopback port with temporary storage and a random test-only token. Ambient `GATEWAY_*` and `USB_AGENT_*` settings are removed from that child process. No existing deployment or physical device is used.

The actual `core.mjs` imports and compiles the sample Collection, and MiniPost sends its 12 requests to Gateway. Assertions cover health/session/listing, Demo create/start/events/policy/stop/delete, unauthenticated 401, and login Set-Cookie. Missing source or dependencies fail the test. The child process and temporary data are cleaned up on exit.
