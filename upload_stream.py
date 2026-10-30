"""Bounded-memory, single-use upload staging and replayable outbound bodies.

TemporaryFile is anonymous/unlinked on supported systems: uploaded bytes are
never workspace data, and OS close (including process death) releases them.
"""
from __future__ import annotations

from contextlib import contextmanager
import secrets
import select
import socket
import tempfile
import threading
import time
import uuid

CHUNK_BYTES = 1024 * 1024
IO_BYTES = 64 * 1024
UPLOAD_TTL = 15 * 60
MAX_METADATA_BYTES = 1024 * 1024


class UploadError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def integer(value):
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 9007199254740991


class Upload:
    def __init__(self, sizes, directory=None):
        self.sizes = tuple(sizes)
        self.offsets = [0] * len(sizes)
        self.files = {}
        self.directory = directory
        self.lock = threading.RLock()
        self.cancelled = threading.Event()
        self.finished = threading.Event()
        self.touched = time.monotonic()
        self.claimed = False
        self.closed = False
        self.outgoing = None
        self.incoming = None
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

    def check(self):
        if self.cancelled.is_set():
            raise UploadError('ファイルの転送を中止しました。', 409)

    def cancel(self):
        self.cancelled.set()
        # Interrupt a blocked send/receive, not only the next buffer iteration.
        for connection in (self.outgoing, self.incoming):
            if connection is not None:
                try:
                    connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
        if not self.claimed:
            self.close()

    def close(self):
        self.finished.set()
        with self.lock:
            if self.closed:
                return
            self.closed = True
            for file in self.files.values():
                file.close()
            self.files.clear()

    def file(self, index):
        if not integer(index) or index >= len(self.sizes):
            raise UploadError('添付ファイルの参照が不正です。')
        if index not in self.files:
            self.files[index] = tempfile.TemporaryFile(mode='w+b', dir=self.directory)
        return self.files[index]

    def append(self, index, offset, length, source, connection=None):
        with self.lock:
            self.check()
            if self.claimed or self.closed:
                raise UploadError('この転送はすでに送信処理に使用されています。', 409)
            if not integer(index) or index >= len(self.sizes):
                raise UploadError('添付ファイルの参照が不正です。')
            if not integer(offset) or offset != self.offsets[index]:
                raise UploadError('ファイルの転送位置が一致しません。再送信してください。', 409)
            if not integer(length) or length < 1 or length > CHUNK_BYTES or offset + length > self.sizes[index]:
                raise UploadError('転送チャンクの長さが不正です。')
            self.incoming = connection
            try:
                target = self.file(index)
                target.seek(offset)
                remaining = length
                while remaining:
                    self.check()
                    data = source.read(min(remaining, IO_BYTES))
                    if not data:
                        raise UploadError('ファイルの転送が途中で切断されました。')
                    target.write(data)
                    remaining -= len(data)
                target.flush()
                self.offsets[index] += length
                self.touched = time.monotonic()
                return self.offsets[index]
            finally:
                self.incoming = None

    def watch_client(self, connection):
        """Abort a target operation when the final browser request disconnects."""
        def watch():
            while not self.finished.wait(.2):
                try:
                    readable, _, _ = select.select([connection], [], [], 0)
                    if readable and connection.recv(1, socket.MSG_PEEK) == b'':
                        self.cancel()
                        return
                except (OSError, ValueError):
                    return
        threading.Thread(target=watch, name='minipost-upload-peer', daemon=True).start()


