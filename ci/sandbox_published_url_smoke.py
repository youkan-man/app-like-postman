#!/usr/bin/env python3
"""Real Sandbox publication smoke: guest localhost -> relay -> issued app URL.

This checks the *actual* MiniPost HTTP server, with no mocked responses.
The public URL must be supplied by Relay from the provider reservation; an
internal guest IP is not an acceptable substitute.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
IDENTITY_PATH = "/__ci_publication__/identity.json"
UNIT = "minipost-sandbox-published-url-smoke"
OPENER = build_opener(ProxyHandler({}))


def get_json(url: str) -> dict:
    with OPENER.open(Request(url, headers={"Accept": "application/json"}), timeout=5) as response:
        if response.status != 200:
            raise RuntimeError(f"Unexpected HTTP status {response.status} at {url}")
        data = json.load(response)
    if not isinstance(data, dict):
        raise RuntimeError("Expected a JSON object from MiniPost")
    return data


def report(value: dict) -> None:
    destination = ROOT / ".local_relay" / "output" / "verification.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def launch() -> None:
    identity_file = ROOT / "static" / "__ci_publication__" / "identity.json"
    identity_file.parent.mkdir(parents=True, exist_ok=True)
    identity = {"application": "app-like-postman", "test": "sandbox-published-url-20261014",
                "instance": uuid.uuid4().hex}
    identity_file.write_text(json.dumps(identity), encoding="utf-8")

    # No stale service or unlimited background daemon. systemd will terminate
    # the test-only unauthenticated HTTP app after six minutes at the latest.
    subprocess.run(["systemctl", "stop", UNIT + ".service"], check=False,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run([
        "systemd-run", "--unit=" + UNIT, "--collect",
        "--property=RuntimeMaxSec=360s",
        "--property=WorkingDirectory=/workspace",
        "--setenv=HOST=127.0.0.1", "--setenv=PORT=8080",
        "/usr/bin/python3", "/workspace/app.py",
    ], check=True)
    last_error: Exception | None = None
    for attempt in range(30):
        try:
            if get_json("http://127.0.0.1:8080/api/health").get("ok") is True:
                observed = get_json("http://127.0.0.1:8080" + IDENTITY_PATH)
                if observed == identity:
                    report({"phase": "localhost-ready", "status": "passed",
                            "loopback": "http://127.0.0.1:8080", "identity": identity})
                    print("MINIPOST_LOCALHOST_8080_READY", flush=True)
                    return
                raise RuntimeError("MiniPost served an incorrect instance marker")
        except (OSError, ValueError, RuntimeError) as exc:
            last_error = exc
        time.sleep(0.3)
    raise RuntimeError(f"MiniPost failed guest-local HTTP readiness: {type(last_error).__name__}")


def require_issued_url(raw: str, guest_ip: str) -> str:
    if not raw:
        raise RuntimeError("MISSING_PUBLISHED_URL: provider app.url was not injected by Relay")
    parsed = urlsplit(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise RuntimeError("INVALID_PUBLISHED_URL: unsupported URL form")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise RuntimeError("INVALID_PUBLISHED_URL: path/query/fragment not allowed")
    if parsed.hostname in {"localhost", "127.0.0.1", "0.0.0.0", guest_ip}:
        raise RuntimeError("INVALID_PUBLISHED_URL: this is not an external app URL")
    if parsed.port is None:
        raise RuntimeError("INVALID_PUBLISHED_URL: host port missing")
    return raw.rstrip("/")


def verify() -> None:
    output = {"phase": "published-url-verification", "status": "failed"}
    try:
        guest_ip = os.environ.get("LOCAL_RELAY_VM_APP_IP", "")
        if not guest_ip:
            raise RuntimeError("MISSING_PEER_IP")
        # The managed guest relay listens on port 1000 and forwards to the
        # workload's loopback:8080. This is a private-network path, not the
        # issued host app endpoint.
        private_url = f"http://{guest_ip}:1000"
        private_identity = get_json(private_url + IDENTITY_PATH)
        if private_identity.get("application") != "app-like-postman" or not private_identity.get("instance"):
            raise RuntimeError("PRIVATE_RELAY_IDENTITY_MISMATCH")
        output["private_relay_verified"] = True

        public_url = require_issued_url(
            os.environ.get("LOCAL_RELAY_VM_APP_PUBLIC_URL", ""), guest_ip)
        external_identity = get_json(public_url + IDENTITY_PATH)
        if external_identity != private_identity:
            raise RuntimeError("PUBLISHED_URL_IDENTITY_MISMATCH")
        health = get_json(public_url + "/api/health")
        if health.get("ok") is not True:
            raise RuntimeError("PUBLISHED_URL_MINIPOST_HEALTH_FAILED")
        output.update(status="passed", phase="complete",
                      public_url=public_url, public_health_ok=True,
                      same_instance=True, instance=private_identity["instance"])
        print("PUBLISHED_URL_E2E_PASSED", flush=True)
    except Exception as exc:
        output["error"] = f"{type(exc).__name__}: {exc}"
        print("PUBLISHED_URL_E2E_FAILED:", output["error"], file=sys.stderr, flush=True)
        raise
    finally:
        report(output)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: sandbox_published_url_smoke.py launch|verify|stop")
    if sys.argv[1] == "launch":
        launch()
    elif sys.argv[1] == "verify":
        verify()
    elif sys.argv[1] == "stop":
        subprocess.run(["systemctl", "stop", UNIT + ".service"], check=True)
    else:
        raise SystemExit("Unknown action")


if __name__ == "__main__":
    main()
