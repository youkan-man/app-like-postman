/** Saved scripts and their committed output are independent of HTTP requests. */
import {clone, uid} from './core.mjs';
import {checkName, upsertVariable, variableText} from './runtime.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && value.length > 0 && !value.includes(':') && value !== '__proto__';

export function newScript(name = '新しいスクリプト') {
  return {id:uid(), name:String(name), source:'', input:'null', inputFormat:'json', timeoutMs:0};
}

export function validScripts(value) {
  if (!Array.isArray(value)) return false;
  const ids = new Set();
  return value.every(script => {
    if (!record(script) || !validId(script.id) || ids.has(script.id) || typeof script.name !== 'string' ||
      typeof script.source !== 'string' || typeof script.input !== 'string' ||
      !['json','text'].includes(script.inputFormat) || !Number.isFinite(script.timeoutMs) || script.timeoutMs < 0) return false;
    ids.add(script.id);
    return true;
  });
}

export function validScriptData(value) {
  if (!record(value)) return false;
  const pending = [{value}], ancestors = new Set();
  while (pending.length) {
    const entry = pending.pop();
    if (entry.leaving) {ancestors.delete(entry.value); continue;}
    const current = entry.value;
    if (current === null || typeof current === 'string' || typeof current === 'boolean') continue;
    if (typeof current === 'number') {if (!Number.isFinite(current)) return false; continue;}
    if (typeof current !== 'object' || ancestors.has(current)) return false;
    if (!Array.isArray(current) && ![Object.prototype,null].includes(Object.getPrototypeOf(current))) return false;
    ancestors.add(current);
    pending.push({leaving:true,value:current});
    if (Object.getOwnPropertySymbols(current).length) return false;
    for (const key of Object.keys(current)) pending.push({value:current[key]});
    if (Array.isArray(current)) {
      if (Object.keys(current).length !== current.length) return false;
      for (let index=0;index<current.length;index++) if (!Object.hasOwn(current,index)) return false;
    }
  }
  return true;
}

export function ensureScripts(workspace) {
  if (workspace.scripts === undefined) workspace.scripts = [];
  if (workspace.scriptData === undefined) workspace.scriptData = {};
  if (!validScripts(workspace.scripts)) throw new Error('保存されたスクリプトの形式が不正です。');
  if (!validScriptData(workspace.scriptData)) throw new Error('保存されたスクリプトデータの形式が不正です。');
  return workspace;
}

export function parseScriptInput(script) {
  if (script.inputFormat === 'text') return script.input;
  try {return JSON.parse(script.input);} catch (error) {throw new Error(`入力のJSONを読み取れません: ${error.message}`);}
}

function variableWrites(value) {
  if (!Array.isArray(value)) throw new Error('スクリプトの変数変更形式が不正です。');
  return value.map(row => {
    if (!record(row)) throw new Error('スクリプトの変数変更形式が不正です。');
    const key = checkName(row.key);
    return row.remove ? {key,remove:true} : {key,value:variableText(row.value)};
  });
}

function updateRows(rows, writes) {
  for (const row of writes) {
    if (row.remove) {
      for (let at = rows.length - 1; at >= 0; at--) if (rows[at].key === row.key) rows.splice(at,1);
    } else upsertVariable(rows,row.key,row.value);
  }
  return rows;
}

function validateRows(rows, writes) {
  if (!Array.isArray(rows)) throw new Error('変数の保存形式が不正です。');
  updateRows(rows.map(row => ({...row})),writes);
}

/** Validate every write first; preserve unrelated edits made while a script was running. */
export function applyScriptWrites(workspace, primary, environment, output) {
  if (!record(output?.writes)) throw new Error('スクリプトの結果形式が不正です。');
  const writes = Object.fromEntries(['primary','environment','globals'].map(kind => [kind,variableWrites(output.writes[kind])]));
  if (writes.environment.length && !environment) throw new Error('環境を書き換えるには環境を選択してください。');
  if (writes.primary.length && typeof primary?.apply !== 'function') throw new Error('一次変数を更新できません。');
  if (writes.environment.length) validateRows(environment.values,writes.environment);
  if (writes.globals.length) validateRows(workspace.globals,writes.globals);
  const dataWrites = output.dataWrites ?? [];
  if (!Array.isArray(dataWrites)) throw new Error('スクリプトデータの変更形式が不正です。');
  let nextData;
  if (dataWrites.length) {
    const current = workspace.scriptData === undefined ? {} : workspace.scriptData;
    if (!validScriptData(current)) throw new Error('保存されたスクリプトデータの形式が不正です。');
    nextData = clone(current);
    for (const row of dataWrites) {
      if (!record(row) || typeof row.key !== 'string') throw new Error('スクリプトデータのキーは文字列で指定してください。');
      if (row.remove) delete nextData[row.key];
      else {
        if (!validScriptData({value:row.value})) throw new Error('スクリプトデータにはJSONで表せる値を指定してください。');
        Object.defineProperty(nextData,row.key,{value:clone(row.value),enumerable:true,configurable:true,writable:true});
      }
    }
  }
  if (writes.primary.length) primary.apply(writes.primary);
  if (writes.environment.length) updateRows(environment.values,writes.environment);
  if (writes.globals.length) updateRows(workspace.globals,writes.globals);
  if (nextData) workspace.scriptData = nextData;
  return Boolean(writes.environment.length || writes.globals.length || dataWrites.length);
}
