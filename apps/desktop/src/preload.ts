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
  goBack(): Promise<{ ok: boolean; error?: string }>;
  onStatus(cb: (text: string) => void): () => void;
  onCanGoBack(cb: (can: boolean) => void): () => void;
  getRemote(): Promise<RemoteInfo>;
  setRemote(cfg: { backendUrl: string; agentToken: string }): Promise<{ ok: boolean; error?: string; status?: string }>;
  onRemoteStatus(cb: (text: string) => void): () => void;
  onRemoteLink(cb: (info: RemoteLinkInfo) => void): () => void;
  requestPairCode(): Promise<{ ok: boolean }>;
  onPairCode(cb: (info: PairCodeInfo) => void): () => void;
  openConn(): Promise<void>;
  closeConn(): Promise<void>;
  onPairActive(cb: (on: boolean) => void): () => void;
  quit(): Promise<void>;
  checkUpdates(): Promise<void>;
  downloadUpdate(): Promise<void>;
  restartApp(): Promise<void>;
  onUpdateEvent(cb: (ev: string) => void): () => void;
}

const api: SmartvApi = {
  getApps: () => ipcRenderer.invoke("smartv:get-apps"),
  openApp: (id: string) => ipcRenderer.invoke("smartv:open-app", id),
  goHome: () => ipcRenderer.invoke("smartv:go-home"),
  goBack: () => ipcRenderer.invoke("smartv:go-back"),
  onStatus: (cb: (text: string) => void) => {
    const listener = (_e: unknown, text: string): void => cb(text);
    ipcRenderer.on("smartv:status", listener);
    return () => ipcRenderer.removeListener("smartv:status", listener);
  },
  onCanGoBack: (cb: (can: boolean) => void) => {
    const listener = (_e: unknown, can: boolean): void => cb(can);
    ipcRenderer.on("smartv:can-go-back", listener);
    return () => ipcRenderer.removeListener("smartv:can-go-back", listener);
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
  openConn: () => ipcRenderer.invoke("smartv:conn-open"),
  closeConn: () => ipcRenderer.invoke("smartv:conn-close"),
  onPairActive: (cb: (on: boolean) => void) => {
    const listener = (_e: unknown, on: boolean): void => cb(on);
    ipcRenderer.on("smartv:pair-active", listener);
    return () => ipcRenderer.removeListener("smartv:pair-active", listener);
  },
  quit: () => ipcRenderer.invoke("smartv:quit"),
  checkUpdates: () => ipcRenderer.invoke("smartv:check-updates"),
  downloadUpdate: () => ipcRenderer.invoke("smartv:download-update"),
  restartApp: () => ipcRenderer.invoke("smartv:restart-app"),
  onUpdateEvent: (cb: (ev: string) => void) => {
    const listener = (_e: unknown, ev: string): void => cb(ev);
    ipcRenderer.on("smartv:update-event", listener);
    return () => ipcRenderer.removeListener("smartv:update-event", listener);
  },
};

contextBridge.exposeInMainWorld("smartv", api);
