"""Run the real COM Gateway in disposable local storage; never touch an existing instance."""
from __future__ import annotations

import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer
from urllib.error import URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app import Handler


def main():
    checkout = Path(os.environ.get("GATEWAY_CHECKOUT", "__missing_gateway_checkout__")).resolve()
    if not (checkout / "gateway" / "app.py").is_file():
        raise SystemExit("NOT RUN: set GATEWAY_CHECKOUT to an app-com-transport-gateway checkout.")
    with tempfile.TemporaryDirectory(prefix="minipost-gateway-") as data:
        token = secrets.token_urlsafe(48)
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        # Prevent ambient production GATEWAY_* settings from affecting this test instance.
        env = {k: v for k, v in os.environ.items() if not k.startswith(("GATEWAY_", "USB_AGENT_"))}
        env.update(GATEWAY_DATA_DIR=data, GATEWAY_ADMIN_TOKEN=token, PYTHONPATH=str(checkout))
        with open(Path(data) / "gateway.log", "w+") as log:
            child = subprocess.Popen([sys.executable, "-m", "uvicorn", "gateway.app:app", "--host", "127.0.0.1", "--port", str(port)], cwd=checkout, env=env, stdout=log, stderr=log)
            proxy = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            worker = threading.Thread(target=proxy.serve_forever, daemon=True)
            worker.start()
            try:
                for _ in range(100):
                    if child.poll() is not None:
                        raise RuntimeError("Gateway exited before readiness. Check its dependencies; integration did not run.")
                    try:
                        with urlopen(f"http://127.0.0.1:{port}/healthz", timeout=0.5) as response:
                            assert json.load(response)["status"] == "ok"
                        break
                    except (URLError, OSError):
                        time.sleep(0.1)
                else:
                    raise RuntimeError("Gateway did not become ready; integration did not run.")
                script = """
import fs from 'node:fs';
import {importPostman,walkItems,compileRequest} from './static/core.mjs';
const options=JSON.parse(fs.readFileSync(0,'utf8'));
const c=importPostman(fs.readFileSync('examples/com-gateway.postman_collection.json','utf8')).collections[0];
const env={id:'test',values:Object.entries(options).map(([key,value])=>({key,value}))};
const ws={collections:[c],globals:[],environments:[env],environmentId:'test'};
const result=[];
walkItems(c.item,item=>{if(item.request)result.push({name:item.name,payload:compileRequest(ws,{collectionId:c._mpId,itemId:item._mpId,request:item.request}).payload});});
process.stdout.write(JSON.stringify(result));
"""
                compiled = subprocess.run(["node", "--input-type=module", "-e", script], cwd=ROOT,
                    input=json.dumps({"baseUrl": f"http://127.0.0.1:{port}", "gatewayToken": token, "portId": "minipost-demo"}),
                    capture_output=True, text=True, check=True)
                cases = json.loads(compiled.stdout)
                assert len(cases) == 12
                for case in cases:
                    request = Request(f"http://127.0.0.1:{proxy.server_port}/api/request", data=json.dumps(case["payload"]).encode(), headers={"Content-Type": "application/json"})
                    with urlopen(request, timeout=15) as response:
                        result = json.load(response)
                    expected = 201 if case["name"] == "Create demo port" else 401 if case["name"].startswith("Unauthenticated") else 200
                    assert result["ok"] and result["status"] == expected, (case["name"], result.get("status"), result.get("error"))
                    body = json.loads(result["body"])
                    if case["name"] == "Start demo port": assert body["state"] == "running"
                    if case["name"] == "Stop demo port": assert body["state"] == "stopped"
                    if case["name"].startswith("Login"): assert any(h["key"].lower() == "set-cookie" for h in result["headers"])
                    print(f"PASS {case['name']} -> {expected}", flush=True)
                print("PASS: 12 real-Gateway requests through MiniPost; disposable data only.")
            finally:
                proxy.shutdown(); proxy.server_close(); worker.join(timeout=3)
                if child.poll() is None:
                    child.terminate()
                    try: child.wait(timeout=10)
                    except subprocess.TimeoutExpired: child.kill(); child.wait()


if __name__ == "__main__":
    main()
