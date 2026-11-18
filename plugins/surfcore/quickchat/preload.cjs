// 只暴露发送 / 识别 / 收起 / 模式切换，页面拿不到 Node。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qc', {
  send: (text, withScreen) => ipcRenderer.invoke('qc:send', { text, withScreen: Boolean(withScreen) }),
  hear: (audio) => ipcRenderer.invoke('qc:hear', { audio }),
  hide: () => ipcRenderer.send('qc:hide'),
  onMode: (fn) => ipcRenderer.on('qc:mode', (_e, mode) => fn(mode)),
  onBlur: (fn) => ipcRenderer.on('qc:blur', () => fn()),
  onPtt: (fn) => ipcRenderer.on('qc:ptt', (_e, phase) => fn(phase)),
  showError: () => ipcRenderer.send('qc:show-error'),
});
