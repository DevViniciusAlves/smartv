import { contextBridge, ipcRenderer } from "electron";

// Minimal trusted bridge for the LOCAL home/top-bar UI only.
// Remote service pages never receive a preload script.
export interface RemoteInfo {
  backendUrl: string;
  hasToken: boolean;
  tokenMasked: string;
  enabled: boolean;
  status: string;
  source: string;
  link: "DESCONECTADO" | "CONECTANDO" | "CONECTADO";
  linkedPhones: number;
}

export interface PairCodeInfo {
  code: string;
  expiresAt: number;
}

export interface RemoteLinkInfo {
  link: RemoteInfo["link"];
  linkedPhones: number;
}

export interface SmartvApi {
  getApps(): Promise<Array<{ id: string; name: string; color: string }>>;
  openApp(id: string): Promise<{ ok: boolean; error?: string }>;
  goHome(): Promise<void>;
  onStatus(cb: (text: string) => void): () => void;
  getRemote(): Promise<RemoteInfo>;
  setRemote(cfg: { backendUrl: string; agentToken: string }): Promise<{ ok: boolean; error?: string; status?: string }>;
  onRemoteStatus(cb: (text: string) => void): () => void;
  onRemoteLink(cb: (info: RemoteLinkInfo) => void): () => void;
  requestPairCode(): Promise<{ ok: boolean }>;
  onPairCode(cb: (info: PairCodeInfo) => void): () => void;
  quit(): Promise<void>;
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
  getRemote: () => ipcRenderer.invoke("smartv:get-remote"),
  setRemote: (cfg: { backendUrl: string; agentToken: string }) =>
    ipcRenderer.invoke("smartv:set-remote", cfg),
  onRemoteStatus: (cb: (text: string) => void) => {
    const listener = (_e: unknown, text: string): void => cb(text);
    ipcRenderer.on("smartv:remote-status", listener);
    return () => ipcRenderer.removeListener("smartv:remote-status", listener);
  },
  onRemoteLink: (cb: (info: RemoteLinkInfo) => void) => {
    const listener = (_e: unknown, info: RemoteLinkInfo): void => cb(info);
    ipcRenderer.on("smartv:remote-link", listener);
    return () => ipcRenderer.removeListener("smartv:remote-link", listener);
  },
  requestPairCode: () => ipcRenderer.invoke("smartv:pair-code-request"),
  onPairCode: (cb: (info: PairCodeInfo) => void) => {
    const listener = (_e: unknown, info: PairCodeInfo): void => cb(info);
    ipcRenderer.on("smartv:pair-code", listener);
    return () => ipcRenderer.removeListener("smartv:pair-code", listener);
  },
  quit: () => ipcRenderer.invoke("smartv:quit"),
};

contextBridge.exposeInMainWorld("smartv", api);
