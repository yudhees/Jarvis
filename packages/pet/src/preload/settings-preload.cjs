// Preload for the Settings window. Plain CommonJS because Electron's sandbox requires it.
// The page gets exactly these calls; the main process checks every argument.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvisSettings', {
  load: () => ipcRenderer.invoke('settings:load'),
  saveAppearance: (patch) => ipcRenderer.invoke('settings:appearance', patch),
  setLogo: (dataUrl) => ipcRenderer.invoke('settings:logo', String(dataUrl)),
  clearLogo: () => ipcRenderer.invoke('settings:clear-logo'),
  saveBehavior: (patch) => ipcRenderer.invoke('settings:behavior', patch),
  saveCore: (patch) => ipcRenderer.invoke('settings:core', patch),
  voices: () => ipcRenderer.invoke('settings:voices'),
  preview: (voice, rate, text) =>
    ipcRenderer.invoke('settings:preview', voice, Number(rate), String(text)),
  startCore: () => ipcRenderer.invoke('settings:start-core'),
  stopCore: () => ipcRenderer.invoke('settings:stop-core'),
  restartCore: () => ipcRenderer.invoke('settings:restart-core'),
  /** 'running' | 'starting' | 'restarting' | 'stopped', whenever it changes. */
  onStatus(callback) {
    ipcRenderer.on('settings:status', (_event, status) => callback(String(status)));
  },
  usage: (days) => ipcRenderer.invoke('settings:usage', Number(days)),
  /** Ask Jarvis to listen once and report what it heard (nothing is answered). */
  voiceTest: () => ipcRenderer.invoke('settings:voice-test'),
  onVoiceTest(callback) {
    ipcRenderer.on('settings:voice-test', (_event, result) => callback(result));
  },
  /** The last 10 conversations, newest first. */
  history: () => ipcRenderer.invoke('settings:history'),
  /** Save as JSONL: 'recent' (the last 10) or 'all' (everything kept). */
  downloadHistory: (scope) =>
    ipcRenderer.invoke('settings:history-download', scope === 'all' ? 'all' : 'recent'),
  openConfigFolder: () => ipcRenderer.invoke('settings:open-config'),
});
