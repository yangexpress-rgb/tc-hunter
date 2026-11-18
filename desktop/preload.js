// What TC Hunter's own pages can ask of this app: the Workday reader's state, "Read now", and the
// "Open TC Hunter when this Mac starts" setting. Only TC Hunter's own address gets these.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tcDesktop", {
  readNow: () => ipcRenderer.invoke("tc:read-now"),
  status: () => ipcRenderer.invoke("tc:status"),
  openAtLogin: () => ipcRenderer.invoke("tc:open-at-login"),
  setOpenAtLogin: (on) => ipcRenderer.invoke("tc:set-open-at-login", !!on),
});
