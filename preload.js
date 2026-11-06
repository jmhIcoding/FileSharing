'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** 统一解包 main 进程的 { ok, data, error } 结果 */
async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res || res.ok !== true) {
    const err = new Error((res && res.error) || '操作失败');
    throw err;
  }
  return res.data;
}

const api = {
  // 应用级
  init: () => call('app:init'),
  checkGit: () => call('app:check-git'),
  saveGlobals: (patch) => call('app:save-globals', patch),
  applyCredential: (id) => call('app:apply-credential', id),
  pickFolder: (defaultPath) => call('app:pick-folder', defaultPath),
  openPath: (p) => call('app:open-path', p),
  showInFolder: (p) => call('app:show-in-folder', p),
  openLogs: () => call('app:open-logs'),
  copy: (text) => call('app:copy', text),
  quit: () => call('app:quit'),
  minimize: () => call('app:minimize'),
  hide: () => call('app:hide'),
  setTitleBarTheme: (theme) => call('app:set-titlebar-theme', theme),
  syncAll: () => call('sync:all'),
  recentLogs: (limit) => call('logs:recent', limit),

  // 项目
  project: {
    save: (input) => call('project:save', input),
    remove: (id) => call('project:delete', id),
    test: (input) => call('project:test', input),
    sync: (id) => call('project:sync', id),
    inspect: (id) => call('project:inspect', id),
    commitPush: (id, message) => call('project:commit-push', { id, message }),
    push: (id) => call('project:push', id),
    discard: (id) => call('project:discard', id),
    fileDecision: (payload) => call('project:file-decision', payload),
    resolve: (id, file, strategy) => call('project:resolve', { id, file, strategy }),
    finishMerge: (id, push) => call('project:finish-merge', { id, push }),
    abortMerge: (id) => call('project:abort-merge', id),
    openFile: (id, file) => call('project:open-file', { id, file }),
    showFile: (id, file) => call('project:show-file', { id, file }),
  },

  // 事件
  onEngineUpdate: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('engine:update', handler);
    return () => ipcRenderer.removeListener('engine:update', handler);
  },
  onLog: (cb) => {
    const handler = (_e, entry) => cb(entry);
    ipcRenderer.on('log:line', handler);
    return () => ipcRenderer.removeListener('log:line', handler);
  },
  onFocusProject: (cb) => {
    const handler = (_e, id) => cb(id);
    ipcRenderer.on('ui:focus-project', handler);
    return () => ipcRenderer.removeListener('ui:focus-project', handler);
  },
};

contextBridge.exposeInMainWorld('api', api);
