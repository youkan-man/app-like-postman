# スクリプト編集

独立したスクリプトと送信前・受信後のJavaScriptを、構文ハイライト付きのネイティブtextareaで編集します。変更はブラウザへ自動保存し、コードを書くだけでは実行しません。

左の「スクリプト」では名前・コード・入力を保存し、リクエストを作成せず実行できます。入力形式はJSON／テキストで、コードから `input` として参照します。`return` の値は結果欄、`console` の出力は実行中からログ欄へ表示します。`null` と戻り値なしは区別します。実行を停止しても、それまでに届いたログは残ります。

`scripts.list()` と `await scripts.run(idOrName, input)` で保存済み処理を再利用できます。名前が重複する場合はIDで指定します。`store` はJSON型の共有データを保存し、成功時だけ変数とともにワークスペースへ反映します。スクリプト・入力・共有データは全体バックアップにも含まれます。

スクリプト画面の **⋯ → APIリファレンス** で、API名・目的・説明を検索できます。カテゴリからURL、JSON、ハッシュ、ワークスペース編集などに絞り込めます。以下の `tools` は `minipost.tools` と同じオブジェクトです。外部ライブラリーの読み込みやDOMは必要ありません。

## ワークスペースをコードから編集する

コレクション、フォルダー、リクエスト、下書き、環境、保存スクリプト、リレーション、リボンの定義を作成・取得・更新・削除できます。モデルの読み取りと編集は同期APIです。HTTP送信、リレーション実行、保存レスポンスと添付ファイルの取得には `await` を使います。

```javascript
const collection = minipost.collections.create({name: '生成したAPI'});
const folder = minipost.folders.create({parent: collection.id, name: '利用者'});
const request = tools.request.build({
  method: 'POST',
  url: '{{baseUrl}}/users',
  headers: {'Accept': 'application/json'},
  json: {name: '利用者A', active: true}
});
const saved = minipost.requests.create({
  parent: folder.id,
  name: '利用者を作成',
  request
});
minipost.collections.variables(collection.id).set('baseUrl', 'https://api.example.test');
return {collectionId: collection.id, requestId: saved.id};
```

`create`・`update`・`move`・`clone` は変更後のオブジェクトを返します。`list`・`get` の結果はコピーです。コピーの中身を直接変更しても保存されないため、変更には `update(reference, patch)` を使います。`update` はオブジェクトを再帰的に更新し、配列は渡した配列で置き換えます。IDの変更はできません。

参照には `id` または一意の名前を使い、リクエストとフォルダーは `コレクション / フォルダー / 名前` のパスも使用できます。IDを最優先で解決し、曖昧な名前や見つからない対象はエラーにします。コレクション内のIDは `collectionId:itemId`、下書きは `draft:tabId` です。作成結果の `id` を続く操作へ渡すと、同名のデータに影響されません。

| API | 作成・固有の操作 |
| --- | --- |
| `minipost.collections` | `list/get/create/update/delete`。`create({name, variable?})` |
| `minipost.folders` | 同上。`create({parent, name, variable?})`、`move(ref, parentRef)` |
| `minipost.requests` | 同上。`create({parent, name, request, settings?})`、`move(ref, parentRef)`、`clone(ref, {name?, parent?})`。`list/get` は下書きも含む |
| `minipost.drafts` | `list/get/create/update/delete`。`create({name?, request?, settings?})`。下書きだけを対象にする |
| `minipost.environments` | `list/get/create/update/delete`。`create({name, values: [{key, value}]})`、`active()`、`activate(refOrNull)` |
| `scripts`／`minipost.scripts` | `list/get/create/update/delete/run`。`create({name, source, input, inputFormat, timeoutMs})`。`list()` はID・名前、`get()` はコード・入力を含む |
| `minipost.relations` | `list/get/create/update/delete` と `await run(ref, {environmentId?})` |
| `minipost.ribbons` | 実行開始時の対象リクエストの `list/get/create/update/delete`。`forRequest(requestRef)` で別リクエストを指定 |
| `minipost.ribbons.groups(ribbonRef)` | グループの `list/get/create/update/delete` |
| `minipost.ribbons.controls(ribbonRef, groupRef)` | 項目の `list/get/create/update/delete` |
| `minipost.settings` | `get(key?)` と `update(patch)`。対象は `theme`、`editorSettings`、`settings` |
| `minipost.history` | `list/get/delete/clear`。`clear()` は削除件数を返す |
| `minipost.workspace.read()` | 実行内の変更を含むワークスペースのコピー |

`parent` はコレクションまたはフォルダーのIDです。`requests.move` で下書きを保存することはできません。下書きからコレクションへ保存する場合は `const draft = minipost.drafts.get(ref)` の `request`・`settings` を `requests.create` へ渡します。不要になった下書きは `drafts.delete` で削除できます。フォルダーやコレクションの削除は配下の項目も削除します。`delete` の戻り値は `true` で、対象がなければエラーです。

