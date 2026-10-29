/** Application confirmation, including when an editor/drawer is already open. */
let pending = null;
export function confirmAction(message, {title = '操作の確認', accept = '削除', danger = true} = {}) {
  // Never queue a destructive action behind an unrelated confirmation.
  if (pending) return Promise.resolve(false);
  return new Promise(resolve => {
    const returnTo = document.activeElement;
    const dialog = document.createElement('dialog'); dialog.className = 'app-confirm'; dialog.id = 'appConfirm';
    dialog.setAttribute('aria-labelledby', 'appConfirmTitle'); dialog.setAttribute('aria-describedby', 'appConfirmMessage');
    const heading = document.createElement('h2'); heading.id = 'appConfirmTitle'; heading.textContent = title;
    const description = document.createElement('p'); description.id = 'appConfirmMessage'; description.textContent = String(message);
    const actions = document.createElement('div'); actions.className = 'app-confirm-actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'button'; cancel.textContent = 'キャンセル'; cancel.autofocus = true;
    const submit = document.createElement('button'); submit.type = 'button'; submit.className = danger ? 'button danger' : 'button primary'; submit.textContent = accept;
    let finished = false;
    function finish(value) {
      if (finished) return; finished = true; pending = null;
      if (dialog.open) dialog.close(); dialog.remove();
      if (returnTo?.isConnected && !returnTo.closest('[inert]')) returnTo.focus({preventScroll: true});
      resolve(value);
    }
    pending = dialog;
    cancel.onclick = () => finish(false); submit.onclick = () => finish(true);
    dialog.addEventListener('cancel', event => {event.preventDefault(); event.stopPropagation(); finish(false);});
    dialog.addEventListener('close', () => finish(false));
    // Keep application-wide shortcuts away from editors behind the modal.
    dialog.addEventListener('keydown', event => event.stopPropagation());
    actions.append(cancel, submit); dialog.append(heading, description, actions); document.body.append(dialog);
    try {dialog.showModal(); cancel.focus({preventScroll: true});}
    catch {finish(false);}
  });
}
