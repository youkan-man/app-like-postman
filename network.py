"""Direct URL connections and credential-free diagnostics; no routing overrides."""
from __future__ import annotations

import errno
import ipaddress
import os
from pathlib import Path
import socket
import ssl


def runtime_info():
    container = os.environ.get("MINIPOST_CONTAINER") == "1" or Path("/.dockerenv").exists()
    return {"container": container, "network_mode": "container" if container else "native"}


def is_loopback(host):
    if host.lower().rstrip(".") == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def connection_details(target):
    return {
        "scheme": target.scheme, "url_host": target.hostname,
        "connect_host": target.hostname,
        "port": target.port or (443 if target.scheme == "https" else 80),
        "host_routing_applied": False, "runtime": runtime_info(),
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
    if is_loopback(details["url_host"]) and details["runtime"]["container"]:
        hint += " localhostはMiniPostコンテナ自身です。送信したいAPIの到達可能なURLを入力してください。"
    return {**details, "code": code, "phase": phase, "hint": hint}


def format_network_error(error, diagnostic):
    authority = f"{diagnostic['connect_host']}:{diagnostic['port']}"
    return f"{diagnostic['code']} · {authority} · {diagnostic['phase']}\n{error}\n\n{diagnostic['hint']}"