`collections.variables(ref)`、`folders.variables(ref)`、`environments.variables(ref)` は、その保存先の `list/get/has/set/unset/clear/toObject` を提供します。`set(key, value, metadata?)` は文字列化した値を返し、metadataに `enabled`・`disabled`・`description` などを指定できます。`unset` は削除できたかの真偽値、`clear` は削除件数です。`vars`、`pm.environment`、`pm.globals` の既存APIにも `list()` と `clear()` があり、既存の `set/unset` の戻り値は `undefined` です。`environments.activate` は画面で選択する環境を変更しますが、実行中の `pm.environment` の対象は開始時の環境を維持します。送信時に切り替える場合は `requests.send` の `environmentId` を明示します。

ワークスペースへの書き込みは、親と子のスクリプトを含む実行全体の成功時にまとめて反映します。同じ実行中の読み取りは保留中の変更を参照できます。失敗・停止・時間切れでは保留中の書き込みを破棄します。実行中に画面から同じ項目・フィールドを変更した場合は競合として扱い、古い値で上書きしません。関係のない項目の変更は保持します。HTTP送信など、既に完了した外部処理は取り消されません。

### 保存レスポンスと添付内容

`await minipost.responses.list()` は `{id, requestId, name, response}` の配列、`get(requestRef?)` は1件または `null` を返します。対象を省略すると実行対象リクエストです。レスポンスは実行開始時の読み取り用スナップショットです。`requests.send` の新しい結果はその戻り値から受け取ります。画面のレスポンスを加工するには後述の `response` APIを使います。

```javascript
const requestRef = '取得したリクエストID';
const files = await minipost.attachments.list(requestRef);
const first = files[0];
if (!first) return null;
const bytes = await minipost.attachments.read(
  requestRef, first.slot, first.index,
  {format: 'bytes', maxBytes: 10 * 1024 * 1024}
);
return {name: first.name, sha256: await tools.crypto.hash(bytes)};
```

添付一覧は `slot/index/name/type/size/lastModified` を返します。`read(requestRef, slot, index = 0, options = {})` の `format` は `text`・`base64`・`bytes`、既定は `text` です。`bytes` は0〜255の数値配列で、エンコード・ハッシュAPIへそのまま渡せます。読取上限 `maxBytes` の既定は10MiBで、超える場合は切り詰めずエラーにします。ファイルそのものの追加・置き換えはファイル選択の操作を使います。

## データを構築・解析するヘルパー

### URL・クエリ・ヘッダー・Cookie・リクエスト

クエリとヘッダーの入力には文字列、`{key, value}` の行配列、`[key, value]` の組の配列、またはオブジェクトを指定します。オブジェクトの配列値は同名キーの複数行へ展開します。無効な行は除外し、空の値と重複するキーを保持します。

| API | 戻り値・動作 |
| --- | --- |
| `tools.url.parse(url, base?)` | `href/origin/protocol/hostname/port/username/password/path/hash/query`。queryはキー値の行配列 |
| `tools.url.build(url, {base?, path?, query?, hash?, username?, password?})` | 指定した要素を置換したURL文字列 |
| `tools.url.join(base, ...segments)` | 各要素をエンコードしてパスへ追加したURL。クエリとフラグメントは保持 |
| `tools.query.parse/stringify` | クエリとキー値の行配列を相互変換 |
| `tools.query.get/getAll/set/append/remove/toObject` | 第1引数が元データ、第2引数がキー。`set/append` は第3引数が値。変更後の新しい行配列を返す |
| `tools.headers.parse/stringify/get/getAll/set/append/remove/toObject` | 同じ操作をヘッダーに適用。名前は大小文字を区別しない。`stringify` はCRLFで結合 |
| `tools.cookies.parse/stringify` | リクエストCookieとオブジェクト・キー値データを相互変換 |
| `tools.cookies.parseSetCookie(value)` | 1行を `{name, value, attributes}` へ解析。属性名は小文字、フラグは `true` |
| `tools.cookies.serialize(name, value, attributes?)` | Set-Cookieの1行を作成。`Expires` に `Date`、`Secure/HttpOnly` に `true` を指定可能 |
| `tools.request.build(options)` | `method/url/header/body/auth` を持つMiniPostのリクエスト設定 |

`get` は最初の値または `undefined`、`getAll` は全値を返します。`toObject` は重複を文字列配列にまとめ、ヘッダー名を小文字へ揃えます。Cookieの `parse` は同名キーの最後の値を採用します。`Set-Cookie` は `Expires` 内にカンマを含むため、複数のヘッダーを連結せず1行ずつ `parseSetCookie` へ渡します。

```javascript
const request = tools.request.build({
  method: 'POST',
  url: '{{baseUrl}}/search',
  query: {tag: ['first', 'second'], language: '日本語'},
  headers: {'Accept': 'application/json'},
  form: {query: '東京', limit: 10},
  bearer: vars.get('accessToken')
});
const result = await minipost.requests.send(request);
return {status: result.status, body: result.body};
```

`json`・`form`・`body` は1種類だけ指定します。`json` はJSONのraw本文とContent-Type、`form` はURLエンコード形式を構築します。`body` は文字列またはMiniPostのbody設定です。認証は `basic: {username, password}` または `bearer: token` を指定します。両方を指定するとエラーです。`request.build` は `{{変数}}` を含むURLを保持し、送信時に変数展開します。URL自体を分解する `url.parse/build/join` は標準の `URL` と同じく有効なURLまたはbaseが必要です。

