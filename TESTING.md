# Tests

## GitHub Actions

`.github/workflows/verify.yml` runs on pull requests to `main`, pushes to `main`, and manual dispatch. It uses hosted Ubuntu 24.04 runners, Python 3.12 and Node.js 22. It neither deploys the app nor publishes a Docker image.

| Job | Coverage | Artifact |
| --- | --- | --- |
| Import and HTTP regression | Postman import, request compilation, real loopback HTTP and self-signed HTTPS | `regression-<attempt>` |
| Chromium live HTTP E2E | Real imports/sends/files/persistence, UI interactions and screenshots | `browser-<attempt>` |
| Docker outbound network and live browser | Shipped Compose, host HTTP/TLS, peer-container DNS, public HTTPS, host networking and actual browser 502 diagnosis | `docker-<attempt>` |

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

The browser job screenshots show an echo-server response, **not** a Gateway response. The separate private Gateway workflow now captures real Gateway responses through Docker. Physical COM/USB, actual phone hardware, Firefox/Safari and assistive-technology interoperability are not covered by these Chromium tests. The 200% check enlarges root text; it is not a test of every browser zoom configuration.

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

## Docker deployment coverage

The Docker job executes `tests/docker_network.py` using the shipped bridge and host Compose files. It verifies actual container-to-host HTTP/HTTPS, peer-container DNS, public HTTPS, and a loopback-only host service through host networking. Its real browser cases reproduce the localhost 502, select the Docker-host route, send again, and distinguish an upstream HTTP 502 from an entry proxy's HTML 502. The fixture endpoints here are live test servers, not the COM Gateway. Network namespace IDs and actual peer IP addresses demonstrate that traffic crosses the intended boundaries.

```bash
# Needs Linux Docker Engine/Compose, openssl, and installed Playwright Chromium.
ARTIFACT_DIR=artifacts/docker-network python tests/docker_network.py
```

Test containers use unique names/projects and are removed on exit. Only their read-only readiness requests are retried. No production container is stopped and no Docker socket is mounted inside MiniPost.

## Real Gateway outside Docker

Check out `youkan-man/app-com-transport-gateway` alongside this project. Install Docker/Compose, Node.js, Gateway dependencies and Playwright Chromium:

```bash
python -m pip install ../app-com-transport-gateway
python -m pip install -r requirements-test.txt
python -m playwright install --with-deps chromium
GATEWAY_CHECKOUT=../app-com-transport-gateway ARTIFACT_DIR=artifacts/gateway python tests/gateway_integration.py
```

The private Gateway workflow runs this script with **MiniPost inside Docker** and an actual Gateway process on the host, rather than both processes on loopback. It executes 12 lifecycle requests per deployment (bridge + host = 24) and browser-to-Docker-to-Gateway requests in both configurations. Screenshots from that workflow show actual Gateway health responses.

The Gateway instances use temporary data, unused ports and generated test-only tokens. Ambient `GATEWAY_*` and `USB_AGENT_*` settings are removed from the child process. Assertions cover health/session/listing, Demo create/start/events/policy/stop/delete, unauthenticated 401 and login Set-Cookie. Missing dependencies fail the test. Processes and test Compose projects are cleaned up on exit.

The historical 12-request in-process Gateway result did **not** validate Docker egress. Only the revised workflow's artifacts establish this coverage. No tests here verify the user's own LAN, production Gateway, physical devices or mandatory corporate forward proxies. See [NETWORKING.md](NETWORKING.md).
