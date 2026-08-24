# app-like-postman

Pythonバックエンド経由でHTTPリクエストを送る、簡易Postman風ツールです。

## 起動

```bash
docker compose up -d --build
```

ブラウザで開きます。

```text
http://localhost:8080
```

停止:

```bash
docker compose down
```

Dockerを動かしているPC上のAPIへ送る場合は、URLのホストに `host.docker.internal` を使います。

```text
http://host.docker.internal:3000/api/health
```