class UploadStore:
    def __init__(self, directory=None, ttl=UPLOAD_TTL):
        self.directory = directory
        self.ttl = ttl
        self.entries = {}
        self.lock = threading.Lock()
        self.stopped = threading.Event()
        self.sweeper = None

    def create(self, sizes):
        if not isinstance(sizes, list) or not sizes or len(sizes) > 1024 or not all(integer(size) for size in sizes):
            raise UploadError('ファイルのサイズ一覧が不正です。')
        self.expire()
        with self.lock:
            token = secrets.token_hex(32)
            self.entries[token] = Upload(sizes, self.directory)
            if self.sweeper is None:
                self.sweeper = threading.Thread(target=self._sweep, name='minipost-upload-cleanup', daemon=True)
                self.sweeper.start()
        return token

    def _sweep(self):
        while not self.stopped.wait(30):
            self.expire()

    def get(self, token):
        with self.lock:
            value = self.entries.get(token)
        if value is None:
            raise UploadError('転送用ファイルが見つからないか有効期限が切れました。再送信してください。', 404)
        return value

    def discard(self, token):
        with self.lock:
            value = self.entries.pop(token, None)
        if value is not None:
            value.cancel()

    def expire(self):
        now = time.monotonic()
        with self.lock:
            expired = [key for key, value in self.entries.items() if not value.claimed and now - value.touched > self.ttl]
        for key in expired:
            self.discard(key)

    @contextmanager
    def claim(self, token, connection=None):
        upload = self.get(token)
        with upload.lock:
            upload.check()
            if upload.claimed or upload.closed:
                raise UploadError('同じ添付ファイルを重複送信できません。', 409)
            if tuple(upload.offsets) != upload.sizes:
                self.discard(token)
                raise UploadError('ファイルの転送が完了していません。', 409)
            upload.claimed = True
        if connection is not None:
            upload.watch_client(connection)
        try:
            yield upload
        finally:
            with self.lock:
                if self.entries.get(token) is upload:
                    del self.entries[token]
            upload.close()

    def close(self):
        self.stopped.set()
        with self.lock:
            values = list(self.entries.values())
            self.entries.clear()
        for value in values:
            value.cancel()
            value.close()


def quoted(value):
    value = str(value)
    if '\r' in value or '\n' in value:
        raise UploadError('フォームの名前・ファイル名に改行は使用できません。')
    return value.replace('\\', '\\\\').replace('"', '\\"')


class StreamBody:
    """A small segment list; file segments remain on disk, including redirects."""
    def __init__(self, upload, segments):
        self.upload = upload
        self.segments = segments
        self.size = sum(len(item) if isinstance(item, bytes) else upload.sizes[item] for item in segments)

    def __len__(self):
        return self.size

    def send(self, connection):
        self.upload.outgoing = connection.sock
        try:
            self.upload.check()
            connection.endheaders()
            for item in self.segments:
                if isinstance(item, bytes):
                    for start in range(0, len(item), IO_BYTES):
                        self.upload.check()
                        chunk = item[start:start + IO_BYTES]
                        connection.send(chunk)
                        self.upload.advance(len(chunk))
                else:
                    file = self.upload.file(item)
                    file.seek(0)
                    remaining = self.upload.sizes[item]
                    while remaining:
                        self.upload.check()
                        data = file.read(min(remaining, IO_BYTES))
                        if not data:
                            raise UploadError('送信用の一時ファイルを読み込めません。')
                        connection.send(data)
                        self.upload.advance(len(data))
                        remaining -= len(data)
        except Exception:
            self.upload.outgoing = None
            raise
        # Keep the socket registered while waiting for the target response, so
        # Cancel interrupts getresponse()/read() as well as upload writes.


def prepare_stream_body(payload, headers, upload):
    if 'body_upload' in payload:
        index = payload['body_upload']
        upload.file(index)
        if 'multipart' in payload or 'body_base64' in payload or payload.get('body') is not None:
            raise UploadError('送信本文の形式が重複しています。')
        return StreamBody(upload, [index])
    parts = payload.get('multipart')
    if not isinstance(parts, list):
        raise UploadError('転送したファイルの使用先が指定されていません。')
    boundary = '----MiniPost' + uuid.uuid4().hex
    segments = []
    for part in parts:
        if not isinstance(part, dict) or 'key' not in part:
            raise UploadError('multipartの形式が不正です。')
        disposition = f'Content-Disposition: form-data; name="{quoted(part["key"])}"'
        if 'upload' in part:
            upload.file(part['upload'])
            disposition += f'; filename="{quoted(part.get("filename", "blob"))}"'
            data = part['upload']
        elif 'filename' in part:
            raise UploadError('ファイルの転送データが指定されていません。')
        else:
            data = str(part.get('value', '')).encode('utf-8')
        head = f'--{boundary}\r\n{disposition}\r\n'
        content_type = part.get('content_type')
        if content_type:
            if not isinstance(content_type, str) or '\r' in content_type or '\n' in content_type:
                raise UploadError('Content-Typeが不正です。')
            head += f'Content-Type: {content_type}\r\n'
        segments.extend([head.encode('utf-8') + b'\r\n', data, b'\r\n'])
    segments.append(f'--{boundary}--\r\n'.encode('ascii'))
    headers[:] = [(key, value) for key, value in headers if key.lower() != 'content-type']
    headers.append(('Content-Type', f'multipart/form-data; boundary={boundary}'))
    return StreamBody(upload, segments)
