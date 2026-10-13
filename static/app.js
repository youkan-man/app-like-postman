import {SCHEMA, clone, uid, rows, enabled, urlParts, displayUrl, setUrlText, setQuery, newRequest, normalizeRequest, walkItems, findItem, importPostman, exportCollection, contextFor, compileRequest} from './core.mjs';

const $ = id => document.getElementById(id);
const KEY = 'minipost.workspace.v2';
const freshTab = () => ({id: uid(), name: 'Untitled request', request: newRequest(), settings: {verify_tls: false, follow_redirects: true, timeout_ms: 30000}, dirty: false});
const initial = () => {const tab = freshTab(); return {version: 2, collections: [], environments: [], globals: [], tabs: [tab], activeId: tab.id, environmentId: '', history: [], collapsed: [], theme: 'dark'};};
let workspace;
let recoveryMessage = '';
try {
  const saved = localStorage.getItem(KEY);
  workspace = saved ? JSON.parse(saved) : initial();
  if (workspace.version !== 2 || !Array.isArray(workspace.tabs) || !Array.isArray(workspace.collections) || !Array.isArray(workspace.environments) || !Array.isArray(workspace.globals) || !Array.isArray(workspace.history)) throw new Error('保存データの形式が不正です。');
  if (!workspace.tabs.length) workspace.tabs.push(freshTab());
  if (!workspace.tabs.some(t => t.id === workspace.activeId)) workspace.activeId = workspace.tabs[0].id;
} catch (error) {
  try {const raw = localStorage.getItem(KEY); if (raw) localStorage.setItem(KEY + '.recovery', raw);} catch {}
  workspace = initial(); recoveryMessage = `保存データを読み込めませんでした。元データは可能な場合に .recovery キーへ保持しています。${error.message}`;
}
const responses = new Map(), requests = new Map(), selectedFiles = new Map();
let pane = 'params', side = 'collections', responseView = 'pretty', selectedCollectionId = '', modalAction = null;
let saveTimer, toastTimer, responseSearchTimer;
const active = () => workspace.tabs.find(t => t.id === workspace.activeId) || workspace.tabs[0];
const describe = value => typeof value === 'string' ? value : value?.content || '';
const element = (tag, className, text) => {const e = document.createElement(tag); if (className) e.className = className; if (text != null) e.textContent = text; return e;};
function button(text, fn, className = 'button') {const e = element('button', className, text); e.type = 'button'; e.onclick = fn; return e;}
function input(value, placeholder, change, type = 'text') {const e = element('input'); e.type = type; e.value = value ?? ''; e.placeholder = placeholder; e.setAttribute('aria-label', placeholder); e.spellcheck = false; e.oninput = () => change(e.value); return e;}
function select(options, value, change) {const e = element('select'); for (const [v, label] of options) {const o = element('option', '', label); o.value = v; e.append(o);} e.value = value; e.onchange = () => change(e.value); return e;}
function field(label, control) {const e = element('div', 'form-field'); e.append(element('label', '', label), control); return e;}
function toast(message) {$('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 6500);}
function persist(now = false) {
  clearTimeout(saveTimer);
  $('saveState').textContent = '保存中…';
  const save = () => {
    try {localStorage.setItem(KEY, JSON.stringify(workspace)); $('saveState').textContent = 'ローカルに保存済み';}
    catch { $('saveState').textContent = '保存できません'; toast('ブラウザの保存領域が不足しているか、保存が許可されていません。Collectionをエクスポートしてください。'); }
  };
  if (now) save(); else saveTimer = setTimeout(save, 220);
}
function touch() {active().dirty = true; persist(); renderTabs(); updateCounts();}
function download(name, content, type = 'application/json') {
  const blob = content instanceof Blob ? content : new Blob([content], {type});
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportFile(name, value) {download(name, JSON.stringify(value, null, 2));}
function closeModal() {$('modal').close(); modalAction = null;}
function showModal(title, content, action, submit = '保存') {
  $('modalTitle').textContent = title; $('modalBody').replaceChildren(content);
  $('modalSubmit').textContent = submit; $('modalSubmit').hidden = !action;
  $('modalSubmit').disabled = false; $('modalMessage').textContent = '';
  modalAction = action;
  if (!$('modal').open) $('modal').showModal();
}
$('modalForm').onsubmit = async event => {
  event.preventDefault();
  if (!modalAction) return;
  const action = modalAction;
  $('modalSubmit').disabled = true;
  try {await action();} catch (error) {$('modalMessage').textContent = error.message;}
  finally {$('modalSubmit').disabled = false;}
};
$('closeModal').onclick = $('cancelModal').onclick = closeModal;
$('modal').addEventListener('cancel', () => {modalAction = null;});
window.addEventListener('pagehide', () => persist(true));

function kvEditor(list, changed, options = {}) {
  const wrap = element('div'); const table = element('table', 'kv-table');
  const head = element('tr');
  const columns = [['', 'check'], ['KEY', ''], ...(options.files ? [['TYPE', 'type']] : []), ['VALUE', ''], ['DESCRIPTION', ''], ['', 'action']];
  for (const [name, cls] of columns) head.append(element('th', cls, name));
  const thead = element('thead'); thead.append(head); table.append(thead);
  const tbody = element('tbody'); table.append(tbody);
  function paint() {
    tbody.replaceChildren();
    list.forEach((row, index) => {
      const tr = element('tr', enabled(row) ? '' : 'disabled');
      const checkCell = element('td', 'check'); const check = element('input');
      check.type = 'checkbox'; check.checked = enabled(row); check.setAttribute('aria-label', `行 ${index + 1} を有効にする`);
      check.onchange = () => {row.disabled = !check.checked; delete row.enabled; tr.classList.toggle('disabled', row.disabled); changed();};
      checkCell.append(check); tr.append(checkCell);
      const keyCell = element('td'); keyCell.append(input(row.key, `Key ${index + 1}`, value => {row.key = value; changed();})); tr.append(keyCell);
      if (options.files) {
        const typeCell = element('td'); typeCell.append(select([['text', 'Text'], ['file', 'File']], row.type || 'text', value => {row.type = value; changed(); paint();})); tr.append(typeCell);
      }
      const valueCell = element('td');
      if (options.files && row.type === 'file') {
        const chosen = selectedFiles.get(active().id)?.[`form-${index}`];
        const names = chosen?.map(f => f.name).join(', ') || (Array.isArray(row.src) ? row.src.join(', ') : row.src);
        valueCell.append(button(chosen ? names : names ? `${names} — 再選択` : 'ファイルを選択', () => chooseFiles(`form-${index}`, true, names => {row.src = names; changed(); paint();}), 'file-pick'));
      } else valueCell.append(input(row.value, `Value ${index + 1}`, value => {row.value = value; changed();}, options.secret && row.type === 'secret' ? 'password' : 'text'));
      tr.append(valueCell);
      const descriptionCell = element('td'); descriptionCell.append(input(describe(row.description), `Description ${index + 1}`, value => {row.description = value; changed();})); tr.append(descriptionCell);
      const actionCell = element('td'); const remove = button('×', () => {
        list.splice(index, 1);
        if (options.files) {
          const files = selectedFiles.get(active().id) || {};
          delete files[`form-${index}`];
          for (let n = index + 1; n <= list.length; n++) {files[`form-${n - 1}`] = files[`form-${n}`]; delete files[`form-${n}`];}
        }
        changed(); paint();
      }, 'icon-button'); remove.title = '行を削除'; remove.setAttribute('aria-label', `行 ${index + 1} を削除`); actionCell.append(remove); tr.append(actionCell);
      tbody.append(tr);
    });
  }
  paint(); wrap.append(table, button('＋ 行を追加', () => {list.push({key: '', value: '', disabled: false, ...(options.files ? {type: 'text'} : {})}); changed(); paint(); tbody.lastElementChild?.querySelector('input[type=text]')?.focus();}, 'table-add'));
  return wrap;
}
function caption(title, parent) {const line = element('div', 'section-caption', title); parent.append(line); return line;}
function updateCounts() {
  const r = active().request;
  const count = list => list.filter(enabled).filter(row => row.key).length;
  $('paramsCount').textContent = count(urlParts(r.url).query) || '';
  $('headersCount').textContent = count(rows(r.header)) || '';
  $('bodyDot').textContent = r.body?.mode && r.body.mode !== 'none' ? '●' : '';
  $('scriptDot').textContent = contextFor(workspace, active()).events.length ? '●' : '';
}
function authEditor(owner, inherited = false, changed = () => {}) {
  const box = element('div');
  function paint() {
    box.replaceChildren(); const grid = element('div', 'field-stack');
    const options = [['inherit', 'Inherit auth from parent'], ['noauth', 'No Auth'], ['bearer', 'Bearer Token'], ['basic', 'Basic Auth'], ['apikey', 'API Key'], ['oauth2', 'OAuth 2.0 · access token']];
    const type = owner.auth?.type || 'inherit';
    if (!options.some(([value]) => value === type)) options.push([type, `${type}（送信未対応）`]);
    const typeSelect = select(options, type, value => {owner.auth = value === 'inherit' ? null : {type: value, [value]: []}; changed(); paint();});
    typeSelect.setAttribute('aria-label', '認証方式');
    grid.append(element('label', '', 'Auth type'), typeSelect);
    if (type === 'inherit') grid.append(element('div', 'hint', inherited ? 'コレクション / フォルダーの認証設定を使用します。' : '親の認証を使用します。親に設定がなければ認証なしで送信します。'));
    const specs = {bearer: [['token', 'Token']], basic: [['username', 'Username'], ['password', 'Password']], apikey: [['key', 'Key'], ['value', 'Value'], ['in', 'Add to']], oauth2: [['accessToken', 'Access token'], ['headerPrefix', 'Header prefix']]};
    if (specs[type]) {
      const attrs = owner.auth[type] ||= [];
      for (const [key, label] of specs[type]) {
        let row = attrs.find(v => v.key === key);
        const value = row?.value ?? (key === 'in' ? 'header' : key === 'headerPrefix' ? 'Bearer' : '');
        const change = v => {if (!row) {row = {key, type: 'string'}; attrs.push(row);} row.value = v; changed();};
        const control = key === 'in' ? select([['header', 'Header'], ['query', 'Query Params']], value, change) : input(value, label, change, key === 'password' ? 'password' : 'text');
        control.setAttribute('aria-label', label); grid.append(element('label', '', label), control);
      }
      grid.append(element('div', 'hint', type === 'oauth2' ? '取得済みのアクセストークンを送信します。認可画面やトークンの取得・更新フローは実行しません。' : '{{変数名}} が使えます。送信時にAuthorizationヘッダー / API Keyへ反映します。'));
    }
    box.append(grid);
  }
  paint(); return box;
}
function renderPane() {
  const root = $('editorContent'); root.replaceChildren();
  document.querySelectorAll('[data-pane]').forEach(b => {b.classList.toggle('active', b.dataset.pane === pane); b.setAttribute('aria-selected', String(b.dataset.pane === pane));});
  const tab = active(), r = tab.request;
  const context = contextFor(workspace, tab);
  const scriptWarning = context.events.some(e => e.disabled !== true);
  $('requestWarning').hidden = !scriptWarning;
  $('requestWarning').textContent = 'このリクエストにはScriptsが含まれます。保持・表示のみで実行しません。生成する値は変数欄に設定してください。';
  if (pane === 'params') {
    const u = urlParts(r.url); r.url = {...r.url, query: u.query, variable: u.variable};
    caption('Query Params', root);
    root.append(kvEditor(r.url.query, () => {setQuery(r, r.url.query); $('url').value = displayUrl(r.url); touch();}));
    if (r.url.variable.length || /\/:\w/.test(u.base)) {caption('Path Variables', root); root.append(kvEditor(r.url.variable, touch));}
  } else if (pane === 'headers') {
    r.header = rows(r.header); caption('Request Headers', root); root.append(kvEditor(r.header, touch));
    root.append(element('p', 'hint', 'Content-TypeはBody形式に合わせて補完します。Content-Lengthとmultipartのboundaryは送信データから生成します。'));
  } else if (pane === 'authorization') root.append(authEditor(r, true, touch));
  else if (pane === 'body') renderBody(root, tab);
  else if (pane === 'settings') {
    const settings = tab.settings ||= {verify_tls: false, follow_redirects: true, timeout_ms: 30000};
    for (const [key, label] of [['verify_tls', 'TLS証明書を検証する'], ['follow_redirects', 'リダイレクトを追従する']]) {
      const line = element('label', 'settings-line'); const control = element('input'); control.type = 'checkbox'; control.checked = settings[key]; control.onchange = () => {settings[key] = control.checked; touch(); renderRequestFooter();}; line.append(control, document.createTextNode(label)); root.append(line);
    }
    const timeout = input(settings.timeout_ms, 'Timeout ms', value => {settings.timeout_ms = Number(value); touch();}, 'number'); timeout.min = '0';
    const line = element('label', 'settings-line'); line.append('Timeout', timeout, 'ms（0 = 無制限）'); root.append(line);
    root.append(element('p', 'hint', '自己署名HTTPS向けにTLS検証は初期OFFです。信頼できる接続先で使用してください。'));
    root.append(element('p', 'hint', '受信を中止しても、送信先ですでに開始した処理は取り消せません。'));
  } else if (pane === 'scripts') {
    caption('Imported Scripts · read only', root);
    root.append(element('p', 'hint', 'Postmanスクリプトのランタイムは実装していません。コードは再エクスポート時にも保持されます。'));
    if (!context.events.length) root.append(element('p', 'hint', 'このリクエストにScriptsはありません。'));
    context.events.forEach(event => {
      const details = element('details', 'scripts-block'); details.open = true;
      details.append(element('summary', '', `${event.listen || 'Script'}${event.disabled ? ' · disabled' : ''}`));
      const source = event.script?.exec; details.append(element('pre', '', Array.isArray(source) ? source.join('\n') : source || '')); root.append(details);
    });
  }
  updateCounts();
}
async function chooseFiles(key, multiple, done) {
  const chooser = element('input'); chooser.type = 'file'; chooser.multiple = multiple;
  const tabId = active().id;
  chooser.onchange = async () => {
    try {
      const files = await Promise.all([...chooser.files].map(async file => {
        const data = new Uint8Array(await file.arrayBuffer()); let binary = '';
        for (let n = 0; n < data.length; n += 32768) binary += String.fromCharCode(...data.subarray(n, n + 32768));
        return {name: file.name, type: file.type, data: btoa(binary)};
      }));
      if (!files.length) return;
      const selected = selectedFiles.get(tabId) || {}; selected[key] = files; selectedFiles.set(tabId, selected);
      if (active().id === tabId) done(files.map(f => f.name));
    } catch (error) {toast(`ファイルを読み込めませんでした: ${error.message}`);}
  };
  chooser.click();
}
function renderBody(root, tab) {
  const body = tab.request.body ||= {mode: 'none'};
  const toolbar = element('div', 'body-toolbar');
  const modes = [['none', 'none'], ['formdata', 'form-data'], ['urlencoded', 'x-www-form-urlencoded'], ['raw', 'raw'], ['file', 'binary'], ['graphql', 'GraphQL']];
  for (const [value, label] of modes) {
    const wrap = element('label'); const radio = element('input'); radio.type = 'radio'; radio.name = 'bodyMode'; radio.value = value; radio.checked = (body.mode || 'none') === value;
    radio.onchange = () => {body.mode = value; touch(); renderPane();}; wrap.append(radio, label); toolbar.append(wrap);
  }
  root.append(toolbar);
  if (body.disabled) {
    const enable = button('このBodyは無効です · 有効にする', () => {body.disabled = false; touch(); renderPane();}, 'text-button'); root.append(enable);
  }
  if (body.mode === 'raw') {
    body.options ||= {}; body.options.raw ||= {language: 'text'};
    toolbar.append(select([['text', 'Text'], ['json', 'JSON'], ['xml', 'XML'], ['html', 'HTML'], ['javascript', 'JavaScript']], body.options.raw.language || 'text', value => {body.options.raw.language = value; touch();}));
    toolbar.append(button('Beautify', () => {try {body.raw = JSON.stringify(JSON.parse(body.raw || ''), null, 2); touch(); renderPane();} catch (error) {toast(`JSON: ${error.message}`);}}, 'text-button'));
    const area = element('textarea', 'code-editor'); area.value = body.raw || ''; area.spellcheck = false; area.setAttribute('aria-label', 'Raw body'); area.placeholder = '{\n  "name": "{{name}}"\n}'; area.oninput = () => {body.raw = area.value; touch();}; root.append(area);
  } else if (body.mode === 'urlencoded' || body.mode === 'formdata') {
    const key = body.mode; body[key] = rows(body[key]); root.append(kvEditor(body[key], touch, {files: key === 'formdata'}));
  } else if (body.mode === 'file') {
    const chosen = selectedFiles.get(tab.id)?.binary?.[0];
    root.append(button(chosen ? chosen.name : 'ファイルを選択', () => chooseFiles('binary', false, names => {body.file = {src: names[0]}; touch(); renderPane();})));
    root.append(element('p', 'hint', chosen ? 'ファイル本体はこのタブでのみ保持します。再読み込み後は再選択してください。' : body.file?.src ? `元のファイル: ${body.file.src}。送信前にファイルを選び直してください。` : '選択したファイルのバイト列をそのまま送信します。'));
  } else if (body.mode === 'graphql') {
    body.graphql ||= {query: '', variables: '{}'};
    for (const key of ['query', 'variables']) {
      caption(key === 'query' ? 'Query' : 'Variables (JSON)', root);
      const area = element('textarea', 'code-editor'); area.value = typeof body.graphql[key] === 'object' ? JSON.stringify(body.graphql[key], null, 2) : body.graphql[key] || ''; area.setAttribute('aria-label', `GraphQL ${key}`); area.oninput = () => {body.graphql[key] = area.value; touch();}; root.append(area);
    }
  } else root.append(element('p', 'hint', 'このリクエストにはBodyを付けません。'));
}

function renderTabs() {
  const parent = $('requestTabs'); parent.replaceChildren();
  for (const tab of workspace.tabs) {
    const el = element('div', `request-tab${tab.id === workspace.activeId ? ' active' : ''}`); el.setAttribute('role', 'tab'); el.tabIndex = tab.id === workspace.activeId ? 0 : -1; el.setAttribute('aria-selected', String(tab.id === workspace.activeId));
    const method = element('span', `method-label method-${tab.request.method}`, tab.request.method);
    el.append(method, element('span', 'tab-name', tab.name));
    if (tab.dirty) el.append(element('span', 'dirty-dot', '●'));
    const close = button('×', event => {event.stopPropagation(); closeTab(tab.id);}, 'icon-button tab-close'); close.setAttribute('aria-label', `${tab.name}を閉じる`); el.append(close);
    el.onclick = () => {workspace.activeId = tab.id; persist(); renderAll();};
    el.onkeydown = event => {
      if (event.key === 'Enter' || event.key === ' ') {event.preventDefault(); el.click();}
      if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {event.preventDefault(); const index = workspace.tabs.indexOf(tab); const next = workspace.tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + workspace.tabs.length) % workspace.tabs.length]; workspace.activeId = next.id; persist(); renderAll(); $('requestTabs').querySelector('[aria-selected=true]')?.focus();}
    };
    parent.append(el);
  }
}
function closeTab(id) {
  const tab = workspace.tabs.find(t => t.id === id);
  if (tab.dirty && !confirm('このタブには未保存の変更があります。閉じますか？')) return;
  requests.get(id)?.abort(); requests.delete(id); responses.delete(id); selectedFiles.delete(id);
  const at = workspace.tabs.findIndex(t => t.id === id); workspace.tabs.splice(at, 1);
  if (!workspace.tabs.length) workspace.tabs.push(freshTab());
  if (workspace.activeId === id) workspace.activeId = workspace.tabs[Math.min(at, workspace.tabs.length - 1)].id;
  persist(); renderAll();
}
function addTab(tab = freshTab()) {workspace.tabs.push(tab); workspace.activeId = tab.id; persist(); renderAll();}
function openRequest(collection, item) {
  selectedCollectionId = collection._mpId;
  const existing = workspace.tabs.find(t => t.collectionId === collection._mpId && t.itemId === item._mpId);
  if (existing) {workspace.activeId = existing.id; persist(); renderAll(); return;}
  addTab({...freshTab(), name: item.name, request: normalizeRequest(item.request), collectionId: collection._mpId, itemId: item._mpId});
}
function renderEditor() {
  const tab = active(), ctx = contextFor(workspace, tab);
  $('requestName').value = tab.name;
  $('breadcrumb').textContent = ctx.collection ? [ctx.collection.info.name, ...ctx.parents.map(p => p.name)].join(' / ') + ' /' : '';
  if (![...$('method').options].some(o => o.value === tab.request.method)) $('method').append(new Option(tab.request.method, tab.request.method));
  $('method').value = tab.request.method; $('method').className = `method-${tab.request.method}`;
  $('url').value = displayUrl(tab.request.url);
  renderPane(); renderRequestFooter();
}
function renderRequestFooter() {
  $('tlsStatus').textContent = `TLS verification ${active().settings?.verify_tls ? 'ON' : 'OFF'}`;
  $('send').replaceChildren();
  if (requests.has(active().id)) {$('send').append(element('span', 'spinner'), document.createTextNode('Cancel'));}
  else {$('send').append(document.createTextNode('Send'), element('kbd', '', /Mac/.test(navigator.platform) ? '⌘ ↵' : 'Ctrl ↵'));}
}
function renderEnvironments() {
  $('environment').replaceChildren(new Option('No environment', ''));
  for (const env of workspace.environments) $('environment').append(new Option(env.name, env.id));
  $('environment').value = workspace.environmentId || '';
}
function renderSidebar() {
  const title = {collections: 'Collections', environments: 'Environments', history: 'History'}[side];
  $('sidebarTitle').textContent = title;
  $('search').placeholder = {collections: 'コレクションを検索', environments: '環境を検索', history: '履歴を検索'}[side];
  document.querySelectorAll('[data-sidebar]').forEach(b => b.classList.toggle('active', b.dataset.sidebar === side));
  const root = $('sidebarContent'); root.replaceChildren(); const search = $('search').value.trim().toLowerCase();
  if (side === 'environments') {
    root.append(button('◫  Globals', () => editEnvironment(null, true), 'tree-open tree-row'));
    workspace.environments.filter(e => e.name.toLowerCase().includes(search)).forEach(env => {
      const row = element('div', `tree-row${env.id === workspace.environmentId ? ' selected' : ''}`);
      row.append(button(`◫  ${env.name}`, () => {workspace.environmentId = env.id; persist(); renderAll(); editEnvironment(env);}, 'tree-open'));
      root.append(row);
    });
  } else if (side === 'history') {
    for (const entry of [...workspace.history].reverse().filter(h => `${h.tab.name} ${displayUrl(h.tab.request.url)}`.toLowerCase().includes(search))) {
      const row = button('', () => {if (workspace.environments.some(e => e.id === entry.environmentId)) workspace.environmentId = entry.environmentId; addTab({...clone(entry.tab), id: uid(), dirty: true});}, 'history-entry');
      const label = element('span', 'tree-label'); label.append(element('span', '', entry.tab.name), element('small', '', new Date(entry.at).toLocaleString() + ' · ' + displayUrl(entry.tab.request.url)));
      row.append(element('span', `method-label method-${entry.tab.request.method}`, entry.tab.request.method), label, element('span', 'history-code', entry.status || 'ERR')); root.append(row);
    }
  } else {
    function matches(item) {return item.name?.toLowerCase().includes(search) || (item.request && displayUrl(item.request.url).toLowerCase().includes(search)) || item.item?.some(matches);}
    function paintItem(collection, item, level, force = false) {
      if (search && !force && !matches(item)) return;
      const isFolder = Array.isArray(item.item); const expanded = search || !(workspace.collapsed || []).includes(item._mpId);
      const row = element('div', `tree-row${active().itemId === item._mpId ? ' selected' : ''}`); row.style.paddingLeft = `${level * 13 + 4}px`;
      const open = button('', () => {
        selectedCollectionId = collection._mpId;
        if (isFolder) {toggleCollapse(item._mpId); renderSidebar();} else openRequest(collection, item);
      }, 'tree-open');
      if (isFolder) open.append(element('span', 'tree-arrow', expanded ? '▾' : '▸'), element('span', 'tree-folder', '▱'));
      else open.append(element('span', `method-label method-${item.request.method}`, item.request.method));
      open.append(element('span', 'tree-label', item.name)); open.title = item.request ? displayUrl(item.request.url) : item.name; row.append(open);
      const more = button('⋯', () => isFolder ? editCollection(collection, item) : editRequestItem(collection, item), 'icon-button'); more.title = `${item.name}の操作`; more.setAttribute('aria-label', `${item.name}の操作`); row.append(more); root.append(row);
      if (isFolder && expanded) item.item.forEach(child => paintItem(collection, child, level + 1, force || item.name.toLowerCase().includes(search)));
    }
    for (const c of workspace.collections) {
      const match = c.info.name.toLowerCase().includes(search);
      if (search && !match && !c.item.some(matches)) continue;
      const row = element('div', 'tree-row'); row.style.marginTop = '4px';
      const expanded = search || !(workspace.collapsed || []).includes(c._mpId);
      const open = button('', () => {selectedCollectionId = c._mpId; toggleCollapse(c._mpId); renderSidebar();}, 'tree-open');
      open.append(element('span', 'tree-arrow', expanded ? '▾' : '▸'), element('span', 'tree-folder', '▤'), element('strong', 'tree-label', c.info.name));
      const more = button('⋯', () => editCollection(c), 'icon-button'); more.title = `${c.info.name}の設定`; more.setAttribute('aria-label', `${c.info.name}の設定`); row.append(open, more); root.append(row);
      if (expanded) c.item.forEach(item => paintItem(c, item, 1, match));
    }
  }
  if (!root.children.length) root.append(element('div', 'sidebar-empty', side === 'history' ? '送信したリクエストの履歴がここに表示されます。' : side === 'collections' ? 'コレクションを作成するか、ImportからPostmanのJSONを読み込んでください。' : '＋から環境を追加できます。'));
}
function toggleCollapse(id) {workspace.collapsed ||= []; const at = workspace.collapsed.indexOf(id); if (at < 0) workspace.collapsed.push(id); else workspace.collapsed.splice(at, 1); persist();}
function renderAll() {renderTabs(); renderEnvironments(); renderSidebar(); renderEditor(); renderResponse();}

function newCollection() {
  let name = 'My Collection'; const box = field('Name', input(name, 'Collection name', value => name = value));
  showModal('New collection', box, () => {
    if (!name.trim()) throw new Error('名前を入力してください。');
    const c = {_mpId: uid(), info: {name: name.trim(), schema: SCHEMA}, item: [], variable: []}; workspace.collections.push(c); selectedCollectionId = c._mpId; side = 'collections'; closeModal(); persist(); renderAll();
  }, '作成');
}
function folderChoices(collection) {
  const values = [['', 'コレクション直下']];
  walkItems(collection?.item, (item, parents) => {if (item.item) values.push([item._mpId, [...parents.map(p => p.name), item.name].join(' / ')]);}); return values;
}
function saveRequest() {
  const tab = active(); const current = workspace.collections.find(c => c._mpId === tab.collectionId); const located = findItem(current, tab.itemId);
  if (located) {located.item.name = tab.name; located.item.request = clone(tab.request); tab.dirty = false; persist(); renderAll(); toast('コレクションに保存しました。'); return;}
  let name = tab.name, collectionId = current?._mpId || selectedCollectionId || workspace.collections[0]?._mpId || '', folderId = tab.pendingFolderId || '';
  const box = element('div'); box.append(field('Request name', input(name, 'Request name', value => name = value)));
  const options = workspace.collections.map(c => [c._mpId, c.info.name]); if (!options.length) options.push(['', 'My Collection（新規作成）']);
  const folderSelect = select(folderChoices(workspace.collections.find(c => c._mpId === collectionId)), folderId, value => folderId = value);
  const collectionSelect = select(options, collectionId, value => {collectionId = value; folderId = ''; folderSelect.replaceChildren(...folderChoices(workspace.collections.find(c => c._mpId === value)).map(([id, label]) => new Option(label, id)));});
  box.append(field('Collection', collectionSelect), field('Folder', folderSelect));
  showModal('Save request', box, () => {
    if (!name.trim()) throw new Error('リクエスト名を入力してください。');
    let collection = workspace.collections.find(c => c._mpId === collectionId);
    if (!collection) {collection = {_mpId: uid(), info: {name: 'My Collection', schema: SCHEMA}, item: [], variable: []}; workspace.collections.push(collection);}
    const parent = findItem(collection, folderId)?.item || collection; const item = {_mpId: uid(), name: name.trim(), request: clone(tab.request)};
    parent.item.push(item); Object.assign(tab, {name: item.name, collectionId: collection._mpId, itemId: item._mpId, dirty: false}); delete tab.pendingFolderId;
    side = 'collections'; closeModal(); persist(); renderAll(); toast('コレクションに保存しました。');
  });
}
function editCollection(collection, folder = null) {
  selectedCollectionId = collection._mpId;
  const original = folder || collection; const draft = clone(original); let name = folder ? draft.name : draft.info.name;
  draft.variable = rows(draft.variable);
  const box = element('div'); const actions = element('div', 'collection-menu');
  actions.append(button('＋ Request', () => {closeModal(); addTab({...freshTab(), collectionId: collection._mpId, pendingFolderId: folder?._mpId, dirty: true});}));
  actions.append(button('＋ Folder', () => {
    let folderName = 'New folder'; const form = field('Folder name', input(folderName, 'Folder name', v => folderName = v));
    showModal('New folder', form, () => {if (!folderName.trim()) throw new Error('名前を入力してください。'); original.item.push({_mpId: uid(), name: folderName.trim(), item: []}); closeModal(); persist(); renderAll();}, '作成');
  }));
  if (!folder) actions.append(button('Export collection', () => exportFile(`${collection.info.name}.postman_collection.json`, exportCollection(collection))));
  actions.append(button('削除', () => {
    if (!confirm(`「${name}」と配下の保存済みリクエストを削除しますか？開いているタブの内容は残ります。`)) return;
    if (folder) {const parent = findItem(collection, folder._mpId)?.parents.at(-1) || collection; parent.item = parent.item.filter(item => item._mpId !== folder._mpId);}
    else workspace.collections = workspace.collections.filter(c => c !== collection);
    closeModal(); persist(); renderAll();
  }));
  box.append(actions, field('Name', input(name, 'Name', v => name = v)));
  caption('Variables', box); box.append(kvEditor(draft.variable, () => {})); caption('Authorization', box); box.append(authEditor(draft));
  box.append(element('p', 'hint', '変数と認証値はこのブラウザに保存します。環境変数はコレクション変数より優先されます。'));
  showModal(folder ? 'Folder settings' : 'Collection settings', box, () => {
    if (!name.trim()) throw new Error('名前を入力してください。');
    if (folder) original.name = name.trim(); else original.info.name = name.trim();
    original.variable = draft.variable; original.auth = draft.auth; closeModal(); persist(); renderAll();
  });
}
function editRequestItem(collection, item) {
  const box = element('div', 'collection-menu');
  box.append(button('開く', () => {closeModal(); openRequest(collection, item);}));
  box.append(button('複製', () => {const copy = {...clone(item), _mpId: uid(), name: `${item.name} copy`}; const parent = findItem(collection, item._mpId)?.parents.at(-1) || collection; parent.item.push(copy); closeModal(); openRequest(collection, copy); persist();}));
  box.append(button('削除', () => {if (!confirm(`「${item.name}」を削除しますか？`)) return; const parent = findItem(collection, item._mpId)?.parents.at(-1) || collection; parent.item = parent.item.filter(i => i._mpId !== item._mpId); closeModal(); persist(); renderAll();}));
  showModal(item.name, box, null);
}
function editEnvironment(env, globals = false) {
  const draft = env ? clone(env) : {id: uid(), name: 'New environment', values: []};
  const values = globals ? rows(clone(workspace.globals)) : rows(draft.values);
  const box = element('div'); let name = draft.name;
  if (!globals) box.append(field('Environment name', input(name, 'Environment name', v => name = v)));
  const actions = element('div', 'collection-menu');
  actions.append(button('Export', () => exportFile(`${globals ? 'globals' : name}.postman_${globals ? 'globals' : 'environment'}.json`, {id: draft.id, name: globals ? 'Globals' : name, values: values.map(v => ({...v, enabled: enabled(v)})), _postman_variable_scope: globals ? 'globals' : 'environment'})));
  if (env && !globals) actions.append(button('削除', () => {if (!confirm(`環境「${env.name}」を削除しますか？`)) return; workspace.environments = workspace.environments.filter(e => e.id !== env.id); if (workspace.environmentId === env.id) workspace.environmentId = ''; closeModal(); persist(); renderAll();}));
  box.append(actions, kvEditor(values, () => {}, {secret: true}), element('p', 'hint', '変数は {{baseUrl}} のように参照します。保存値・トークンはブラウザのlocalStorageに平文で残り、エクスポートにも含まれます。共有PCでは扱いに注意してください。'));
  showModal(globals ? 'Global variables' : 'Environment variables', box, () => {
    if (globals) workspace.globals = values;
    else {
      if (!name.trim()) throw new Error('環境名を入力してください。');
      Object.assign(draft, {name: name.trim(), values});
      const index = workspace.environments.findIndex(e => e.id === draft.id);
      if (index < 0) workspace.environments.push(draft); else workspace.environments[index] = draft;
      workspace.environmentId = draft.id;
    }
    closeModal(); persist(); renderAll();
  });
}

function importDialog(initialFiles = []) {
  let files = [...initialFiles]; const box = element('div'); const drop = element('div', 'import-drop'); const fileList = element('div', 'file-list');
  drop.append(element('strong', '', 'Postmanの設定ファイルをここにドロップ'));
  const picker = element('input'); picker.type = 'file'; picker.accept = '.json,application/json'; picker.multiple = true; picker.hidden = true;
  const folderPicker = element('input'); folderPicker.type = 'file'; folderPicker.multiple = true; folderPicker.setAttribute('webkitdirectory', ''); folderPicker.hidden = true;
  const refreshFiles = () => fileList.textContent = files.map(f => f.webkitRelativePath || f.name).join('\n');
  picker.onchange = () => {files = [...picker.files]; refreshFiles();}; folderPicker.onchange = () => {files = [...folderPicker.files].filter(f => f.name.toLowerCase().endsWith('.json')); refreshFiles();};
  drop.append(button('ファイルを選択', () => picker.click()), button('フォルダーを選択', () => folderPicker.click()), picker, folderPicker);
  drop.append(element('p', '', 'Collection v2.0 / v2.1 · Environment · Globals · 複数JSON / data dump'), element('p', '', 'ZIPは展開してから、JSONファイルまたはフォルダーを選択してください。'), fileList);
  drop.ondragover = event => {event.preventDefault(); drop.classList.add('dragover');}; drop.ondragleave = () => drop.classList.remove('dragover');
  drop.ondrop = event => {event.preventDefault(); drop.classList.remove('dragover'); files = [...event.dataTransfer.files]; refreshFiles();};
  const paste = element('textarea', 'import-paste'); paste.placeholder = 'または、PostmanのJSONを貼り付け'; paste.setAttribute('aria-label', 'Postman JSON'); paste.spellcheck = false;
  box.append(drop, field('Raw JSON', paste)); refreshFiles();
  showModal('Import Postman', box, async () => {
    const inputs = await Promise.all(files.map(async file => ({name: file.name, content: await file.text()})));
    if (paste.value.trim()) inputs.push({name: 'Pasted JSON', content: paste.value});
    if (!inputs.length) throw new Error('JSONファイルを選択するか、JSONを貼り付けてください。');
    // Parse the entire batch before changing persistent workspace data.
    const parsed = inputs.map(i => {try {return importPostman(i.content, i.name);} catch (error) {throw new Error(`${i.name}: ${error.message}`);}});
    applyImports(parsed);
  }, 'Import');
}
function applyImports(parsed) {
  const collections = parsed.flatMap(p => p.collections), environments = parsed.flatMap(p => p.environments), globals = parsed.flatMap(p => p.globals), warnings = [...new Set(parsed.flatMap(p => p.warnings))];
  workspace.collections.push(...collections); workspace.environments.push(...environments); workspace.globals.push(...globals);
  if (environments.length) workspace.environmentId = environments[0].id;
  let count = 0, first;
  for (const collection of collections) walkItems(collection.item, item => {if (item.request) {count++; first ||= {collection, item};}});
  side = 'collections'; $('search').value = '';
  if (first) openRequest(first.collection, first.item); else {persist(); renderAll();}
  persist(true);
  const box = element('div', 'import-report', `${collections.length} Collections · ${count} Requests\n${environments.length} Environments · ${globals.length} Global variables\n\n読み込みました。既存データは上書きしていません。`);
  if (warnings.length) box.append(element('div', 'warning', '\n' + warnings.join('\n')));
  showModal('インポート完了', box, closeModal, '完了');
}

function bytes(value) {return value < 1024 ? `${value} B` : value < 1048576 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1048576).toFixed(1)} MB`;}
function responseText(result, mode = responseView) {
  if (!result) return '';
  if (result.error) return result.error;
  if (mode === 'headers') return (result.headers || []).map(h => `${h.key}: ${h.value}`).join('\n');
  if (mode === 'cookies') return (result.headers || []).filter(h => h.key.toLowerCase() === 'set-cookie').map(h => h.value).join('\n');
  if (result.body_encoding === 'base64') return `[binary · ${result.content_type || 'application/octet-stream'}]\n\n${result.body}`;
  if (mode === 'pretty') {try {return JSON.stringify(JSON.parse(result.body), null, 2);} catch {}}
  return result.body || '';
}
function codeView(text, json = false, search = '') {
  const pre = element('pre', 'response-code');
  const appendText = (target, value) => {
    if (!search) {target.append(document.createTextNode(value)); return;}
    let pos = 0; const lower = value.toLowerCase(), needle = search.toLowerCase(); let at;
    while ((at = lower.indexOf(needle, pos)) >= 0) {target.append(document.createTextNode(value.slice(pos, at)), element('mark', '', value.slice(at, at + search.length))); pos = at + search.length;}
    target.append(document.createTextNode(value.slice(pos)));
  };
  for (const line of text.split('\n')) {
    const el = element('span', 'code-line');
    if (!json) appendText(el, line);
    else {
      const tokens = /("(?:\\.|[^"\\])*"\s*:?)|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
      let pos = 0;
      for (const match of line.matchAll(tokens)) {
        appendText(el, line.slice(pos, match.index));
        const value = match[0]; const cls = value.startsWith('"') ? /:\s*$/.test(value) ? 'token-key' : 'token-string' : ['true', 'false'].includes(value) ? 'token-boolean' : value === 'null' ? 'token-null' : 'token-number';
        const token = element('span', cls); appendText(token, value); el.append(token); pos = match.index + value.length;
      }
      appendText(el, line.slice(pos));
    }
    pre.append(el);
  }
  return pre;
}
function emptyResponse(title, message, icon = '↗') {const box = element('div', 'response-empty'); box.append(element('div', 'empty-icon', icon), element('strong', '', title), element('p', '', message)); return box;}
function renderResponse() {
  const root = $('responseContent'); root.replaceChildren(); const result = responses.get(active().id);
  document.querySelectorAll('[data-response]').forEach(b => b.classList.toggle('active', b.dataset.response === responseView));
  $('responseStatus').className = 'response-status'; $('responseTime').textContent = ''; $('responseSize').textContent = '';
  if (requests.has(active().id)) {$('responseStatus').textContent = 'Sending…'; root.append(emptyResponse('リクエストを送信中', 'Cancelで受信を中止できます。', '◌')); return;}
  if (!result) {$('responseStatus').textContent = '未送信'; root.append(emptyResponse('Send a request to see the response', '左のコレクションから選ぶか、URLを入力してSendを押してください。')); return;}
  if (result.error) {$('responseStatus').textContent = result.cancelled ? 'CANCELLED' : 'ERROR'; $('responseStatus').classList.add('error'); root.append(codeView(result.error)); return;}
  $('responseStatus').textContent = `${result.status} ${result.status_text || ''}`;
  $('responseStatus').classList.add(result.status < 400 ? 'good' : 'error'); $('responseTime').textContent = `${result.elapsed_ms} ms`; $('responseSize').textContent = bytes(result.size);
  const search = $('responseSearch').value;
  if (responseView === 'headers' || responseView === 'cookies') {
    let entries = result.headers || [];
    if (responseView === 'cookies') entries = entries.filter(h => h.key.toLowerCase() === 'set-cookie');
    entries = entries.filter(h => `${h.key} ${h.value}`.toLowerCase().includes(search.toLowerCase()));
    if (!entries.length) {root.append(emptyResponse(responseView === 'cookies' ? 'Set-Cookieはありません' : '該当するヘッダーはありません', responseView === 'cookies' ? 'レスポンスが返したCookieを表示します。次のリクエストへの自動送信は行いません。' : '')); return;}
    const table = element('table', 'kv-table kv-readonly'); const head = element('tr'); head.append(element('th', '', 'KEY'), element('th', '', 'VALUE')); table.append(head);
    for (const h of entries) {const tr = element('tr'); tr.append(element('td', '', h.key), element('td', '', h.value)); table.append(tr);} root.append(table);
  } else if (responseView === 'preview') {
    if (result.body_encoding === 'base64') {root.append(emptyResponse('バイナリレスポンス', `${result.content_type} · Save responseで保存してください。`)); return;}
    if (/text\/html|image\/svg\+xml/i.test(result.content_type)) {
      const frame = element('iframe', 'preview-frame'); frame.setAttribute('sandbox', ''); frame.referrerPolicy = 'no-referrer'; frame.title = 'Response preview';
      frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'">` + result.body;
      root.append(frame);
    } else root.append(codeView(responseText(result, 'pretty'), /json/i.test(result.content_type), search));
  } else root.append(codeView(responseText(result), responseView === 'pretty' && /json/i.test(result.content_type), search));
}
async function sendRequest() {
  const tab = active();
  if (requests.has(tab.id)) {requests.get(tab.id).abort(); return;}
  let compiled;
  try {compiled = compileRequest(workspace, tab, selectedFiles.get(tab.id) || {});}
  catch (error) {responses.set(tab.id, {error: error.message}); renderResponse(); return;}
  const snapshot = clone(tab), environmentId = workspace.environmentId;
  const controller = new AbortController(); requests.set(tab.id, controller);
  responses.delete(tab.id); renderRequestFooter(); renderResponse();
  try {
    const response = await fetch('/api/request', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(compiled.payload), signal: controller.signal});
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || `Backend HTTP ${response.status}`);
    if (workspace.tabs.some(t => t.id === tab.id)) responses.set(tab.id, result);
    workspace.history.push({id: uid(), at: new Date().toISOString(), tab: snapshot, environmentId, status: result.status, elapsed_ms: result.elapsed_ms}); persist();
    if (active().id === tab.id) $('requestInfo').textContent = `${tab.request.method} · ${new Date().toLocaleTimeString()}${result.redirects?.length ? ` · ${result.redirects.length} redirects` : ''}`;
  } catch (error) {
    const cancelled = error.name === 'AbortError';
    if (workspace.tabs.some(t => t.id === tab.id)) responses.set(tab.id, {error: cancelled ? '受信を中止しました。送信先ですでに開始した処理は取り消せません。' : error.message, cancelled});
    if (!cancelled) {workspace.history.push({id: uid(), at: new Date().toISOString(), tab: snapshot, environmentId, status: 'ERR'}); persist();}
  } finally {
    requests.delete(tab.id); if (active().id === tab.id) {renderRequestFooter(); renderResponse();} if (side === 'history') renderSidebar();
  }
}