### JSONのパス、編集、差分、検証

パスにはJSON Pointerの `/rows/0/name`、ドット・添字の `rows[0].name`、配列の `['rows', 0, 'name']` を指定できます。空文字列と `$` はルートです。キー自体に `/` や `~` がある場合、Pointerでは `~1` と `~0` で表します。ドットを含むキーは `["a.b"]` のように指定できます。

| API | 動作 |
| --- | --- |
| `tools.json.pointer(path)` | パスをJSON Pointerへ変換 |
| `get(value, path, fallback?)`／`has(value, path)` | 値のコピー・存在を取得。見つからないときだけfallback、未指定なら `undefined` |
| `set(value, path, next)`／`update(value, path, fn)` | 元のJSON値を変えずに新しい値を返す。updateの関数には現在値を渡す |
| `remove(value, path)` | 指定キー・配列要素を除いた値を返す。ルートの削除は `null` |
| `select(value, path)` | `*` による抽出。`{path, value}` の配列を返す |
| `flatten(value)` | JSON Pointerをキー、葉の値を値とするオブジェクト。空オブジェクト・空配列・nullも保持 |
| `diff(before, after)` | `add/remove/replace` と `path/value` によるJSON Patch差分 |
| `pick(value, keys)`／`omit(value, keys)` | 最上位のキーを選択・除外 |
| `merge(...values)` | オブジェクトを再帰的に結合。後の値が優先し、配列は置換 |
| `schema(value)` | 値から基本的なJSON Schemaを生成 |
| `validate(value, schema)` | `{valid, errors:[{path, keyword, message}]}` を返す |

```javascript
const data = {items: [{id: 1, price: 100}, {id: 2, price: 200}]};
const updated = tools.json.update(data, '/items/0/price', value => value * 1.1);
const prices = tools.json.select(updated, '/items/*/price').map(row => row.value);
const patch = tools.json.diff(data, updated);
tools.assert.schema(updated, {
  type: 'object', required: ['items'],
  properties: {items: {type: 'array', items: {
    type: 'object', required: ['id', 'price'],
    properties: {id: {type: 'integer'}, price: {type: 'number', minimum: 0}}
  }}}
});
return {updated, prices, patch};
```

`set` は存在しないオブジェクト・配列の親を作成できます。配列への末尾追加は `/items/-` を使い、欠損要素のある配列を作る添字は拒否します。編集・差分・スキーマの対象はJSON値です。循環参照、`undefined`、非有限数、DateなどのJSONでない値はエラーにします。結果はコピーで、`__proto__` などの文字列キーからプロトタイプを変更しません。

スキーマは `type/enum/const/properties/required/additionalProperties/items/minItems/maxItems/uniqueItems/minLength/maxLength/pattern/minimum/maximum/exclusiveMinimum/exclusiveMaximum/multipleOf/anyOf/allOf/oneOf/not` に対応します。`$schema/title/description/default/examples` は注釈として受け付けます。`$ref`・`format` など未対応のキーワードや不正なスキーマはエラーにし、検証を通ったことにはしません。文字数はUnicodeのコードポイントで数えます。`tools.assert.schema` は検証に成功すると元の値を返し、失敗すると `errors` を持つ `AssertionError` を投げます。

### CSV、エンコード、暗号処理

`tools.csv.parse(text)` は文字列の行配列、`parse(text, {header:true})` は1行目をキーにしたオブジェクト配列を返します。`stringify(rows)` は逆変換で、オブジェクト配列では既定で見出しを出力します。引用符のエスケープ、セル内改行、CRLF、先頭BOMを扱い、不正な引用符・見出しの重複・見出しと行の列数不一致を検出します。`delimiter`、`skipEmptyLines`、書き出し時の `columns/header/lineEnding/trailingNewline` を指定できます。

```javascript
const rows = tools.csv.parse(input, {header: true});
const totals = tools.data.countBy(rows, 'category');
const csv = tools.csv.stringify(Object.entries(totals).map(([category, count]) => ({category, count})));
return {csv, sha256: await tools.crypto.hash(csv)};
```

上の例の入力形式はテキストです。`utf8/base64/hex` と暗号APIは、Unicode文字列・ArrayBuffer・型付き配列・0〜255の数値配列を受け付けます。文字列はUTF-8で処理します。

| API | 動作 |
| --- | --- |
| `tools.encoding.utf8.encode/decode` | UTF-8の `Uint8Array` と文字列を変換 |
| `tools.encoding.base64.encode(value, {urlSafe?, padding?})` | Base64文字列。URL形式は既定でパディングなし |
| `tools.encoding.base64.decode(text, {urlSafe?, asBytes?, fatal?})` | 既定はUTF-8文字列、`asBytes:true` は `Uint8Array` |
| `tools.encoding.hex.encode/decode` | 16進文字列を変換。decodeも `asBytes/fatal` を指定可能 |
| `tools.encoding.url.encode/decode` | URLの1要素をパーセント符号化・復元 |
| `await tools.crypto.hash(value, algorithm = 'SHA-256', format = 'hex')` | SHA-256・SHA-384・SHA-512のハッシュ |
| `await tools.crypto.hmac(key, value, algorithm = 'SHA-256', format = 'hex')` | HMAC署名 |
| `tools.crypto.uuid()`／`randomBytes(length)` | UUID v4／暗号学的乱数の `Uint8Array` |

