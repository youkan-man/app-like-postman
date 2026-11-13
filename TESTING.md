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
python tests/ui_sent_values.py
python tests/ui_draft_lifecycle.py
python tests/ui_asset_update.py
python tests/docker_network.py
```

ブラウザ試験は実HTTPのテストサーバーを使います。設定同期、自動保存、コピー操作、単一選択、表示高さ、設定別履歴、復元、リロード、モバイル表示を確認します。保存失敗の試験だけブラウザストレージに意図的なエラーを注入します。

`tests/ui_sent_values.py` は変数ホバーの優先順位・文字位置・スクロールと、実HTTPで受信したURL・ヘッダー・本文が送信履歴に一致することを確認します。送信前後のスクリプト、環境切替、再読込、旧履歴、320/390px幅を含み、`sent-values/` に結果と画面を保存します。`tests/test_sent_request.py` はリダイレクト・送信失敗・本文の全文保持・ファイルのメタ情報を検証します。

`tests/ui_draft_lifecycle.py` は履歴の一時編集・明示保存、行とキー操作による複数選択・範囲選択・削除、入力欄のキー操作保護、最後の下書きの削除後も空のままであることを実ブラウザで確認します。送信済みの下書きの一括削除では、キャンセル時の全データ保持と、確定時に選択分のレスポンス・変更履歴だけが消えることも検証します。`tests/request-session.test.mjs` は一時編集が下書き・変更履歴・全体バックアップへ混入しないこと、添付に使うIDの保持、選択復元・移動・保存後の再編集を検証します。

`tests/ui_asset_update.py` は旧モジュールを実HTTPキャッシュに残した状態で新しい画面を開き、更新された依存モジュールが読み込まれて一括削除が完了することをnative Chromiumで検証します。静的ファイルのキャッシュ方針・同一更新時刻での内容差し替えは `tests/test_proxy.py` で確認します。変数ポップアップの上下両方向の配置と、値がカーソルに近い端に来ることは `tests/ui_sent_values.py` が実座標で確認します。

Docker試験は同梱Composeを使い、試験用のコンテナ名・公開ポートだけを分離します。host／subnetオーバーライドや接続先書換えは使いません。結果と画面は `ARTIFACT_DIR` へ保存します。GitHub Actionsも同じ試験を実行します。物理COM／USBや本番APIを操作する試験は含みません。

## ワークスペース拡張

`node --test tests/*.test.mjs` は一次変数、JSON Pointer、スクリプト適用順、リレーションの反復・条件・中断・参照検証・バックアップを含みます。`python tests/ui_automation.py` は新規作成、階層挿入、環境のページ編集、本文ハイライト、スクリプト、受信後抽出、リレーションを実ブラウザとEcho HTTPで確認し、デスクトップ／モバイル画像を残します。既存の全ブラウザスイートも実行します。

`MINIPOST_INLINE_TEST=1` は明示的なDOM用テストダブルです。HTML・モジュールをabout:blankへ渡し、ストレージとHTTPを注入するため、ブラウザネットワークのE2E保証には使用しません。GitHub Actionsの検証ではこのモードを使用せず、実HTTPで実行します。アプリ本体の動作やブラウザポリシーは変更しません。

## ブラウザ保存・復元

`node --test tests/storage.test.mjs` は保存層の分離試験です。`python tests/ui_storage.py` は通常HTTPオリジン上のChromiumで、旧localStorage移行、6 MiBデータ、localStorage書込の全面失敗、明示サーバー保存／復元、再読込、トランザクション中断を検証します。後者はモックIndexedDBやinlineモードを使いません。CIのbrowserジョブで実行し、`storage/` に結果と画面を保存します。

`python tests/ui_extraction.py` は抽出先に応じた入力欄、キャンセル時の非更新、レスポンス要素のフォーカス・スクロール保持、キーボード／コンテキストメニュー、320–1440px幅と文字拡大時の表示を検証します。通常は実HTTP、明示したinlineモードはDOM試験として結果JSONに区別して記録します。

`python tests/ui_focus.py` はツリー展開、本文・認証・ファイル種別変更、行の挿入・削除・有効切替、リレーションの追加・並べ替え・複製・削除・停止におけるフォーカスと値の保持を確認します。デスクトップと320/390pxの実画面を撮影します。CIでは通常HTTPのChromiumで動作し、ローカルでは `MINIPOST_INLINE_TEST=1` を明示したDOM試験として区別します。
