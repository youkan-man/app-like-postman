# Docker外のAPIへ接続する

送信元はブラウザではなく **MiniPostのPythonプロキシ**です。通常のDocker bridgeでは、`localhost` / `127.0.0.1` / `::1` はMiniPostコンテナ自身です。Dockerホスト、ブラウザを開いているPC、別コンテナはそれぞれ別の接続先です。

## 接続先の選択

| APIの場所 | 指定 |
| --- | --- |
| Dockerホスト | `http://host.docker.internal:APIのポート`。またはPostmanから取り込んだlocalhost URLを保ち、URL欄の下の **localhost の接続先 → Dockerホスト** を選択 |
| 同じDockerネットワークの別コンテナ | `http://サービス名:コンテナ内のポート`。両コンテナを同じネットワークへ接続する。ホストの公開ポートとは別 |
| 別PC・LAN機器 | `http://その機器のIPまたはDNS名:ポート`。DockerホストにそのLANへの経路が必要 |
| インターネット | URLをそのまま指定。Docker側のDNS、外向き経路、ファイアウォールに依存 |

`Dockerホスト`の選択はliteral localhostとループバックIPにだけ適用します。URL、HTTP Host、TLS SNI、証明書検証対象は変更せず、TCP接続先だけを明示的に変えます。通常のホスト名やLAN IPは書き換えません。選択変更だけで送信・自動再送はしません。送信はSend操作で行います。

標準の起動:

```bash
docker compose up -d --build
```

同梱Composeは `extra_hosts: ["host.docker.internal:host-gateway"]` を設定しています。`docker run`を使う場合は自分で指定します。

```bash
docker run --rm -p 8080:8080 --add-host=host.docker.internal:host-gateway minipost
```

`-p` はMiniPost画面への**入口**であり、APIへの外向き通信を許可する設定ではありません。リモートDockerを使う場合の「Dockerホスト」はそのリモートホストで、ブラウザのPCではありません。

## LinuxのホストAPIが127.0.0.1だけで待ち受けている場合

bridgeからホストのgatewayアドレスに接続しても、127.0.0.1だけの待受には届きません。APIをDocker bridge側のインターフェースで待ち受ける構成にするか、同梱のhostネットワーク構成を使用します。APIを無条件に全LANへ公開する必要はありません。

```bash
docker compose -f docker-compose.host.yml up -d --build
```

このファイルは**単独で使用する別構成**で、通常Composeへの追加overrideではありません。Linux Docker Engine向けです。ホストとネットワーク名前空間を共有するため、そのlocalhostに届きます。ポートマッピングは使わず、MiniPostの待受は既定で`127.0.0.1:8080`です。他PCからMiniPostを開く構成では必要なインターフェースを`MINIPOST_BIND`、競合時は`MINIPOST_PORT`で指定します。

```bash
MINIPOST_BIND=0.0.0.0 MINIPOST_PORT=8080 docker compose -f docker-compose.host.yml up -d --build
```

MiniPost自体にアクセス認証はありません。上の全インターフェース待受は管理されたネットワークでのみ使用してください。Docker Desktopのhostネットワークは対応環境で機能を有効にする必要があり、rootless/VPNを含むすべての構成を検証したものではありません。

## 502の区別

`ERROR · 入口 HTTP 502`はMiniPostのJSON応答が得られない状態です。入口リバースプロキシの接続先・タイムアウト・MiniPost起動状態を確認します。

`ERROR · MiniPost 502 · CONNECTION_REFUSED`などはMiniPostから送信先への通信失敗です。DNS_ERROR、CONNECTION_REFUSED、NETWORK_UNREACHABLE、TIMEOUT、TLS_CERTIFICATE_ERROR、TLS_ERRORなどの分類、接続先host:port、失敗段階を表示します。診断にURLのquery・Body・認証値は含めません。

送信先自身がHTTP 502を返した場合は **502 Bad Gatewayと応答Body** を通常のレスポンスとして表示します。これを通信エラーや成功HTTP 200へ置き換えません。POST等の自動再送も行いません。

ホストのファイアウォール、VPNの分離、社内HTTPプロキシ必須環境は別要因です。現在の送信処理は直接TCP接続であり、`HTTP_PROXY`/`HTTPS_PROXY`によるforward proxyや認証プロキシには未対応です。任意の502がこの変更だけで解消するとは限りません。

## 実行検証

`tests/docker_network.py`は同梱Composeで実コンテナを起動し、ホストのHTTP/HTTPS、別コンテナのDNS、公開HTTPS、hostネットワークを試験します。localhostの502を実際に発生させ、画面でDockerホストを選択して接続できることも実Chromiumで試験します。ネットワーク名前空間と実peer IPを記録し、自己接続を外部接続の成功に数えません。

Gateway側Actionsは`tests/gateway_integration.py`で **Docker内MiniPost → ホスト上の実COM Gateway** を2構成で実行します。Demo lifecycleは一時データの24リクエスト、ブラウザ経由の実Gateway送信は2構成です。実機COM/USBや利用者のLANを試験したものではありません。

参照: [Docker host networking](https://docs.docker.com/engine/network/drivers/host/) / [host-gateway](https://docs.docker.com/reference/cli/dockerd/#configure-host-gateway-ip)
