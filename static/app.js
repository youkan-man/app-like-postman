import {SCHEMA, clone, uid, rows, enabled, urlParts, displayUrl, setUrlText, setQuery, newRequest, normalizeRequest, walkItems, findItem, importPostman, exportCollection, contextFor, compileRequest} from './core.mjs';
import {initWorkbench, bindTabStrip, bindItemMenu, openItemMenu, closeItemMenu, openSurface, bindSurface} from './workbench.mjs';
import {exportWorkspace, isWorkspaceBundle, readWorkspaceBundle, mergeWorkspace} from './workspace-data.mjs';
import {sendThroughProxy} from './transport.mjs';
import {RevisionStore, requestKey, requestSettings, settingsIndex} from './revisions.mjs';
import {copyName, duplicateItem, duplicateCollection, duplicateEnvironment, snapshotSettings, applySettings} from './editops.mjs';
import {createCodeEditor} from './code-editor.mjs';
import {initStudio} from './studio.mjs';
import {WorkspaceStorage} from './storage.mjs';

const $ = id => document.getElementById(id);
let workbench, studio;
const storage = new WorkspaceStorage();
const freshTab = () => ({id: uid(), name: 'Untitled request', request: newRequest(), settings: {verify_tls: false, follow_redirects: true, timeout_ms: 30000}, dirty: false});
const initial = () => {const tab = freshTab(); return {version: 2, collections: [], environments: [], globals: [], tabs: [tab], activeId: tab.id, environmentId: '', history: [], collapsed: [], theme: 'light'};};
let workspace;
let recoveryMessage = '';
$('saveState').textContent = 'ローカルデータを読込中…';
try {
  workspace = await storage.load(saved => {
    readWorkspaceBundle({kind: 'minipost.workspace', version: 1, workspace: saved});
  }) || initial();
  if (!workspace.tabs.length) workspace.tabs.push(freshTab());
  if (!workspace.tabs.some(t => t.id === workspace.activeId)) workspace.activeId = workspace.tabs[0].id;
} catch (error) {
  workspace = initial(); recoveryMessage = `保存データを読み込めませんでした。元データは上書きせず保持しています。${error.message}`;
}
for (const draft of workspace.tabs) draft.settings = requestSettings(draft.settings);
workspace.relations ||= []; workspace.relationRuns ||= [];
let revisionStore = new RevisionStore(workspace);
const responses = new Map(), requests = new Map(), selectedFiles = new Map();
const navigationKey = 'minipost.navigation.v1';
const editorPageKey = 'minipost.editor.page.v1';
function normalizeNavigation(value) {
  const allowed = {
    editor: ['all','params','headers','authorization','body','settings','scripts'],
    sidebar: ['collections','environments','history','relations'],
    response: ['pretty','raw','headers','cookies','preview']
  };
  return Object.fromEntries(Object.entries(allowed).map(([key, values]) => [key, values.includes(value?.[key]) ? value[key] : values[0]]));
}
let navigation = normalizeNavigation(null);
try {navigation = normalizeNavigation(JSON.parse(storage.getItem(navigationKey)) ?? {editor:storage.getItem(editorPageKey)});} catch {}
let pane = 'params', side = navigation.sidebar, responseView = navigation.response, selectedCollectionId = '', modalAction = null;
const sidebarSearch = {collections:'', environments:'', history:'', relations:''};
const sidebarScroll = {collections:0, environments:0, history:0, relations:0};
function saveNavigation() {
  try {storage.setItem(navigationKey, JSON.stringify({editor:editorPage, sidebar:side, response:responseView}));}
  catch {toast('表示状態を保存できません。入力内容は維持しています。');}
}
function selectPageTab(id, attribute, value, panelId) {
  for (const tab of $(id).querySelectorAll('button[role=tab]')) {
    const selected = tab.getAttribute(attribute) === value;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected) {$(panelId).setAttribute('aria-labelledby', tab.id);}
  }
  $(panelId).setAttribute('role', 'tabpanel');
}
let saveTimer, toastTimer, responseSearchTimer;
let localChangeGeneration = 0, saveSequence = 0, importInProgress = false;
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
  if (importInProgress) return Promise.resolve(false);
  localChangeGeneration += 1;
  const sequence = ++saveSequence;
  const sync = $('serverSaveState');
  if (sync?.classList.contains('saved')) {
    sync.classList.remove('saved');
    sync.textContent = 'サーバーには未反映';
  }
  clearTimeout(saveTimer); setSaveStatus('保存中…');
  const save = () => {
    let operation;
    try {revisionStore.capture(); operation = storage.save(workspace);}
    catch (error) {operation = Promise.reject(error);}
    return operation.then(() => {
      if (sequence === saveSequence && !importInProgress) setSaveStatus('ローカルに保存済み');
      return true;
    }, error => {
      if (sequence === saveSequence && !importInProgress) {
        setSaveStatus('保存できません。エクスポートしてください。', true);
        toast('ブラウザに保存できません。編集中の値は維持しています。全体エクスポートまたはサーバーへ保存してください。 ' + error.message);
      }
      return false;
    });
  };
  if (now) return save();
  saveTimer = setTimeout(save, 220);
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
document.addEventListener('visibilitychange', () => {if (document.visibilityState === 'hidden') persist(true);});

