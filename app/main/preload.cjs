const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openArw: () => ipcRenderer.invoke('dialog:openArw'),
  saveImage: (dataUrl, suggestedName) => ipcRenderer.invoke('dialog:saveImage', dataUrl, suggestedName),
});
