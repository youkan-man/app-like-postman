/** Application-owned confirmation. Never calls window.alert/confirm/prompt. */
export function confirmAction(message, {title = '操作の確認', accept = '実行', danger = false} = {}) {
  return new Promise(resolve => {
    const previous = document.activeElement;
    const dialog = document.createElement('dialog');dialog.className = 'confirm-dialog';
    dialog.setAttribute('aria-label', title);dialog.setAttribute('aria-modal', 'true');
    const heading = document.createElement('div');heading.className = 'dialog-heading';
    const name = document.createElement('h2');name.textContent = title;heading.append(name);
    const content = document.createElement('p');content.className = 'confirm-message';content.textContent = message;
    const footer = document.createElement('div');footer.className = 'dialog-footer';
    const cancel = document.createElement('button');cancel.type = 'button';cancel.className = 'button';cancel.textContent = 'キャンセル';cancel.dataset.confirmCancel = '';
    const ok = document.createElement('button');ok.type = 'button';ok.className = danger ? 'button confirm-danger' : 'button primary';ok.textContent = accept;ok.dataset.confirmAccept = '';
    let settled = false;
    const finish = value => {
      if (settled) return;settled = true;dialog.close();dialog.remove();
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({preventScroll: true});
      resolve(value);
    };
    cancel.onclick = () => finish(false);ok.onclick = () => finish(true);
    dialog.addEventListener('keydown', event => event.stopPropagation());
    dialog.addEventListener('cancel', event => {event.preventDefault();finish(false);});
    dialog.addEventListener('close', () => finish(false));
    footer.append(cancel, ok);dialog.append(heading, content, footer);document.body.append(dialog);
    dialog.showModal();cancel.focus();
  });
}
