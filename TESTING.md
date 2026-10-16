# 検証

```bash
node --test tests/*.test.mjs
python -m unittest discover -s tests -p 'test_*.py' -v
python -m pip install -r requirements-test.txt
python -m playwright install --with-deps chromium
python tests/browser_smoke.py
python tests/ui_workbench.py
python tests/ui_edgecases.py
python tests/ui_settings.py
python tests/ui_selection.py
python tests/docker_network.py
```

ブラウザ試験は実HTTPのテストサーバーを使います。設定同期、自動保存、コピー操作、単一選択、表示高さ、設定別履歴、復元、リロード、モバイル表示を確認します。保存失敗の試験だけブラウザストレージに意図的なエラーを注入します。

Docker試験は同梱Composeを使い、試験用のコンテナ名・公開ポートだけを分離します。host／subnetオーバーライドや接続先書換えは使いません。結果と画面は `ARTIFACT_DIR` へ保存します。GitHub Actionsも同じ試験を実行します。物理COM／USBや本番APIを操作する試験は含みません。

## ワークスペース拡張

`node --test tests/*.test.mjs` は一次変数、JSON Pointer、スクリプト適用順、リレーションの反復・条件・中断・参照検証・バックアップを含みます。`python tests/ui_automation.py` は新規作成、階層挿入、環境のページ編集、本文ハイライト、スクリプト、受信後抽出、リレーションを実ブラウザとEcho HTTPで確認し、デスクトップ／モバイル画像を残します。既存の全ブラウザスイートも実行します。

`MINIPOST_INLINE_TEST=1` は明示的なDOM用テストダブルです。HTML・モジュールをabout:blankへ渡し、ストレージとHTTPを注入するため、ブラウザネットワークのE2E保証には使用しません。GitHub Actionsの検証ではこのモードを使用せず、実HTTPで実行します。アプリ本体の動作やブラウザポリシーは変更しません。

## ブラウザ保存・復元

`node --test tests/storage.test.mjs` は保存層の分離試験です。`python tests/ui_storage.py` は通常HTTPオリジン上のChromiumで、旧localStorage移行、6 MiBデータ、localStorage書込の全面失敗、明示サーバー保存／復元、再読込、トランザクション中断を検証します。後者はモックIndexedDBやinlineモードを使いません。CIのbrowserジョブで実行し、`storage/` に結果と画面を保存します。

`python tests/ui_extraction.py` は抽出先に応じた入力欄、キャンセル時の非更新、レスポンス要素のフォーカス・スクロール保持、キーボード／コンテキストメニュー、320–1440px幅と文字拡大時の表示を検証します。通常は実HTTP、明示したinlineモードはDOM試験として結果JSONに区別して記録します。