function chooseEnvironment(id, open = false) {
  persist(true);
  const environment = workspace.environments.find(e => e.id === id);
  workspace.environmentId = environment?.id || '';
  persist(); renderEnvironments(); renderSidebar(); updateCounts();
  studio?.environmentChosen(workspace.environmentId);
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
function emptyEnvironmentDrawer() {studio.environmentChosen(''); chooseSidebar('environments');}
function copyConfiguration(owner, kind) {settingsClipboard = snapshotSettings(owner, kind); toast('設定をコピーしました。貼り付け先のメニューから貼り付けできます。');}
function pasteConfiguration(owner, kind) {applySettings(owner, kind, settingsClipboard); settingsChanged(true); refreshSettingsDrawer(); if(kind==='environment')studio?.refresh(); toast('設定を貼り付けました。名前は変更していません。');}
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
  const columns = [['', 'check'], ['キー', ''], ...(options.files ? [['種類', 'type']] : []), ['値', ''], ['説明', ''], ['', 'action row-actions']];
  for (const [name, cls] of columns) head.append(element('th', cls, name));
  const thead = element('thead'); thead.append(head); table.append(thead);
  const tbody = element('tbody'); table.append(tbody);
  function paint() {
    tbody.replaceChildren();
    list.forEach((row, index) => {
      const tr = element('tr', enabled(row) ? 'kv-data-row' : 'kv-data-row disabled');
      if (options.files) tr.classList.add('kv-data-row--file');
      const checkCell = element('td', 'check kv-enabled'), check = element('input');
      check.type = 'checkbox'; check.checked = enabled(row); check.setAttribute('aria-label', `行 ${index + 1} を有効にする`);
      check.onchange = () => {row.disabled = !check.checked; delete row.enabled; tr.classList.toggle('disabled', row.disabled); changed();};
      checkCell.append(check); tr.append(checkCell);
      const keyCell = element('td', 'kv-key'); keyCell.append(input(row.key, `Key ${index + 1}`, value => {row.key = value; changed();})); tr.append(keyCell);
      if (options.files) {
        const typeCell = element('td', 'kv-type'); typeCell.append(select([['text', 'Text'], ['file', 'File']], row.type || 'text', value => {row.type = value; changed(); paint(); tbody.children[index]?.querySelector('select')?.focus({preventScroll:true});})); tr.append(typeCell);
      }
      const valueCell = element('td', 'kv-value');
      if (options.files && row.type === 'file') {
        const chosen = selectedFiles.get(active().id)?.[`form-${index}`];
        const names = chosen?.map(f => f.name).join(', ') || (Array.isArray(row.src) ? row.src.join(', ') : row.src);
        valueCell.append(button(chosen ? names : names ? `${names} — 再選択` : 'ファイルを選択', () => chooseFiles(`form-${index}`, true, names => {row.src = names; changed(); paint();}), 'file-pick'));
      } else valueCell.append(input(row.value, `Value ${index + 1}`, value => {row.value = value; changed();}, options.secret && row.type === 'secret' ? 'password' : 'text'));
      tr.append(valueCell);
      const descriptionCell = element('td', 'kv-description'); descriptionCell.append(input(describe(row.description), `Description ${index + 1}`, value => {row.description = value; changed();})); tr.append(descriptionCell);
      const actionCell = element('td', 'row-actions kv-actions');
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
        // The menu trigger was replaced along with the row. Place keyboard focus
        // on the inserted/remainder row rather than dropping it onto <body>.
        const focusAt = Math.min(at, list.length - 1);
        if (focusAt >= 0) tbody.children[focusAt]?.querySelector('input[aria-label^="Key "]')?.focus({preventScroll:true});
        else wrap.querySelector('.table-add')?.focus({preventScroll:true});
      }
      const more = button('⋯', () => {}, 'icon-button row-menu'); more.setAttribute('aria-label', `行 ${index + 1} の操作`);
      bindContext(tr, more, (anchor, event) => openItemMenu(anchor, [
        {label: 'この上に行を追加', run: () => editRows(index, 0, [{key:'', value:'', disabled:false}])},
        {label: 'この下に行を追加', run: () => editRows(index + 1, 0, [{key:'', value:'', disabled:false}])},
        {label: '値をコピー', run: () => copyText(row.value)},
        {label: '行をコピー', run: () => {rowClipboard = clone(row); toast('行をコピーしました。');}},
        {label: '行を複製', run: () => editRows(index + 1, 0, [clone(row)])},
        {label: 'コピーした行を下に貼り付け', disabled: !rowClipboard, run: () => editRows(index + 1, 0, [clone(rowClipboard)])},
        {label: enabled(row) ? '無効にする' : '有効にする', run: () => {row.disabled = enabled(row); delete row.enabled; changed(); paint(); tbody.children[index]?.querySelector('.kv-enabled input')?.focus({preventScroll:true});}},
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
  $('bodyDot').textContent = r.body?.mode && r.body.mode !== 'none' ? '●' : ''; $('scriptDot').textContent = (contextFor(workspace, active()).events.length || r._minipost?.before || r._minipost?.after || r._minipost?.extractions?.length) ? '●' : '';
}
function authEditor(owner, inherited = false, changed = () => {}) {
  const box = element('div');
  function paint() {
    box.replaceChildren(); const grid = element('div', 'field-stack');
    const options = [['inherit', 'Inherit auth from parent'], ['noauth', 'No Auth'], ['bearer', 'Bearer Token'], ['basic', 'Basic Auth'], ['apikey', 'API Key'], ['oauth2', 'OAuth 2.0 · access token']];
    const type = owner.auth?.type || 'inherit';
    if (!options.some(([value]) => value === type)) options.push([type, `${type}（送信未対応）`]);
    const typeSelect = select(options, type, value => {owner.auth = value === 'inherit' ? null : {type: value, [value]: []}; changed(); paint(); box.querySelector('select[aria-label="認証方式"]')?.focus({preventScroll:true});}); typeSelect.setAttribute('aria-label', '認証方式');
    grid.append(element('label', '', '認証方式'), typeSelect);
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
  $('requestWarning').hidden = !scriptWarning; $('requestWarning').textContent = 'インポート済みスクリプトは参照のみです。実行するコードはスクリプト編集欄へ明示的にコピーしてください。';
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
  } else if (pane === 'scripts') studio.renderScripts(root, tab);
}
const editorSections = [
  ['params','クエリとパス変数'],
  ['headers','HTTP ヘッダー'],
  ['authorization','認証'],
  ['body','リクエスト本文'],
  ['settings','通信設定'],
  ['scripts','スクリプト']
];
// Disclosure preferences are presentation state, not request changes or revisions.
const sectionKey = 'minipost.sections.v1';
let expandedSections = editorSections.map(([name]) => name);
try {
  const saved = JSON.parse(storage.getItem(sectionKey));
  if (Array.isArray(saved)) expandedSections = expandedSections.filter(name => saved.includes(name));
} catch {}
let editorPage = navigation.editor, pageExpanded = true;
function applyEditorPage() {
  for (const tab of $('editorTabs').querySelectorAll('[data-editor]')) {
    const selected = tab.dataset.editor === editorPage;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  $('editorContent').setAttribute('aria-labelledby', 'editor-tab-' + editorPage);
  document.documentElement.dataset.editorPage = editorPage;
  for (const section of $('editorContent').querySelectorAll('.editor-section')) {
    const single = editorPage !== 'all';
    section.hidden = single && section.dataset.pane !== editorPage;
    const expanded = single ? pageExpanded : expandedSections.includes(section.dataset.pane);
    section.querySelector('.editor-section-body').hidden = !expanded;
    section.querySelector('.editor-section-toggle').setAttribute('aria-expanded', String(expanded));
  }
}
function selectEditorPage(next) {
  if (next !== 'all' && !editorSections.some(([name]) => name === next)) return;
  editorPage = next; pageExpanded = true;
  try {storage.setItem(editorPageKey, editorPage);} catch {}
  applyEditorPage(); $('editorContent').scrollTop = 0; saveNavigation();
}
function setSectionExpanded(section, expanded) {
  const fields = section.querySelector('.editor-section-body');
  section.querySelector('.editor-section-toggle').setAttribute('aria-expanded', String(expanded));
  fields.hidden = !expanded;
  if (editorPage !== 'all') pageExpanded = expanded;
  const names = new Set(expandedSections);
  if (expanded) names.add(section.dataset.pane); else names.delete(section.dataset.pane);
  expandedSections = editorSections.map(([name]) => name).filter(name => names.has(name));
  try {storage.setItem(sectionKey, JSON.stringify(expandedSections));}
  catch {toast('開閉状態を保存できません。画面上の開閉と入力内容は維持しています。');}
}
function renderPane() {
  const root = $('editorContent'), scrollTop = root.scrollTop;
  const content = document.createDocumentFragment();
  for (const [name, title] of editorSections) {
    const section = element('section', 'editor-section'); section.dataset.pane = name;
    const heading = element('h2', 'editor-section-heading');
    heading.id = `request-section-${name}`;
    section.setAttribute('aria-labelledby', heading.id);
    const fields = element('div', 'editor-section-body'); fields.id = `request-fields-${name}`;
    const toggle = button(title, () => setSectionExpanded(section, fields.hidden), 'editor-section-toggle');
    toggle.setAttribute('aria-controls', fields.id);
    toggle.setAttribute('aria-expanded', String(expandedSections.includes(name)));
    fields.hidden = !expandedSections.includes(name);
    const indicator = {params:'paramsCount',headers:'headersCount',body:'bodyDot',scripts:'scriptDot'}[name];
    if (indicator) {const count = element('span', 'editor-section-count'); count.id = indicator; toggle.append(count);}
    heading.append(toggle);
    heading.onclick = event => {if (!toggle.contains(event.target)) toggle.click();};
    renderPaneSection(fields, name);
    section.append(heading, fields);
    content.append(section);
  }
  root.replaceChildren(content);
  applyEditorPage();
  root.scrollTop = scrollTop;
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
    radio.onchange = () => {body.mode = value; touch(); renderPane(); $('editorContent').querySelector(`input[name="bodyMode"][value="${value}"]`)?.focus({preventScroll:true});}; wrap.append(radio, label); toolbar.append(wrap);
  }
  root.append(toolbar);
  if (body.disabled) root.append(button('このBodyは無効です · 有効にする', () => {body.disabled = false; touch(); renderPane();}, 'text-button'));
  if (body.mode === 'raw') {
    body.options ||= {}; body.options.raw ||= {language: 'text'};
    const editor = createCodeEditor({value:body.raw || '', language:body.options.raw.language || 'text', label:'Raw body', onChange:value=>{body.raw=value;touch();}});
    const language = select([['text','Text'],['json','JSON'],['xml','XML'],['html','HTML'],['javascript','JavaScript']], body.options.raw.language || 'text', value=>{body.options.raw.language=value;editor.setLanguage(value);touch();});
    language.setAttribute('aria-label','本文のフォーマット');toolbar.append(language);
    toolbar.append(button('JSON整形',()=>{try{editor.setValue(JSON.stringify(JSON.parse(editor.textarea.value),null,2));}catch(error){toast(`JSON: ${error.message}`);}},'text-button'));
    root.append(editor.element);
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
      root.append(createCodeEditor({value:typeof body.graphql[key] === 'object' ? JSON.stringify(body.graphql[key],null,2) : body.graphql[key] || '',language:key === 'query' ? 'graphql' : 'json',label:`GraphQL ${key}`,onChange:value=>{body.graphql[key]=value;touch();}}).element);
    }
  }
}

// The legacy tabs array is a draft cache only; the DOM contains one editor.
function renderSelection() {
  const draft = active(), collection = workspace.collections.find(c => c._mpId === draft.collectionId);
  const inCollection = Boolean(findItem(collection, draft.itemId)?.item.request);
  $('requestDirty').textContent = draft.dirty ? '自動保存済み · 未登録' : '';
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
  studio?.captureContext({collectionId:collection._mpId,parentId:findItem(collection,item._mpId)?.parents.at(-1)?._mpId});
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
  if (studio?.renderSidebarSection(side)) return;
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
      row.append(element('span', `method-label method-${entry.tab.request.method}`, entry.tab.request.method), label, element('span', 'history-code', entry.status || 'ERR'));
      const menu = event => {event?.preventDefault(); openItemMenu(row, [
        {label:'編集用に開く',run:()=>row.click()},
        {label:'もう一度送信',run:()=>{row.click(); sendRequest();}}
      ],event);};
      row.oncontextmenu = menu;
      row.onkeydown = event => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) menu(event);
      };
      root.append(row);
    }
  } else {
    function matches(item) {return item.name?.toLowerCase().includes(search) || (item.request && displayUrl(item.request.url).toLowerCase().includes(search)) || item.item?.some(matches);}
    function paintItem(collection, item, level, force = false) {
      if (search && !force && !matches(item)) return;
      const isFolder = Array.isArray(item.item), expanded = search || !(workspace.collapsed || []).includes(item._mpId);
      const row = element('div', `tree-row${active().itemId === item._mpId ? ' selected' : ''}`); row.dataset.collectionId = collection._mpId; row.dataset.itemId = item._mpId; row.style.paddingLeft = `${level * 13 + 4}px`;
      const open = button('', () => {selectedCollectionId = collection._mpId; studio?.captureContext({collectionId:collection._mpId,parentId:isFolder?item._mpId:findItem(collection,item._mpId)?.parents.at(-1)?._mpId}); if (isFolder) {toggleCollapse(item._mpId); renderSidebar(); focusTreeItem(collection._mpId, item._mpId);} else openRequest(collection, item);}, 'tree-open');
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
          {label: '送信', run: () => {selectRequest(draft.id); sendRequest();}},
          ...(studio?.draftActions(draft) || []),
          {label: '変更履歴', run: () => showRevisions(requestKey(workspace, draft))},
          {label: '複製', run: () => addTab({...clone(draft), id: uid(), name: copyName(draft.name, workspace.tabs.map(t => t.name)), dirty: true})},
          {label: '設定をコピー', run: () => copyConfiguration(draft, 'request')},
          {label: '設定を貼り付け', disabled: settingsClipboard?.kind !== 'request', run: () => {applySettings(draft, 'request', settingsClipboard); draft.settings = requestSettings(draft.settings); draft.dirty = true; selectedFiles.delete(draft.id); persist(); renderAll();}},
          {label: '下書きを削除', danger: true, run: () => discardDraft(draft.id)}
        ], event)); row.append(open, more); root.append(row);
      }
    }
    for (const c of workspace.collections) {
      const match = c.info.name.toLowerCase().includes(search);
      if (search && !match && !c.item.some(matches)) continue;
      const row = element('div', 'tree-row'); row.dataset.collectionId = c._mpId; row.style.marginTop = '4px';
      const expanded = search || !(workspace.collapsed || []).includes(c._mpId);
      const open = button('', () => {selectedCollectionId = c._mpId; studio?.captureContext({collectionId:c._mpId}); toggleCollapse(c._mpId); renderSidebar(); focusTreeItem(c._mpId);}, 'tree-open');
      open.append(element('span', 'tree-arrow', expanded ? '▾' : '▸'), element('span', 'tree-folder', '▤'), element('strong', 'tree-label', c.info.name)); open.setAttribute('aria-expanded', String(Boolean(expanded)));
      const more = button('⋯', () => {}, 'icon-button'); bindContext(row, more, (anchor, event) => collectionMenu(c, null, anchor, event)); more.title = `${c.info.name}の設定`; more.setAttribute('aria-label', `${c.info.name}の設定`); row.append(open, more); root.append(row);
      if (expanded) c.item.forEach(item => paintItem(c, item, 1, match));
    }
  }
  if (!root.children.length) root.append(element('div', 'sidebar-empty', search ? '一致する項目なし' : side === 'history' ? '送信履歴なし' : side === 'collections' ? 'コレクションなし' : '環境なし'));
}
function renderSidebar() {
  const root = $('sidebarContent'), previous = root.dataset.side;
  if (previous && previous !== side) {
    sidebarSearch[previous] = $('search').value;
    sidebarScroll[previous] = root.scrollTop;
    $('search').value = sidebarSearch[side];
  }
  const scrollTop = previous === side ? root.scrollTop : sidebarScroll[side];
  renderSidebarSection();
  root.dataset.side = side;
  root.scrollTop = scrollTop;
  selectPageTab('sidebarTabs', 'data-sidebar', side, 'sidebarContent');
  studio?.syncView(side);
}
function chooseSidebar(name) {
  side = name;
  renderSidebar();
  studio?.syncView(side);
  saveNavigation();
}
function focusTreeItem(collectionId, itemId) {
  const line = [...$('sidebarContent').querySelectorAll('.tree-row')].find(row =>
    row.dataset.collectionId === collectionId && (itemId ? row.dataset.itemId === itemId : !row.dataset.itemId));
  line?.querySelector('.tree-open')?.focus({preventScroll:true});
}
function toggleCollapse(id) {workspace.collapsed ||= []; const at = workspace.collapsed.indexOf(id); if (at < 0) workspace.collapsed.push(id); else workspace.collapsed.splice(at, 1); persist();}
function renderAll() {renderSelection(); renderEnvironments(); renderSidebar(); renderEditor(); renderResponse();}

