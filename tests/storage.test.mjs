import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceStorage, WORKSPACE_KEY, FALLBACK_KEY} from '../static/storage.mjs';

const validate = ws => {if (ws.version !== 2) throw new Error('invalid workspace');};
const workspace = text => ({version: 2, text});
function local(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {data, limit: Infinity, denied: false,
    getItem(key) {return data.get(key) ?? null;},
    setItem(key, value) {
      if (this.denied || String(value).length > this.limit) throw new DOMException('full', 'QuotaExceededError');
      data.set(key, String(value));
    },
    removeItem(key) {if (!this.denied) data.delete(key);}
  };
}
/** A transactional test double. Native IndexedDB is exercised in ui_storage.py. */
function database() {
  const db = {data: new Map(), chain: Promise.resolve(), failNextWrite: false,
    objectStoreNames: {contains: () => true}, close() {},
    transaction(_name, mode) {
      const operations = [], tx = {error: null, aborted: false,
        abort() {this.aborted = true;},
        objectStore() {return {
          get(key) {const req = {}; operations.push(['get', key, req]); return req;},
          put(value, key) {operations.push(['put', key, structuredClone(value)]);}
        };}
      };
      db.chain = db.chain.then(() => new Promise(resolve => queueMicrotask(() => {
        if (mode === 'readwrite' && db.failNextWrite) {db.failNextWrite = false; tx.aborted = true; tx.error = new Error('disk full');}
        const pending = new Map(db.data);
        for (const [operation, key, value] of operations) {
          if (operation === 'get') value.result = structuredClone(pending.get(key));
          else pending.set(key, value);
        }
        if (tx.aborted) tx.onabort?.();
        else {db.data = pending; tx.oncomplete?.();}
        resolve();
      })));
      return tx;
    }};
  const factory = {open() {const request = {result: db}; queueMicrotask(() => request.onsuccess?.()); return request;}};
  return {db, factory};
}
async function create(localStore, factory) {
  const store = new WorkspaceStorage({getLocal: () => localStore, getDatabase: () => factory});
  const value = await store.load(validate);
  return {store, value};
}

