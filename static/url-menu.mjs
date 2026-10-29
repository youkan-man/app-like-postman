/** Explicit URL text conversion. No conversion is performed on render or typing. */
export function bindUrlMenu(input, {openMenu, notify, identity = () => null}) {
  let sequence = 0;
  input.addEventListener('input', () => {sequence++;});
  function open(event) {
    event?.preventDefault(); event?.stopPropagation();
    const start = input.selectionStart, end = input.selectionEnd, selected = start !== end;
    const before = input.value, version = sequence, owner = identity();
    const text = selected ? before.slice(start, end) : before;
    async function convert(operation) {
      try {
        const reply = await fetch('/api/url-transform', {method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({text, operation, kind: selected ? 'component' : 'url'})});
        const data = await reply.json();
        if (!reply.ok || !data.ok) throw new Error(data.error || 'URLを変換できません。');
        if (!input.isConnected || input.value !== before || sequence !== version || identity() !== owner) throw new Error('変換中にURLが変更されました。元の編集内容を保持しています。');
        input.focus({preventScroll: true}); input.setSelectionRange(selected ? start : 0, selected ? end : before.length);
        const previous = input.value;
        let inserted = false; try {inserted = document.execCommand('insertText', false, data.text);} catch {}
        if (!inserted && input.value === previous) {
          input.setRangeText(data.text, input.selectionStart, input.selectionEnd, 'select');
          input.dispatchEvent(new Event('input', {bubbles: true}));
        }
        input.setSelectionRange(selected ? start : 0, (selected ? start : 0) + data.text.length);
      } catch (error) {notify(error.message);}
    }
    const copy = async () => {
      try {await navigator.clipboard.writeText(text);} catch {
        input.focus(); input.setSelectionRange(selected ? start : 0, selected ? end : before.length);
        if (!document.execCommand('copy')) notify('選択した文字列をキーボードでコピーしてください。');
      }
    };
    openMenu(input, [
      {label: selected ? '選択範囲をコピー' : 'URLをコピー', run: copy},
      {label: 'すべて選択', run: () => {input.focus(); input.select();}}, null,
      {label: selected ? '選択範囲をURLエンコード' : 'URLエンコード', disabled: !text, run: () => convert('encode')},
      {label: selected ? '選択範囲をURLデコード' : 'URLデコード', disabled: !text, run: () => convert('decode')}
    ], event);
  }
  input.addEventListener('contextmenu', open);
  input.addEventListener('keydown', event => {if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) open(event);});
}