function newCollection() {
  let name = 'My Collection'; const box = field('Name', input(name, 'Collection name', value => name = value));
  showModal('New collection', box, () => {
    if (!name.trim()) throw new Error('名前を入力してください。');
    const c = {_mpId: uid(), info: {name: name.trim(), schema: SCHEMA}, item: [], variable: []}; workspace.collections.push(c); selectedCollectionId = c._mpId; side = 'collections'; studio?.captureContext({collectionId:c._mpId}); closeModal(); persist(); renderAll();
  }, '作成');
}
function folderChoices(collection) {
  const values = [['', 'コレクション直下']];
  walkItems(collection?.item, (item, parents) => {if (item.item) values.push([item._mpId, [...parents.map(p => p.name), item.name].join(' / ')]);}); return values;
}
function saveRequest() {
  const tab = active(); const priorKey = requestKey(workspace, tab);
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
    revisionStore.transfer(priorKey, requestKey(workspace, tab)); studio?.transferResponse(priorKey, requestKey(workspace, tab));
    side = 'collections'; closeModal(); persist(); renderAll(); toast('コレクションに保存しました。');
  });
}
function collectionMenu(collection, folder, anchor, event) {
  selectedCollectionId = collection._mpId;
  const owner = folder || collection, name = folder?.name || collection.info.name;
  const actions = [
    {label:'リクエストを追加',run:()=>studio.createItem('request',{collectionId:collection._mpId,parentId:folder?._mpId})},
    {label:'フォルダーを追加',run:()=>studio.createItem('folder',{collectionId:collection._mpId,parentId:folder?._mpId})},
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
    ...studio.requestActions(collection,item),
    {label: '送信', run: () => {openRequest(collection, item); sendRequest();}},
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
function environmentActions(env, globals) {
  const owner = globals ? {get values() {return workspace.globals;}, set values(value) {workspace.globals = value;}} : env;
  const actions = [{label: '変数を編集', run: () => globals ? editEnvironment(null, true) : chooseEnvironment(env.id, true)}];
  if (!globals) actions.push({label: '複製', run: () => {const copy = duplicateEnvironment(env, workspace.environments.map(e => e.name)); workspace.environments.push(copy); chooseEnvironment(copy.id, true); toast('環境を複製しました。');}});
  actions.push({label: '変更履歴', run: () => showRevisions(globals ? 'globals' : `environment:${env.id}`)}, ...configurationActions(owner, 'environment'), {label: 'エクスポート', run: () => exportEnvironment(env, globals)});
  if (!globals) actions.push(null, {label: '削除', danger: true, run: () => {
    if (!confirm(`環境「${env.name}」を削除しますか？`)) return;
    workspace.environments = workspace.environments.filter(e => e.id !== env.id); chooseEnvironment(workspace.environmentId === env.id ? '' : workspace.environmentId);
  }}); return actions;
}
function environmentMenu(env, globals, anchor, event) {openItemMenu(anchor,environmentActions(env,globals),event);}
function exportEnvironment(env, globals = false) {
  const name = globals ? 'Globals' : env.name || 'Environment', values = globals ? workspace.globals : env.values;
  exportFile(`${name}.postman_${globals ? 'globals' : 'environment'}.json`, {...(globals ? {} : {id: env.id}), name, values: values.map(v => ({...v, enabled: enabled(v)})), _postman_variable_scope: globals ? 'globals' : 'environment'});
}
function editEnvironment(env, globals = false) {studio.editEnvironment(env, globals);}
function preferencesForArchive() {
  let layout = null;
  try {layout = JSON.parse(storage.getItem('minipost.layout.v1'));} catch {}
  return {layout, sections: expandedSections, navigation: {editor:editorPage, sidebar:side, response:responseView}};
}
async function commitImportedWorkspace(next, layout) {
  try {await storage.save(next, {layout, replace: true});}
  catch (error) {throw new Error('インポートを保存できませんでした。既存のワークスペースは維持しています: ' + error.message);}
}
function saveFullBackup() {
  persist(true);
  exportFile('MiniPost-full-' + new Date().toISOString().slice(0,10) + '.json', exportWorkspace(workspace, preferencesForArchive()));
}
function showArchiveImport(bundle, source = 'ファイル') {
  const parsed = readWorkspaceBundle(bundle);
  const contents = parsed.workspace;
  const box = element('div');
  const intro = element('p', 'input-condition', `取込元: ${source}
コレクション ${contents.collections.length}件、環境 ${contents.environments.length}件、変数 ${contents.globals.length}件、送信履歴 ${contents.history.length}件。
設定別の変更履歴・下書き・選択環境も含まれます。`);
  intro.style.whiteSpace = 'pre-wrap';
  const mode = select([['replace','現在のワークスペースを置換（完全復元）'],['merge','現在の内容に追加（IDを再発行）']], 'replace', () => {});
  mode.id = 'importMode';
  const warning = element('p', 'server-warning', '認証トークンなどもインポートされます。置換する場合、現在のローカル保存内容は更新されます。');
  box.append(intro, field('インポート方式', mode), warning);
  showModal('MiniPost 全体バックアップを取り込む', box, async () => {
    if (studio?.isRunning()) throw new Error('実行中のリレーションを停止してから取り込んでください。');
    if (mode.value === 'merge') revisionStore.capture();
    const next = mode.value === 'merge' ? mergeWorkspace(clone(workspace), contents) : clone(contents);
    if (!next.tabs.length) next.tabs.push(freshTab());
    if (!next.tabs.some(tab => tab.id === next.activeId)) next.activeId = next.tabs[0].id;
    // Restore must not depend on saving the old (possibly quota-exhausted) data.
    // Suppress delayed saves and response callbacks until the atomic replacement ends.
    clearTimeout(saveTimer); ++saveSequence; importInProgress = true;
    try {await commitImportedWorkspace(next, mode.value === 'replace' ? parsed.layout : null);}
    catch (error) {importInProgress = false; throw error;}
    workspace = next;
    studio?.reset();
    revisionStore = new RevisionStore(workspace);
    responses.clear(); requests.forEach(x => x.abort()); requests.clear(); selectedFiles.clear();
    closeModal();
    // Recreate layout handlers only once, after the IndexedDB transaction commits.
    window.location.reload();
  }, 'インポートして反映');
}

async function saveToServer() {
  persist(true);
  const savedGeneration = localChangeGeneration;
  const button = $('dataActions'); button.disabled = true;
  try {
    const content = exportWorkspace(workspace, preferencesForArchive());
    const response = await fetch('/api/workspace', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(content)});
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
    const newerLocalChanges = localChangeGeneration !== savedGeneration;
    $('serverSaveState').classList.remove('error');
    $('serverSaveState').classList.toggle('saved', !newerLocalChanges);
    $('serverSaveState').textContent = newerLocalChanges ? 'サーバーには未反映' : 'サーバーへ明示保存済み';
    toast(newerLocalChanges ? '送信開始時の内容を保存しました。保存中の変更はサーバーに未反映です。' : 'サーバーに保存しました。');
  } catch(error) {
    $('serverSaveState').classList.add('error');
    $('serverSaveState').textContent = 'サーバー保存失敗';
    toast('サーバーへ保存できません: ' + error.message);
  } finally {button.disabled = false;}
}
async function loadFromServer() {
  const button = $('dataActions'), status = $('serverSaveState');
  const previous = {text: status.textContent, className: status.className, generation: localChangeGeneration};
  button.disabled = true; button.setAttribute('aria-busy', 'true');
  status.textContent = 'サーバーから読込中…'; status.className = '';
  try {
    const response = await fetch('/api/workspace', {cache: 'no-store'});
    let body;
    try {body = await response.json();}
    catch {throw new Error(`サーバーの応答がJSONではありません（HTTP ${response.status}）。`);}
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    showArchiveImport(body, 'サーバー保存');
    status.textContent = previous.text; status.className = previous.className;
    if (previous.generation !== localChangeGeneration && status.classList.contains('saved')) {status.classList.remove('saved'); status.textContent = 'サーバーには未反映';}
  } catch(error) {
    status.textContent = 'サーバー読込失敗'; status.className = 'error';
    toast('サーバーから読み込めません: ' + error.message);
  } finally {button.disabled = false; button.removeAttribute('aria-busy');}
}
function importDialog(initialFiles = []) {
  let files = [...initialFiles]; const box = element('div'), drop = element('div','import-drop'), fileList = element('div','file-list');
  drop.append(element('strong','','MiniPost 全体バックアップ / Postman JSON'));
  const picker = element('input'); picker.type = 'file'; picker.accept = '.json,application/json'; picker.multiple = true; picker.hidden = true;
  const folderPicker = element('input'); folderPicker.type = 'file'; folderPicker.multiple = true; folderPicker.setAttribute('webkitdirectory',''); folderPicker.hidden = true;
  const refreshFiles = () => fileList.textContent = files.map(f=>f.webkitRelativePath || f.name).join('\n');
  picker.onchange = () => {files = [...picker.files]; refreshFiles();};
  folderPicker.onchange = () => {files = [...folderPicker.files].filter(f => f.name.toLowerCase().endsWith('.json')); refreshFiles();};
  drop.append(button('JSONファイルを選択',()=>picker.click()),button('フォルダーを選択',()=>folderPicker.click()),picker,folderPicker,fileList);
  drop.ondragover = e => {e.preventDefault();drop.classList.add('dragover');};
  drop.ondragleave = () => drop.classList.remove('dragover');
  drop.ondrop = e => {e.preventDefault();drop.classList.remove('dragover');files=[...e.dataTransfer.files];refreshFiles();};
  const paste = element('textarea','import-paste');paste.placeholder='またはJSONを貼り付け';paste.spellcheck=false;paste.setAttribute('aria-label','インポートJSON');
  box.append(drop,field('JSONを貼り付け',paste));refreshFiles();
  showModal('インポート',box,async()=>{
    const inputs = await Promise.all(files.map(async f => ({name:f.name,content:await f.text()})));
    if(paste.value.trim())inputs.push({name:'貼り付けJSON',content:paste.value});
    if(!inputs.length)throw new Error('JSONファイルまたはJSONテキストを指定してください。');
    if(inputs.some(i=>i.content.length>10*1024*1024))throw new Error('1ファイル10 MiBまで対応します。');
    // Validate every file before touching the current workspace.
    const parsed=inputs.map(i=>{
      try {
        const data=JSON.parse(i.content);
        return isWorkspaceBundle(data) ? {name:i.name,kind:'full',data} : {name:i.name,kind:'individual',data:importPostman(data,i.name)};
      }catch(error){throw new Error(i.name+': '+error.message);}
    });
    const full=parsed.filter(x=>x.kind==='full');
    if(full.length) {
      if(parsed.length!==1)throw new Error('全体バックアップは単独で読み込んでください。個別ファイルは別途追加できます。');
      showArchiveImport(full[0].data,full[0].name);
    } else applyImports(parsed.map(x=>x.data));
  },'読み込む');
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
  const root = $('responseContent'); root.replaceChildren(); const result = responses.get(active().id) || studio?.responseFor(active());
  $('extractResponse').disabled = !studio?.responseFor(active());
  $('automationError').textContent = result?.automationErrors?.join('\n') || '';
  $('automationError').hidden = !result?.automationErrors?.length;
  document.documentElement.dataset.responseEmpty = String(!result && !requests.has(active().id));
  for (const tab of $('responseTabs').querySelectorAll('[data-response]')) {
    const selected = tab.dataset.response === responseView;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  root.setAttribute('aria-labelledby', 'response-tab-' + responseView);
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
    const table = element('table', 'kv-table kv-readonly'), head = element('tr'); head.append(element('th', '', 'キー'), element('th', '', '値')); table.append(head);
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
  const snapshot = clone(tab), environmentId = workspace.environmentId, controller = new AbortController(); requests.set(tab.id, controller);
  responses.delete(tab.id); renderRequestFooter(); renderResponse();
  try {
    const result = await studio.execute(tab,{signal:controller.signal,environmentId,files:selectedFiles.get(tab.id)||{}});
    if (workspace.tabs.some(t => t.id === tab.id)) responses.set(tab.id, result);
    workspace.history.push({id: uid(), at: new Date().toISOString(), tab: snapshot, environmentId, status: result.status, elapsed_ms: result.elapsed_ms}); persist();
    if (active().id === tab.id) $('requestInfo').textContent = `${tab.request.method} · ${new Date().toLocaleTimeString()}${result.redirects?.length ? ` · ${result.redirects.length} redirects` : ''}`;
  } catch (error) {
    const cancelled = error.name === 'AbortError';
    if (workspace.tabs.some(t => t.id === tab.id)) responses.set(tab.id, {error: cancelled ? '受信を中止しました。送信先ですでに開始した処理は取り消せません。' : error.message, cancelled, errorTitle: error.title});
    if (!cancelled) {workspace.history.push({id: uid(), at: new Date().toISOString(), tab: snapshot, environmentId, status: 'ERR'}); persist();}
  } finally {requests.delete(tab.id); if (active().id === tab.id) {renderRequestFooter(); renderResponse();} renderSidebar();}
}
function showRevisions(key) {
  persist(true);
  const row = settingsIndex(workspace).get(key);
  if (!row) return toast('対象の設定がありません。');
  const box = element('div', 'revision-panel'); box.dataset.revisionKey = key;
  const heading = element('div', 'revision-toolbar');
  heading.append(element('strong', '', row.name || '名前なし'), button('履歴をエクスポート', () => exportFile(`${row.name || 'settings'}.revisions.json`, {key, revisions: workspace.revisions[key] || []})));
  box.append(heading);
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
$('addTab').onclick = event => studio.creationMenu(event.currentTarget,event);
$('duplicateRequest').onclick = () => addTab({...clone(active()), id: uid(), itemId: undefined, name: `${active().name} copy`, dirty: true});
$('saveRequest').onclick = saveRequest;
$('requestName').oninput = () => {active().name = $('requestName').value; touch();};
$('method').onchange = () => {active().request.method = $('method').value; $('method').className = `method-${$('method').value}`; touch();};
$('url').oninput = () => {setUrlText(active().request, $('url').value); touch(); renderPane();};
$('environment').onchange = () => chooseEnvironment($('environment').value);
$('search').oninput = renderSidebar;
$('import').onclick = () => importDialog();
$('dataActions').onclick = event => openItemMenu(event.currentTarget, [
  {label:'全体エクスポート',run:saveFullBackup},
  {label:'サーバーへ保存',run:saveToServer},
  {label:'サーバーから読込',run:loadFromServer}
], event);
$('importFiles').onchange = () => importDialog([...$('importFiles').files]);
$('sidebarAdd').onclick = event => studio.creationMenu(event.currentTarget,event);
$('clearHistory').onclick = () => {if (confirm('送信履歴をすべて削除しますか？')) {workspace.history = []; persist(); renderSidebar();}};
for (const tab of $('editorTabs').querySelectorAll('[data-editor]'))
  tab.onclick = () => selectEditorPage(tab.dataset.editor);
for (const tab of $('responseTabs').querySelectorAll('[data-response]'))
  tab.onclick = () => {responseView = tab.dataset.response; renderResponse(); saveNavigation();};
for (const tab of $('sidebarTabs').querySelectorAll('[data-sidebar]')) tab.onclick = () => chooseSidebar(tab.dataset.sidebar);
bindTabStrip($('editorTabs'), '[role="tab"]');
bindTabStrip($('responseTabs'), '[role="tab"]');
bindTabStrip($('sidebarTabs'), '[role="tab"]');
$('responseSearch').oninput = () => {clearTimeout(responseSearchTimer); responseSearchTimer = setTimeout(renderResponse, 180);};
$('copyResponse').onclick = async () => {const value = responseText(responses.get(active().id) || studio?.responseFor(active())); if (!value) return toast('コピーするレスポンスがありません。'); await copyText(value);};
$('downloadResponse').onclick = () => {
  const result = responses.get(active().id) || studio?.responseFor(active()); if (!result || result.error) return toast('保存するレスポンスがありません。');
  const raw = result.body_base64 || (result.body_encoding === 'base64' ? result.body : null);
  const data = raw != null ? Uint8Array.from(atob(raw), c => c.charCodeAt(0)) : result.body;
  const suffix = /json/i.test(result.content_type) ? '.json' : /html/i.test(result.content_type) ? '.html' : result.body_encoding === 'base64' ? '.bin' : '.txt';
  download('response' + suffix, new Blob([data], {type: result.content_type || 'application/octet-stream'}));
};
function setTheme() {document.documentElement.dataset.theme = workspace.theme || 'light';}
$('theme').onclick = () => {workspace.theme = workspace.theme === 'light' ? 'dark' : 'light'; setTheme(); persist();};
document.addEventListener('keydown', event => {
  if (['environments','relations'].includes(side) && (event.ctrlKey||event.metaKey) && event.key.toLowerCase()==='s' && !$('modal').open) {event.preventDefault();persist(true);return;}
  if (settingsDrawer && $('modal').open && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {event.preventDefault(); persist(true); return;}
  if ($('modal').open && ($('modal').matches(':modal') || $('modal').contains(document.activeElement))) return;
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !['environments','relations'].includes(side)) {event.preventDefault(); sendRequest();}
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {event.preventDefault(); saveRequest();}
  if (event.key === 'Escape' && requests.has(active().id)) requests.get(active().id).abort();
});
workbench = initWorkbench(storage); bindItemMenu(); bindSurface();
studio = initStudio({
  $,element,button,input,select,field,kvEditor,openItemMenu,bindContext,showModal,closeModal,persist,toast,
  workspace:()=>workspace,active,side:()=>side,setSide:value=>{side=value;saveNavigation();},
  renderSidebar,renderAll,renderEditor,renderEnvironments,closeNavigation:()=>workbench.closeNavigation(),
  chooseEnvironment,environmentMenu,environmentActions,exportEnvironment,showRevisions,exportFile,copyText,newCollection,openRequest,selectRequest,selectEditorPage,touch,
  addDraft:()=>{side='collections';addTab();$('url').focus();},
  findDraft:(collectionId,itemId)=>workspace.tabs.find(t=>t.collectionId===collectionId&&t.itemId===itemId),
  filesFor:tab=>selectedFiles.get(workspace.tabs.find(t=>t.id===tab.id||(tab.itemId&&t.collectionId===tab.collectionId&&t.itemId===tab.itemId))?.id)||{},
  saveTab:tab=>{
    const collection=workspace.collections.find(c=>c._mpId===tab.collectionId),item=findItem(collection,tab.itemId)?.item;
    if(item){item.request=clone(tab.request);for(const draft of workspace.tabs)if(draft.collectionId===tab.collectionId&&draft.itemId===tab.itemId)draft.request=clone(tab.request);}
    persist();if(active().id===tab.id)renderEditor();
  },
  recordBackground:(tab,response,environmentId)=>{
    const draft=workspace.tabs.find(t=>t.id===tab.id||(tab.itemId&&t.collectionId===tab.collectionId&&t.itemId===tab.itemId));
    if(draft)responses.set(draft.id,response);
    workspace.history.push({id:uid(),at:new Date().toISOString(),tab:clone(tab),environmentId,status:response.status,elapsed_ms:response.elapsed_ms});persist();renderSidebar();renderResponse();
  }
});
// Internal editor/response pages are tabbed; only request selection itself stays tab-free.
// All-settings view retains flat spacing and heading disclosure.
setTheme(); renderAll();
setSaveStatus(recoveryMessage ? '保存データの復元が必要です。' : 'ローカルに保存済み', !!recoveryMessage);
$('saveState').title = storage.backend === 'indexedDB' ? 'このブラウザのIndexedDBへ保存します。サーバーへの自動送信は行いません。' : '従来のブラウザ保存を使用しています。';
storage.onPreferenceError = () => toast('表示設定を保存できません。入力内容は維持しています。');
if (recoveryMessage || storage.warning) toast(recoveryMessage || storage.warning);
fetch('/api/health').then(r => {if (!r.ok) throw new Error(); $('connectionStatus').replaceChildren(element('span', 'status-dot'), document.createTextNode('Python proxy · connected'));}).catch(() => {$('connectionStatus').textContent = 'Python proxy · 接続できません';});
