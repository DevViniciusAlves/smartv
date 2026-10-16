import { contextBridge, ipcRenderer } from "electron";

// Minimal trusted bridge for the LOCAL home/top-bar UI only.
// Remote service pages never receive a preload script.
export interface SmartvApi {
  getApps(): Promise<Array<{ id: string; name: string; color: string }>>;
  openApp(id: string): Promise<{ ok: boolean; error?: string }>;
  goHome(): Promise<void>;
  onStatus(cb: (text: string) => void): () => void;
}

const api: SmartvApi = {
  getApps: () => ipcRenderer.invoke("smartv:get-apps"),
  openApp: (id: string) => ipcRenderer.invoke("smartv:open-app", id),
  goHome: () => ipcRenderer.invoke("smartv:go-home"),
  onStatus: (cb: (text: string) => void) => {
    const listener = (_e: unknown, text: string): void => cb(text);
    ipcRenderer.on("smartv:status", listener);
    return () => ipcRenderer.removeListener("smartv:status", listener);
  },
};

contextBridge.exposeInMainWorld("smartv", api);
