"""Explicit loopback routing and credential-free connection diagnostics."""
from __future__ import annotations

import errno
import ipaddress
import os
from pathlib import Path
import socket
import ssl


def runtime_info():
    container = os.environ.get("MINIPOST_CONTAINER") == "1" or Path("/.dockerenv").exists()
    mode = os.environ.get("MINIPOST_NETWORK_MODE", "unknown" if container else "native")
    return {"container": container, "network_mode": mode, "docker_host": "host.docker.internal"}


def is_loopback(host):
    if host.lower().rstrip(".") == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def connection_details(target, route="direct"):
    if route not in {"direct", "docker-host"}:
        raise ValueError("localhostの接続先は direct または docker-host を指定してください。")
    runtime = runtime_info()
    use_host = route == "docker-host" and is_loopback(target.hostname) and runtime["network_mode"] != "host"
    return {
        "scheme": target.scheme, "url_host": target.hostname,
        "connect_host": runtime["docker_host"] if use_host else target.hostname,
        "port": target.port or (443 if target.scheme == "https" else 80),
        "loopback_target": route, "host_routing_applied": use_host,
        "runtime": runtime,
    }


def connection_diagnostic(error, details, phase):
    code, hint = "NETWORK_ERROR", "送信先の待受・経路・ファイアウォールを確認してください。"
    if isinstance(error, socket.gaierror):
        code, hint = "DNS_ERROR", "送信元のDNSで名前解決できません。ホスト名またはIPアドレスを確認してください。"
    elif isinstance(error, ssl.SSLCertVerificationError):
        code, hint = "TLS_CERTIFICATE_ERROR", "信頼するCAと証明書のホスト名を確認してください。自己署名環境ではSettingsのTLS検証設定を確認してください。"
    elif isinstance(error, ssl.SSLError):
        code, hint = "TLS_ERROR", "HTTP/HTTPSの指定、TLSバージョン、送信先の証明書を確認してください。"
    elif isinstance(error, (TimeoutError, socket.timeout)):
        code, hint = "TIMEOUT", "接続または応答がタイムアウトしました。経路・待受・Timeoutを確認してください。"
    elif isinstance(error, ConnectionRefusedError):
        code, hint = "CONNECTION_REFUSED", "接続が拒否されました。送信先の起動・ポート・待受アドレスを確認してください。"
    elif isinstance(error, ConnectionResetError):
        code, hint = "CONNECTION_RESET", "送信先が接続を切断しました。HTTP/HTTPSの指定と送信先ログを確認してください。"
    elif getattr(error, "errno", None) in {errno.ENETUNREACH, errno.EHOSTUNREACH}:
        code, hint = "NETWORK_UNREACHABLE", "ネットワークへの経路がありません。Dockerネットワーク、VPN、LAN経路を確認してください。"
    runtime = details["runtime"]
    if details["connect_host"] == "host.docker.internal":
        hint += " DockerホストへはComposeのextra_hosts、またはdocker run --add-host=host.docker.internal:host-gatewayが必要です。Linuxのホスト側が127.0.0.1だけで待ち受ける場合はhostネットワーク構成を使用してください。"
    elif is_loopback(details["url_host"]) and runtime["container"] and runtime["network_mode"] != "host":
        hint += " このlocalhostはMiniPostコンテナ自身です。ホスト上のAPIには画面のlocalhost接続先でDockerホストを選択してください。"
    # No URL path, query, Authorization, request body, or proxy credentials.
    return {**details, "code": code, "phase": phase, "hint": hint}


def format_network_error(error, diagnostic):
    authority = f"{diagnostic['connect_host']}:{diagnostic['port']}"
    return f"{diagnostic['code']} · {authority} · {diagnostic['phase']}\n{error}\n\n{diagnostic['hint']}"
