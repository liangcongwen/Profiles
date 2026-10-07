'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('get-state'),
  setTasks: (tasks) => ipcRenderer.invoke('set-tasks', tasks),
  setCategories: (cats) => ipcRenderer.invoke('set-categories', cats),
  completeTask: (id) => ipcRenderer.invoke('complete-task', id),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  getTask: (id) => ipcRenderer.invoke('get-task', id),
  reminderAction: (id, action, minutes) => ipcRenderer.invoke('reminder-action', id, action, minutes),
  exportData: () => ipcRenderer.invoke('export-data'),
  importData: () => ipcRenderer.invoke('import-data'),
  win: (cmd) => ipcRenderer.send('win', cmd),
  setEditing: (v) => ipcRenderer.send('editing', v),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onFocusInput: (cb) => ipcRenderer.on('focus-input', () => cb())
});
