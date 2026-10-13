# インターネットとDockerホストには届くが、LANの別機器へ届かない場合

これはlocalhostの接続先選択とは別の問題です。LANのIPはそのまま指定します。相手のIPを `host.docker.internal` に置き換えると別の機器へ送ることになるため、行いません。MiniPostの送信処理にRFC1918のプライベートIPを拒否する機能はありません。

## 稼働中の環境を1コマンドで比較

Dockerを実行しているホストで、Python 3とDocker CLIを使います。コンテナ名が異なる場合だけ `--container` を変更してください。

```bash
python3 tools/diagnose_network.py 'http://接続できない機器のIP:ポート' --container app-like-postman --output minipost-network.json
```

`tools/diagnose_network.py` は単独ファイルです。改修ブランチ全体や新イメージを配備しなくても、元のMiniPostコンテナに対して使用できます。Python3とDockerを操作する権限が必要です。追加パッケージ、コンテナへのiproute2導入、特権付与は不要です。

同じ指定ホスト名・ポートに対し、CLI側とコンテナ側でDNS・TCP接続・HTTPSの場合はTLSハンドシェイクを比較します。APIのHTTPリクエストは送りません。URLのパス・クエリ・認証値は収集せず、接続先、経路、DockerネットワークのCIDRと結果のみをJSONで出力します。IPアドレスは診断に必要なので含まれます。無関係な内部アドレスを公開Issueへそのまま貼らないでください。

ネットワーク名やコンテナ名は変更せず、再起動・ルート追加・ファイアウォール変更・サブネットスキャンもしません。TCP成功はHTTP/API成功を意味しません。

リモートDockerやDocker Desktopでは、CLI側とdaemon側は別のネットワーク環境です。その場合は比較元を同一Dockerホストと断定せず警告します。`ip` がないコンテナではIPv4の `/proc/net/route` を併記しますが、ポリシールーティングを含む完全な経路判定とは扱いません。

## 判定の読み方

| 結果 | 次に確認すること |
| --- | --- |
| `TARGET_IN_DOCKER_BRIDGE_SUBNET` | LAN機器のIPがDocker bridgeのCIDRに入っている。LAN/VPNとの重複が疑われる。意図した別コンテナ宛てなら一致は正常なので、これだけで原因を断定しない |
| `CLI_REACHABLE_CONTAINER_UNREACHABLE` | 同じ宛先へのTCPがCLI側で成功し、コンテナで失敗。解決IP、経路、DockerのNAT・転送、宛先の送信元制限を比較 |
| `DNS_RESULTS_DIFFER` | 名前が違うIPへ解決されている、または片側で解決できない。内部DNS/検索ドメインを比較 |
| `BOTH_UNREACHABLE` | CLI側からも届かない。送信先の待受・ホストの経路・ネットワーク側も確認 |
| `CONTAINER_TCP_REACHABLE` / `CONTAINER_TLS_FAILED` | TCP到達性とTLS/HTTPレベルの問題を区別。稼働アプリ版と502の本文も比較 |

Docker/LANのCIDR重複があると、対象LANへのパケットだけがDockerネットワーク側へ向かい、インターネットへは接続できる状態が起き得ます。MiniPostが接続しているネットワークだけでなく、同じdaemon上の別のbridgeネットワークがホスト側の経路を変えている場合もあるため、診断は全bridge CIDRを比較します。

`network_mode: host` はコンテナ側のネットワーク分離を外しますが、ホスト自身の経路が別のDocker bridgeへ向いている場合まで解決するものではありません。ファイアウォールの全無効化や、無条件のACCEPTルール追加は行わないでください。

## 重複を確認できた場合のみ、MiniPostのサブネットを指定

`docker-compose.subnet.yml` を任意のoverrideとして追加しました。**LAN・VPN・他のDockerネットワークと重複しないCIDRを確認して** `MINIPOST_SUBNET` に指定します。安全だと決めつけた既定のCIDRは設定していません。

```bash
# 運用中のMiniPostを一時停止します。-vは指定せず、ボリュームは削除しません。
# 実際の起動で使用したCompose project/追加ファイルの指定を維持してください。
docker compose down
MINIPOST_SUBNET='確認した非重複CIDR' docker compose -f docker-compose.yml -f docker-compose.subnet.yml up -d --build
```

既存ネットワークのCIDRは `up` だけでそのまま変更できないため、対象プロジェクトの再作成が必要です。他のアプリのネットワークやdaemon全体のアドレスプールは変更しません。重複しているのが別のプロジェクトなら、その所有者と調整が必要です。DNS・転送・送信元制限が原因の場合、CIDR変更をしても解消しません。

## 検証の範囲

`.github/workflows/private-lan.yml` は隔離されたActionsランナー上で、ホスト・MiniPostコンテナ・Docker外のLAN相当peerを別々のネットワーク名前空間に配置します。実TCP/HTTPを使用し、以下を検証します。

- 非重複bridgeからLAN相当peerへ接続でき、送信元がホストのLAN側アドレスへNATされる。
- LAN IPはlocalhost接続先設定でDockerホストへ書き換えられない。
- 意図的にDocker CIDRをpeerのIPと重複させると、ホストへは接続できてもpeer宛てだけ失敗する。
- ホストの明示ルートは正しい状態に保ち、CLI成功/コンテナ失敗とCIDR一致を診断できる。
- 非重複サブネットの同梱Compose overrideにより、同じURLのHTTP通信が回復する。

これは**仮想LAN構成の回帰試験**です。実TCPであっても、利用者自身のLAN・実機・VPN・ファイアウォールを検証したという意味ではありません。個別の障害原因は上の診断結果で確認します。テストは固有名のnamespace/interface/Compose projectを片付け、ランナーの既存経路やファイアウォールを一括変更しません。

参考: [Docker bridge](https://docs.docker.com/engine/network/drivers/bridge/) / [Docker host network](https://docs.docker.com/engine/network/drivers/host/) / [Docker firewall](https://docs.docker.com/engine/network/firewall-iptables/)
