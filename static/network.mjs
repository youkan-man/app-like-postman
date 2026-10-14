import {contextFor, resolver, urlParts} from './core.mjs';

const loopback = host => host.toLowerCase().replace(/\.$/, '') === 'localhost' || host === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host);

/** This control only changes TCP routing for literal loopback destinations. */
export function createNetworkControls({tab, workspace, changed}) {
  let runtime = {container: false, network_mode: 'unknown'};
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/network.css'; document.head.append(css);
  const root = document.createElement('div'); root.className = 'network-bar';
  const label = document.createElement('label'); label.htmlFor = 'loopbackTarget'; label.textContent = 'localhost の接続先';
  const select = document.createElement('select'); select.id = 'loopbackTarget';
  select.append(new Option('実行環境', 'direct'), new Option('Dockerホスト', 'docker-host'));
  select.title = 'localhost / 127.x.x.x / ::1 のTCP接続先。LANのIPやサービス名はURLどおりに接続します。';
  const info = document.createElement('span'); info.id = 'networkDestination';
  root.append(label, select, info);
  document.querySelector('.urlbar').after(root);
  select.onchange = () => {tab().settings ||= {}; tab().settings.loopback_target = select.value; changed(); render();};
  function render() {
    const current = tab(); select.value = current.settings?.loopback_target || 'direct';
    select.options[0].textContent = runtime.container && runtime.network_mode !== 'host' ? 'コンテナ内' : '実行環境';
    const source = runtime.container ? `Docker (${runtime.network_mode})` : 'Python';
    try {
      let base = resolver(contextFor(workspace(), current).vars)(urlParts(current.request.url).base.trim());
      if (!base) {info.textContent = source; return;}
      if (!/^[a-z][a-z\d+.-]*:\/\//i.test(base)) base = 'http://' + base;
      const url = new URL(base);
      const routed = loopback(url.hostname) && select.value === 'docker-host' && runtime.network_mode !== 'host';
      info.textContent = `${source} → ${routed ? 'host.docker.internal' : url.hostname}:${url.port || (url.protocol === 'https:' ? 443 : 80)}`;
      info.title = loopback(url.hostname) && runtime.container && runtime.network_mode !== 'host' && !routed
        ? 'このlocalhostはブラウザのPCやDockerホストではなく、MiniPostコンテナ自身です。'
        : '送信はブラウザではなくMiniPostのPythonプロキシから行います。';
    } catch {info.textContent = source; info.title = '変数展開後の接続先を表示します。';}
  }
  fetch('/api/health').then(r => r.json()).then(data => {runtime = data.runtime || runtime; render();}).catch(() => {});
  document.getElementById('environment').addEventListener('change', render);
  document.getElementById('sidebarContent').addEventListener('click', render);
  render(); return {render};
}

/** Distinguish a reverse-proxy HTML 502 from a MiniPost JSON failure. No retries. */
export async function sendThroughProxy(payload, signal) {
  let response;
  try {
    response = await fetch('/api/request', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload), signal});
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    const failure = new Error('MiniPostへの接続に失敗しました。ブラウザとMiniPost間の接続・入口プロキシを確認してください。');
    failure.title = 'ERROR · MiniPost接続'; throw failure;
  }
  const text = await response.text();
  let result;
  try {result = JSON.parse(text);} catch {}
  if (!result || typeof result.ok !== 'boolean') {
    const error = new Error(`入口 HTTP ${response.status}：MiniPostのJSON応答を取得できませんでした。\nリバースプロキシの接続先・タイムアウトとMiniPostの起動状態を確認してください。送信先APIの応答とは区別してください。`);
    error.title = `ERROR · 入口 HTTP ${response.status}`; throw error;
  }
  if (!response.ok || !result.ok) {
    const error = new Error(String(result.error || `MiniPost HTTP ${response.status}`));
    error.title = `ERROR · MiniPost ${response.status}${result.diagnostic?.code ? ' · ' + result.diagnostic.code : ''}`;
    throw error;
  }
  return result;
}
