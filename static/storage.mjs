/** Browser-only persistence. IndexedDB owns the data; localStorage is a bounded
 * compatibility cache, not a prerequisite for editing or restoring a backup. */
export const WORKSPACE_KEY = 'minipost.workspace.v2';
export const DATABASE_NAME = 'minipost.workspace.v1';
export const FALLBACK_KEY = 'minipost.workspace.fallback.v1';
const CACHE_LIMIT = 512 * 1024;
const DATABASE_USED_KEY = 'minipost.workspace.indexed.v1';
const PREFERENCES_CACHE_KEY = 'minipost.preferences.v1';
const timestamp = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const preferenceKeys = ['minipost.layout.v1', 'minipost.sections.v1', 'minipost.navigation.v1', 'minipost.editor.page.v1'];
const own = (obj, key) => Object.hasOwn(obj, key);
const message = error => error?.message || String(error);

export class WorkspaceStorage {
  constructor({getDatabase = () => globalThis.indexedDB, getLocal = () => globalThis.localStorage} = {}) {
    this.getDatabase = getDatabase; this.getLocal = getLocal;
    this.database = null; this.preferences = {}; this.encoded = null;
    this.backend = 'localStorage'; this.blocked = false; this.warning = '';
    this.onPreferenceError = () => {};
    this.clock = 0; this.committedAt = 0; this.preferencesAt = 0;
  }
  localRead(key) {try {return this.getLocal()?.getItem(key) ?? null;} catch {return null;}}
  localWrite(key, value) {try {this.getLocal()?.setItem(key, value);} catch {}}
  localRemove(key) {try {this.getLocal()?.removeItem(key);} catch {}}
  nextTimestamp() {return this.clock = Math.max(Date.now(), this.clock + 1, timestamp(this.localRead(DATABASE_USED_KEY)) + 1);}
  cachePreferences() {this.localWrite(PREFERENCES_CACHE_KEY, JSON.stringify({preferences: this.preferences, savedAt: this.preferencesAt}));}
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
        transaction = this.database.transaction('state', mode, mode === 'readwrite' ? {durability: 'strict'} : undefined);
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
      // A temporarily inaccessible primary database is not a new empty profile.
      // Do not create a newer empty fallback which would later replace it.
      if (this.localRead(DATABASE_USED_KEY) && !this.localRead(FALLBACK_KEY)) {
        this.blocked = true;
        throw new Error('以前のIndexedDB保存領域を開けません。元データは保持しています。再読込するか、バックアップを明示的に取り込んでください。 ' + message(error));
      }
      this.warning = 'IndexedDBを利用できないため従来のブラウザ保存を使用します: ' + message(error);
    }
    try {
      let encoded = null, savedAt = 0;
      if (this.database) {
        const saved = await this.transaction('readonly', store => {
          const workspace = store.get('workspace'), preferences = store.get('preferences'), preferencesAt = store.get('preferencesAt');
          return () => ({workspace: workspace.result, preferences: preferences.result, preferencesAt: preferencesAt.result});
        });
        if (saved.workspace) {
          encoded = saved.workspace.json; savedAt = timestamp(saved.workspace.savedAt);
          this.committedAt = savedAt; this.clock = Math.max(this.clock, savedAt);
          this.localWrite(DATABASE_USED_KEY, String(savedAt));
        }
        if (saved.preferences) this.preferences = saved.preferences;
        this.preferencesAt = timestamp(saved.preferencesAt); this.clock = Math.max(this.clock, this.preferencesAt);
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
        this.preferencesAt = timestamp(fallback.preferencesAt ?? fallback.savedAt);
        this.clock = Math.max(this.clock, timestamp(fallback.savedAt), this.preferencesAt);
      }
      // Small presentation changes are mirrored synchronously. A browser may
      // end the document before its last IndexedDB transaction has committed.
      // Reconcile by revision, never let an old cache undo an imported layout.
      try {
        const cached = JSON.parse(this.localRead(PREFERENCES_CACHE_KEY));
        if (cached?.preferences && timestamp(cached.savedAt) > this.preferencesAt) {
          this.preferences = cached.preferences; this.preferencesAt = timestamp(cached.savedAt);
          this.clock = Math.max(this.clock, this.preferencesAt);
        }
      } catch {} // A corrupt presentation cache does not invalidate user data.
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
    const record = {json: encoded, savedAt: this.nextTimestamp()};
    return this.transaction('readwrite', store => {
      store.put(record, 'workspace');
      if (preferences) {store.put(preferences, 'preferences'); store.put(record.savedAt, 'preferencesAt');}
    }).then(() => {
      this.committedAt = record.savedAt;
      if (preferences) this.preferencesAt = record.savedAt;
    });
  }
  mirror(encoded) {
    if (encoded.length > CACHE_LIMIT) this.localRemove(WORKSPACE_KEY);
    else {
      try {this.getLocal()?.setItem(WORKSPACE_KEY, encoded);}
      catch {this.localRemove(WORKSPACE_KEY);}
    }
    if (this.backend === 'indexedDB') this.localWrite(DATABASE_USED_KEY, String(this.committedAt));
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
    const complete = () => {
      this.encoded = encoded; this.blocked = false;
      if (layout) {
        this.preferences = preferences;
        for (const [key, value] of Object.entries(preferences)) this.localWrite(key, value);
        this.cachePreferences();
      }
      this.mirror(encoded);
      if (this.backend === 'indexedDB') this.localRemove(FALLBACK_KEY);
    };
    if (this.backend === 'indexedDB') {
      // Workspace and imported presentation settings commit in one transaction.
      return this.writeDatabase(encoded, layout ? preferences : null).then(complete);
    }
    try {
      const savedAt = this.nextTimestamp();
      this.getLocal().setItem(FALLBACK_KEY, JSON.stringify({json: encoded, preferences, savedAt, preferencesAt: layout ? savedAt : this.preferencesAt}));
      if (layout) this.preferencesAt = savedAt;
      // The fallback write is already durable synchronously. Update its cache
      // now, before a same-turn navigation preference write can use old data.
      complete();
      return Promise.resolve();
    } catch (error) {return Promise.reject(error);}
  }

  /** Synchronous preference reads over the cache populated at startup. */
  getItem(key) {return own(this.preferences, key) ? this.preferences[key] : this.localRead(key);}
  setItem(key, value) {
    this.preferences = {...this.preferences, [key]: String(value)};
    this.localWrite(key, String(value));
    this.preferencesAt = this.nextTimestamp(); this.cachePreferences();
    const preferences = {...this.preferences};
    let operation;
    try {
      if (this.backend === 'indexedDB') {
        const savedAt = this.preferencesAt;
        operation = this.transaction('readwrite', store => {store.put(preferences, 'preferences'); store.put(savedAt, 'preferencesAt');});
      }
      else {
        if (this.encoded) this.getLocal().setItem(FALLBACK_KEY, JSON.stringify({json: this.encoded, preferences, savedAt: this.nextTimestamp(), preferencesAt: this.preferencesAt}));
        operation = Promise.resolve();
      }
    } catch (error) {operation = Promise.reject(error);}
    operation.catch(error => this.onPreferenceError(error));
  }
}
