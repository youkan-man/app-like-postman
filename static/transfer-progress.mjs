/** Ephemeral, per-send progress. Never serialized with workspace/history data. */
export class TransferProgress {
  constructor(onChange = () => {}, {delayMs = 700} = {}) {
    this.entries = new Map(); this.onChange = onChange; this.delayMs = delayMs;
  }
  get(id) {return this.entries.get(id);}
  begin(id) {
    const previous = this.entries.get(id); clearTimeout(previous?.timer);
    const entry = {phase: 'prepare', visible: false};
    this.entries.set(id, entry);
    const notify = () => {if (this.entries.get(id) === entry) this.onChange(id);};
    entry.timer = setTimeout(() => {entry.visible = true; notify();}, this.delayMs);
    entry.timer.unref?.();
    return {
      update: progress => {
        if (this.entries.get(id) !== entry || entry.phase === 'stopping') return;
        // Phase changes discard prior byte counts. Response waiting is not 100%.
        const {phase = 'send', completed, total, attempt} = progress || {};
        Object.assign(entry, {phase, completed, total, attempt}); notify();
      },
      finish: () => {
        clearTimeout(entry.timer);
        if (this.entries.get(id) !== entry) return;
        this.entries.delete(id); this.onChange(id);
      }
    };
  }
  cancelling(id) {
    const entry = this.entries.get(id); if (!entry) return;
    Object.assign(entry, {phase: 'stopping', completed: undefined, total: undefined});
    this.onChange(id);
  }
}
export function transferPresentation(state = {}) {
  const labels = {prepare: '送信準備中', script: '送信前スクリプト実行中', upload: 'アップロード中',
    send: '送信先へ転送中', waiting: '応答待ち', processing: '受信後処理中', stopping: '停止中'};
  let label = labels[state.phase] || '送信中';
  if (state.phase === 'send' && Number.isInteger(state.attempt) && state.attempt > 1)
    label = `送信先へ再転送中（${state.attempt}回目）`;
  const known = ['upload', 'send'].includes(state.phase) && Number.isFinite(state.completed) &&
    state.completed >= 0 && Number.isFinite(state.total) && state.total >= 0;
  const completed = known ? Math.min(state.completed, state.total) : 0;
  const percent = known ? state.total === 0 ? 100 : Math.floor(completed / state.total * 1000) / 10 : null;
  const bytes = value => {
    if (value < 1024) return `${value} B`;
    const unit = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
    return `${(value / 1024 ** unit).toLocaleString('ja-JP', {maximumFractionDigits: 1})} ${['B','KiB','MiB','GiB','TiB'][unit]}`;
  };
  // Use one unit for the pair so its scale does not change as the transfer grows.
  const unit = known && state.total >= 1024 ? Math.min(4, Math.floor(Math.log(state.total) / Math.log(1024))) : 0;
  const quantity = value => (value / 1024 ** unit).toLocaleString('ja-JP', {maximumFractionDigits: 1});
  const amount = known ? `${quantity(completed)} / ${quantity(state.total)} ${['B','KiB','MiB','GiB','TiB'][unit]}` : '';
  const routes = {upload: 'ブラウザ → MiniPost', send: 'MiniPost → 送信先', waiting: '送信先 → MiniPost'};
  return {visible: Boolean(state.visible), label, known, completed, total: known ? state.total : 0,
    amount, percent, route: routes[state.phase] || '',
    detail: known ? `${bytes(completed)} / ${bytes(state.total)} · ${percent}%` : ''};
}
export function createTransferView(state) {
  const node = (tag, className) => {const element = document.createElement(tag); element.className = className; return element;};
  const root = node('div', 'transfer-progress'); root.id = 'transferProgress';
  const line = node('div', 'transfer-progress-line');
  const heading = node('div', 'transfer-progress-heading');
  const indicator = node('span', 'transfer-progress-indicator'); indicator.setAttribute('aria-hidden', 'true');
  const label = node('span', 'transfer-progress-label');
  label.setAttribute('role', 'status'); label.setAttribute('aria-live', 'polite');
  const percent = node('span', 'transfer-progress-percent'); percent.setAttribute('aria-hidden', 'true');
  heading.append(indicator, label); line.append(heading, percent);
  const track = node('div', 'transfer-progress-track');
  const bar = node('progress', 'transfer-progress-bar');
  const pulse = node('span', 'transfer-progress-pulse'); pulse.setAttribute('aria-hidden', 'true');
  track.append(bar, pulse);
  const footer = node('div', 'transfer-progress-meta');
  const detail = node('span', 'transfer-progress-detail');
  const route = node('span', 'transfer-progress-route');
  footer.append(detail, route); root.append(line, track, footer); paintTransferView(root, state); return root;
}
export function paintTransferView(root, state) {
  if (!root) return;
  const info = transferPresentation(state);
  const label = root.querySelector('.transfer-progress-label'), detail = root.querySelector('.transfer-progress-detail');
  const percent = root.querySelector('.transfer-progress-percent'), bar = root.querySelector('progress');
  root.dataset.phase = state?.phase || 'prepare'; root.dataset.visible = String(info.visible);
  root.dataset.determinate = String(info.known);
  const caption = info.visible ? info.label : '送信中…';
  // Keep the live status and progress elements mounted; announce phase, not every chunk.
  if (label.textContent !== caption) label.textContent = caption;
  detail.textContent = info.amount;
  percent.textContent = info.known ? `${info.percent}%` : '';
  percent.style.visibility = info.visible && info.known ? 'visible' : 'hidden';
  // Reserve the same rows for every phase. Waiting must never retain an old 100%.
  for (const selector of ['.transfer-progress-track', '.transfer-progress-meta']) {
    const element = root.querySelector(selector);
    element.style.visibility = info.visible ? 'visible' : 'hidden';
    element.setAttribute('aria-hidden', String(!info.visible));
  }
  bar.setAttribute('aria-label', info.label); bar.setAttribute('aria-hidden', String(!info.visible));
  if (info.known) {
    bar.max = info.total || 1; bar.value = info.total ? info.completed : 1;
    bar.setAttribute('aria-valuetext', `${info.label}: ${info.detail}`);
  } else {bar.removeAttribute('value'); bar.removeAttribute('aria-valuetext');}
  root.querySelector('.transfer-progress-route').textContent = info.route;
}
