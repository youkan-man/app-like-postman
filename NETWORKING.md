# 通常の接続

`docker compose up -d --build` で起動し、公開した8080番ポートを開きます。公開ポートを変える場合だけ `MINIPOST_PORT=9000 docker compose up -d --build` とします。

Sandboxでは通常の8080番公開先をそのまま使います。固定IP、独自サブネット、hostネットワーク、extra_hosts、NAT変更、localhostの接続先切替は不要です。入力したURLのホスト名・ポートにPythonプロキシから接続します。Docker内のlocalhostはコンテナ自身です。別の機器には、その機器の到達可能なIP／ホスト名を入力してください。

SettingsのTLS証明書検証、Timeout、リダイレクト追従はHTTPリクエストの設定として残しています。認証情報はAuthorizationまたは変数で設定します。接続失敗・DNS・TLSエラーは応答欄に表示します。送信先自身が返すHTTP 502は応答として表示し、MiniPostの接続失敗とは区別します。POSTを自動再送する処理はありません。
