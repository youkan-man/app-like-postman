/** Immutable transport evidence, separate from the editable request template. */
import {clone, uid, displayUrl} from './core.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function sentRequests(value) {
  if (Array.isArray(value?.sent_requests)) return value.sent_requests.filter(record);
  return record(value?.sent_request) ? [value.sent_request] : null;
}

export function historyEntry(tab, result, {environmentId = '', environmentName = '', at = new Date().toISOString()} = {}) {
  const entry = {id: uid(), at, tab: clone(tab), environmentId, environmentName,
    status: result.status ?? 'ERR'};
  if (result.elapsed_ms != null) entry.elapsed_ms = result.elapsed_ms;
  if (result.error || result instanceof Error) entry.error = String(result.error || result.message);
  const sent = sentRequests(result);
  if (sent !== null) entry.sent_requests = clone(sent);
  return entry;
}

export function historyUrl(entry) {
  return sentRequests(entry)?.[0]?.url || displayUrl(entry.tab.request.url);
}

/** The viewer never resolves variables or changes the selected editor/environment. */
export function createHistoryView(root, {edit, copy}) {
  const node = (tag, className, text) => {
    const value = document.createElement(tag);
    if (className) value.className = className;
    if (text != null) value.textContent = String(text);
    return value;
  };
  const button = (label, action, className = 'button') => {
    const value = node('button', className, label); value.type = 'button';
    value.addEventListener('click', action); return value;
  };
  function section(title, value, attribute) {
    const box = node('section', 'sent-section'), heading = node('div', 'sent-section-heading');
    heading.append(node('h2', '', title));
    if (value != null) {
      heading.append(button('コピー', () => copy(String(value)), 'text-button'));
    }
    box.append(heading);
    if (value != null) {
      const content = node('pre', 'sent-value', value);
      if (attribute) content.setAttribute(attribute, '');
      content.tabIndex = 0; box.append(content);
    }
    return box;
  }
  function table(entries, attribute) {
    const value = node('table', 'sent-table');
    if (attribute) value.setAttribute(attribute, '');
    const head = node('thead'), line = node('tr'), body = node('tbody');
    for (const label of ['キー', '値']) {const cell = node('th', '', label); cell.scope = 'col'; line.append(cell);}
    head.append(line); value.append(head, body);
    for (const [key, content] of entries) {
      const row = node('tr'); row.append(node('td', '', key), node('td', '', content)); body.append(row);
    }
    return value;
  }
  let shown = null;
  function render(entry) {
    // Keep selection and scroll when unrelated workspace state changes.
    if (shown === entry && root.childElementCount) return;
    shown = entry; root.replaceChildren(); root.scrollTop = 0;
    if (!entry) {
      const empty = node('div', 'workspace-empty'); empty.append(node('h1', '', '送信履歴はありません'));
      root.append(empty); return;
    }
    root.dataset.historyId = entry.id || '';
    const heading = node('div', 'sent-heading'), title = node('h1', '', entry.tab.name || 'リクエスト');
    const editButton = button('編集用に開く', () => edit(entry)); editButton.dataset.historyEdit = '';
    heading.append(title, editButton); root.append(heading);
    const info = node('div', 'sent-info');
    const date = new Date(entry.at);
    info.append(node('time', '', Number.isNaN(date.valueOf()) ? '' : date.toLocaleString()));
    if (entry.environmentName) info.append(node('span', '', entry.environmentName));
    info.append(node('span', `history-code${Number(entry.status) >= 400 || entry.status === 'ERR' ? ' sent-error' : ''}`, entry.status ?? 'ERR'));
    if (entry.elapsed_ms != null) info.append(node('span', '', `${entry.elapsed_ms} ms`));
    root.append(info);
    if (entry.error) root.append(node('p', 'sent-error', entry.error));
    const requests = sentRequests(entry);
    if (requests === null) {
      const message = node('p', 'sent-notice', 'この履歴には送信時の実値が保存されていません。');
      message.dataset.sentLegacy = ''; root.append(message, section('元のURL', displayUrl(entry.tab.request.url)));
      return;
    }
    if (!requests.length) {
      root.append(node('p', 'sent-notice', 'HTTPリクエストの送信記録はありません。'));
      return;
    }
    const content = node('div', 'sent-request');
    if (requests.length > 1) {
      const field = node('label', 'sent-hop'), select = node('select');
      field.append(node('span', '', '送信経路')); select.setAttribute('aria-label', '送信経路');
      for (const [index, request] of requests.entries()) {
        select.append(new Option(`${index + 1}. ${request.method} ${request.url}${request.response_status ? ' · ' + request.response_status : ''}`, String(index)));
      }
      select.addEventListener('change', () => paintRequest(content, requests[Number(select.value)]));
      field.append(select); root.append(field);
    }
    root.append(content); paintRequest(content, requests[0]);
  }
  function paintRequest(root, request) {
    root.replaceChildren();
    const url = section('送信URL', request.url || '', 'data-sent-url');
    url.querySelector('h2').prepend(node('span', `method-label method-${request.method}`, request.method || ''));
    root.append(url);
    if (request.transmission && request.transmission !== 'sent') {
      const warning = node('p', 'sent-notice', request.transmission === 'incomplete'
        ? '送信途中で通信が終了しました。以下はその送信で使用した値です。'
        : '送信は完了していません。以下は送信準備時の値です。');
      root.append(warning);
    }
    const headers = (Array.isArray(request.headers) ? request.headers : []).filter(record);
    const headerSection = section('ヘッダー', null);
    headerSection.querySelector('.sent-section-heading').append(button('コピー', () => copy(headers.map(h => `${h.key}: ${h.value}`).join('\r\n')), 'text-button'));
    headerSection.append(table(headers.map(h => [h.key, h.value]), 'data-sent-headers')); root.append(headerSection);
    const mode = request.body_mode || (request.body != null ? 'text' : 'none');
    if (mode === 'multipart') {
      const body = section('本文 · form-data', null);
      const parts = (Array.isArray(request.multipart) ? request.multipart : []).filter(record);
      body.append(table(parts.map(part => [part.key,
        part.filename != null ? [part.filename, part.content_type, part.size != null ? `${part.size} bytes` : ''].filter(Boolean).join('\n') : String(part.value ?? '')]), 'data-sent-multipart'));
      if (parts.some(part => part.filename != null)) body.append(node('p', 'sent-notice', 'ファイル内容は履歴に保存していません。'));
      root.append(body);
    } else if (mode === 'binary') {
      const body = section('本文 · バイナリ', null), file = request.file || {};
      body.append(table([['ファイル名', file.filename || '—'], ['Content-Type', file.content_type || headers.find(h => String(h.key).toLowerCase() === 'content-type')?.value || '—'],
        ['サイズ', `${file.size ?? request.body_size ?? 0} bytes`]], 'data-sent-file'));
      body.append(node('p', 'sent-notice', 'ファイル内容は履歴に保存していません。')); root.append(body);
    } else if (mode === 'none') {
      const body = section('本文', null); body.append(node('p', 'sent-notice', '本文なし')); root.append(body);
    } else {
      const body = section('本文', String(request.body ?? ''), 'data-sent-body');
      if (request.body_size != null) body.querySelector('h2').append(node('span', 'sent-body-size', `${request.body_size} bytes`));
      if (request.body === '') body.append(node('p', 'sent-notice', '空の本文'));
      if (request.body_truncated) body.append(node('p', 'sent-notice', 'この本文は一部のみ保存されています。'));
      root.append(body);
    }
  }
  return {render};
}