decodeの `fatal` は既定で `true` です。不正なUTF-8、奇数桁の16進数、不正なBase64の文字・末尾ビットを検出します。バイナリは `asBytes:true` で取得します。ハッシュとHMACの `format` は `hex/base64/base64url/bytes` で、`bytes` は `Uint8Array` を返します。WebCryptoが使えない通常のHTTPオリジンでもSHA-256とHMAC-SHA256は同じアルゴリズムのJavaScript実装で計算します。SHA-384・SHA-512はWebCryptoが必要です。UUIDと乱数は `crypto.getRandomValues` を使い、それが使えない場合はエラーにします。

### 配列・検証・待機・再試行

`tools.data.range(end)` または `range(start, end, step = 1)` はendを含まない数値配列です。`chunk(items, size)`、`uniqueBy(items, key?)`、`groupBy/countBy/sortBy(items, key)` で分割・重複排除・集計・安定ソートができます。keyにはパスまたは `(item, index) => value` の関数を指定します。`sortBy` の第3引数に `{descending:true}` を指定すると降順になります。入力配列を直接並べ替えません。

`tools.assert.ok/equal/deepEqual/match` は真偽、`Object.is` の一致、JSONの構造一致、正規表現を検証します。失敗は `AssertionError`、成功時は検証した値を返します。`throws(fn, match?)` と `await rejects(fn, match?)` は同期・非同期の例外を確認します。matchはメッセージに含む文字列または正規表現です。`pm.test('名前', () => tools.assert.deepEqual(...))` で名前付きのログにもできます。

| 非同期API | オプションと動作 |
| --- | --- |
| `await tools.flow.delay(ms)` | ミリ秒の待機。実行停止で解除 |
| `await tools.flow.retry(fn, options?)` | `attempts:3` は初回を含む回数。`delayMs:200`、`factor:2`、`maxDelayMs:30000`。`shouldRetry(error, attempt)` で再試行を選別 |
| `await tools.flow.poll(fn, options?)` | `until(value, attempt)` を満たすまで繰り返す。既定はtruthy、`intervalMs:200`、`timeoutMs:10000`、`maxAttempts:0`。時間・回数それぞれ0でその制限なし |
| `await tools.flow.batch(items, fn, options?)` | `concurrency:4` で並列実行し入力順の結果を返す。`settle:true` は `{status:'fulfilled', value}`／`{status:'rejected', reason}` の配列 |

retryとpollの関数へ渡す試行番号は1始まりです。retryは関数が例外・Promise拒否で失敗した場合に再試行します。HTTPのステータスで再試行したい場合は、戻り値を確認して例外を投げてください。pollは関数や終了条件のPromiseが完了しない場合にも時間制限を適用します。batchの既定 `settle:false` は失敗後に新しい処理の開始を止め、開始済みの処理が終わってから例外を返します。停止はこれらの待機にも伝播します。

```javascript
const requests = minipost.requests.list().filter(item => item.name.startsWith('確認:'));
return await tools.flow.batch(requests, async item => {
  const result = await tools.flow.retry(async () => {
    const response = await minipost.requests.send(item.id);
    tools.assert.ok(response.status < 500, 'retry-server-error');
    return response;
  }, {attempts: 3, shouldRetry: error => error?.message === 'retry-server-error'});
  return {id: item.id, status: result.status};
}, {concurrency: 3});
```

## JavaScriptのループとリレーション

スクリプトは通常のJavaScriptの非同期関数として実行します。`for`、`for...of`、`while`、`do...while`、`break`、`continue`、`try/catch/finally`、関数、`await` をそのまま使えます。順番に送信する処理は、次のように記述できます。

```javascript
const results = [];
for (const item of minipost.requests.list()) {
  if (!item.name.startsWith('確認:')) continue;
  const result = await minipost.requests.send(item.id);
  results.push({id: item.id, status: result.status});
  if (result.status >= 500) break;
}
return results;
```

保存する実行手順にはリレーションを使用できます。`minipost.relations.create/update` の `steps` に、リクエスト、繰り返し（`repeat`）、配列ループ（`forEach`）、条件ループ（`while`）、条件分岐（`if`）、待機（`wait`）、保存スクリプト（`script`）、`break/continue` を指定します。各ステップは一意のIDを持ち、ブロックの子は `steps`、条件分岐の偽側は `elseSteps` です。IDの生成には `tools.crypto.uuid()` を使えます。`await minipost.relations.run(id)` で保存した手順を実行し、実行記録を受け取れます。

## カスタムリボンとの連携

各リクエストの **リボン** から作成した項目を、`ribbon` または `minipost.ribbon` から読み書きできます。リボンの定義・値・表示中のリボンはリクエストごとに独立し、別のリクエストで同じキーを使えます。編集画面の **戻る** で対象リクエストへ戻って操作します。リボンの名前・参照キーは **⋯ → リボンの設定** で変更できます。

