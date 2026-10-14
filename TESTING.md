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