test('migrates the existing workspace without removing content or history', async () => {
  const original = {version: 2, history: [{text: 'keep'}], text: 'old'};
  const ls = local({[WORKSPACE_KEY]: JSON.stringify(original)}), {factory, db} = database();
  const {store, value} = await create(ls, factory);
  assert.deepEqual(value, original); assert.equal(store.backend, 'indexedDB');
  assert.deepEqual(JSON.parse(db.data.get('workspace').json), original);
});
test('workspace writes and reload work while localStorage is denied', async () => {
  const ls = local(), {factory} = database(); const {store} = await create(ls, factory);
  ls.denied = true;
  await store.save(workspace('survives'));
  const reloaded = await create(ls, factory); assert.equal(reloaded.value.text, 'survives');
});
test('large bodies are kept intact in IndexedDB, not duplicated in localStorage', async () => {
  const ls = local(), {factory} = database(); const {store} = await create(ls, factory);
  const data = workspace('x'.repeat(6 * 1024 * 1024));
  await store.save(data);
  assert.equal(ls.getItem(WORKSPACE_KEY), null);
  assert.deepEqual((await create(ls, factory)).value, data);
});
test('large legacy data is removed only after migration commits', async () => {
  const data = workspace('x'.repeat(600000)), ls = local({[WORKSPACE_KEY]: JSON.stringify(data)}), {db, factory} = database();
  db.failNextWrite = true;
  const store = new WorkspaceStorage({getLocal: () => ls, getDatabase: () => factory});
  await assert.rejects(store.load(validate), /disk full/);
  assert.equal(ls.getItem(WORKSPACE_KEY), JSON.stringify(data));
  await assert.rejects(store.save(workspace('empty')), /元の保存データ/);
});
test('atomic restore succeeds despite full localStorage and restores layout', async () => {
  const ls = local(), {factory} = database(); const {store} = await create(ls, factory);
  await store.save(workspace('before')); ls.denied = true;
  await store.save(workspace('restored'), {replace: true, layout: {layout: {sidebar: 410}, sections: ['body'], navigation: {editor: 'body'}}});
  const next = await create(ls, factory);
  assert.equal(next.value.text, 'restored');
  assert.deepEqual(JSON.parse(next.store.getItem('minipost.layout.v1')), {sidebar: 410});
});
test('failed transaction leaves both workspace and preferences unchanged', async () => {
  const ls = local(), {db, factory} = database(); const {store} = await create(ls, factory);
  await store.save(workspace('before'), {layout: {sections: ['headers']}});
  const before = structuredClone(db.data); db.failNextWrite = true;
  await assert.rejects(store.save(workspace('rejected'), {replace: true, layout: {sections: ['body']}}), /disk full/);
  assert.deepEqual(db.data, before);
  assert.equal((await create(ls, factory)).value.text, 'before');
});
test('a later save wins even when earlier saves are still in flight', async () => {
  const ls = local(), {factory} = database(); const {store} = await create(ls, factory);
  await Promise.all([store.save(workspace('one')), store.save(workspace('two')), store.save(workspace('three'))]);
  assert.equal((await create(ls, factory)).value.text, 'three');
});
test('corrupt data cannot be silently overwritten by an empty autosave', async () => {
  const ls = local({[WORKSPACE_KEY]: '{broken'}), {factory} = database();
  const store = new WorkspaceStorage({getLocal: () => ls, getDatabase: () => factory});
  await assert.rejects(store.load(validate));
  await assert.rejects(store.save(workspace('fresh')), /元の保存データ/);
  assert.equal(ls.getItem(WORKSPACE_KEY), '{broken');
  await store.save(workspace('explicit recovery'), {replace: true});
  assert.equal((await create(ls, factory)).value.text, 'explicit recovery');
});
test('a corrupt obsolete fallback does not hide a valid database workspace', async () => {
  const ls = local(), {factory} = database(); const {store} = await create(ls, factory);
  await store.save(workspace('valid')); ls.data.set(FALLBACK_KEY, '{broken');
  assert.equal((await create(ls, factory)).value.text, 'valid');
});
test('fallback storage works without IndexedDB and later migrates', async () => {
  const ls = local(); const {store} = await create(ls, null);
  assert.equal(store.backend, 'localStorage');
  await store.save(workspace('fallback'), {layout: {sections: ['body']}});
  assert.equal((await create(ls, null)).value.text, 'fallback');
  const {factory} = database(); const migrated = await create(ls, factory);
  assert.equal(migrated.value.text, 'fallback'); assert.equal(ls.getItem(FALLBACK_KEY), null);
  assert.equal(migrated.store.getItem('minipost.sections.v1'), '["body"]');
});
test('fallback quota failure does not partially replace data or layout', async () => {
  const ls = local(); const {store} = await create(ls, null);
  await store.save(workspace('old'), {layout: {sections: ['headers']}});
  const before = new Map(ls.data); ls.limit = 50;
  await assert.rejects(store.save(workspace('x'.repeat(500)), {replace: true, layout: {sections: ['body']}}));
  assert.deepEqual(ls.data, before); assert.equal(store.getItem('minipost.sections.v1'), '["headers"]');
});
test('presentation preferences persist independently from request revisions', async () => {
  const ls = local(), {factory, db} = database(); const {store} = await create(ls, factory);
  await store.save(workspace('unchanged')); const before = db.data.get('workspace');
  ls.denied = true; store.setItem('minipost.navigation.v1', '{"editor":"body"}'); await db.chain;
  assert.deepEqual(db.data.get('workspace'), before);
  assert.equal((await create(ls, factory)).store.getItem('minipost.navigation.v1'), '{"editor":"body"}');
});
test('version changes close the old connection without silently changing backend', async () => {
  const ls = local(), {factory, db} = database(); const {store} = await create(ls, factory);
  db.onversionchange(); await assert.rejects(store.save(workspace('blocked')));
  assert.equal(ls.getItem(FALLBACK_KEY), null);
});

test('preference-only changes survive before the first workspace save', async () => {
  const ls = local(), {factory, db} = database(); const {store} = await create(ls, factory);
  ls.denied = true; store.setItem('minipost.sections.v1', '["body"]'); await db.chain;
  const next = await create(ls, factory);
  assert.equal(next.value, null); assert.equal(next.store.getItem('minipost.sections.v1'), '["body"]');
});
test('fallback preference writes cannot overwrite a newer same-turn workspace save', async () => {
  const ls = local(); const {store} = await create(ls, null);
  await store.save(workspace('old'));
  store.setItem('minipost.sections.v1', '["body"]');
  await store.save(workspace('new'));
  assert.equal((await create(ls, null)).value.text, 'new');
});