独立実行、送信前・受信後、`scripts.run()` の子スクリプトで共通のAPIを使用します。独立実行は開始時に選択しているリクエスト、送信前・受信後はその処理対象のリクエストを使用します。子スクリプトは親の対象を引き継ぎます。`await` の途中で画面を別のリクエストへ切り替えても、読み書き先は開始時のリクエストに固定されます。独立実行の `request` は従来どおり `null` です。

項目ID、または `リボンの参照キー.項目の参照キー` で対象を指定します。項目キーだけの場合は表示中のリボンを優先し、そこにない場合は **同じリクエスト内** で一意の項目を探します。別のリクエストの項目や、取り込んでいない以前の共通リボンは参照しません。項目の表示名は参照に使用しません。

```javascript
const count = ribbon.get('main.count') ?? 0;
const result = await scripts.run('集計', {count});
ribbon.set('main.result', result);
ribbon.enable('main.run', count > 0);
return result;
```

| API | 動作 |
| --- | --- |
| `ribbon.get(reference)` | 項目の現在値を取得。数値・真偽値・JSONの型を維持 |
| `ribbon.set(reference, value)` | 値を設定して、項目の型に合わせた値を返す |
| `ribbon.values(reference?)` | リボンの全項目の値を、項目キーを持つオブジェクトで取得 |
| `ribbon.controls(reference?)` | 項目のID・キー・表示名・型・値・基本の表示／有効状態と、所属リボン／グループを取得 |
| `ribbon.list()`／`active()` | 対象リクエスト内の一覧／表示中のリボンを `{id, key, name}` で取得。未選択の `active()` は `null` |
| `ribbon.activate(reference)` | ID・キー・一意の名前でリボンを切り替え、切り替え先の `{id, key, name}` を返す |
| `ribbon.show(reference, visible = true)` | 項目の基本の表示状態を設定し、真偽値を返す |
| `ribbon.enable(reference, enabled = true)` | 項目の基本の有効状態を設定し、真偽値を返す |

`values()` と `controls()` の対象を省略すると表示中のリボンを使用します。未選択ならそれぞれ空のオブジェクト・配列を返します。表示条件・有効条件がある項目は、基本の状態が真で、さらに条件も満たす場合にだけ表示・操作できます。`controls()` の `visible`／`enabled` はこの基本状態です。

リクエストが選択されていない場合、リボンをまだ持たない場合、または履歴から開いた一時編集では、`list()`／`controls()` は空配列、`values()` は空オブジェクト、`active()` は `null` を返します。`get()`／`set()`／`show()`／`enable()`／`activate()` は対象がないためエラーになります。実行対象のリクエストに `minipost.ribbons` で新設したリボン・項目は、同じ実行の `ribbon` APIから参照できます。別のリクエストを新設・送信しても、呼び出し元スクリプトの `ribbon` の対象は変わりません。別のリクエストの定義を編集する場合は `minipost.ribbons.forRequest(requestRef)` を使います。

文字入力には文字列・有限の数値・真偽値・`null` を指定でき、文字列に変換します。`null` は空文字です。数値入力には有限の数値または数値文字列を指定でき、空文字と `null` は未入力の `null` になります。チェックには `true`／`false`、選択欄には選択肢の値または空文字を指定します。ボタンと値表示にはJSON値を保持できます。返されたオブジェクトはコピーなので、`const value = ribbon.get(...)` の中身を変更しただけでは画面の値は変わりません。変更後に `ribbon.set(...)` で設定します。

リボンの **クリック時／変更時** の処理から実行したスクリプトには、以下の `input` を渡します。操作に紐づいた実行では保存スクリプトの入力欄をこのイベント入力で置き換えます。

| フィールド | 内容 |
| --- | --- |
| `type` | `click` または `change` |
| `ribbonId`／`controlId` | 操作したリボンと項目のID |
| `key` | 操作した項目の参照キー |
| `value` | その処理を開始する時点の項目の値 |
| `previousValue` | 操作前の項目の値 |
| `values` | 同じリボンの全項目の値。項目の参照キーをプロパティに持つ |

親スクリプトと子スクリプトは同じ変更を参照します。`set()` の直後に `get()` すると変更した値を取得でき、`activate()` の後は切り替え先を対象に省略形のAPIを使えます。読み取り対象は実行開始時の状態と実行内の書き込みです。画面への反映は実行成功時に行い、例外・停止・時間切れではその実行の書き込みを反映しません。実行中に書き込み先の値・型・選択肢が変更された場合もエラーにし、古い結果で新しい入力を上書きしません。

リボンの操作に複数の処理を登録した場合は、先行処理の書き込みを後続処理で利用し、全処理が成功してからまとめて反映します。途中で失敗した場合も、操作のきっかけとなった直接入力は保持します。HTTP送信のように既に実行した外部処理は取り消されません。プログラムからの値変更は項目の変更時処理を再帰的には呼びません。

