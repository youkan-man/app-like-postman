# Local Relay CI: external URL acceptance

`.local_relay/workflow.json` uses Local Relay branch CI in `kip-n02`, not a
GitHub Actions job or a chain of interactive Sandbox-create Issues. It reserves
A (MiniPost in the shipped Docker bridge deployment), B (a live test-only HTTP
receiver), and C (Playwright Chromium) on a provider selected by Local Relay.
The application source and existing GitHub Actions workflows are unchanged.

The acceptance path is **C browser -> A published URL -> A Python proxy ->
B published URL**. Four button-driven POSTs cover JSON with Japanese text,
plain text, XML, and a deliberate upstream HTTP 502. Receiver identity, three
independent boot IDs, exact target URL, original Host, byte count and SHA-256,
and the receiver's unique request IDs must match. No POST is retried. This
receiver is not the private COM Gateway; its existing integration remains a
separate test and is not claimed by this workflow.

## Published endpoint contract

The test requires the following **non-secret provider metadata** on C:

```
LOCAL_RELAY_VM_A_PUBLIC_URL=http(s)://<published-host>:<A-published-port>
LOCAL_RELAY_VM_B_PUBLIC_URL=http(s)://<published-host>:<B-published-port>
```

These are an explicit requirement of this test, **not a claim that the current
Relay already injects them**. The inspected Relay revision
`1b070590a22e4b0973a1741b82d4d24179300b19` injects only member `_IP`, `_PORT`
and `_ADDRESS` (private peer addresses). If published metadata is not supplied,
the acceptance step fails with `MISSING_PUBLISHED_URL`, retaining the missing
contract in `verification.json`. Do not replace it with private `_ADDRESS`,
hard-code an expired Sandbox URL, calculate public ports from guest IPs, or
provide Sandbox/HostHub credentials to the VM. Published values must originate
from the provider's actual reservation metadata.

## Evidence and lifetime

Artifacts are written to `.local_relay/output/` on each VM. Local Relay publishes
its run result, per-VM logs, receiver receipts and screenshots under
`.local_relay/results/<run-id>/`. `verification.json` is authoritative for the
external test; successful deployment alone is not an E2E success. A failed
navigation must not be described as a successful POST. Missing metadata or
network failures are failures, not skips.

Only synthetic bodies are used. Do not attach private application logs,
credentials or real user payloads to this public repository's artifacts.
Local Relay retains VMs according to its finite contract; lease release is not
VM deletion. Success stops the two test services. On a later-step failure, the
receiver has a 35-minute systemd lifetime and A has a matching stop timer.
The workflow does not modify host routing/NAT or existing deployment services.

```
python3 -m unittest discover -s ci/local_relay -p 'test_*.py' -v
```

These local contract/receiver tests are not three-VM deployment evidence.
