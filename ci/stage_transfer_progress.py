"""Apply reviewed, plaintext edits to disposable verification checkouts.

Every input is pinned to its Git blob. Export the exact tested files for clean
promotion; this helper and the staging workflow are not application changes.
"""
from pathlib import Path
import hashlib
import json

CHANGES = {}

def change(path, sha, replacements):
    CHANGES[path] = (sha, replacements)

change('static/app.js', '4d67ce3365ccca37195d177401626fc5d2e96d35', [
    ("import {bindUrlMenu} from './url-menu.mjs';", "import {bindUrlMenu} from './url-menu.mjs';\nimport {TransferProgress, createTransferView, paintTransferView} from './transfer-progress.mjs';"),
    ('const responses = new Map(), requests = new Map(), selectedFiles = new RequestFiles();',
     "const responses = new Map(), requests = new Map(), selectedFiles = new RequestFiles();\nconst transfers = new TransferProgress(id => {if (active().id === id) paintTransferView($('transferProgress'), transfers.get(id));});"),
    ("root.append(emptyResponse('送信中…')); return;", "root.append(createTransferView(transfers.get(active().id))); return;"),
    ('const tab = active(); if (requests.has(tab.id)) {requests.get(tab.id).abort(); return;}',
     'const tab = active(); if (requests.has(tab.id)) {transfers.cancelling(tab.id); requests.get(tab.id).abort(); return;}'),
    ('controller = new AbortController(); requests.set(tab.id, controller);',
     'controller = new AbortController(); requests.set(tab.id, controller);\n  const transfer = transfers.begin(tab.id);'),
    ('files:selectedFiles.snapshot(tab.id,snapshot.request,controller.signal)});',
     'files:selectedFiles.snapshot(tab.id,snapshot.request,controller.signal),onProgress:transfer.update});'),
    ('} finally {requests.delete(tab.id); if (active().id === tab.id)',
     '} finally {transfer.finish(); requests.delete(tab.id); if (active().id === tab.id)')
])
change('static/studio.mjs', '41b714b310ad8b5365912c788caf9ca88e3f3a67', [
    ('async function execute(tab,{signal,environmentId=w().environmentId,files={}}={})',
     'async function execute(tab,{signal,environmentId=w().environmentId,files={},onProgress}={})'),
    ('workspace:w(),tab,files,primary,environmentId,signal,onVariables:',
     'workspace:w(),tab,files,primary,environmentId,signal,onProgress,onVariables:')
])
change('static/execution.mjs', '10bbd76b8163e623d302d1fbecc8cf602cf7acb4', [
    ('onVariables=()=>{},onScript=()=>{}})', 'onVariables=()=>{},onScript=()=>{},onProgress})'),
    ('    const ctx=contextFor(view,snapshot,primary.rows);',
     "    onProgress?.({phase:phase==='before'?'script':'processing'});\n    const ctx=contextFor(view,snapshot,primary.rows);"),
    ('send(compiled.payload,signal)', 'send(compiled.payload,signal,onProgress)')
])
change('static/transport.mjs', 'cc351a284f3112e4acb68ead0111d799756bc1d6', [
    ("import {uploadPlan, uploadFiles} from './upload-transport.mjs';",
     "import {uploadPlan, uploadFiles} from './upload-transport.mjs';\nimport {watchTransferProgress} from './transfer-monitor.mjs';"),
    ('  try {\n    return await callProxy',
     "  onProgress?.({phase: 'send'});\n  const stop = watchTransferProgress(staged.progress, signal, onProgress);\n  try {\n    return await callProxy"),
    ('} finally {await staged.release();}', '} finally {stop(); await staged.release();}')
])
change('static/upload-transport.mjs', 'b6e46b5fc041505ebbd42febf9782cd5d464c891', [
    ("onProgress({phase: 'send', completed, total});", "onProgress({phase: 'send'});"),
    ('return {request: {...plan.request, upload_id: created.upload_id}, release};',
     "return {request: {...plan.request, upload_id: created.upload_id}, release,\n      progress: created.progress === true ? endpoint + '/progress' : null};")
])
change('app.py', 'fb92821830e78916d89bc265552de70fbc5add0b', [
    ('        phase = "connect"\n        try:',
     '        phase = "connect"\n        if upload is not None:\n            upload.begin_send(len(body) if body is not None else 0)\n        try:'),
    ('            phase = "receive"\n            response',
     '            phase = "receive"\n            if upload is not None:\n                upload.wait_response()\n            response'),
    ('    def do_GET(self):\n        if self.path == "/api/health":',
     '''    def do_GET(self):
        progress = re.fullmatch(r"/api/uploads/([a-f0-9]{64})/progress", self.path)
        if progress:
            if not self.upload_origin_allowed():
                self.send_json(403, {"ok": False, "error": "別オリジンからの転送状態取得は許可されていません。"})
                return
            try:
                self.send_json(200, {"ok": True, "progress": UPLOADS.get(progress[1]).progress()})
            except UploadError as error:
                self.send_json(error.status, {"ok": False, "error": str(error)})
            return
        if self.path == "/api/health":'''),
    ('"uploads": {"protocol": 1, "chunk_bytes": CHUNK_BYTES}',
     '"uploads": {"protocol": 1, "chunk_bytes": CHUNK_BYTES, "progress": True}'),
    ('{"ok": True, "upload_id": token, "chunk_bytes": CHUNK_BYTES}',
     '{"ok": True, "upload_id": token, "chunk_bytes": CHUNK_BYTES, "progress": True}')
])
change('upload_stream.py', '9e2d7715b9cf391d330240beb51e8410cd0e4765', [
    ('        self.incoming = None\n\n    def check(self):',
     '''        self.incoming = None
        # Telemetry uses its own short lock, never the file/socket I/O lock.
        self.progress_lock = threading.Lock()
        self.progress_phase = "upload"
        self.progress_sent = 0
        self.progress_total = sum(sizes)
        self.progress_attempt = 0

    def begin_send(self, total):
        with self.progress_lock:
            self.progress_phase = "send"
            self.progress_sent = 0
            self.progress_total = total
            self.progress_attempt += 1

    def advance(self, length):
        with self.progress_lock:
            self.progress_sent += length

    def wait_response(self):
        with self.progress_lock:
            self.progress_phase = "waiting"

    def progress(self):
        # Polling is read-only and does not prolong idle upload retention.
        with self.progress_lock:
            return {"phase": self.progress_phase, "completed": self.progress_sent,
                    "total": self.progress_total, "attempt": self.progress_attempt}

    def check(self):'''),
    ('                        connection.send(item[start:start + IO_BYTES])',
     '                        chunk = item[start:start + IO_BYTES]\n                        connection.send(chunk)\n                        self.upload.advance(len(chunk))'),
    ('                        connection.send(data)\n                        remaining -= len(data)',
     '                        connection.send(data)\n                        self.upload.advance(len(data))\n                        remaining -= len(data)')
])
# These two insertions are anchored to exact source text and the pinned commit.
change('static/index.html', None, [('</head>', '  <link rel="stylesheet" href="transfer-progress.css">\n</head>')])
change('ci/relay_2vm_verify_browser.sh', '3e6cc27476d86be5bded46ee871f39b9217b473b', [
    ('python tests/ui_large_binary.py >', 'python tests/ui_transfer_progress.py >.local_relay/output/two-vm-transfer-progress.log 2>&1 || { cat .local_relay/output/two-vm-transfer-progress.log; exit 1; }\npython tests/ui_large_binary.py >'),
    ("large=json.loads((root/'large-binary/results.json').read_text())", "progress=json.loads((root/'transfer-progress/results.json').read_text())\nassert progress['mode']=='native Chromium HTTP' and not progress['page_errors'] and not progress['native_dialogs']\nlarge=json.loads((root/'large-binary/results.json').read_text())"),
    ("summary={'large_binary_checks':", "summary={'transfer_progress_checks':len(progress['checks']),'large_binary_checks':")
])

def apply(root):
    outputs = {}
    for name, (expected, replacements) in CHANGES.items():
        path = root/name
        raw = path.read_bytes()
        sha = hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()
        if expected and sha != expected:
            raise RuntimeError(f'{name}: expected {expected}, got {sha}')
        text = raw.decode()
        for before, after in replacements:
            if text.count(before) != 1:
                raise RuntimeError(f'{name}: edit anchor count {text.count(before)}: {before[:80]}')
            text = text.replace(before, after)
        outputs[name] = text.encode()
    # Validate all inputs before the first write. Only this disposable checkout is changed.
    for name, raw in outputs.items():
        (root/name).write_bytes(raw)
        target=root/'.local_relay/output/staged'/name
        target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(raw)
    manifest={name:{'sha256':hashlib.sha256(raw).hexdigest(),
        'git_blob':hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()} for name,raw in outputs.items()}
    (root/'.local_relay/output/progress-source-manifest.json').write_text(json.dumps(manifest,indent=2))
    print(json.dumps(manifest,indent=2))

if __name__=='__main__': apply(Path.cwd())