対象リクエスト内のリボンの参照候補と値の型を言語サービスへ反映します。`get('main.count')` は数値、`get('main.result')` は保存したJSONの構造、`values('main')` はそのリボンの項目キーを持つ型として解析します。数値・文字入力への `set()` は変換後の戻り値、値表示への `set()` は新しく渡したJSONの構造を推論します。`values()` の省略形と項目キーだけの参照は編集時点の対象リクエストと表示中リボンに基づくため、同じリクエスト内でリボンを切り替えるコードでは対象を明示すると型が明確になります。

## リクエストとレスポンスの加工

送信前の処理では `request`、受信後の処理では `response` を直接変更できます。`minipost.request` と `pm.request` は `request` と同じ対象、`minipost.response` は `response` と同じ対象です。子スクリプトも同じ変更対象を共有します。`pm.response.json()`／`text()`、ステータスとヘッダーの取得も、その時点までのレスポンスの変更を読み取ります。

独立スクリプトの通常の実行では `request` と `response` は `null` です。受信済みのレスポンスを加工するときは、そのレスポンスの **レスポンスの操作 → スクリプトを実行** から保存したスクリプトを選びます。この実行には対象のリクエスト、レスポンス、レスポンスのメタデータを持つ `input` を渡します。リクエストに設定した受信後スクリプトは、受信のたびに同じ加工を実行します。

### 送信内容の変更

`request.method`、`request.url`、`request.header`、`request.body`、`request.auth` などを変更できます。送信前の `response` は `null` です。

```javascript
request.url = vars.get('baseUrl') + '/users';
request.header ??= [];
request.header.push({
  key: 'X-Request-Source',
  value: 'MiniPost',
  enabled: true
});
```

自動の送信前処理では、変更したリクエストを変数展開・HTTP送信に使用します。この処理用のコピーへの変更で、保存した設定を自動で書き換えません。送信前処理を手動で実行した場合は、成功時に現在のリクエスト編集へ反映し、通常の編集と同じ自動保存を行います。コレクションに登録済みなら、その設定にも反映されます。受信後の `request` は参照用です。送信済みのリクエストを変更すると実行エラーになるため、送信内容の変更は送信前処理で行います。

form-dataの既存の行を並べ替えたり、前後に行を追加・削除した場合も、選択済みファイルは元の行に対応付けます。行のプロパティを変更する場合は、既存の行を編集するか `{...row, key: 'newName'}` のようにコピーできます。JSONを経由して行を作り直し、選択済みファイルとの対応を特定できなくなった場合は、別のファイルを推測して送らず実行エラーにします。

### 本文・ヘッダー・表示の変更

JSONを受信した場合、`response.body` は解析したJSON値です。本文を直接代入して置き換えるほか、`response.setBody(value, contentType?)` で本文とContent-Typeをまとめて変更できます。

```javascript
const source = response.json();
response.setBody(source.items.map(item => ({
  id: item.id,
  name: item.name
})));
response.setHeader('X-Processed', 'true');
response.show('pretty');
```

| 操作 | 動作 |
| --- | --- |
| `response.body = value` | 本文をJSON値または文字列に置き換える。入れ子のプロパティの変更にも対応 |
| `response.setBody(value, contentType?)` | 本文を置き換え、代入した値を返す。Content-Typeを省略すると文字列は `text/plain; charset=utf-8`、ほかのJSON値は `application/json`。本文のエンコーディングは `text` になる |
| `response.headers` | 名前から文字列または文字列配列へのマップ。直接編集・置換できる |
| `response.getHeader(name)` | 大文字・小文字を区別せずヘッダーを取得。複数値なら先頭、存在しなければ `undefined` |
| `response.setHeader(name, value)` | ヘッダーを設定。文字列配列で複数値を指定できる |
| `response.removeHeader(name)` | ヘッダーを削除 |
| `response.status`／`statusText` | 表示・後続処理に使用するステータスと説明を変更 |
| `response.content_type`／`body_encoding` | 本文のContent-Type・エンコーディングを変更 |
| `response.text()` | 現在の本文を文字列で取得。本文を変更するまでは受信時の文字列、変更後は文字列をそのまま、ほかのJSON値をJSON文字列として返す |
| `response.json()` | 現在の本文をJSONとして取得。バイナリ本文や無効なJSONはエラー |
| `response.show(view)` | 成功時の表示を `pretty`／`raw`／`headers`／`cookies`／`preview` に切り替える |

HTMLを表示するときは `response.setBody(html, 'text/html; charset=utf-8')` と `response.show('preview')` を使用できます。`show()` は実行成功時に一度表示を切り替え、その後は通常の操作で表示形式を選べます。`return` はスクリプトの戻り値で、レスポンスの変更には `response` の代入・メソッドを使用します。

### 反映のタイミングと受信内容の保持

送信順序は **送信前スクリプト → 変数展開 → HTTP送信 → 受信後スクリプト → 自動抽出** です。受信後の加工結果を表示、コピー、保存、自動抽出、リレーションの後続処理へ渡します。受信済みレスポンスの手動加工でも、そのリクエストに設定した抽出ルールを加工後の値へ適用します。抽出先とスクリプトで明示的に設定した一次変数が同じ場合は、スクリプトの値を優先します。1回のスクリプト実行が例外・停止・時間切れで終わった場合、その実行と子スクリプトのリクエスト・レスポンス・表示形式・変数・共有データの変更は反映しません。既に完了した送信前処理やHTTP送信は取り消されません。

