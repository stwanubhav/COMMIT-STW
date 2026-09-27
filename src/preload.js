const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Open native folder picker
  pickFolder: () => ipcRenderer.invoke('pick-folder'),

  // Start the full commit pipeline
  startCommit: (options) => ipcRenderer.invoke('start-commit', options),

  // Cancel an in-progress run
  cancelCommit: () => ipcRenderer.invoke('cancel-commit'),

  // Listen for streamed progress events from main process
  onProgress: (callback) => {
    ipcRenderer.on('progress-update', (_event, data) => callback(data));
  },

  // Remove all progress listeners (cleanup)
  removeProgressListeners: () => {
    ipcRenderer.removeAllListeners('progress-update');
  }
});
