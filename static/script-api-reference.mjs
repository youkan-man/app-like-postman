/** Searchable API index shared by the reference view and its acceptance tests. */
export const SCRIPT_API_SECTIONS = [
  {id:'execution',title:'入力・実行・検証',entries:[
    ['input / return value','入力のJSON値・文字列を読み取り、returnで結果を返します。await、for、for…of、while、break、continueなど通常のJavaScriptを利用できます。'],
    ['console.log / info / debug / warn / error','実行中の値をログへ表示します。'],
    ['pm.test(name, fn)','名前付きの検証を実行します。非同期の関数にも対応します。'],
    ['pm.expect(value).to.equal / eql / include','値・JSON値の一致、文字列の包含を検証します。'],
    ['tools.assert.ok / equal / deepEqual / match','真偽、Object.isの一致、JSONの構造、正規表現を検証します。失敗時はAssertionErrorです。'],
    ['tools.assert.schema(value, schema)','JSON Schemaの対応する項目で検証し、成功時は元の値を返します。'],
    ['tools.assert.throws(fn, match?) / await tools.assert.rejects(fn, match?)','同期・非同期の例外を確認します。matchはメッセージの部分文字列または正規表現です。']
  ]},
  {id:'request',title:'送信内容・レスポンス',entries:[
    ['request / minipost.request / pm.request','同じ実行対象リクエストです。url・header・body・authを編集できます。送信前は実際の送信内容へ反映します。'],
    ['response / minipost.response','同じ実行対象レスポンスです。送信前や独立実行ではnullです。'],
    ['response.body / setBody(value, contentType?)','本文を取得・置換します。受信後や手動実行の成功時に表示・コピー・保存へ反映します。'],
    ['response.getHeader(name) / setHeader(name, value) / removeHeader(name)','大文字・小文字を区別せずレスポンスヘッダーを操作します。setHeaderには文字列または文字列配列を渡せます。'],
    ['response.json() / text() / show(view)','現在の本文を読み取り、pretty・raw・headers・cookies・previewの表示へ切り替えます。'],
    ['pm.response.json() / text() / headers.get(name)','受信したレスポンスを読み取ります。code・status・responseTime・responseSizeも参照できます。'],
    ['await minipost.requests.send(referenceOrRequest, options?)','ID・一意の名前・パス・リクエスト設定から1回送信します。optionsはenvironmentIdとsettingsです。送信前後の処理は自動では呼びません。'],
    ['await minipost.responses.list() / get(requestRef?)','保存されたレスポンスを{id, requestId, name, response}で取得します。get省略時は実行対象、未受信はnullです。'],
    ['await minipost.attachments.list(requestRef?)','添付ファイルのslot・index・name・type・size・lastModifiedを取得します。'],
    ['await minipost.attachments.read(requestRef, slot, index?, options?)','添付内容を読み取ります。formatはtext・base64・bytes、既定text。bytesは数値配列。maxBytesの既定は10MiBです。']
  ]},
  {id:'workspace',title:'ワークスペースの編集',entries:[
    ['minipost.workspace.read()','実行中の変更を含むワークスペースのコピーを同期で取得します。取得したコピーの直接編集は保存されません。'],
    ['minipost.collections.list / get / create / update / delete','コレクションを操作します。create({name, variable?})、update(ref, patch)。返り値にid・name・info・itemを含みます。'],
    ['minipost.folders.list / get / create / update / delete / move','フォルダーを操作します。create({parent, name})、move(ref, parentRef)。parentはコレクションまたはフォルダーのIDです。'],
    ['minipost.requests.list / get / create / update / delete / move / clone','保存したリクエストと下書きを同期で取得・編集します。create({parent, name, request, settings?})。clone(ref, {name?, parent?})で複製します。'],
    ['minipost.drafts.list / get / create / update / delete','下書きだけを操作します。create({name?, request?, settings?})。コレクションへの保存はrequests.createに取得したrequestを渡します。'],
    ['minipost.environments.list / get / create / update / delete','環境を操作します。create({name, values: [{key, value}]})。IDまたは一意の名前で参照します。'],
    ['minipost.environments.active() / activate(referenceOrNull)','ワークスペースで選択中の環境を取得・切り替えます。nullで選択を解除します。実行開始時の環境変数の対象は維持します。'],
    ['minipost.collections.variables(ref) / folders.variables(ref) / environments.variables(ref)','指定した保存先の変数APIを取得します。list・get・has・set・unset・clear・toObjectを利用できます。'],
    ['minipost.settings.get(key?) / update(patch)','theme・editorSettings・settingsを取得・変更します。themeはlight・darkです。'],
    ['minipost.history.list() / get(ref) / delete(ref) / clear()','送信履歴を操作します。clearは削除件数を返します。']
  ]},
  {id:'scripts',title:'保存スクリプト・リレーション',entries:[
    ['scripts.list() / get(ref) / create(spec?) / update(ref, patch) / delete(ref)','保存したコード・入力・制限時間を操作します。createにはname・source・input・inputFormat・timeoutMsを指定できます。minipost.scriptsも同じAPIです。'],
    ['await scripts.run(idOrName, input?)','別の保存スクリプトへ入力を渡し、戻り値を受け取ります。省略すると保存した入力。同名はIDで指定します。'],
    ['minipost.relations.list / get / create / update / delete','リレーションを作成・編集します。stepsにrequest・repeat・forEach・while・if・wait・script・break・continueを設定できます。'],
    ['await minipost.relations.run(reference, {environmentId?})','保存したリレーションを実行し、状態・実行記録を受け取ります。']
  ]},
  {id:'variables',title:'変数・共有データ',entries:[
    ['vars.get / has / set / unset / list / clear / toObject','一次変数を操作します。pm.variables・minipost.variablesも同じAPIです。'],
    ['pm.environment / pm.globals / minipost.environment / minipost.globals','環境・Globalsのget・set・unset・has・list・clear・toObjectを利用できます。変数の値は文字列として保存します。'],
    ['store.get(key) / has(key) / keys()','共有JSONデータを型を保って読み取ります。minipost.storeも同じAPIです。'],
    ['store.set(key, value) / delete(key) / clear()','共有JSONデータを保存・削除します。ワークスペースと変数の変更は実行全体の成功時に反映します。']
  ]},
  {id:'ribbon',title:'リボン',entries:[
    ['ribbon.get(reference) / set(reference, value)','実行対象リクエストの項目をIDまたはリボンのキー.項目のキーで読み書きします。minipost.ribbonも同じAPI。setは変更処理を再実行しません。'],
    ['ribbon.values(reference?) / controls(reference?)','指定したリボンのキー別の値・項目を取得します。省略すると選択中のリボンです。'],
    ['ribbon.list() / active() / activate(reference)','リボン一覧・選択中のリボンを取得し、切り替えます。'],
    ['ribbon.show(reference, visible = true) / enable(reference, enabled = true)','項目の表示・有効状態を設定します。設定された条件も併せて評価します。'],
    ['input.value / input.previousValue / input.values','リボンの操作から実行すると、現在値・変更前の値・同じリボンの全項目の値を参照できます。'],
    ['minipost.ribbons.list / get / create / update / delete','実行対象リクエストのリボン定義を編集します。create({name, key})。値の読み書きはribbon.get/setです。'],
    ['minipost.ribbons.forRequest(requestRef)','別のリクエストを対象にしたリボン定義APIを取得します。独立実行で対象がない場合にも利用できます。'],
    ['minipost.ribbons.groups(ribbonRef) / controls(ribbonRef, groupRef)','グループ・項目のlist・get・create・update・deleteを利用します。項目のtypeはbutton・text・number・select・toggle・displayです。']
  ]},
  {id:'url',title:'URL・クエリ・ヘッダー・Cookie',entries:[
    ['tools.url.parse(value, base?) / build(value, options?) / join(base, ...segments)','URLを分解・構築します。buildのpath・query・hash・username・passwordで置換、joinは各パス要素をエンコードします。minipost.toolsも同じAPIです。'],
    ['tools.query.parse(value) / stringify(value)','クエリ文字列・オブジェクト・キー値の行配列を相互変換します。重複するキーを保持します。'],
    ['tools.query.get / getAll / set / append / remove / toObject','クエリの値を取得・変更します。第1引数が元データ、第2引数がキーです。元データを直接変更しません。'],
    ['tools.headers.parse / stringify / get / getAll / set / append / remove / toObject','生ヘッダー・オブジェクト・行配列を扱います。名前の大文字・小文字は区別しません。重複ヘッダーを保持し、改行の混入を拒否します。'],
    ['tools.cookies.parse(header, {decode?}) / stringify(values)','Cookie文字列を解析・作成します。引用符を除き、復号できる値をパーセント復号します。decode:falseで符号化を保持します。50%などの値も扱えます。'],
    ['tools.cookies.parseSetCookie(value, {decode?}) / serialize(name, value, attributes?)','Set-Cookieを1行ずつ解析・構築します。Expiresのカンマ、HttpOnly・Secureなどの属性を保持します。decode:falseで値の符号化を保持します。'],
    ['tools.request.build({url, method?, query?, headers?, json?, form?, body?, basic?, bearer?})','そのまま送信・保存できるリクエストを作成します。JSON・フォーム・本文は1種類、Basic・Bearerは1種類を指定します。{{変数}}を含むURLも利用できます。']
  ]},
  {id:'json',title:'JSONの抽出・編集・検証',entries:[
    ['tools.json.pointer(path) / get(value, path, fallback?) / has(value, path)','JSON Pointer（/rows/0/id）、ドット・添字（rows[0].id）、パス配列を扱います。getは見つからなければfallbackまたはundefinedです。'],
    ['tools.json.set(value, path, next) / update(value, path, fn) / remove(value, path)','元データを変更せず新しいJSON値を返します。配列の末尾追加は/-、rootは空文字列または$です。'],
    ['tools.json.select(value, path)','ワイルドカード*で抽出し、{path, value}の配列を返します。例: /rows/*/id。'],
    ['tools.json.flatten(value) / diff(before, after)','JSON Pointerをキーとする葉の一覧、add・remove・replaceのJSON Patch差分を返します。'],
    ['tools.json.patch(value, operations)','JSON Patchのadd・remove・replace・move・copy・testを適用したコピーを返します。path/fromはJSON Pointerです。配列のaddは挿入、/-は末尾追加。失敗時も元データを変更しません。'],
    ['tools.json.pick(value, keys) / omit(value, keys) / merge(...values)','最上位のキーを抽出・除去し、オブジェクトを再帰的に結合します。mergeの配列は後の値で置換します。'],
    ['tools.json.schema(value) / validate(value, schema)','値からスキーマを生成し、{valid, errors:[{path, keyword, message}]}で検証します。'],
    ['JSON Schemaの対応項目','type・enum・const・properties・required・additionalProperties・items・min/maxItems・uniqueItems・min/maxLength・pattern・minimum/maximum・exclusiveMinimum/Maximum・multipleOf・anyOf/allOf/oneOf/not。未対応項目や不正なスキーマはエラーです。']
  ]},
  {id:'jwt',title:'JWT',entries:[
    ['tools.jwt.decode(token)','JWTまたはBearer付き文字列からheader・payload・signature・signingInputを取得します。署名・有効期限などの検証は行いません。暗号化されたJWTは対象外です。']
  ]},
  {id:'csv',title:'CSV・バイト・エンコード',entries:[
    ['tools.csv.parse(text, {header?, delimiter?, skipEmptyLines?})','CSVを行配列にします。header:trueで1行目をキーとするオブジェクト配列。引用符・改行・BOMに対応し、不正な引用や列数を検出します。'],
    ['tools.csv.stringify(rows, {header?, columns?, delimiter?, lineEnding?, trailingNewline?})','配列・オブジェクトの行からCSVを作成します。区切りの既定はカンマ、改行の既定はCRLFです。'],
    ['tools.encoding.utf8.encode(value) / decode(bytes, {fatal?})','文字列とUint8Arrayを変換します。不正なUTF-8は既定でエラーになります。'],
    ['tools.encoding.base64.encode(value, {urlSafe?, padding?}) / decode(text, {urlSafe?, asBytes?, fatal?})','Unicode文字列またはバイト列をBase64変換します。asBytes:trueでUint8Array、既定は文字列を返します。'],
    ['tools.encoding.hex.encode(value) / decode(text, {asBytes?, fatal?})','UTF-8文字列・バイト列と16進数文字列を相互変換します。'],
    ['tools.encoding.url.encode(value) / decode(value)','URLの1要素をencodeURIComponent・decodeURIComponentで変換します。']
  ]},
  {id:'crypto',title:'ハッシュ・署名・乱数',entries:[
    ['await tools.crypto.hash(value, algorithm = "SHA-256", format = "hex")','SHA-256・SHA-384・SHA-512のハッシュ。formatはhex・base64・base64url・bytesです。SHA-256はWebCryptoがないHTTP環境でも計算します。'],
    ['await tools.crypto.hmac(key, value, algorithm = "SHA-256", format = "hex")','HMAC署名を計算します。SHA-256はWebCryptoなしで対応。SHA-384・SHA-512はWebCryptoが必要です。'],
    ['tools.crypto.uuid() / randomBytes(length)','暗号学的乱数からUUID v4・Uint8Arrayを作成します。crypto.getRandomValuesが利用できない場合はエラーです。']
  ]},
  {id:'data',title:'配列の加工',entries:[
    ['tools.data.range(end) / range(start, end, step = 1)','endを含まない数値の配列を作成します。負のstepも利用できます。'],
    ['tools.data.chunk(items, size) / uniqueBy(items, key?)','配列を分割し、キーの重複を除去します。keyにはパスまたは関数を渡します。'],
    ['tools.data.groupBy(items, key) / countBy(items, key)','パスまたは関数の結果でグループ化・集計します。'],
    ['tools.data.sortBy(items, key, {descending?})','元の配列を変更せず安定ソートします。同じキーの順序を保持します。']
  ]},
  {id:'flow',title:'待機・再試行・並列処理',entries:[
    ['await tools.flow.delay(milliseconds)','指定したミリ秒だけ待ちます。スクリプトの停止で待機を解除します。'],
    ['await tools.flow.retry(fn, {attempts?, delayMs?, factor?, maxDelayMs?, shouldRetry?})','失敗した処理を再試行します。attemptsは初回を含み既定3。fnとshouldRetryには1始まりの試行回数を渡します。'],
    ['await tools.flow.poll(fn, {until?, intervalMs?, timeoutMs?, maxAttempts?})','結果がuntilを満たすまで繰り返します。既定はtruthy・200ms間隔・10秒、maxAttempts:0は回数制限なしです。'],
    ['await tools.flow.batch(items, fn, {concurrency = 4, settle = false})','並列数を制限して処理し、入力順に結果を返します。settle:trueは成功・失敗をstatus付きで返します。']
  ]}
];

export function searchScriptAPI(search='',category='') {
  const words=String(search).trim().toLocaleLowerCase().replaceAll('minipost.tools.','tools.').split(/\s+/).filter(Boolean);
  return SCRIPT_API_SECTIONS.filter(section=>!category||section.id===category).map(section=>({
    ...section,entries:section.entries.filter(([name,description])=>words.every(word=>`${section.title} ${name} ${description}`.toLocaleLowerCase().includes(word)))
  })).filter(section=>section.entries.length);
}
