# MiniPost / app-like-postman

Pythonバックエンド経由でHTTPリクエストを送る、Postman風のローカルワークベンチです。フロントエンドのビルド、外部CDN、Python追加パッケージは不要です。

## 起動

```bash
docker compose up -d --build
```

`http://localhost:8080` を開きます。停止は `docker compose down`。Dockerホスト上のAPIには `host.docker.internal` を使います。Python単体では `python app.py` で起動でき、`HOST` / `PORT` 環境変数で待受を変更できます。

Dockerホスト・別コンテナ・LAN APIへの接続と502の切り分けは [NETWORKING.md](NETWORKING.md) を参照してください。localhostの接続先はURL欄の下で選べます。

## ワークスペース

左にコレクション／フォルダー、上に複数リクエストタブ、中央にURL・送信設定、下にレスポンスを表示します。右上の分割ボタンで、広い画面ではリクエストとレスポンスを左右に並べられます。境界のドラッグ、または境界にフォーカスして矢印キーで表示比率を変更できます。サイドバーの開閉・幅、分割方向・比率、レスポンスの折り返しはブラウザに保存します。

新規リクエストはタブ列の **＋** から作成します。コレクションやフォルダーの **⋯** は、その保存先を選択した状態でリクエストを追加するための入口です。保存済み項目の名前変更・複製・削除も **⋯** から行います。右クリック、キーボード、タッチでも操作できます。

環境の選択は上部のプルダウン、編集は左の **環境** 一覧から行います。変数・認証の編集はデスクトップでは右ドロワー、狭い画面ではモーダル表示になり、幅を変えても入力途中の値を維持します。キャンセルした値は反映しません。スマートフォン幅では左上の一覧ボタンからコレクションを開き直せます。

- コレクション・フォルダー・リクエストの作成、名前変更、複製、削除、検索、日時付き履歴からの再編集。
- ParamsとURLの双方向編集、Headersの有効／無効、Authorization、Body、URL変数、Scripts表示、Settings。
- 環境切替、Globals／コレクション／環境／URL変数、`{{variable}}` 展開、コレクション・フォルダーからの認証継承。
- レスポンスのPretty／Raw／Headers／Cookies／HTML Preview、検索、コピー、バイナリを含む保存、HTTPステータス・時間・サイズ。
- タブごとの送信とレスポンス保持、ダーク／ライト切替。`Ctrl/Cmd+Enter` で送信、`Ctrl/Cmd+S` でコレクションへ保存。設定・レスポンスタブは矢印キーで切り替えられます。

下書き、開いたタブ、履歴、コレクション、環境は同じブラウザ・同じオリジンのlocalStorageに保存します。**認証情報もブラウザ内には平文で保存されます。** 共有PCでは扱いに注意してください。サーバー側の認証・クラウド同期はありません。未信頼ネットワークへそのまま公開しないでください。

## Postmanからインポート

左上の **Import** からJSONファイルを複数選択、フォルダーを選択、またはJSONを貼り付けます。ZIPは展開してから選択してください。

| 入力 | 対応 |
| --- | --- |
| Collection v2.0 / v2.1 | フォルダー階層、リクエスト、変数、認証、Body、説明、イベント・例などのメタデータを保持 |
| Environment / Globals | 名前・値・有効／無効を取り込み、環境を切り替えて使用 |
| `collections` / `environments` / `globals` を持つJSONダンプ | まとめて取り込み |
| Postman APIの `collection` / `environment` ラッパー | 内側のデータを取り込み |

展開したdata dumpの `archive.json` がCollection／EnvironmentのID一覧だけを持つ場合は、索引として警告を表示して読み飛ばします。**索引だけでは設定を復元できません。同じフォルダーのCollection／Environment本体のJSONも一緒に選択してください。** 壊れたJSONや不正なリソースを黙って無視する動作ではありません。

同名でも別コレクション・別環境として追加し、既存データは上書きしません。複数ファイルの解析に失敗した場合は、その取り込み全体を反映しません。Collection／Environmentは再エクスポートできます。Collection v2.0のオブジェクト形式とv2.1の配列形式の認証属性を扱い、編集後も宣言されたスキーマに合わせて出力します。

送信できる認証は **No Auth / Basic / Bearer / API Key**、および取得済みアクセストークンを設定したOAuth 2.0です。Bodyはraw（JSON・Text・XML・HTML・JavaScript）、x-www-form-urlencoded、form-data（ファイル含む）、binary、GraphQLに対応します。無効行は送信せず、重複クエリ・ヘッダーを保持します。未設定・循環変数は送信前に表示します。

**Postman完全互換ではありません。** Pre-request / Testsスクリプトは保持・表示しますが実行しません。スクリプトで作る値は変数欄で設定してください。OAuthトークン取得フロー、Digest等の追加認証、Collection Runner、WebSocket/gRPC、Cookie jarの自動再送、クライアント証明書・プロキシ・Postmanアプリ全体のPreferences移行は未対応です。インポートしたファイルパスからローカルファイルは自動取得せず、送信時に選び直します。未対応の認証・Bodyモードは黙って別方式へ置換せずエラーにします。

既存の自己署名HTTPS向け動作を維持し、**TLS証明書検証は初期状態OFF**です。SettingsでONにできます。リダイレクト追従とTimeoutも変更できます。Timeoutの0は無制限です。Cancelはレスポンスの受信を止めますが、既に送信済みのサーバー処理を取り消すものではありません。

## COM Transport Gateway用サンプル

画面左下の **＋ COM Gateway サンプル**、または `examples/com-gateway.postman_collection.json` をImportします。`examples/local.postman_environment.json` も利用できます。

コレクションまたは環境の `baseUrl` をGatewayの実際のアドレス、`gatewayToken` を設定済みの管理者トークンに変更します。サンプルの8081は例です。両アプリの初期ポートは8080なので、同じホストで起動するときはどちらかの公開ポートを変更してください。実トークンはリポジトリにコミットしないでください。

Health、Session、Hosted ports、Remote gateways、認証なし401、ログインCookie確認に加え、Demoポートの作成→開始→イベント取得→Read-only変更→停止→削除の12リクエストを用意しています。Demo lifecycleはテスト環境のメモリー内デモポート用です。サンプルの読み込みだけではAPIへ送信しません。

## 検証

アプリ側の `MiniPost verification` が回帰試験・実ブラウザ・UI操作と画面撮影・Dockerを実行します。Gatewayとの結合試験はGateway側のActionsで別実行し、ログもそちらに保持します。ブラウザE2Eの画面は実HTTPのEchoサーバー応答であり、Gatewayの画面ではありません。物理COM/USBの試験は含みません。実行方法・試験範囲・Artifactsは [TESTING.md](TESTING.md) を参照してください。