加工後も受信時のレスポンスを保持します。**レスポンスの操作 → 受信時のレスポンスに戻す** で元の受信内容を表示できます。受信後スクリプトが失敗した場合も受信したレスポンスは残ります。**受信後スクリプトを編集** から、対象リクエストの設定へ移動できます。

手動スクリプトの実行中に対象のリクエストやレスポンスが更新された場合は、その実行の変更を反映しません。本文を書き換えず、古いレスポンスから変数や共有データだけを作る処理も同じ扱いです。

## 補完と引数表示

識別子の入力や `account.name.` のようなドットで候補を表示します。Ctrl/Cmd+Spaceで明示的に開き、上下キーで選択、TabまたはEnterで確定、Escapeで閉じます。Shift+Tabは前の操作へ移動します。Ctrl/Cmd+Enterは独立スクリプトの実行、リクエスト画面では送信に使用し、候補確定には使いません。補完はカーソルがある識別子全体を置換し、ChromiumではUndoで戻せます。IME変換中のEnterは補完で消費しません。

候補にはプロパティの型やメソッドの情報を表示します。関数呼び出し中は引数名・型・現在の引数番号を表示します。解析中に編集やカーソル位置が変わった場合は、古い結果を挿入しません。読み込み・解析に失敗した場合は、エディター内の「補完を再試行」から再開できます。

### 構文と型の解析

TypeScript 5.9.3のJavaScript言語サービスを使用します。構文木（AST）、宣言の結び付け、型推論を通して、現在のスコープで使える変数とメンバーを求めます。

- オブジェクトと入れ子のプロパティ、別名への代入、分割代入、同名変数のスコープを解析します。
- 配列のコールバック引数、関数の戻り値、`await` 後の値、クラス・継承・`this` のメンバーを推論します。
- 配列、文字列、Map、Set、Promise、型付き配列などには標準型定義を使用します。
- JSDocの `@param`・`@returns`・`@type` などを読み取り、型と引数情報へ反映します。
- オプショナルチェーンや添字でのプロパティ参照、書きかけのコードも解析します。

コメント、正規表現、通常の文字列本文では候補を表示しません。プロパティ名やAPIの引数に入る文字列は、その型から名前・キーの候補を表示します。テンプレート文字列の `${...}` 内はJavaScriptの式として解析します。

### 動的な辞書

解析時点のワークスペースから型定義と参照辞書を生成します。辞書には名前やデータの構造を使用し、環境変数などの保存値を補完の説明欄へ掲載しません。

| データ | 補完・推論の対象 |
| --- | --- |
| JSON／テキスト入力 | `input` の型、入れ子のプロパティ、配列要素の型 |
| 共有データ | `store.get()` などのキーと、保存値の型 |
| カスタムリボン | リボンID・キー・一意の名前、項目ID・参照キー、`get()`／`set()` の値の型、`values()` の項目、JSON値の内部構造 |
| 一次変数・選択環境・Globals | `vars`、`pm`、`minipost` の変数APIで使用できるキー |
| 保存スクリプト | ID・一意の名前、呼び出したスクリプトのコードから推論する戻り値 |
| 保存済みリクエスト・下書き | ID・一意の名前・パス、取得する設定の構造 |
| コレクション・フォルダー・リレーション | 同期CRUDのID・一意の名前・パス、作成先・移動先の候補 |
| 環境 | 環境のID・一意の名前 |
| ヘルパー | URL・CSV・エンコード・ハッシュの結果、JSONパスの値、set/merge後の構造、batch/pollの関数引数とawait後の結果 |
| 送信前・受信後の処理 | リクエストまたは受信済みレスポンスの `input`、JSON本文とヘッダー |
| レスポンスの加工 | `response`／`minipost.response` のメソッド、ヘッダー名、`show()` の表示形式、`setBody()` が返す値の型 |

コードや入力、保存データ、名前を変更・削除すると、次の解析で辞書を更新します。`await scripts.run(...)` の戻り値は保存スクリプトの仮想JavaScriptファイルを参照して推論するため、呼び出し先のコード変更も反映します。全体バックアップの追加取り込みで保持した参照先にも対応します。

`tools.json.get(value, '/rows/0/name')` は与えた値とリテラルのパスから型を推論します。`set` や `merge` で型を変更した場合も戻り値に反映し、数値から文字列へ変えたフィールドには文字列のメソッドを提示します。実行時まで決まらないパスは `unknown` として扱います。`minipost.ribbons` の定義編集は現在のリクエストの参照候補を使います。`forRequest(...)` の別リクエストには現在の項目名を流用せず、汎用の定義型を提示します。

### 解析と実行の範囲

解析は専用Workerで行い、エディターのメインスレッドで言語サービスを動かしません。言語サービス、ES2023とWorker向けの標準型定義は同梱しており、実行時のCDN取得や外部解析サービスは使用しません。編集中のコードは仮想ファイルとして解析し、補完のために評価・実行しません。