$('send').onclick = sendRequest;
$('newRequest').onclick = $('addTab').onclick = () => addTab();
$('duplicateRequest').onclick = () => addTab({...clone(active()), id: uid(), itemId: undefined, name: `${active().name} copy`, dirty: true});
$('saveRequest').onclick = saveRequest;
$('requestName').oninput = () => {active().name = $('requestName').value; touch();};
$('method').onchange = () => {active().request.method = $('method').value; $('method').className = `method-${$('method').value}`; touch();};
$('url').oninput = () => {setUrlText(active().request, $('url').value); touch(); if (pane === 'params') renderPane();};
$('environment').onchange = () => {workspace.environmentId = $('environment').value; persist(); renderSidebar(); renderPane();};
$('editEnvironment').onclick = () => editEnvironment(workspace.environments.find(e => e.id === workspace.environmentId), !workspace.environmentId);
$('search').oninput = renderSidebar;
$('import').onclick = () => importDialog();
$('importFiles').onchange = () => importDialog([...$('importFiles').files]);
$('sidebarAdd').onclick = () => side === 'environments' ? editEnvironment() : side === 'history' ? addTab() : newCollection();
$('sidebarMore').onclick = () => {
  if (side === 'environments') return editEnvironment(null, true);
  if (side === 'history') {if (confirm('送信履歴をすべて削除しますか？')) {workspace.history = []; persist(); renderSidebar();} return;}
  const collection = workspace.collections.find(c => c._mpId === selectedCollectionId) || workspace.collections.find(c => c._mpId === active().collectionId) || workspace.collections[0];
  if (collection) editCollection(collection); else newCollection();
};
$('gatewayExample').onclick = async () => {
  try {const r = await fetch('/api/examples/gateway'); if (!r.ok) throw new Error(`HTTP ${r.status}`); applyImports([importPostman(await r.json())]);} catch (error) {toast(error.message);}
};
for (const button of document.querySelectorAll('[data-pane]')) button.onclick = () => {pane = button.dataset.pane; renderPane();};
for (const button of document.querySelectorAll('[data-response]')) button.onclick = () => {responseView = button.dataset.response; renderResponse();};
for (const button of document.querySelectorAll('[data-sidebar]')) button.onclick = () => {side = button.dataset.sidebar; $('search').value = ''; renderSidebar();};
$('responseSearch').oninput = () => {clearTimeout(responseSearchTimer); responseSearchTimer = setTimeout(renderResponse, 180);};
$('copyResponse').onclick = async () => {
  const value = responseText(responses.get(active().id));
  if (!value) return toast('コピーするレスポンスがありません。');
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(value);
    else {const field = element('textarea'); field.value = value; field.style.position = 'fixed'; field.style.opacity = '0'; document.body.append(field); field.select(); const ok = document.execCommand('copy'); field.remove(); if (!ok) throw new Error('copy failed');}
    toast('レスポンスをコピーしました。');
  } catch {toast('コピーできませんでした。レスポンスを選択してコピーしてください。');}
};
$('downloadResponse').onclick = () => {
  const result = responses.get(active().id); if (!result || result.error) return toast('保存するレスポンスがありません。');
  const raw = result.body_base64 || (result.body_encoding === 'base64' ? result.body : null);
  const data = raw != null ? Uint8Array.from(atob(raw), c => c.charCodeAt(0)) : result.body;
  const suffix = /json/i.test(result.content_type) ? '.json' : /html/i.test(result.content_type) ? '.html' : result.body_encoding === 'base64' ? '.bin' : '.txt';
  download('response' + suffix, new Blob([data], {type: result.content_type || 'application/octet-stream'}));
};
function setTheme() {document.documentElement.dataset.theme = workspace.theme || 'dark';}
$('theme').onclick = () => {workspace.theme = workspace.theme === 'light' ? 'dark' : 'light'; setTheme(); persist();};
document.addEventListener('keydown', event => {
  if ($('modal').open) return;
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {event.preventDefault(); sendRequest();}
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {event.preventDefault(); saveRequest();}
  if (event.key === 'Escape' && requests.has(active().id)) requests.get(active().id).abort();
});
function bindResize(handle, move) {
  handle.onpointerdown = event => {if (event.button !== 0) return; event.preventDefault(); handle.setPointerCapture(event.pointerId); handle.onpointermove = e => move(e); const stop = () => {handle.onpointermove = null; handle.onpointerup = null; handle.onpointercancel = null;}; handle.onpointerup = stop; handle.onpointercancel = stop;};
}
bindResize($('sidebarResize'), event => {const rail = document.querySelector('.rail').getBoundingClientRect().width; document.documentElement.style.setProperty('--sidebar', `${Math.min(460, Math.max(150, event.clientX - rail))}px`);});
bindResize($('responseResize'), event => {const main = document.querySelector('.main').getBoundingClientRect(); const height = Math.max(225, Math.min(main.height - 240, event.clientY - main.top - 40)); document.documentElement.style.setProperty('--request-height', `${height}px`);});
$('sidebarResize').onkeydown = event => {if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {event.preventDefault(); const width = document.querySelector('.sidebar').getBoundingClientRect().width; document.documentElement.style.setProperty('--sidebar', `${Math.max(150, Math.min(460, width + (event.key === 'ArrowRight' ? 20 : -20)))}px`);}};
$('responseResize').onkeydown = event => {if (['ArrowUp', 'ArrowDown'].includes(event.key)) {event.preventDefault(); const height = document.querySelector('.request-editor').getBoundingClientRect().height; document.documentElement.style.setProperty('--request-height', `${Math.max(225, height + (event.key === 'ArrowDown' ? 20 : -20))}px`);}};
setTheme(); renderAll(); if (recoveryMessage) toast(recoveryMessage);
fetch('/api/health').then(r => {if (!r.ok) throw new Error(); $('connectionStatus').replaceChildren(element('span', 'status-dot'), document.createTextNode('Python proxy · connected'));}).catch(() => {$('connectionStatus').textContent = 'Python proxy · 接続できません';});
