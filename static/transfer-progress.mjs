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
  return {visible: Boolean(state.visible), label, known, completed, total: known ? state.total : 0,
    detail: known ? `${bytes(completed)} / ${bytes(state.total)} · ${percent}%` : ''};
}
export function createTransferView(state) {
  const root = document.createElement('div'); root.id = 'transferProgress'; root.className = 'transfer-progress';
  const line = document.createElement('div'); line.className = 'transfer-progress-line';
  const label = document.createElement('span'); label.className = 'transfer-progress-label';
  label.setAttribute('role', 'status'); label.setAttribute('aria-live', 'polite');
  const detail = document.createElement('span'); detail.className = 'transfer-progress-detail';
  const bar = document.createElement('progress'); bar.className = 'transfer-progress-bar';
  line.append(label, detail); root.append(line, bar); paintTransferView(root, state); return root;
}
export function paintTransferView(root, state) {
  if (!root) return;
  const info = transferPresentation(state);
  const label = root.querySelector('.transfer-progress-label'), detail = root.querySelector('.transfer-progress-detail');
  const bar = root.querySelector('progress');
  root.dataset.phase = state?.phase || 'prepare'; root.dataset.visible = String(info.visible);
  const caption = info.visible ? info.label : '送信中…';
  // Do not re-announce the phase at every chunk or replace the focused controls.
  if (label.textContent !== caption) label.textContent = caption;
  detail.textContent = info.detail; detail.hidden = !info.visible;
  bar.style.visibility = info.visible ? 'visible' : 'hidden';
  bar.setAttribute('aria-label', info.label); bar.setAttribute('aria-hidden', String(!info.visible));
  if (info.known) {
    bar.max = info.total || 1; bar.value = info.total ? info.completed : 1;
    bar.setAttribute('aria-valuetext', `${info.label}: ${info.detail}`);
  } else {bar.removeAttribute('value'); bar.removeAttribute('aria-valuetext');}
}
