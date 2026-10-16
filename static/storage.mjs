/** Browser-only persistence. IndexedDB owns the data; localStorage is a bounded
 * compatibility cache, not a prerequisite for editing or restoring a backup. */
export const WORKSPACE_KEY = 'minipost.workspace.v2';
export const DATABASE_NAME = 'minipost.workspace.v1';
export const FALLBACK_KEY = 'minipost.workspace.fallback.v1';
const CACHE_LIMIT = 512 * 1024;
const preferenceKeys = ['minipost.layout.v1', 'minipost.sections.v1', 'minipost.navigation.v1', 'minipost.editor.page.v1'];
const own = (obj, key) => Object.hasOwn(obj, key);
const message = error => error?.message || String(error);

export class WorkspaceStorage {
  constructor({getDatabase = () => globalThis.indexedDB, getLocal = () => globalThis.localStorage} = {}) {
    this.getDatabase = getDatabase; this.getLocal = getLocal;
    this.database = null; this.preferences = {}; this.encoded = null;
    this.backend = 'localStorage'; this.blocked = false; this.warning = '';
    this.onPreferenceError = () => {};
  }
  localRead(key) {try {return this.getLocal()?.getItem(key) ?? null;} catch {return null;}}
  localWrite(key, value) {try {this.getLocal()?.setItem(key, value);} catch {}}
  localRemove(key) {try {this.getLocal()?.removeItem(key);} catch {}}
  async open() {
    const factory = this.getDatabase();
    if (!factory) throw new Error('IndexedDBを利用できません。');
    const database = await new Promise((resolve, reject) => {
      let settled = false;
      const request = factory.open(DATABASE_NAME, 1);
      const fail = error => {if (!settled) {settled = true; clearTimeout(timer); reject(error);}};
      const timer = setTimeout(() => fail(new Error('ローカル保存領域の応答がありません。')), 4000);
      request.onupgradeneeded = () => {if (!request.result.objectStoreNames.contains('state')) request.result.createObjectStore('state');};
      request.onblocked = () => fail(new Error('他のタブが保存領域を使用中です。'));
      request.onerror = () => fail(request.error || new Error('ローカル保存領域を開けません。'));
      request.onsuccess = () => {
        if (settled) {request.result.close(); return;}
        settled = true; clearTimeout(timer); resolve(request.result);
      };
    });
    database.onversionchange = () => {database.close(); this.database = null; this.blocked = true;};
    this.database = database; this.backend = 'indexedDB';
  }
  transaction(mode, action) {
    return new Promise((resolve, reject) => {
      if (!this.database) {reject(new Error('ローカル保存領域を再読込してください。')); return;}
      let transaction;
      try {
        transaction = this.database.transaction('state', mode);
        let result;
        transaction.oncomplete = () => resolve(typeof result === 'function' ? result() : result);
        transaction.onabort = () => reject(transaction.error || new Error('ローカル保存が中断されました。'));
        transaction.onerror = () => {}; // onabort is the final transaction result.
        result = action(transaction.objectStore('state'));
      } catch (error) {
        try {transaction?.abort();} catch {}
        reject(error);
      }
    });
  }
  async load(validate) {
    // Presentation preferences can be read before the first database migration.
    for (const key of preferenceKeys) {const raw = this.localRead(key); if (raw !== null) this.preferences[key] = raw;}
    try {await this.open();} catch (error) {
      this.warning = 'IndexedDBを利用できないため従来のブラウザ保存を使用します: ' + message(error);
    }
    try {
      let encoded = null, savedAt = 0;
      if (this.database) {
        const saved = await this.transaction('readonly', store => {
          const workspace = store.get('workspace'), preferences = store.get('preferences');
          return () => ({workspace: workspace.result, preferences: preferences.result});
        });
        if (saved.workspace) {
          encoded = saved.workspace.json; savedAt = saved.workspace.savedAt || 0;
        }
        if (saved.preferences) this.preferences = saved.preferences;
      }
      // If IndexedDB was unavailable on the preceding visit, migrate the newer
      // fallback only after it has been read and validated successfully.
      const fallbackRaw = this.localRead(FALLBACK_KEY);
      let fallback = null;
      try {fallback = fallbackRaw ? JSON.parse(fallbackRaw) : null;}
      catch (error) {if (!encoded) throw error; this.warning = '従来の保存データに不正な値があります。IndexedDBの保存内容を使用しています。';}
      if (fallback && (!encoded || fallback.savedAt > savedAt)) {
        if (typeof fallback.json !== 'string') throw new Error('ブラウザ保存の形式が不正です。');
        encoded = fallback.json; this.preferences = fallback.preferences || this.preferences;
      }
      if (!encoded) encoded = this.localRead(WORKSPACE_KEY);
      if (!encoded) return null;
      const workspace = JSON.parse(encoded);
      validate(workspace);
      this.encoded = encoded;
      if (this.database && (!savedAt || (fallback && fallback.savedAt > savedAt))) {
        await this.writeDatabase(encoded, this.preferences);
        this.localRemove(FALLBACK_KEY); this.mirror(encoded);
      }
      return workspace;
    } catch (error) {
      // Never replace an unreadable record with a fresh empty workspace on exit.
      this.blocked = true;
      throw error;
    }
  }
  writeDatabase(encoded, preferences) {
    const record = {json: encoded, savedAt: Date.now()};
    return this.transaction('readwrite', store => {
      store.put(record, 'workspace');
      if (preferences) store.put(preferences, 'preferences');
    });
  }
  mirror(encoded) {
    if (encoded.length > CACHE_LIMIT) {this.localRemove(WORKSPACE_KEY); return;}
    try {this.getLocal()?.setItem(WORKSPACE_KEY, encoded);}
    catch {this.localRemove(WORKSPACE_KEY);}
  }
  /** Starts the IndexedDB transaction synchronously, including on pagehide. */
  save(workspace, {layout, replace = false} = {}) {
    if (this.blocked && !replace) return Promise.reject(new Error('元の保存データを保護しています。バックアップの読込で復元してください。'));
    let encoded, preferences;
    try {
      encoded = JSON.stringify(workspace);
      preferences = {...this.preferences};
      if (layout?.layout) preferences['minipost.layout.v1'] = JSON.stringify(layout.layout);
      if (Array.isArray(layout?.sections)) preferences['minipost.sections.v1'] = JSON.stringify(layout.sections);
      if (layout?.navigation) preferences['minipost.navigation.v1'] = JSON.stringify(layout.navigation);
    } catch (error) {return Promise.reject(error);}
    let operation;
    if (this.backend === 'indexedDB') {
      // Workspace and imported presentation settings commit in one transaction.
      operation = this.writeDatabase(encoded, layout ? preferences : null);
    } else {
      try {
        this.getLocal().setItem(FALLBACK_KEY, JSON.stringify({json: encoded, preferences, savedAt: Date.now()}));
        operation = Promise.resolve();
      } catch (error) {operation = Promise.reject(error);}
    }
    return operation.then(() => {
      this.encoded = encoded; this.blocked = false;
      if (layout) {
        this.preferences = preferences;
        for (const [key, value] of Object.entries(preferences)) this.localWrite(key, value);
      }
      this.mirror(encoded);
      if (this.backend === 'indexedDB') this.localRemove(FALLBACK_KEY);
    });
  }
  /** Synchronous preference reads over the cache populated at startup. */
  getItem(key) {return own(this.preferences, key) ? this.preferences[key] : this.localRead(key);}
  setItem(key, value) {
    this.preferences = {...this.preferences, [key]: String(value)};
    this.localWrite(key, String(value));
    const preferences = {...this.preferences};
    let operation;
    try {
      if (this.backend === 'indexedDB') operation = this.transaction('readwrite', store => store.put(preferences, 'preferences'));
      else {
        if (this.encoded) this.getLocal().setItem(FALLBACK_KEY, JSON.stringify({json: this.encoded, preferences, savedAt: Date.now()}));
        operation = Promise.resolve();
      }
    } catch (error) {operation = Promise.reject(error);}
    operation.catch(error => this.onPreferenceError(error));
  }
}
