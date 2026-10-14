import {SCHEMA, clone, uid, rows, enabled, urlParts, displayUrl, setUrlText, setQuery, newRequest, normalizeRequest, walkItems, findItem, importPostman, exportCollection, contextFor, compileRequest} from './core.mjs';
import {initWorkbench, bindItemMenu, openItemMenu, closeItemMenu, openSurface, bindSurface} from './workbench.mjs';
import {exportWorkspace, isWorkspaceBundle, readWorkspaceBundle, mergeWorkspace} from './workspace-data.mjs';
import {sendThroughProxy} from './transport.mjs';
import {RevisionStore, requestKey, requestSettings, settingsIndex} from './revisions.mjs';
import {copyName, duplicateItem, duplicateCollection, duplicateEnvironment, snapshotSettings, applySettings} from './editops.mjs';

const $ = id => document.getElementById(id);
let workbench;
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
for (const draft of workspace.tabs) draft.settings = requestSettings(draft.settings);
let revisionStore = new RevisionStore(workspace);
const responses = new Map(), requests = new Map(), selectedFiles = new Map();
let pane = 'params', side = 'collections', responseView = 'pretty', selectedCollectionId = '', modalAction = null;
let saveTimer, toastTimer, responseSearchTimer;
let settingsDrawer = null, settingsClipboard = null, rowClipboard = null;
let saveStatus = 'ローカルに保存済み';
const active = () => workspace.tabs.find(t => t.id === workspace.activeId) || workspace.tabs[0];
const describe = value => typeof value === 'string' ? value : value?.content || '';
const element = (tag, className, text) => {const e = document.createElement(tag); if (className) e.className = className; if (text != null) e.textContent = text; return e;};
function button(text, fn, className = 'button') {const e = element('button', className, text); e.type = 'button'; e.onclick = fn; return e;}
function input(value, placeholder, change, type = 'text') {const e = element('input'); e.type = type; e.value = value ?? ''; e.placeholder = placeholder; e.setAttribute('aria-label', placeholder); e.spellcheck = false; e.oninput = () => change(e.value); return e;}
function select(options, value, change) {const e = element('select'); for (const [v, label] of options) {const o = element('option', '', label); o.value = v; e.append(o);} e.value = value; e.onchange = () => change(e.value); return e;}
function field(label, control) {const e = element('div', 'form-field'); control.id ||= uid(); const text = element('label', '', label); text.htmlFor = control.id; e.append(text, control); return e;}
function toast(message) {$('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 6500);}
function setSaveStatus(message, failed = false) {
  saveStatus = message; $('saveState').textContent = message;
  const status = $('drawerSaveState');
  if (status) {status.textContent = message; status.classList.toggle('save-error', failed);}
}
function persist(now = false) {
  const sync = $('serverSaveState');
  if (sync?.classList.contains('saved')) {
    sync.classList.remove('saved');
    sync.textContent = 'サーバーには未反映';
  }
  clearTimeout(saveTimer); setSaveStatus('保存中…');
  const save = () => {
    try {revisionStore.capture(); localStorage.setItem(KEY, JSON.stringify(workspace)); setSaveStatus('ローカルに保存済み');}
    catch {setSaveStatus('保存できません。エクスポートしてください。', true); toast('ブラウザに保存できません。編集中の値は画面に残しています。エクスポートして退避してください。');}
  };
  if (now) save(); else saveTimer = setTimeout(save, 220);
}
// Saved requests are updated in the browser collection automatically. Server writes remain opt-in.
function touch() {
  const tab = active(), collection = workspace.collections.find(c => c._mpId === tab.collectionId);
  const item = findItem(collection, tab.itemId)?.item;
  if (item?.request) {
    item.name = tab.name; item.request = clone(tab.request); item.settings = clone(tab.settings);
    tab.dirty = false;
  } else tab.dirty = true;
  persist(); renderSelection(); renderSidebar(); updateCounts();
}
function download(name, content, type = 'application/json') {
  const blob = content instanceof Blob ? content : new Blob([content], {type});
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportFile(name, value) {download(name, JSON.stringify(value, null, 2));}
function closeModal() {if (settingsDrawer) persist(true); closeItemMenu(false); $('modal').close(); modalAction = null; settingsDrawer = null;}
function showModal(title, content, action, submit = '保存', kind = 'dialog') {
  if (settingsDrawer) persist(true);
  settingsDrawer = null; $('cancelModal').textContent = 'キャンセル';
  delete $('modal').dataset.settingsKind; delete $('modal').dataset.settingsId;
  $('modalTitle').textContent = title; $('modalBody').replaceChildren(content);
  $('modalSubmit').textContent = submit; $('modalSubmit').hidden = !action;
  $('modalSubmit').disabled = false; $('modalMessage').textContent = ''; modalAction = action;
  workbench?.closeNavigation(); openSurface(kind);
}
$('modalForm').onsubmit = async event => {
  event.preventDefault(); if (!modalAction) return;
  const action = modalAction; $('modalSubmit').disabled = true;
  try {await action();} catch (error) {$('modalMessage').textContent = error.message;}
  finally {$('modalSubmit').disabled = false;}
};
$('closeModal').onclick = $('cancelModal').onclick = closeModal;
$('modal').addEventListener('cancel', () => {if (settingsDrawer) persist(true); closeItemMenu(false); modalAction = null;});
$('modal').addEventListener('close', () => {if (!$('modal').open) {if (settingsDrawer) persist(true); closeItemMenu(false); settingsDrawer = null; modalAction = null;}});
window.addEventListener('pagehide', () => persist(true));

function chooseEnvironment(id, open = false) {
  persist(true);
  const environment = workspace.environments.find(e => e.id === id);
  workspace.environmentId = environment?.id || '';
  persist(); renderEnvironments(); renderSidebar(); updateCounts();
  if (open || (settingsDrawer?.kind === 'environment' && $('modal').open)) {
    const focused = document.activeElement;
    if (environment) editEnvironment(environment); else emptyEnvironmentDrawer();
    if (!open && focused?.isConnected && !$('modal').contains(focused)) focused.focus();
  }
}
function showSettings(title, box, descriptor) {
  showModal(title, box, null, '保存', 'drawer'); settingsDrawer = descriptor;
  $('modal').dataset.settingsKind = descriptor.kind; $('modal').dataset.settingsId = descriptor.id || '';
  $('cancelModal').textContent = '閉じる';
  const historyKey = descriptor.kind === 'globals' ? 'globals' : descriptor.kind === 'folder' ? `folder:${descriptor.collectionId}:${descriptor.id}` : `${descriptor.kind}:${descriptor.id}`;
  if (descriptor.id || descriptor.kind === 'globals') box.append(button('変更履歴', () => showRevisions(historyKey), 'button settings-history'));
  const status = element('span', 'drawer-save-state', saveStatus);
  status.id = 'drawerSaveState'; status.setAttribute('role', 'status'); status.classList.toggle('save-error', saveStatus.startsWith('保存できません'));
  const meta = element('div', 'settings-meta'); meta.append(element('span', '', '自動保存'), status); box.prepend(meta);
}
function settingsChanged(rename = false) {persist(); if (rename) {renderEnvironments(); renderSidebar();} updateCounts();}
function refreshSettingsDrawer() {
  const descriptor = settingsDrawer;
  if (!descriptor || !$('modal').open) return;
  if (descriptor.kind === 'environment') {
    const env = workspace.environments.find(e => e.id === workspace.environmentId);
    if (env) editEnvironment(env); else emptyEnvironmentDrawer();
  } else if (descriptor.kind === 'globals') editEnvironment(null, true);
  else {
    const collection = workspace.collections.find(c => c._mpId === descriptor.collectionId);
    const folder = descriptor.kind === 'folder' ? findItem(collection, descriptor.id)?.item : null;
    if (collection && (descriptor.kind !== 'folder' || folder)) editCollection(collection, folder); else closeModal();
  }
}
function emptyEnvironmentDrawer() {
  const box = element('div');
  box.append(element('p', 'empty-state', 'No environment — 環境は選択されていません。'), button('環境を作成', () => editEnvironment()));
  showSettings('Environment variables', box, {kind: 'environment', id: ''});
}
function copyConfiguration(owner, kind) {settingsClipboard = snapshotSettings(owner, kind); toast('設定をコピーしました。貼り付け先のメニューから貼り付けできます。');}
function pasteConfiguration(owner, kind) {applySettings(owner, kind, settingsClipboard); settingsChanged(true); refreshSettingsDrawer(); toast('設定を貼り付けました。名前は変更していません。');}
function configurationActions(owner, kind) {
  return [{label: '設定をコピー', run: () => copyConfiguration(owner, kind)}, {label: '設定を貼り付け', disabled: settingsClipboard?.kind !== kind, run: () => pasteConfiguration(owner, kind)}];
}
async function copyText(value) {
  const text = String(value ?? ''), focused = document.activeElement;
  const selection = focused && typeof focused.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd] : null;
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else {
      const area = element('textarea'); area.value = text; area.style.cssText = 'position:fixed;opacity:0;left:0;top:0;';
      ($('modal').open ? $('modal') : document.body).append(area);
      try {area.select(); if (!document.execCommand('copy')) throw new Error('Clipboard unavailable');} finally {area.remove();}
    }
    toast('コピーしました。');
  } catch {toast('クリップボードへコピーできません。入力欄で文字列を選択してコピーしてください。');}
  finally {if (focused?.isConnected) {focused.focus(); if (selection) focused.setSelectionRange(...selection);}}
}
function bindContext(target, anchor, menu) {
  anchor.setAttribute('aria-haspopup', 'menu'); anchor.onclick = event => menu(anchor, event);
  target.addEventListener('contextmenu', event => {
    if (event.target.closest('input,textarea,select,[contenteditable=true]')) return;
    event.preventDefault(); event.stopPropagation(); menu(anchor, event);
  });
  target.addEventListener('keydown', event => {
    if (event.target.closest('input,textarea,select,[contenteditable=true]')) return;
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    event.preventDefault(); event.stopPropagation(); menu(anchor);
  });
}
function kvEditor(list, changed, options = {}) {
  const wrap = element('div', 'kv-editor'), table = element('table', 'kv-table'), head = element('tr');
  const columns = [['', 'check'], ['KEY', ''], ...(options.files ? [['TYPE', 'type']] : []), ['VALUE', ''], ['DESCRIPTION', ''], ['', 'action row-actions']];
  for (const [name, cls] of columns) head.append(element('th', cls, name));
  const thead = element('thead'); thead.append(head); table.append(thead);
  const tbody = element('tbody'); table.append(tbody);
  function paint() {
    tbody.replaceChildren();
    list.forEach((row, index) => {
      const tr = element('tr', enabled(row) ? '' : 'disabled');
      const checkCell = element('td', 'check'), check = element('input');
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
      const actionCell = element('td', 'row-actions');
      function editRows(at, remove, additions = []) {
        list.splice(at, remove, ...additions);
        if (options.files) {
          const files = selectedFiles.get(active().id) || {}, previous = {...files};
          for (const key of Object.keys(files)) if (key.startsWith('form-')) delete files[key];
          const oldLength = list.length + remove - additions.length;
          for (let n = 0; n < oldLength; n++) {
            if (n >= at && n < at + remove) continue;
            const next = n < at ? n : n - remove + additions.length;
            if (previous[`form-${n}`]) files[`form-${next}`] = previous[`form-${n}`];
          }
        }
        changed(); paint();
      }
      const more = button('⋯', () => {}, 'icon-button row-menu'); more.setAttribute('aria-label', `行 ${index + 1} の操作`);
      bindContext(tr, more, (anchor, event) => openItemMenu(anchor, [
        {label: '値をコピー', run: () => copyText(row.value)},
        {label: '行をコピー', run: () => {rowClipboard = clone(row); toast('行をコピーしました。');}},
        {label: '行を複製', run: () => editRows(index + 1, 0, [clone(row)])},
        {label: 'コピーした行を下に貼り付け', disabled: !rowClipboard, run: () => editRows(index + 1, 0, [clone(rowClipboard)])},
        {label: enabled(row) ? '無効にする' : '有効にする', run: () => {row.disabled = enabled(row); delete row.enabled; changed(); paint();}},
        {label: '削除', danger: true, run: () => editRows(index, 1)}
      ], event));
      const remove = button('×', () => editRows(index, 1), 'icon-button'); remove.title = '行を削除'; remove.setAttribute('aria-label', `行 ${index + 1} を削除`);
      actionCell.append(more, remove); tr.append(actionCell); tbody.append(tr);
    });
  }
  paint(); wrap.append(table, button('＋ 行を追加', () => {list.push({key: '', value: '', disabled: false, ...(options.files ? {type: 'text'} : {})}); changed(); paint(); tbody.lastElementChild?.querySelector('input[type=text]')?.focus();}, 'table-add'));
  const paste = button('行を貼り付け', () => {if (!rowClipboard) {toast('先に行のメニューからコピーしてください。'); return;} list.push(clone(rowClipboard)); changed(); paint();}, 'text-button table-paste');
  paste.setAttribute('aria-label', 'コピーした行を末尾に貼り付け'); wrap.append(paste); return wrap;
}
function caption(title, parent) {const line = element('div', 'section-caption', title); parent.append(line); return line;}
function updateCounts() {
  const r = active().request, count = list => list.filter(enabled).filter(row => row.key).length;
  $('paramsCount').textContent = count(urlParts(r.url).query) || ''; $('headersCount').textContent = count(rows(r.header)) || '';
  $('bodyDot').textContent = r.body?.mode && r.body.mode !== 'none' ? '●' : ''; $('scriptDot').textContent = contextFor(workspace, active()).events.length ? '●' : '';
}
function authEditor(owner, inherited = false, changed = () => {}) {
  const box = element('div');
  function paint() {
    box.replaceChildren(); const grid = element('div', 'field-stack');
    const options = [['inherit', 'Inherit auth from parent'], ['noauth', 'No Auth'], ['bearer', 'Bearer Token'], ['basic', 'Basic Auth'], ['apikey', 'API Key'], ['oauth2', 'OAuth 2.0 · access token']];
    const type = owner.auth?.type || 'inherit';
    if (!options.some(([value]) => value === type)) options.push([type, `${type}（送信未対応）`]);
    const typeSelect = select(options, type, value => {owner.auth = value === 'inherit' ? null : {type: value, [value]: []}; changed(); paint();}); typeSelect.setAttribute('aria-label', '認証方式');
    grid.append(element('label', '', 'Auth type'), typeSelect);
    const specs = {bearer: [['token', 'Token']], basic: [['username', 'Username'], ['password', 'Password']], apikey: [['key', 'Key'], ['value', 'Value'], ['in', 'Add to']], oauth2: [['accessToken', 'Access token'], ['headerPrefix', 'Header prefix']]};
    if (specs[type]) {
      const attrs = owner.auth[type] = rows(owner.auth[type]);
      for (const [key, label] of specs[type]) {
        let row = attrs.find(v => v.key === key);
        const value = row?.value ?? (key === 'in' ? 'header' : key === 'headerPrefix' ? 'Bearer' : '');
        const change = v => {if (!row) {row = {key, type: 'string'}; attrs.push(row);} row.value = v; changed();};
        const control = key === 'in' ? select([['header', 'Header'], ['query', 'Query Params']], value, change) : input(value, label, change, key === 'password' ? 'password' : 'text');
        control.setAttribute('aria-label', label); grid.append(element('label', '', label), control);
      }
      if (type === 'oauth2') grid.append(element('div', 'input-condition', '取得済みのアクセストークンを入力してください。'));
    }
    box.append(grid);
  }
  paint(); return box;
}
function renderPaneSection(root, pane) {
  root.replaceChildren();
  const tab = active(), r = tab.request, context = contextFor(workspace, tab);
  const scriptWarning = context.events.some(e => e.disabled !== true);
  $('requestWarning').hidden = !scriptWarning; $('requestWarning').textContent = 'Scriptsは実行されません。送信に必要な値を変数へ設定してください。';
  if (pane === 'params') {
    const u = urlParts(r.url); r.url = {...r.url, query: u.query, variable: u.variable};
    if (r.url.variable.length) caption('Query Params', root);
    root.append(kvEditor(r.url.query, () => {setQuery(r, r.url.query); $('url').value = displayUrl(r.url); touch();}));
    if (r.url.variable.length || /\/:\w/.test(u.base)) {caption('Path Variables', root); root.append(kvEditor(r.url.variable, touch));}
  } else if (pane === 'headers') {r.header = rows(r.header); root.append(kvEditor(r.header, touch));}
  else if (pane === 'authorization') root.append(authEditor(r, true, touch));
  else if (pane === 'body') renderBody(root, tab);
  else if (pane === 'settings') {
    const settings = tab.settings ||= {verify_tls: false, follow_redirects: true, timeout_ms: 30000};
    for (const [key, label] of [['verify_tls', 'TLS証明書を検証する'], ['follow_redirects', 'リダイレクトを追従する']]) {
      const line = element('label', 'settings-line'), control = element('input'); control.type = 'checkbox'; control.checked = settings[key];
      control.onchange = () => {settings[key] = control.checked; touch(); renderRequestFooter();}; line.append(control, document.createTextNode(label)); root.append(line);
    }
    const timeout = input(settings.timeout_ms, 'Timeout ms', value => {settings.timeout_ms = Number(value); touch();}, 'number'); timeout.min = '0';
    const line = element('label', 'settings-line'); line.append('Timeout', timeout, 'ms（0 = 無制限）'); root.append(line);
  } else if (pane === 'scripts') {
    if (!context.events.length) root.append(element('p', 'empty-state', 'Scriptsなし'));
    context.events.forEach(event => {
      const details = element('details', 'scripts-block'); details.open = true;
      details.append(element('summary', '', `${event.listen || 'Script'}${event.disabled ? ' · disabled' : ''}`));
      const source = event.script?.exec; details.append(element('pre', '', Array.isArray(source) ? source.join('\n') : source || '')); root.append(details);
    });
  }
}
const editorSections = [
  ['params','クエリとパス変数'],
  ['headers','HTTP ヘッダー'],
  ['authorization','認証'],
  ['body','リクエスト本文'],
  ['settings','通信設定'],
  ['scripts','スクリプト（参照のみ）']
];
const sectionKey = 'minipost.sections.v1';
let expandedSections;
try {expandedSections = JSON.parse(localStorage.getItem(sectionKey));} catch {}
if (!Array.isArray(expandedSections)) expandedSections = ['params','headers','authorization','body'];
function renderPane() {
  const root = $('editorContent'), oldSections = [...root.querySelectorAll('details.editor-section')];
  if (oldSections.length) expandedSections = oldSections.filter(section => section.open).map(section => section.dataset.pane);
  root.replaceChildren();
  for (const [name, title] of editorSections) {
    const section = element('details','editor-section'); section.dataset.pane = name;
    section.open = expandedSections.includes(name);
    const summary = element('summary');
    summary.append(element('span','editor-section-title',title));
    const indicator = {params:'paramsCount',headers:'headersCount',body:'bodyDot',scripts:'scriptDot'}[name];
    if (indicator) {const counter = element('small'); counter.id = indicator; summary.append(counter);}
    const content = element('div','editor-section-body');
    renderPaneSection(content,name);
    section.append(summary,content);
    section.addEventListener('toggle', () => {
      expandedSections = [...root.querySelectorAll('details.editor-section')].filter(x => x.open).map(x => x.dataset.pane);
      try {localStorage.setItem(sectionKey,JSON.stringify(expandedSections));} catch {}
    });
    root.append(section);
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
  const body = tab.request.body ||= {mode: 'none'}, toolbar = element('div', 'body-toolbar');
  const modes = [['none', 'none'], ['formdata', 'form-data'], ['urlencoded', 'x-www-form-urlencoded'], ['raw', 'raw'], ['file', 'binary'], ['graphql', 'GraphQL']];
  for (const [value, label] of modes) {
    const wrap = element('label'), radio = element('input'); radio.type = 'radio'; radio.name = 'bodyMode'; radio.value = value; radio.checked = (body.mode || 'none') === value;
    radio.onchange = () => {body.mode = value; touch(); renderPane();}; wrap.append(radio, label); toolbar.append(wrap);
  }
  root.append(toolbar);
  if (body.disabled) root.append(button('このBodyは無効です · 有効にする', () => {body.disabled = false; touch(); renderPane();}, 'text-button'));
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
    if (!chosen && body.file?.src) root.append(element('p', 'input-condition', `${body.file.src}：送信前に選び直してください。`));
  } else if (body.mode === 'graphql') {
    body.graphql ||= {query: '', variables: '{}'};
    for (const key of ['query', 'variables']) {
      caption(key === 'query' ? 'Query' : 'Variables (JSON)', root);
      const area = element('textarea', 'code-editor'); area.value = typeof body.graphql[key] === 'object' ? JSON.stringify(body.graphql[key], null, 2) : body.graphql[key] || ''; area.setAttribute('aria-label', `GraphQL ${key}`); area.oninput = () => {body.graphql[key] = area.value; touch();}; root.append(area);
    }
  }
}

// The legacy tabs array is a draft cache only; the DOM contains one editor.
function renderSelection() {
  const draft = active(), collection = workspace.collections.find(c => c._mpId === draft.collectionId);
  const inCollection = Boolean(findItem(collection, draft.itemId)?.item.request);
  $('requestDirty').textContent = draft.dirty ? '自動保存済み · 未登録' : '';
  $('currentContext').textContent = draft.name || '新規リクエスト';
  $('saveRequest').hidden = inCollection;
}
function selectRequest(id) {
  if (!workspace.tabs.some(t => t.id === id)) return;
  persist(true); workspace.activeId = id; workbench?.closeNavigation();
  if ($('modal').open) closeModal();
  persist(); renderAll();
}
function discardDraft(id) {
  const draft = workspace.tabs.find(t => t.id === id);
  if (!draft || !confirm('この下書きを削除しますか？')) return;
  persist(true); requests.get(id)?.abort(); requests.delete(id); responses.delete(id); selectedFiles.delete(id);
  workspace.tabs = workspace.tabs.filter(t => t.id !== id);
  if (!workspace.tabs.length) workspace.tabs.push(freshTab());
  if (workspace.activeId === id) workspace.activeId = workspace.tabs[0].id;
  persist(); renderAll();
}
function addTab(tab = freshTab()) {persist(true); tab.settings = requestSettings(tab.settings); workspace.tabs.push(tab); selectRequest(tab.id);}
function openRequest(collection, item) {
  workbench?.closeNavigation(); selectedCollectionId = collection._mpId;
  const existing = workspace.tabs.find(t => t.collectionId === collection._mpId && t.itemId === item._mpId);
  if (existing) {selectRequest(existing.id); return;}
  addTab({...freshTab(), name: item.name, request: normalizeRequest(item.request), settings: requestSettings(item.settings), collectionId: collection._mpId, itemId: item._mpId});
}
function renderEditor() {
  const tab = active(), ctx = contextFor(workspace, tab);
  $('requestName').value = tab.name;
  $('breadcrumb').textContent = ctx.collection ? [ctx.collection.info.name, ...ctx.parents.map(p => p.name)].join(' / ') + ' /' : '';
  if (![...$('method').options].some(o => o.value === tab.request.method)) $('method').append(new Option(tab.request.method, tab.request.method));
  $('method').value = tab.request.method; $('method').className = `method-${tab.request.method}`;
  $('url').value = displayUrl(tab.request.url); renderPane(); renderRequestFooter();
}
function renderRequestFooter() {
  $('tlsStatus').textContent = `TLS verification ${active().settings?.verify_tls ? 'ON' : 'OFF'}`;
  $('send').replaceChildren();
  if (requests.has(active().id)) $('send').append(element('span', 'spinner'), document.createTextNode('Cancel'));
  else $('send').append(document.createTextNode('Send'), element('kbd', '', /Mac/.test(navigator.platform) ? '⌘ ↵' : 'Ctrl ↵'));
}
function renderEnvironments() {
  $('environment').replaceChildren(new Option('No environment', ''));
  for (const env of workspace.environments) $('environment').append(new Option(env.name || '名前なしの環境', env.id));
  $('environment').value = workspace.environmentId || '';
}
function renderSidebarSection() {
  const title = {collections: 'Collections', environments: 'Environments', history: 'History'}[side];
  document.querySelector('.sidebar').setAttribute('aria-label', title);
  $('sidebarAdd').hidden = side === 'history'; $('clearHistory').hidden = side !== 'history';
  $('sidebarAdd').setAttribute('aria-label', side === 'environments' ? '環境を作成' : 'コレクションを作成');
  $('search').placeholder = {collections: 'コレクションを検索', environments: '環境を検索', history: '履歴を検索'}[side];
  document.querySelectorAll('[data-sidebar]').forEach(b => (b.classList.toggle('active', b.dataset.sidebar === side), b.setAttribute('aria-current', b.dataset.sidebar === side ? 'true' : 'false')));
  const root = $('sidebarContent'); root.replaceChildren(); const search = $('search').value.trim().toLowerCase();
  if (side === 'environments') {
    const globalRow = element('div', 'tree-row');
    const globalsButton = button('◫  Globals', () => editEnvironment(null, true), 'tree-open'); globalsButton.id = 'globalVariables';
    const globalMore = button('⋯', () => {}, 'icon-button'); globalMore.setAttribute('aria-label', 'Globalsの操作');
    globalRow.append(globalsButton, globalMore); root.append(globalRow);
    bindContext(globalRow, globalMore, (anchor, event) => environmentMenu(null, true, anchor, event));
    workspace.environments.filter(e => e.name.toLowerCase().includes(search)).forEach(env => {
      const row = element('div', `tree-row${env.id === workspace.environmentId ? ' selected' : ''}`); row.dataset.environmentId = env.id;
      const edit = button(`◫  ${env.name || '名前なしの環境'}`, () => chooseEnvironment(env.id, true), 'tree-open'); edit.id = `env-${env.id}`; edit.setAttribute('aria-current', String(env.id === workspace.environmentId));
      const more = button('⋯', () => {}, 'icon-button'); more.setAttribute('aria-label', `${env.name || '名前なしの環境'}の操作`);
      row.append(edit, more); root.append(row); bindContext(row, more, (anchor, event) => environmentMenu(env, false, anchor, event));
    });
  } else if (side === 'history') {
    for (const entry of [...workspace.history].reverse().filter(h => `${h.tab.name} ${displayUrl(h.tab.request.url)}`.toLowerCase().includes(search))) {
      const row = button('', () => {chooseEnvironment(entry.environmentId); addTab({...clone(entry.tab), id: uid(), itemId: undefined, dirty: true});}, 'history-entry');
      const label = element('span', 'tree-label'); label.append(element('span', '', entry.tab.name), element('span', 'history-detail', new Date(entry.at).toLocaleString() + ' · ' + displayUrl(entry.tab.request.url)));
      row.append(element('span', `method-label method-${entry.tab.request.method}`, entry.tab.request.method), label, element('span', 'history-code', entry.status || 'ERR')); root.append(row);
    }
  } else {
    function matches(item) {return item.name?.toLowerCase().includes(search) || (item.request && displayUrl(item.request.url).toLowerCase().includes(search)) || item.item?.some(matches);}
    function paintItem(collection, item, level, force = false) {
      if (search && !force && !matches(item)) return;
      const isFolder = Array.isArray(item.item), expanded = search || !(workspace.collapsed || []).includes(item._mpId);
      const row = element('div', `tree-row${active().itemId === item._mpId ? ' selected' : ''}`); row.style.paddingLeft = `${level * 13 + 4}px`;
      const open = button('', () => {selectedCollectionId = collection._mpId; if (isFolder) {toggleCollapse(item._mpId); renderSidebar();} else openRequest(collection, item);}, 'tree-open');
      if (isFolder) open.append(element('span', 'tree-arrow', expanded ? '▾' : '▸'), element('span', 'tree-folder', '▱'));
      else open.append(element('span', `method-label method-${item.request.method}`, item.request.method));
      if (isFolder) open.setAttribute('aria-expanded', String(Boolean(expanded)));
      open.append(element('span', 'tree-label', item.name)); open.title = item.request ? displayUrl(item.request.url) : item.name; row.append(open);
      const more = button('⋯', () => {}, 'icon-button'); bindContext(row, more, (anchor, event) => isFolder ? collectionMenu(collection, item, anchor, event) : editRequestItem(collection, item, anchor, event)); more.title = `${item.name}の操作`; more.setAttribute('aria-label', `${item.name}の操作`); row.append(more); root.append(row);
      if (isFolder && expanded) item.item.forEach(child => paintItem(collection, child, level + 1, force || item.name.toLowerCase().includes(search)));
    }
    const drafts = workspace.tabs.filter(t => !workspace.collections.some(c => c._mpId === t.collectionId && findItem(c, t.itemId)?.item.request));
    if (drafts.length) {
      root.append(element('div', 'section-caption', '下書き'));
      for (const draft of drafts.filter(t => !search || `${t.name} ${displayUrl(t.request.url)}`.toLowerCase().includes(search))) {
        const row = element('div', `tree-row${active().id === draft.id ? ' selected' : ''}`); row.dataset.draftId = draft.id;
        const open = button('', () => selectRequest(draft.id), 'tree-open');
        open.append(element('span', `method-label method-${draft.request.method}`, draft.request.method), element('span', 'tree-label', draft.name)); open.title = draft.name;
        const more = button('⋯', () => {}, 'icon-button'); more.setAttribute('aria-label', `${draft.name}の下書き操作`);
        bindContext(row, more, (anchor, event) => openItemMenu(anchor, [
          {label: '変更履歴', run: () => showRevisions(requestKey(workspace, draft))},
          {label: '複製', run: () => addTab({...clone(draft), id: uid(), name: copyName(draft.name, workspace.tabs.map(t => t.name)), dirty: true})},
          {label: '設定をコピー', run: () => copyConfiguration(draft, 'request')},
          {label: '設定を貼り付け', disabled: settingsClipboard?.kind !== 'request', run: () => {applySettings(draft, 'request', settingsClipboard); draft.settings = requestSettings(draft.settings); draft.dirty = true; selectedFiles.delete(draft.id); persist(); renderAll();}},
          {label: '下書きを削除', danger: true, run: () => discardDraft(draft.id)}
        ], event)); row.append(open, more); root.append(row);
      }
      root.append(element('div', 'section-caption', 'Collections'));
    }
    for (const c of workspace.collections) {
      const match = c.info.name.toLowerCase().includes(search);
      if (search && !match && !c.item.some(matches)) continue;
      const row = element('div', 'tree-row'); row.style.marginTop = '4px';
      const expanded = search || !(workspace.collapsed || []).includes(c._mpId);
      const open = button('', () => {selectedCollectionId = c._mpId; toggleCollapse(c._mpId); renderSidebar();}, 'tree-open');
      open.append(element('span', 'tree-arrow', expanded ? '▾' : '▸'), element('span', 'tree-folder', '▤'), element('strong', 'tree-label', c.info.name)); open.setAttribute('aria-expanded', String(Boolean(expanded)));
      const more = button('⋯', () => {}, 'icon-button'); bindContext(row, more, (anchor, event) => collectionMenu(c, null, anchor, event)); more.title = `${c.info.name}の設定`; more.setAttribute('aria-label', `${c.info.name}の設定`); row.append(open, more); root.append(row);
      if (expanded) c.item.forEach(item => paintItem(c, item, 1, match));
    }
  }
  if (!root.children.length) root.append(element('div', 'sidebar-empty', search ? '一致する項目なし' : side === 'history' ? '送信履歴なし' : side === 'collections' ? 'コレクションなし' : '環境なし'));
}
function renderSidebar() {
  const root = $('sidebarContent');
  const previous = side;
  const previousOpen = Object.fromEntries([...root.querySelectorAll('details.sidebar-group')].map(el => [el.dataset.group, el.open]));
  const groups = [];
  for (const [mode, label, count] of [
    ['collections', 'COLLECTIONS', workspace.collections.length],
    ['environments', 'ENVIRONMENTS', workspace.environments.length],
    ['history', 'SEND HISTORY', workspace.history.length]
  ]) {
    side = mode; renderSidebarSection();
    const group = element('details', 'sidebar-group');
    group.dataset.group = mode;
    group.open = Object.hasOwn(previousOpen, mode) ? previousOpen[mode] : mode !== 'history';
    const summary = element('summary');
    summary.append(element('span', '', label), element('span', 'count', String(count)));
    const contents = element('div', 'sidebar-group-content');
    contents.append(...root.childNodes);
    group.append(summary, contents); groups.push(group);
  }
  side = previous;
  root.replaceChildren(...groups);
  document.querySelector('.sidebar').setAttribute('aria-label', '保存済みデータ');
  $('search').placeholder = 'すべて検索';
  $('sidebarAdd').hidden = false;
  $('sidebarAdd').setAttribute('aria-label', 'コレクションを作成');
  $('clearHistory').hidden = workspace.history.length === 0;
}
function toggleCollapse(id) {workspace.collapsed ||= []; const at = workspace.collapsed.indexOf(id); if (at < 0) workspace.collapsed.push(id); else workspace.collapsed.splice(at, 1); persist();}
function renderAll() {renderSelection(); renderEnvironments(); renderSidebar(); renderEditor(); renderResponse();}

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
  const tab = active(); persist(true); const priorKey = requestKey(workspace, tab);
  const current = workspace.collections.find(c => c._mpId === tab.collectionId), located = findItem(current, tab.itemId);
  if (located) {located.item.name = tab.name; located.item.request = clone(tab.request); located.item.settings = requestSettings(tab.settings); tab.dirty = false; persist(); renderAll(); toast('コレクションに保存しました。'); return;}
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
    const parent = findItem(collection, folderId)?.item || collection;
    const item = {_mpId: uid(), name: name.trim(), request: clone(tab.request), settings: requestSettings(tab.settings)};
    parent.item.push(item); Object.assign(tab, {name: item.name, collectionId: collection._mpId, itemId: item._mpId, dirty: false}); delete tab.pendingFolderId;
    revisionStore.transfer(priorKey, requestKey(workspace, tab));
    side = 'collections'; closeModal(); persist(); renderAll(); toast('コレクションに保存しました。');
  });
}
function collectionMenu(collection, folder, anchor, event) {
  selectedCollectionId = collection._mpId;
  const owner = folder || collection, name = folder?.name || collection.info.name;
  const actions = [
    {label: 'リクエストを追加', run: () => addTab({...freshTab(), collectionId: collection._mpId, pendingFolderId: folder?._mpId, dirty: true})},
    {label: 'フォルダーを追加', run: () => {
      let value = 'New folder'; const box = field('Folder name', input(value, 'Folder name', text => value = text));
      showModal('New folder', box, () => {if (!value.trim()) throw new Error('名前を入力してください。'); owner.item.push({_mpId: uid(), name: value.trim(), item: []}); closeModal(); persist(); renderAll();}, '作成');
    }},
    {label: '変数・認証を編集', run: () => editCollection(collection, folder)},
    {label: '複製', run: () => {
      if (folder) {
        const parent = findItem(collection, folder._mpId)?.parents.at(-1) || collection;
        const copy = duplicateItem(folder); copy.name = copyName(folder.name, parent.item.map(i => i.name)); parent.item.push(copy);
      } else workspace.collections.push(duplicateCollection(collection, workspace.collections.map(c => c.info.name)));
      persist(); renderSidebar(); toast('複製しました。');
    }},
    {label: '変更履歴', run: () => showRevisions(folder ? `folder:${collection._mpId}:${folder._mpId}` : `collection:${collection._mpId}`)},
    ...configurationActions(owner, 'scope')
  ];
  if (!folder) actions.push({label: 'エクスポート', run: () => exportFile(`${name}.postman_collection.json`, exportCollection(collection))});
  actions.push(null, {label: '削除', danger: true, run: () => {
    if (!confirm(`「${name}」と配下の保存済みリクエストを削除しますか？編集中の内容は下書きとして残ります。`)) return;
    if (folder) {const parent = findItem(collection, folder._mpId)?.parents.at(-1) || collection; parent.item = parent.item.filter(item => item._mpId !== folder._mpId);}
    else workspace.collections = workspace.collections.filter(c => c !== collection);
    persist(); renderAll(); refreshSettingsDrawer();
  }}); openItemMenu(anchor, actions, event);
}
function editCollection(collection, folder = null) {
  const owner = folder || collection; owner.variable = rows(owner.variable);
  const box = element('div');
  const name = input(folder ? owner.name : owner.info.name, 'Name', value => {if (folder) owner.name = value; else owner.info.name = value; settingsChanged(true);});
  box.append(field('Name', name));
  const tools = element('div', 'settings-tools'), more = button('⋯', event => collectionMenu(collection, folder, event.currentTarget), 'icon-button');
  more.setAttribute('aria-label', 'この設定の操作'); tools.append(more); box.append(tools);
  caption('Variables', box); box.append(kvEditor(owner.variable, settingsChanged)); caption('Authorization', box); box.append(authEditor(owner, false, settingsChanged));
  box.append(element('p', 'input-condition', '認証値はこのブラウザに平文で保存されます。'));
  showSettings(folder ? 'Folder settings' : 'Collection settings', box, {kind: folder ? 'folder' : 'collection', id: owner._mpId, collectionId: collection._mpId});
}
function editRequestItem(collection, item, anchor, event) {
  openItemMenu(anchor, [
    {label: '変更履歴', run: () => showRevisions(`request:${collection._mpId}:${item._mpId}`)},
    {label: '名前を変更', run: () => {
      let value = item.name; const box = field('Name', input(value, 'Name', text => value = text));
      showModal('リクエスト名', box, () => {
        if (!value.trim()) throw new Error('名前を入力してください。'); item.name = value.trim();
        for (const tab of workspace.tabs) if (tab.itemId === item._mpId && tab.collectionId === collection._mpId && !tab.dirty) tab.name = item.name;
        closeModal(); persist(); renderAll();
      });
    }},
    {label: '複製', run: () => {const parent = findItem(collection, item._mpId)?.parents.at(-1) || collection; const copy = duplicateItem(item); copy.name = copyName(item.name, parent.item.map(i => i.name)); parent.item.push(copy); openRequest(collection, copy); persist();}},
    {label: '設定をコピー', run: () => copyConfiguration({request: item.request, settings: item.settings}, 'request')},
    {label: '設定を貼り付け', disabled: settingsClipboard?.kind !== 'request', run: () => {openRequest(collection, item); const tab = active(); applySettings(tab, 'request', settingsClipboard); tab.settings = requestSettings(tab.settings); selectedFiles.delete(tab.id); touch(); renderEditor();}},
    {label: 'URLをコピー', run: () => copyText(displayUrl(item.request.url))},
    {label: '削除', danger: true, run: () => {if (!confirm(`「${item.name}」を削除しますか？`)) return; const parent = findItem(collection, item._mpId)?.parents.at(-1) || collection; parent.item = parent.item.filter(i => i._mpId !== item._mpId); persist(); renderAll();}}
  ], event);
}
function environmentMenu(env, globals, anchor, event) {
  const owner = globals ? {get values() {return workspace.globals;}, set values(value) {workspace.globals = value;}} : env;
  const actions = [{label: '変数を編集', run: () => globals ? editEnvironment(null, true) : chooseEnvironment(env.id, true)}];
  if (!globals) actions.push({label: '複製', run: () => {const copy = duplicateEnvironment(env, workspace.environments.map(e => e.name)); workspace.environments.push(copy); chooseEnvironment(copy.id, true); toast('環境を複製しました。');}});
  actions.push({label: '変更履歴', run: () => showRevisions(globals ? 'globals' : `environment:${env.id}`)}, ...configurationActions(owner, 'environment'), {label: 'エクスポート', run: () => exportEnvironment(env, globals)});
  if (!globals) actions.push(null, {label: '削除', danger: true, run: () => {
    if (!confirm(`環境「${env.name}」を削除しますか？`)) return;
    workspace.environments = workspace.environments.filter(e => e.id !== env.id); chooseEnvironment(workspace.environmentId === env.id ? '' : workspace.environmentId);
  }}); openItemMenu(anchor, actions, event);
}
function exportEnvironment(env, globals = false) {
  const name = globals ? 'Globals' : env.name || 'Environment', values = globals ? workspace.globals : env.values;
  exportFile(`${name}.postman_${globals ? 'globals' : 'environment'}.json`, {...(globals ? {} : {id: env.id}), name, values: values.map(v => ({...v, enabled: enabled(v)})), _postman_variable_scope: globals ? 'globals' : 'environment'});
}
function editEnvironment(env, globals = false) {
  if (!globals && !env) {
    const names = workspace.environments.map(e => e.name);
    env = {id: uid(), name: names.includes('New environment') ? copyName('New environment', names) : 'New environment', values: []};
    workspace.environments.push(env); workspace.environmentId = env.id; persist();
  }
  if (!globals) workspace.environmentId = env.id;
  if (globals) workspace.globals = rows(workspace.globals); else env.values = rows(env.values);
  const box = element('div');
  if (!globals) box.append(field('Environment name', input(env.name, 'Environment name', value => {env.name = value; settingsChanged(true);} )));
  const tools = element('div', 'settings-tools'); tools.append(button('Export', () => exportEnvironment(env, globals)));
  const more = button('⋯', event => environmentMenu(env, globals, event.currentTarget), 'icon-button'); more.setAttribute('aria-label', 'この設定の操作'); tools.append(more);
  box.append(tools, kvEditor(globals ? workspace.globals : env.values, settingsChanged, {secret: true}), element('p', 'input-condition', '認証値はブラウザとエクスポートに平文で保存されます。'));
  renderEnvironments(); renderSidebar();
  showSettings(globals ? 'Global variables' : 'Environment variables', box, {kind: globals ? 'globals' : 'environment', id: globals ? '' : env.id});
}
function importDialog(initialFiles = []) {
  let files = [...initialFiles]; const box = element('div'), drop = element('div', 'import-drop'), fileList = element('div', 'file-list');
  drop.append(element('strong', '', 'Postman JSONをドロップ'));
  const picker = element('input'); picker.type = 'file'; picker.accept = '.json,application/json'; picker.multiple = true; picker.hidden = true;
  const folderPicker = element('input'); folderPicker.type = 'file'; folderPicker.multiple = true; folderPicker.setAttribute('webkitdirectory', ''); folderPicker.hidden = true;
  const refreshFiles = () => fileList.textContent = files.map(f => f.webkitRelativePath || f.name).join('\n');
  picker.onchange = () => {files = [...picker.files]; refreshFiles();}; folderPicker.onchange = () => {files = [...folderPicker.files].filter(f => f.name.toLowerCase().endsWith('.json')); refreshFiles();};
  drop.append(button('ファイルを選択', () => picker.click()), button('フォルダーを選択', () => folderPicker.click()), picker, folderPicker, fileList);
  drop.ondragover = event => {event.preventDefault(); drop.classList.add('dragover');}; drop.ondragleave = () => drop.classList.remove('dragover');
  drop.ondrop = event => {event.preventDefault(); drop.classList.remove('dragover'); files = [...event.dataTransfer.files]; refreshFiles();};
  const paste = element('textarea', 'import-paste'); paste.placeholder = 'または、PostmanのJSONを貼り付け'; paste.setAttribute('aria-label', 'Postman JSON'); paste.spellcheck = false;
  box.append(drop, field('Raw JSON', paste)); refreshFiles();
  showModal('Import Postman', box, async () => {
    const inputs = await Promise.all(files.map(async file => ({name: file.name, content: await file.text()})));
    if (paste.value.trim()) inputs.push({name: 'Pasted JSON', content: paste.value});
    if (!inputs.length) throw new Error('JSONファイルを選択するか、JSONを貼り付けてください。');
    const parsed = inputs.map(i => {try {return importPostman(i.content, i.name);} catch (error) {throw new Error(`${i.name}: ${error.message}`);}}); applyImports(parsed);
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
  if (!result) return ''; if (result.error) return result.error;
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
        appendText(el, line.slice(pos, match.index)); const value = match[0];
        const cls = value.startsWith('"') ? /:\s*$/.test(value) ? 'token-key' : 'token-string' : ['true', 'false'].includes(value) ? 'token-boolean' : value === 'null' ? 'token-null' : 'token-number';
        const token = element('span', cls); appendText(token, value); el.append(token); pos = match.index + value.length;
      }
      appendText(el, line.slice(pos));
    }
    pre.append(el);
  }
  return pre;
}
function emptyResponse(title, message) {const box = element('div', 'response-empty'); box.append(element('strong', '', title)); if (message) box.append(element('p', '', message)); return box;}
function renderResponse() {
  const root = $('responseContent'); root.replaceChildren(); const result = responses.get(active().id);
  $('responseMode').value = responseView;
  $('responseStatus').className = 'response-status'; $('responseTime').textContent = ''; $('responseSize').textContent = '';
  if (requests.has(active().id)) {$('responseStatus').textContent = 'Sending…'; root.append(emptyResponse('送信中…')); return;}
  if (!result) {$('responseStatus').textContent = '未送信'; return;}
  if (result.error) {$('responseStatus').textContent = result.cancelled ? 'CANCELLED' : result.errorTitle || 'ERROR'; $('responseStatus').classList.add('error'); root.append(codeView(result.error)); return;}
  $('responseStatus').textContent = `${result.status} ${result.status_text || ''}`;
  $('responseStatus').classList.add(result.status < 400 ? 'good' : 'error'); $('responseTime').textContent = `${result.elapsed_ms} ms`; $('responseSize').textContent = bytes(result.size);
  const search = $('responseSearch').value;
  if (responseView === 'headers' || responseView === 'cookies') {
    let entries = result.headers || []; if (responseView === 'cookies') entries = entries.filter(h => h.key.toLowerCase() === 'set-cookie');
    entries = entries.filter(h => `${h.key} ${h.value}`.toLowerCase().includes(search.toLowerCase()));
    if (!entries.length) {root.append(emptyResponse(responseView === 'cookies' ? 'Set-Cookieはありません' : '該当するヘッダーはありません', '')); return;}
    const table = element('table', 'kv-table kv-readonly'), head = element('tr'); head.append(element('th', '', 'KEY'), element('th', '', 'VALUE')); table.append(head);
    for (const h of entries) {const tr = element('tr'); tr.append(element('td', '', h.key), element('td', '', h.value)); table.append(tr);} root.append(table);
  } else if (responseView === 'preview') {
    if (result.body_encoding === 'base64') {root.append(emptyResponse('バイナリレスポンス', result.content_type)); return;}
    if (/text\/html|image\/svg\+xml/i.test(result.content_type)) {
      const frame = element('iframe', 'preview-frame'); frame.setAttribute('sandbox', ''); frame.referrerPolicy = 'no-referrer'; frame.title = 'Response preview';
      frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'">` + result.body; root.append(frame);
    } else root.append(codeView(responseText(result, 'pretty'), /json/i.test(result.content_type), search));
  } else root.append(codeView(responseText(result), responseView === 'pretty' && /json/i.test(result.content_type), search));
}
async function sendRequest() {
  const tab = active(); if (requests.has(tab.id)) {requests.get(tab.id).abort(); return;}
  let compiled;
  try {compiled = compileRequest(workspace, tab, selectedFiles.get(tab.id) || {});}
  catch (error) {responses.set(tab.id, {error: error.message}); renderResponse(); return;}
  const snapshot = clone(tab), environmentId = workspace.environmentId, controller = new AbortController(); requests.set(tab.id, controller);
  responses.delete(tab.id); renderRequestFooter(); renderResponse();
  try {
    const result = await sendThroughProxy(compiled.payload, controller.signal);
    if (workspace.tabs.some(t => t.id === tab.id)) responses.set(tab.id, result);
    workspace.history.push({id: uid(), at: new Date().toISOString(), tab: snapshot, environmentId, status: result.status, elapsed_ms: result.elapsed_ms}); persist();
    if (active().id === tab.id) $('requestInfo').textContent = `${tab.request.method} · ${new Date().toLocaleTimeString()}${result.redirects?.length ? ` · ${result.redirects.length} redirects` : ''}`;
  } catch (error) {
    const cancelled = error.name === 'AbortError';
    if (workspace.tabs.some(t => t.id === tab.id)) responses.set(tab.id, {error: cancelled ? '受信を中止しました。送信先ですでに開始した処理は取り消せません。' : error.message, cancelled, errorTitle: error.title});
    if (!cancelled) {workspace.history.push({id: uid(), at: new Date().toISOString(), tab: snapshot, environmentId, status: 'ERR'}); persist();}
  } finally {requests.delete(tab.id); if (active().id === tab.id) {renderRequestFooter(); renderResponse();} if (side === 'history') renderSidebar();}
}
function showRevisions(key) {
  persist(true);
  const row = settingsIndex(workspace).get(key);
  if (!row) return toast('対象の設定がありません。');
  const box = element('div', 'revision-panel'); box.dataset.revisionKey = key;
  const heading = element('div', 'revision-toolbar');
  heading.append(element('strong', '', row.name || '名前なし'), button('履歴をエクスポート', () => exportFile(`${row.name || 'settings'}.revisions.json`, {key, revisions: workspace.revisions[key] || []})));
  box.append(heading, element('p', 'input-condition', 'この設定だけの変更履歴です。認証情報を含む場合があります。復元してもリクエストは送信しません。'));
  const entries = workspace.revisions[key] || [];
  if (!entries.length) box.append(element('p', 'empty-state', '変更履歴はまだありません。'));
  for (const entry of [...entries].reverse()) {
    const details = element('details', 'revision-entry'), summary = element('summary', '', `${new Date(entry.at).toLocaleString()} · ${entry.reason} · ${entry.changed.join(', ')}`);
    details.append(summary, element('pre', 'revision-value', JSON.stringify(entry.value, null, 2)), button('この版を復元', () => {
      if (!confirm('この設定を選んだ版に戻しますか？現在の値は履歴に残ります。')) return;
      revisionStore.restore(key, entry); selectedFiles.delete(active().id); persist(true); renderAll(); showRevisions(key); toast('復元しました。送信はしていません。');
    })); box.append(details);
  }
  showModal('変更履歴', box, null, '', 'drawer'); $('cancelModal').textContent = '閉じる';
}
$('requestHistory').onclick = () => showRevisions(requestKey(workspace, active()));
$('send').onclick = sendRequest;
$('addTab').onclick = () => {workbench.closeNavigation(); addTab(); $('url').focus();};
$('duplicateRequest').onclick = () => addTab({...clone(active()), id: uid(), itemId: undefined, name: `${active().name} copy`, dirty: true});
$('saveRequest').onclick = saveRequest;
$('requestName').oninput = () => {active().name = $('requestName').value; touch();};
$('method').onchange = () => {active().request.method = $('method').value; $('method').className = `method-${$('method').value}`; touch();};
$('url').oninput = () => {setUrlText(active().request, $('url').value); touch(); renderPane();};
$('environment').onchange = () => chooseEnvironment($('environment').value);
$('search').oninput = renderSidebar;
$('import').onclick = () => importDialog();
$('importFiles').onchange = () => importDialog([...$('importFiles').files]);
$('sidebarAdd').onclick = () => side === 'environments' ? editEnvironment() : newCollection();
$('clearHistory').onclick = () => {if (confirm('送信履歴をすべて削除しますか？')) {workspace.history = []; persist(); renderSidebar();}};
$('gatewayExample').onclick = async () => {
  try {const r = await fetch('/api/examples/gateway'); if (!r.ok) throw new Error(`HTTP ${r.status}`); applyImports([importPostman(await r.json())]);} catch (error) {toast(error.message);}
};
$('responseMode').onchange = () => {responseView = $('responseMode').value; renderResponse();};
$('responseSearch').oninput = () => {clearTimeout(responseSearchTimer); responseSearchTimer = setTimeout(renderResponse, 180);};
$('copyResponse').onclick = async () => {const value = responseText(responses.get(active().id)); if (!value) return toast('コピーするレスポンスがありません。'); await copyText(value);};
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
  if (settingsDrawer && $('modal').open && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {event.preventDefault(); persist(true); return;}
  if ($('modal').open && ($('modal').matches(':modal') || $('modal').contains(document.activeElement))) return;
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {event.preventDefault(); sendRequest();}
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {event.preventDefault(); saveRequest();}
  if (event.key === 'Escape' && requests.has(active().id)) requests.get(active().id).abort();
});
workbench = initWorkbench(); bindItemMenu(); bindSurface();
// Accordion sections replace the tab-based editor and response strip.
setTheme(); renderAll(); if (recoveryMessage) toast(recoveryMessage);
fetch('/api/health').then(r => {if (!r.ok) throw new Error(); $('connectionStatus').replaceChildren(element('span', 'status-dot'), document.createTextNode('Python proxy · connected'));}).catch(() => {$('connectionStatus').textContent = 'Python proxy · 接続できません';});
