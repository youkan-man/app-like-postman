# app-like-postman

ブラウザで使える超簡易APIクライアントです。画面はHTML 1ファイル、HTTPリクエストは同一オリジンのPythonバックエンドを経由します。

ブラウザから対象APIへ直接アクセスしないため、対象API側のCORS設定に依存しません。Python側は標準ライブラリだけで実装しており、追加パッケージはありません。

## 起動

```bash
docker compose up -d --build
```

ブラウザで次を開きます。

```text
http://localhost:8080
```

停止:

```bash
docker compose down
```

状態確認:

```bash
curl http://localhost:8080/api/health
```

## 主な機能

- GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS
- Query Parameters、任意HTTPヘッダー、JSON・Text・Form Body
- CORSに影響されないPythonバックエンド経由の送信
- Redirect追従のON/OFF
- TLS証明書検証のON/OFF
- Timeout、送信中断
- レスポンス本文・ヘッダー・Status・時間・サイズ表示
- JSONレスポンス整形
- ブラウザ内のリクエスト履歴
- バイナリレスポンス判定
- レスポンス上限超過時の切り詰め表示

## Dockerホスト上のAPIへ接続する場合

コンテナ内で `localhost` や `127.0.0.1` を指定すると、それは **コンテナ自身** を指します。

Dockerを動かしているPC上のAPIへ接続するときは、次の形式を使ってください。

```text
http://host.docker.internal:3000/api/health
```

`docker-compose.yml` に `host-gateway` を設定しているため、Linuxでも同じホスト名を利用できます。LAN上の別PCへは、そのPCのIPアドレスを直接指定します。

## LAN内へ公開する場合

既定ではホスト側の `127.0.0.1:8080` にだけ公開されます。LAN内の別端末から開く場合は `.env` を作成します。

```bash
cp .env.example .env
```

`.env` の次の値を変更します。

```dotenv
HOST_IP=0.0.0.0
```

その後、再作成します。

```bash
docker compose up -d --build --force-recreate
```

## 環境変数

| 変数 | 既定値 | 内容 |
|---|---:|---|
| `HOST_IP` | `127.0.0.1` | Dockerホスト側の待受IP |
| `PORT` | `8080` | Dockerホスト側の公開ポート |
| `APP_HOST` | `0.0.0.0` | コンテナ内Pythonサーバーの待受IP |
| `APP_PORT` | `8080` | コンテナ内Pythonサーバーのポート |
| `MAX_REQUEST_BYTES` | `2097152` | 対象APIへ送るBodyの最大サイズ |
| `MAX_RESPONSE_BYTES` | `10485760` | 読み込むレスポンスBodyの最大サイズ |
| `MAX_PROXY_ENVELOPE_BYTES` | 自動算出 | ブラウザからPythonへ送るJSON全体の最大サイズ |
| `LOG_LEVEL` | `INFO` | Pythonログレベル |
| `ALLOWED_ORIGINS` | 空 | 追加で許可するUIオリジン。カンマ区切り |
| `TRUST_PROXY_HEADERS` | `false` | リバースプロキシの `X-Forwarded-Proto` を信頼するか |

## セキュリティ上の注意

このアプリは、入力された任意のHTTP/HTTPS URLへPythonバックエンドから接続します。つまり、公開方法を誤るとオープンプロキシやSSRFの入口になります。

- インターネットへ直接公開しないでください。
- 既定の `HOST_IP=127.0.0.1` を推奨します。
- LAN公開時も、ファイアウォールやVPNで利用者を制限してください。
- リクエスト履歴にはAuthorizationヘッダーやBodyも保存されるため、共有端末では履歴を消してください。
- Redirectで接続先オリジンが変わる場合、`Authorization`、`Cookie`、`Proxy-Authorization` は自動的に除去します。

ブラウザからのプロキシAPI操作は同一オリジンに制限され、CORS許可ヘッダーは返しません。ただし、これはインターネット公開の安全性を保証するものではありません。

## 現在の制限

- WebSocket、SSEの継続ストリーム、multipartファイルアップロードには未対応です。
- リクエストBodyは画面上ではUTF-8テキストとして扱います。
- レスポンスはストリーミングせず、設定上限までメモリへ読み込みます。
- `Connection`、`Transfer-Encoding`、`Content-Length` などのhop-by-hop/配送制御ヘッダーは安全のため再構成します。

## ローカルテスト

Dockerを使わず、Python 3.12以降で実行できます。

```bash
python -m unittest discover -s tests -v
```

直接起動する場合:

```bash
APP_HOST=127.0.0.1 APP_PORT=8080 python app.py
```
