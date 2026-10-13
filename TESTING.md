# Tests

## 実行結果 — 2026-10-13

| レイヤー | 結果 | 内容 |
| --- | --- | --- |
| core | 32 / 32 pass | Collection v2.0/v2.1、環境・Globals、階層、変数優先順位・循環検出、認証、Body、エクスポート等 |
| Python proxy | 22 / 22 pass | 実際のループバックHTTPサーバーとの通信。重複ヘッダー、multipart、binary、リダイレクト、gzip、エラー、自己署名TLS等 |
| Browser DOM | 16 / 16 pass | 実UIの操作。ただしfetchとlocalStorageを明示的に模擬したオフライン検証 |
| Browser live E2E | 未完了 | 最初のURLアクセスがブラウザ管理ポリシーで拒否されたため、シナリオ未実行 |
| COM Gateway integration | 未実施 | ローカルリレーへの要求がツール側で拒否され、Gatewayの実プロセスに接続できていない |
| Docker build | 未実施 | この環境ではDockerによるビルドを実行していない |

Gatewayサンプルは指定リポジトリのAPIソースを確認して作成しています。サンプルを読み込むDOMテストは実Gatewayとの疎通試験ではありません。スクリーンショットのレスポンスも模擬応答です。

## 単体・プロキシ

Python 3.12+、Node.js 20+。本体に追加パッケージは不要です。自己署名TLSテストはopensslコマンドを使います。

```bash
node --test tests/core.test.mjs
python -m unittest discover -s tests -p 'test_proxy.py' -v
```

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
