// Preload for the pet window. Plain CommonJS because Electron's sandbox requires it.
// The page gets exactly these five calls and nothing else from Node or Electron.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvisPet', {
  /** Receive events from core (already validated in the main process). */
  onEvent(callback) {
    ipcRenderer.on('pet:event', (_event, data) => callback(data));
    ipcRenderer.send('pet:ready');
  },
  /** true while the pointer is over the pet or its bubble, so the rest stays click-through. */
  setInteractive(on) {
    ipcRenderer.send('pet:interactive', on === true);
  },
  dragStart(offsetX, offsetY) {
    ipcRenderer.send('pet:drag-start', { x: Number(offsetX), y: Number(offsetY) });
  },
  dragEnd() {
    ipcRenderer.send('pet:drag-end');
  },
  clicked() {
    ipcRenderer.send('pet:clicked');
  },
});
