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
python tests/ui_text_url_navigation.py
python tests/ui_layout.py
python tests/ui_wheel_scroll.py
python tests/ui_scroll_sync.py
python tests/docker_network.py
```

ブラウザ試験は実HTTPのテストサーバーを使います。設定同期、自動保存、コピー操作、単一選択、表示高さ、設定別履歴、復元、リロード、モバイル表示を確認します。保存失敗の試験だけブラウザストレージに意図的なエラーを注入します。

`tests/ui_wheel_scroll.py` は実際のホイール入力で、本文・表・スクリプト・レスポンス・サイドバーと、それぞれの見出しやコード欄下端を確認します。各入力の対象要素、スクロール量、選択範囲を `wheel-scroll/results.json` に記録し、補完表示中の連続操作、Ctrlとの併用、左右配置、狭い画面も検証します。

`tests/ui_scroll_sync.py` はコード欄の入力側とハイライト表示側の文字位置を測定し、縦・横のホイール操作で見えている文字が追従することを確認します。リクエスト・リボン・リレーション内の保存スクリプトと画面幅の変更を対象にし、スクロール量に加えて文字の実座標と末尾の表示を `scroll-sync/results.json` と画像に記録します。

`python tests/ui_relation_requests.py` はリレーションを通常のリクエストとして扱う受け入れ試験です。旧形式の自動移行、共通の形式切替・編集・実行・停止、入れ子のリクエスト呼び出し、環境の引き継ぎ、履歴、複製、再読込を実HTTP上で確認します。1440/390/320pxの画面と結果を `relation-requests/` に保存します。移行後の保存データはコレクションと下書きから検査し、旧 `workspace.relations` を参照するフォールバックは使いません。

`tests/ui_sent_values.py` は変数ホバーの優先順位・文字位置・スクロールと、実HTTPで受信したURL・ヘッダー・本文が送信履歴に一致することを確認します。送信前後のスクリプト、環境切替、再読込、旧履歴、320/390px幅を含み、`sent-values/` に結果と画面を保存します。`tests/test_sent_request.py` はリダイレクト・送信失敗・本文の全文保持・ファイルのメタ情報を検証します。

`tests/ui_draft_lifecycle.py` は履歴の一時編集・明示保存、行とキー操作による複数選択・範囲選択・削除、入力欄のキー操作保護、最後の下書きの削除後も空のままであることを実ブラウザで確認します。送信済みの下書きの一括削除では、キャンセル時の全データ保持と、確定時に選択分のレスポンス・変更履歴だけが消えることも検証します。`tests/request-session.test.mjs` は一時編集が下書き・変更履歴・全体バックアップへ混入しないこと、添付に使うIDの保持、選択復元・移動・保存後の再編集を検証します。

`tests/ui_asset_update.py` は旧モジュールを実HTTPキャッシュに残した状態で新しい画面を開き、更新された依存モジュールが読み込まれて一括削除が完了することをnative Chromiumで検証します。静的ファイルのキャッシュ方針・同一更新時刻での内容差し替えは `tests/test_proxy.py` で確認します。変数ポップアップの上下両方向の配置と、値がカーソルに近い端に来ることは `tests/ui_sent_values.py` が実座標で確認します。

`tests/collection-drop.test.mjs` はドラッグの挿入位置を、兄弟間の共通境界・フォルダー階層・絞り込み・自己位置について検証します。`tests/ui_text_url_navigation.py` では、同じドラッグ中に上の行の下端、実際の行間、下の行の上端を通過させ、挿入位置と1本の線が変わらないことを実座標で確認します。説明ラベルを表示しないこと、行間での実際の移動、タッチ・キー操作、添付ファイル・参照・変更履歴の保持も確認します。

`tests/ui_layout.py` は320/390pxとPC画面で、未登録リクエストの操作、本文・スクリプトとレスポンスの高さ、分割・画面サイズ変更、長い送信履歴を実座標で検証します。外側のはみ出しだけでなく、編集行の可視性、ボタンの文字折返し、操作要素の重なり、ペイン下端の空白も確認し、成功時・失敗時の画面と座標を保存します。

内部スクロールはネイティブのホイール操作で確認します。コード欄を途中・末尾・右端へ動かし、表示レイヤーとの位置一致、サイズ変更と保存後の閲覧位置・編集欄の保持を検証します。`tests/browser_smoke.py` は長いHTMLを実HTTPで取得し、HTMLプレビュー内部のスクロール、低い表示枠への収まり、同じプレビューの更新と保存後のフレーム・閲覧位置の保持を確認します。

`tests/ui_ribbons.py` はリクエストごとの所有・値・スクリプト操作・複製・保存を確認し、単一ボタンのリボンを1440/390/320pxと844×390の低い画面で測定します。ボタン本体に対する余分な高さ、文字サイズ、編集一覧の初期表示位置を `density_metrics` に残します。`tests/ui_script_response.py` は空のクエリ欄が不要な高さを確保しないことと、明示した手動リサイズがページ切替後も優先されることを検証します。

リボンの6種類の編集対象について、固有の入力・選択・表示・処理の設定と実画面を1440px／320pxで確認します。保存スクリプトの編集は、対象リクエスト・選択項目・textareaの同一性を維持し、Undo／Redoと保存後の実行まで検証します。

`tests/ui_settings.py`、`tests/ui_backup.py`、`tests/ui_storage.py` は320pxの設定・インポート・復元失敗画面を撮影します。入力欄と行の操作、エラー全文、実行／キャンセルの位置を確認し、`dialog_metrics` に寸法を保存します。

Docker試験は同梱Composeを使い、試験用のコンテナ名・公開ポートだけを分離します。host／subnetオーバーライドや接続先書換えは使いません。結果と画面は `ARTIFACT_DIR` へ保存します。GitHub Actionsも同じ試験を実行します。物理COM／USBや本番APIを操作する試験は含みません。

## ワークスペース拡張

`node --test tests/*.test.mjs` は一次変数、JSON Pointer、スクリプト適用順、リレーションの反復・条件・中断・参照検証・バックアップを含みます。`python tests/ui_automation.py` は新規作成、階層挿入、環境のページ編集、本文ハイライト、スクリプト、受信後抽出、リレーションを実ブラウザとEcho HTTPで確認し、デスクトップ／モバイル画像を残します。既存の全ブラウザスイートも実行します。

リレーションは空のループ領域、既存ステップを囲む・階層間の移動・外へ出す・キーボード操作・実際のドラッグを検証し、保存した構造とHTTP／スクリプトの実行順を照合します。デスクトップと320pxの画像で、子の処理が親ブロックの内側に収まることも確認します。

`tests/relation-control.test.mjs` は入れ子の繰り返し・配列・条件ループ・分岐・待機・break/continue・保存スクリプト・変数復元を確認します。`tests/script-relations.test.mjs` はスクリプトからリレーションを呼んだ場合の保留データ共有、送信前後の処理、失敗・中断・再帰拒否を検証します。バックアップ試験は入れ子のリクエスト・スクリプト・分岐・変更履歴のID変換も対象です。

`tests/workspace-script-api.test.mjs` は重複・無効な変数への書き込み、全消去、同時編集の競合、受信後抽出と明示的な消去の順序も検証します。ネイティブのワークスペースAPI試験では、画面で無効化した一次変数を使い、分離Workerからリレーションを呼び出した場合も、ループで一時的に使った変数行を元の状態へ戻せることを確認します。

リクエスト編集は `get`／`set`、名前によるヘッダー・クエリ・フォーム操作、JSON本文のパス操作を対象にします。`tests/ui_script_response.py` の送信前処理と `tests/ui_script_workspace_api.py` の保存リクエスト編集では、同じ操作で読み書きした値を実HTTPの受信結果と照合します。重複値、Unicode・空白・リテラルの `+`、無効なヘッダー、JSONの型、子スクリプトからの編集、失敗時の保存取り消し、本文形式とContent-Typeの切替を含みます。取得したモデル全体の書き戻し、入れ子の設定、IDの保持、コレクション名の編集、実際の言語Workerによる補完も確認します。

`tests/script-request-editor.test.mjs` は従来のプロパティ編集との混在、同じリクエストを扱う複数の編集ハンドル、取得・設定を通した添付ファイル行の対応、実際に直列化したWorkerの依存解決を検証します。`tests/script-access-intelligence.test.mjs` は補完・ホバー・引数の診断と、JSON本文の値を含めず構造を更新することを確認します。

`tests/script-tools.test.mjs` は重複クエリ・Cookie・CSV・JSON解析・文字コードの境界、SHA256/HMACの既知ベクトル、Web Cryptoなしの実行、非同期処理の期限・並列数・中断を確認します。JSON Patchの配列操作・移動・コピー・値比較・失敗時の入力保持、JWTのUTF-8とBase64URL、Cookieの引用符・不完全なパーセント表記も対象です。関数をシリアライズして別のVMコンテキストで実行し、Workerへ渡せない外部依存も検出します。

`python tests/ui_script_workspace_api.py` は実際の分離Workerからワークスペースを作成・編集し、子スクリプトとリレーションの実行、失敗・停止時の取り消し、同時編集の衝突と別項目の保持、実HTTPのリクエスト構築・送信、添付読取、再読込、補完と検索リファレンスを検証します。通常HTTPでのSHA256/HMAC動作と320pxの画面を含み、`script-workspace-api/` に結果と画像を保存します。GitHub ActionsとLocal Relayの2VM試験に同じスイートを組み込みます。

`tests/ui_standalone_scripts.py` は、複数のスクリプトを同時に実行し、別のスクリプトを編集中でも右クリックした実行だけを停止できることを確認します。停止した処理の未確定データと、継続中の別の処理・選択中のエディターが影響を受けないことも検証します。

`MINIPOST_INLINE_TEST=1` は明示的なDOM用テストダブルです。HTML・モジュールをabout:blankへ渡し、ストレージとHTTPを注入するため、ブラウザネットワークのE2E保証には使用しません。GitHub Actionsの検証ではこのモードを使用せず、実HTTPで実行します。アプリ本体の動作やブラウザポリシーは変更しません。

## ブラウザ保存・復元

`node --test tests/storage.test.mjs` は保存層の分離試験です。`python tests/ui_storage.py` は通常HTTPオリジン上のChromiumで、旧localStorage移行、12 MiBデータのインポートと圧縮保存、localStorage書込の全面失敗、明示サーバー保存／復元、再読込、トランザクション中断を検証します。後者はモックIndexedDBやinlineモードを使いません。CIのbrowserジョブで実行し、`storage/` に結果と画面を保存します。

`tests/workspace-codec.test.mjs` と `tests/workspace-transfer.test.mjs` は保存データの重複排除・圧縮・復元を検証します。10 MiBを超える変更履歴、Unicode、特殊なキー、復元した履歴間の独立性、圧縮非対応時の保存、圧縮中の編集を含みます。`tests/test_workspace_api.py` は実HTTPで大容量データの保存／読込、旧JSON互換、gzipと形式交渉、不正な参照や圧縮データ・展開上限超過時の既存保存の保持を確認します。

`python tests/ui_extraction.py` は抽出先に応じた入力欄、キャンセル時の非更新、レスポンス要素のフォーカス・スクロール保持、キーボード／コンテキストメニュー、320–1440px幅と文字拡大時の表示を検証します。通常は実HTTP、明示したinlineモードはDOM試験として結果JSONに区別して記録します。

`python tests/ui_focus.py` はツリー展開、本文・認証・ファイル種別変更、行の挿入・削除・有効切替、リレーションの追加・並べ替え・複製・削除・停止におけるフォーカスと値の保持を確認します。デスクトップと320/390pxの実画面を撮影します。CIでは通常HTTPのChromiumで動作し、ローカルでは `MINIPOST_INLINE_TEST=1` を明示したDOM試験として区別します。
