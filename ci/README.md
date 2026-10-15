# Sandbox published-URL smoke test (opt-in)

This test verifies the real `app-like-postman` HTTP service through three
independent routes:

1. The application VM's `http://127.0.0.1:8080/api/health`.
2. A separate probe VM connecting to the app VM's private managed TCP relay.
3. The **exact `app.url` issued by the Sandbox API**, injected by the
   compatible Gateway as `LOCAL_RELAY_VM_APP_PUBLIC_URL`.

The public endpoint must return HTTP 200 and a random application instance
marker matching the private relay. No published URL is inferred from the VM's
private IP. Failure at any stage is a failing CI run, not successful hosting.

## Run via Local Relay

The repository's main branch deliberately retains
`.local_relay/workflow.json` with `"disabled": true`, because simply merging
this test should not create two guest VMs or expose an unauthenticated app.

To run a qualification, use a **dedicated test branch**, and commit the contents
of `ci/sandbox_published_url.workflow.example.json` as
`.local_relay/workflow.json` on that branch. The connected Relay's
owned-repository CI discovers the branch automatically when supported. A valid
Sandbox provider connection, capacity for two 8GiB guest disks and the running
Gateway version that supplies `LOCAL_RELAY_VM_APP_PUBLIC_URL` are required.

Read `.local_relay/results/<run-id>/` for execution and HTTP evidence, and
`vms/probe/artifacts/verification.json` for the independent endpoint check.
`PUBLISHED_URL_E2E_PASSED` is required; mere HTTP 202 admission or an issued
`app.url` does **not** mean the app was reachable.

The guest service is deliberately temporary (systemd stops it after six
minutes, even on test failure). It has no server-side login; run only on an
appropriately restricted private LAN/VPN, never as a public Internet service.
