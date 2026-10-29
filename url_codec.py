"""The HTTP boundary owns URL/form encoding. The editor sends plain strings."""
from __future__ import annotations

import re
from urllib.parse import quote, unquote, urlencode, urlsplit, urlunsplit

_ESCAPE = re.compile(r"(%[0-9a-fA-F]{2})")
_CONTROL = re.compile(r"[\x00-\x20\x7f]")
_PATH_VAR = re.compile(r"(^|/):([\w-]+)(?=/|$)")


def quote_existing(value: str, safe: str) -> str:
    """Encode Unicode/space once, preserving deliberate valid percent escapes.

    Unlike quote(..., safe='%'), an isolated percent sign is still encoded.
    This applies to a URL string, not to plain query/form field values.
    """
    return ''.join(part if _ESCAPE.fullmatch(part) else quote(part, safe=safe)
                   for part in _ESCAPE.split(value))


def wire_url(value: str) -> str:
    """Convert an IRI to an HTTP URL without decoding reserved delimiters."""
    parts = urlsplit(value)
    if parts.scheme not in ('http', 'https') or not parts.hostname:
        raise ValueError('http:// または https:// のURLを指定してください。')
    if parts.username is not None:
        raise ValueError('URL内の認証情報はAuthorizationのBasic Authに設定してください。')
    if _CONTROL.search(parts.netloc):
        raise ValueError('ホスト名に空白や制御文字は使用できません。')
    host = parts.hostname
    if ':' in host:  # IPv6 brackets are structural, not URL-encoded bytes.
        host = '[' + host + ']'
    else:
        host = host.encode('idna').decode('ascii')
    netloc = host + (':' + str(parts.port) if parts.port is not None else '')
    path = quote_existing(parts.path or '/', "/:@!$&'()*+,;=-._~")
    query = quote_existing(parts.query, "/?:@!$&'()*+,;=-._~")
    # Fragments never travel in an HTTP request target.
    return urlunsplit((parts.scheme, netloc, path, query, ''))


def request_url(payload: dict) -> str:
    """Resolve raw path variables and append text query rows at one boundary.

    Legacy clients may supply an already-escaped complete URL. That remains
    supported. New clients provide the unencoded base plus structured query.
    """
    value = str(payload.get('url', '')).lstrip()
    if not re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*://', value):
        value = 'http://' + value
    # urlsplit strips CR/LF/TAB in recent Python versions. Do not silently lose
    # those bytes or permit framing characters through the request target.
    if re.search(r'[\x00-\x1f\x7f]', value):
        raise ValueError('URLに制御文字は使用できません。')
    parts = urlsplit(value)
    variables = payload.get('path_variables', {})
    if not isinstance(variables, dict):
        raise ValueError('パス変数はオブジェクトで指定してください。')
    def replace(match):
        name = match[2]
        if name not in variables:
            # Older callers could intentionally use a literal colon segment.
            return match[0]
        return match[1] + quote(str(variables[name]), safe='')
    path = _PATH_VAR.sub(replace, parts.path)
    query = parts.query
    additions = payload.get('query', [])
    if not isinstance(additions, list):
        raise ValueError('クエリはキーと値の配列で指定してください。')
    for row in additions:
        if not isinstance(row, dict):
            raise ValueError('クエリの形式が不正です。')
        if row.get('disabled') or row.get('enabled') is False:
            continue
        key, val = str(row.get('key', '')), str(row.get('value', ''))
        if row.get('replace'):
            # Authentication helper replaces an inherited/query URL value.
            query = '&'.join(pair for pair in query.split('&') if pair and
                             unquote(pair.split('=', 1)[0].replace('+', ' ')) != key)
        encoded = quote(key, safe='')
        if row.get('hasEquals', True):
            encoded += '=' + quote(val, safe='')
        query += ('&' if query else '') + encoded
    return wire_url(urlunsplit((parts.scheme, parts.netloc, path, query, '')))


def form_body(rows: list) -> bytes:
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        raise ValueError('フォームはキーと値の配列で指定してください。')
    return urlencode([(str(row.get('key', '')), str(row.get('value', '')))
                      for row in rows if not row.get('disabled') and row.get('enabled') is not False]).encode('ascii')


def transform_text(payload: dict) -> str:
    """Explicit editor context action only. Never runs while typing/rendering."""
    if not isinstance(payload, dict):
        raise ValueError('変換リクエストはJSONオブジェクトで指定してください。')
    value, operation = payload.get('text'), payload.get('operation')
    if not isinstance(value, str) or operation not in ('encode', 'decode'):
        raise ValueError('変換する文字列とencode/decodeを指定してください。')
    if operation == 'decode':
        if re.search(r'%(?![0-9a-fA-F]{2})', value):
            raise ValueError('不正な%エスケープが含まれています。元の文字列は変更していません。')
        return unquote(value, encoding='utf-8', errors='strict')
    safe = ":/?#[]@!$&'()*+,;=-._~" if payload.get('kind') == 'url' else ''
    return quote(value, safe=safe)
