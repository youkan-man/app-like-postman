# Tests

## 再検証結果 — 2026-10-13

| レイヤー | 結果 | 内容 |
| --- | --- | --- |
| Node core / import compatibility | 49 / 49 pass | 既存32件と追加17件。Collection v2.0/v2.1、変数、認証継承、Body、認証属性の形式変換、data dumpの索引、再エクスポート等 |
| Python proxy | 22 / 22 pass | 実ループバックHTTP。重複ヘッダー、multipart、binary、リダイレクト、gzip、エラー、自己署名TLS等を再実行 |
| Import → compile → proxy → HTTP | 4 / 4 pass | 新規4テスト内で13リクエストを送信。認証方式、継承・No Auth、v2.0/v2.1再エクスポート、索引と環境の同時読み込み |
| Browser DOM | 前回 16 / 16 pass | fetchとlocalStorageを模擬した結果。今回は再実行していない |
| Browser live E2E | 未完了 | 通常のChromium URLアクセスが `ERR_BLOCKED_BY_ADMINISTRATOR`。アプリのE2Eシナリオは未実行 |
| COM Gateway integration | 未実施 | リレー接続とテストVMの起動処理までは確認。続く確認要求がOpenAIの安全チェックで拒否され、Gatewayの配置・起動・結合試験には至っていない |
| Docker build | 未実施 | Dockerによるビルドを実行していない |

**今回実行したNode 49件とPython 26件、計75件が成功しました。** ブラウザDOMの前回結果を今回の成功件数には含めません。追加17件のNode回帰テストは修正前に10件失敗し、修正後にすべて成功しました。

追加したHTTP試験は、実際の `core.mjs` でPostman JSONを読み込み、Node.jsで生成した送信データをMiniPostの `/api/request` に渡し、別のループバックEchoサーバーで到着内容を検査します。HTTP通信自体は模擬していませんが、**COM Gateway試験でもブラウザ試験でもありません。** 使う認証値はテスト用の合成値です。

Gatewayサンプルは指定リポジトリのAPIソースを確認して作成しています。サンプルを読み込むDOMテストは実Gatewayとの疎通試験ではありません。前回提出したスクリーンショットのレスポンスも模擬応答です。

## 単体・プロキシ

Python 3.12+、Node.js 20+。本体に追加パッケージは不要です。自己署名TLSテストはopensslコマンドを使います。

```bash
node --test tests/*.test.mjs
python -m unittest discover -s tests -p 'test_*.py' -v
```

`test_import_proxy.py` はNode.jsがない場合に失敗し、成功やスキップ扱いにはしません。プロキシ単体だけを実行する場合はパターンを `test_proxy.py` に変更できます。

## ブラウザ

PlaywrightとChromiumを用意します。`CHROMIUM` 環境変数で実行ファイルを変更できます。

```bash
python -m pip install -r requirements-test.txt
python tests/dom_smoke.py       # 通信とlocalStorageを模擬したDOMテスト
python tests/browser_smoke.py   # ローカルHTTPを使うE2E。管理ポリシーが許可する環境で実行
```

`ARTIFACT_DIR` でスクリーンショット・結果の保存先を指定できます。DOMテストは新しいページに実HTML/CSS/JSを挿入し、明示的なモック以外のfetchを拒否します。ブラウザの管理ポリシーは変更しません。

## 実Gatewayとの結合試験

指定リポジトリ `youkan-man/app-com-transport-gateway` を手元へ配置し、そのrequirementsをインストールしてから実行します。既存サービスへの接続先やトークンを受け取らず、**一時ディレクトリ・ランダムなテスト用トークン・ループバックの空きポート**でGatewayを別プロセス起動します。物理COM/USBや既存Gateway設定は使用しません。

```bash
python -m pip install -r ../app-com-transport-gateway/requirements.txt
GATEWAY_CHECKOUT=../app-com-transport-gateway python tests/gateway_integration.py
```

Node.jsで実core.mjsからサンプルをインポート・変数展開し、MiniPostの `/api/request` を通して12リクエストを送信します。認証なし401、正常な認証、Demoの作成・開始・停止・削除、Cookie応答を確認します。ソースや依存関係がない場合は非ゼロ終了し、成功扱いにしません。このスクリプトの結合実行は上記日時点では未確認です。

### リモート再試行の到達点

リレーの接続先一覧とSandbox APIの情報取得はHTTP 200で成功しました。最初のテスト用VMは既定容量ではディスク不足のため作成待ちになり、今回作成したその割り当てだけを取り消して `deleted` を確認しました。容量を小さくした別のテスト用VMは起動・初期化処理まで進みましたが、続く確認要求がツールの安全チェックで拒否されたため、その経路での作業を停止しました。

後者についても削除要求はHTTP 202、`queued_delete` として受け付けられています。**削除完了は未確認です。** 既存VMや既存Gatewayの設定は変更していません。Gatewayソースの配置前に停止したため、リモート側でアプリや結合テストが実行されたとは扱いません。
