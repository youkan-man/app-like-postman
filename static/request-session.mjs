/** Open editors are session state. Only an explicit draft belongs in workspace.tabs. */
import {clone, findItem, normalizeRequest, uid} from './core.mjs';
import {requestSettings} from './revisions.mjs';

export class RequestSession {
  constructor(workspace, createBlank) {
    this.workspace = workspace;
    this.createBlank = createBlank;
    this.temporary = new Map();
    this.historyEditors = new Map();
    this.savedEditors = new Set(workspace.tabs.filter(tab => this.savedItem(tab)).map(tab => tab.id));
    this.selectedId = workspace.activeId;
    this.blankId = null;
    const reference = workspace.activeRequest;
    if (reference) {
      const collection = workspace.collections.find(value => value._mpId === reference.collectionId);
      const item = findItem(collection, reference.itemId)?.item;
      if (item?.request) this.openSaved(collection, item);
      else delete workspace.activeRequest;
    }
  }
  all() {return [...this.workspace.tabs, ...this.temporary.values()];}
  get(id) {return this.workspace.tabs.find(tab => tab.id === id) || this.temporary.get(id);}
  savedItem(tab) {
    const collection = this.workspace.collections.find(value => value._mpId === tab.collectionId);
    const item = findItem(collection, tab.itemId)?.item;
    return item?.request ? item : null;
  }
  isTemporary(tab) {return this.temporary.has(tab.id);}
  isBlank(tab) {return tab.id === this.blankId;}
  get active() {
    let tab = this.get(this.selectedId) || this.get(this.workspace.activeId) || this.workspace.tabs[0];
    if (!tab) {
      tab = this.temporary.get(this.blankId);
      if (!tab) {
        tab = this.createBlank(); this.blankId = tab.id; this.temporary.set(tab.id, tab);
      }
    }
    this.selectedId = tab.id;
    return tab;
  }
  select(id) {
    const tab = this.get(id); if (!tab) return false;
    this.selectedId = id;
    if (this.workspace.tabs.includes(tab)) this.workspace.activeId = id;
    this.rememberSelection(tab);
    return true;
  }
  rememberSelection(tab = this.active) {
    if (this.savedItem(tab)) this.workspace.activeRequest = {collectionId:tab.collectionId, itemId:tab.itemId};
    else if (this.workspace.tabs.includes(tab)) delete this.workspace.activeRequest;
  }
  addDraft(tab = this.createBlank()) {
    tab.settings = requestSettings(tab.settings);
    if (!this.workspace.tabs.some(value => value.id === tab.id)) this.workspace.tabs.push(tab);
    this.temporary.delete(tab.id);
    for (const [key, id] of this.historyEditors) if (id === tab.id) this.historyEditors.delete(key);
    if (this.blankId === tab.id) this.blankId = null;
    this.select(tab.id); return tab;
  }
  markSaved(tab) {
    this.savedEditors.add(tab.id);
    for (const [key, id] of this.historyEditors) if (id === tab.id) this.historyEditors.delete(key);
    if (this.blankId === tab.id) this.blankId = null;
    this.select(tab.id);
  }
  openSaved(collection, item) {
    let tab = this.all().find(value => value.collectionId === collection._mpId && value.itemId === item._mpId);
    if (!tab) {
      tab = {...this.createBlank(), name:item.name, request:normalizeRequest(item.request),
        settings:requestSettings(item.settings), collectionId:collection._mpId, itemId:item._mpId};
      this.temporary.set(tab.id, tab);
    }
    this.savedEditors.add(tab.id); this.select(tab.id); return tab;
  }
  openHistory(entry) {
    const key = entry.id || entry;
    let tab = this.get(this.historyEditors.get(key));
    if (!tab) {
      const collection = this.workspace.collections.find(value => value._mpId === entry.tab.collectionId);
      const pendingFolderId = findItem(collection, entry.tab.itemId)?.parents.at(-1)?._mpId || entry.tab.pendingFolderId;
      tab = {...clone(entry.tab), id:uid(), itemId:undefined, pendingFolderId, dirty:false,
        settings:requestSettings(entry.tab.settings)};
      this.temporary.set(tab.id, tab); this.historyEditors.set(key, tab.id);
    }
    this.select(tab.id); return tab;
  }
  syncSaved() {
    for (const tab of this.all()) {
      const item = this.savedItem(tab);
      if (item) {
        tab.name = item.name; tab.request = normalizeRequest(item.request);
        tab.settings = requestSettings(item.settings); tab.dirty = false;
        this.savedEditors.add(tab.id);
      } else if (this.savedEditors.delete(tab.id)) {
        // Deleting a collection must not turn its old editor cache into new drafts.
        this.workspace.tabs = this.workspace.tabs.filter(value => value.id !== tab.id);
        this.temporary.set(tab.id, tab);
      }
    }
    if (!this.workspace.tabs.some(tab => tab.id === this.workspace.activeId)) this.workspace.activeId = this.workspace.tabs[0]?.id || '';
    if (this.workspace.activeRequest && !this.savedItem(this.workspace.activeRequest)) delete this.workspace.activeRequest;
  }
  remove(ids) {
    const removed = new Set(ids);
    this.workspace.tabs = this.workspace.tabs.filter(tab => !removed.has(tab.id));
    for (const id of removed) {this.temporary.delete(id); this.savedEditors.delete(id);}
    for (const [key, id] of this.historyEditors) if (removed.has(id)) this.historyEditors.delete(key);
    if (removed.has(this.blankId)) this.blankId = null;
    if (removed.has(this.selectedId)) this.selectedId = null;
    if (!this.workspace.tabs.some(tab => tab.id === this.workspace.activeId)) this.workspace.activeId = this.workspace.tabs[0]?.id || '';
  }
}