実行言語はJavaScriptです。現在の入力や受信データから得られる型は、その時点の構造に基づく推論です。実行時まで決まらない値や型情報のない処理には `unknown` や `any` が残るため、必要な形をJSDocで指定できます。非常に大きい値や深い構造では解析量を抑え、一部の型を `unknown` として扱う場合があります。この解析上の制御は、スクリプト実行の制限時間や処理するデータを変更しません。

本文やリクエストの形式を置き換える代入は、受信時・編集時と異なる構造でも使用できます。受信データから得た型は実行前の構造のため、大きく変換した後の値を続けて扱う場合は `const converted = response.setBody(...)` のように戻り値を変数へ受け取ると、その新しい構造を推論できます。送信前の補完には前回のレスポンスの本文やヘッダーを持ち込みません。

リクエストのスクリプト欄では、保存済みスクリプトを送信前／受信後の処理として選択できます。既存の直接入力も維持します。MiniPost APIの型定義は実装済みのAPIを対象にしており、Postmanの全APIや外部パッケージの型定義を提供するものではありません。

## 同梱ライブラリーの更新

`python ci/vendor_typescript.py` でTypeScript 5.9.3の配布物を取得し、固定した整合性情報を検証してから、esbuild 0.25.12で同梱ESモジュールを生成します。再生成にはネットワークとnpmが必要ですが、アプリの起動には不要です。

`python ci/vendor_typescript.py --check` は、ネットワークやビルドツールを使用せず、同梱ファイルのハッシュをマニフェストと照合します。ライセンスと第三者通知は `static/vendor-typescript.LICENSE.txt`、`static/vendor-typescript.NOTICE.txt` に同梱しています。

## 検証

`node --test tests/*.test.mjs` に、実言語サービスによる構文・スコープ・型推論、動的辞書と別スクリプトの戻り値、辞書の更新・削除、解析クライアントの非同期制御の検証を含めています。対象は `script-editor.test.mjs`、`script-intelligence.test.mjs`、`script-language-model.test.mjs`、`script-intelligence-client.test.mjs`、`script-editor-context.test.mjs`、`ribbon-intelligence.test.mjs` です。リボンでは項目の型、正規化した書き込みの戻り値、JSONのメンバー連鎖、表示中リボンの変更、追加インポートの呼び出し元別参照、項目の削除と名前変更を確認します。

`script-tools.test.mjs` はシリアライズしたfactoryを独立したVMで再構成し、Unicode・空値・重複キー・CSVの引用符・JSONの不正なパス・不正なスキーマ・プロトタイプへの影響・中断と時間制限を検証します。SHA-256とHMAC-SHA256はWebCryptoのないVMで既知のベクトル・パディング境界・100万文字を確認し、ネイティブ暗号処理とも比較します。`script-tools-intelligence.test.mjs` はヘルパーの結果・ジェネリックな非同期処理・CRUDの参照更新と削除・検索索引を検証し、実行例をWorker向け標準ライブラリーと全宣言で型検査します。

`python tests/ui_script_editor.py` は通常のHTTPオリジン上で実アプリを操作し、キーボード、Undo、合成IMEイベント、320/390/1440px表示、実Worker実行、失敗時の変数非反映、IndexedDB保存・再読込を確認します。OSのIME候補ウィンドウ自体を操作する試験ではありません。`python tests/ui_script_intelligence.py` は実際の解析Workerを使い、変数・メソッドの補完、ワークスペースからの動的な候補と型推論を確認します。

`python tests/ui_standalone_scripts.py` は、空のワークスペースから独立したスクリプトを作成し、JSON／テキスト入力と戻り値、ID／名前による子スクリプト呼び出し、共有データ、失敗時の非反映、実行中のログと停止、IndexedDB再読込、全体バックアップ復元を実HTTP・実Workerで確認します。明示的なHTTP送信APIと、保存済みスクリプトを送信前後へ接続した場合も確認します。1440/390/320pxの画面を撮影し、横方向のはみ出しも確認します。GitHub ActionsとLocal Relayの両方から実行します。

`python tests/ui_script_response.py` は送信前の変更が実際のHTTPリクエストへ反映されること、受信後の加工結果の表示・コピー・保存・抽出・条件分岐、保存スクリプトによる再加工と復元を確認します。例外・停止・実行中の対象更新による変更の破棄、同じ `show()` の再実行、form-dataの行操作と添付ファイルの対応も対象です。処理単位の回帰試験は `tests/script-response.test.mjs` にあります。

Local Relayの既存2VMワークフローもこの試験を呼びます。ブラウザ実体はPlaywrightのインストール結果から解決します。アプリはこの試験専用systemd unitで管理し、起動時の識別子、Python/静的ファイルのハッシュ、実配信ファイルを照合します。別プロセスのHTTP 200を起動成功として扱いません。他のポート所有者を強制終了しません。試験用unitの最大実行時間は30分です。

出力は `.local_relay/output/script-editor/`、`.local_relay/output/script-intelligence/`、`.local_relay/output/script-response/`、`.local_relay/output/standalone-scripts/`、2VM集計は `.local_relay/output/two-vm-summary.json` に保存します。ローカルのオフラインDOMコンポーネント試験は、Relay上の実HTTP試験と区別してください。
