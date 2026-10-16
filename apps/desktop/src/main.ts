import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, WebContentsView, ipcMain, session } from "electron";
import { STREAMING_APPS } from "@smartv/shared";
import { appUrl, isAllowedAppId, isAllowedNavigation } from "./security.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = __dirname;
const DEV_DEBUG = process.argv.includes("--smartv-dev");

// Persistent, isolated profile for the streaming services (cookies and
// logins survive restarts). One partition for all services, exactly like a
// single browser profile; services stay isolated per-domain by the platform.
const SERVICE_PARTITION = "persist:smartv";

let win: BrowserWindow | null = null;
let barView: WebContentsView | null = null;
let homeView: WebContentsView | null = null;
let serviceView: WebContentsView | null = null;
let currentApp: string | null = null;

const COMMON_WEB_PREFS = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
} as const;

function distFile(...parts: string[]): string {
  return path.join(DIST, ...parts);
}

function setStatus(text: string): void {
  homeView?.webContents.send("smartv:status", text);
  barView?.webContents.send("smartv:status", text);
}

function layout(): void {
  if (!win || !barView || !homeView || !serviceView) return;
  const { width, height } = win.getContentBounds();
  const BAR_H = 56;
  barView.setBounds({ x: 0, y: 0, width, height: BAR_H });
  const content = { x: 0, y: BAR_H, width, height: height - BAR_H };
  if (currentApp) {
    homeView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    serviceView.setBounds(content);
  } else {
    serviceView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    homeView.setBounds(content);
  }
}

function showHome(status = ""): void {
  currentApp = null;
  layout();
  if (status) setStatus(status);
  homeView?.webContents.focus();
}

function openService(id: string): { ok: boolean; error?: string } {
  const url = appUrl(id);
  if (!url) return { ok: false, error: "unknown app" };
  currentApp = id;
  setStatus(`Abrindo ${id}…`);
  void serviceView?.webContents.loadURL(url);
  layout();
  serviceView?.webContents.focus();
  return { ok: true };
}

function guardServiceView(view: WebContentsView): void {
  const wc = view.webContents;
  // Top-level navigation locked to the allowlist.
  wc.on("will-navigate", (e, url) => {
    if (!isAllowedNavigation(url)) {
      e.preventDefault();
      console.warn(`[smartv] blocked navigation: ${url}`);
    }
  });
  // No new windows: allowlisted destinations reuse the same view.
  wc.setWindowOpenHandler(({ url }) => {
    if (isAllowedNavigation(url)) {
      void wc.loadURL(url);
    } else {
      console.warn(`[smartv] blocked popup: ${url}`);
    }
    return { action: "deny" };
  });
  wc.on("did-start-loading", () => setStatus("Carregando…"));
  wc.on("did-stop-loading", () => setStatus(currentApp ? `${currentApp}` : ""));
  wc.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    console.warn(`[smartv] load failed (${code} ${desc}): ${url}`);
    showHome(`Falha ao carregar. Verifique a internet e tente de novo.`);
  });
  // Consistent way back: Escape always returns Home.
  wc.on("before-input-event", (_e, input) => {
    if (input.type === "keyDown" && input.key === "Escape") showHome();
  });
}

async function createWindow(): Promise<void> {
  // Ensures the persistent service partition exists (cookies survive restarts).
  session.fromPartition(SERVICE_PARTITION, { cache: true });

  win = new BrowserWindow({
    fullscreen: true,
    autoHideMenuBar: true,
    backgroundColor: "#0b0e14",
    title: "SmartTV",
    webPreferences: { ...COMMON_WEB_PREFS },
  });
  win.on("closed", () => {
    win = null;
  });
  win.on("resize", layout);

  barView = new WebContentsView({
    webPreferences: { ...COMMON_WEB_PREFS, preload: distFile("preload.js") },
  });
  homeView = new WebContentsView({
    webPreferences: { ...COMMON_WEB_PREFS, preload: distFile("preload.js") },
  });
  serviceView = new WebContentsView({
    webPreferences: { ...COMMON_WEB_PREFS, partition: SERVICE_PARTITION },
  });
  guardServiceView(serviceView);
  // No remote debugging in the shipped app. Local dev only, explicit flag.
  if (DEV_DEBUG) {
    console.warn("[smartv] dev mode");
  }

  win.contentView.addChildView(barView);
  win.contentView.addChildView(homeView);
  win.contentView.addChildView(serviceView);

  await barView.webContents.loadFile(distFile("renderer/bar.html"));
  await homeView.webContents.loadFile(distFile("renderer/home.html"));
  layout();
  showHome();
}

function registerIpc(): void {
  ipcMain.handle("smartv:get-apps", () =>
    STREAMING_APPS.map((a) => ({ id: a.id, name: a.name, color: a.color })),
  );
  ipcMain.handle("smartv:open-app", (_e, id: unknown) => {
    if (typeof id !== "string" || !isAllowedAppId(id)) {
      return { ok: false, error: "unknown app" };
    }
    return openService(id);
  });
  ipcMain.handle("smartv:go-home", () => {
    showHome();
  });
}

async function main(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  registerIpc();
  await app.whenReady();
  await createWindow();
  app.on("activate", () => {
    if (!win) void createWindow();
  });
  app.on("window-all-closed", () => {
    app.quit();
  });
}

void main();
