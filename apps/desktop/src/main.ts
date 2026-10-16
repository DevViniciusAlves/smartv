import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, WebContentsView, ipcMain, session } from "electron";
import { STREAMING_APPS } from "@smartv/shared";
import { appUrl, isAllowedAppId, isAllowedNavigation } from "./security.js";
import { parseCdpPort } from "./cdp.js";
import { LOAD_ERROR_TEXT, ViewRouter, type RouterSnapshot, type Surface } from "./router.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = __dirname;
const DEV_DEBUG = process.argv.includes("--smartv-dev");
// Diagnostic mode: hidden offscreen window, dumps a screenshot of Home plus
// renderer console output, then quits. Never shown on screen.
const SHOT_ARG = process.argv.find((a) => a.startsWith("--smartv-shot="));
const SHOT_PNG = SHOT_ARG ? SHOT_ARG.slice("--smartv-shot=".length) : "";

// Persistent, isolated profile for the streaming services (cookies and
// logins survive restarts). One partition for all services, exactly like a
// single browser profile; services stay isolated per-domain by the platform.
const SERVICE_PARTITION = "persist:smartv";

let win: BrowserWindow | null = null;
let barView: WebContentsView | null = null;
let homeView: WebContentsView | null = null;
let serviceView: WebContentsView | null = null;

// Single source of truth for which surface is visible. Electron events only
// feed it; they never change visibility directly (avoids out-of-order races).
const router = new ViewRouter();
let lastSurface: Surface | null = null;

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
  if (router.snapshot().surface === "service") {
    homeView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    serviceView.setBounds(content);
  } else {
    serviceView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    homeView.setBounds(content);
  }
}

// Applies a router decision: repositions views, refreshes status (always,
// so stale "loading" text can never stick) and moves focus only when the
// visible surface actually changes.
function applyState(s: RouterSnapshot): void {
  layout();
  setStatus(s.status);
  if (s.surface !== lastSurface) {
    lastSurface = s.surface;
    (s.surface === "service" ? serviceView : homeView)?.webContents.focus();
  }
}

function showHome(): void {
  applyState(router.goHome());
}

function openService(id: string): { ok: boolean; error?: string } {
  const url = appUrl(id);
  if (!url || !serviceView) return { ok: false, error: "unknown app" };
  applyState(router.openApp(id, url));
  serviceView.webContents.loadURL(url).catch((err: unknown) => {
    console.warn(`[smartv] loadURL failed: ${(err as Error).message}`);
  });
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
      wc.loadURL(url).catch((err: unknown) => {
        console.warn(`[smartv] popup load failed: ${(err as Error).message}`);
      });
    } else {
      console.warn(`[smartv] blocked popup: ${url}`);
    }
    return { action: "deny" };
  });
  wc.on("did-start-loading", () => applyState(router.onStarted()));
  wc.on("did-stop-loading", () => applyState(router.onStopped()));
  wc.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    const s = router.onFailed(code, isMainFrame, url);
    if (s.status === LOAD_ERROR_TEXT) {
      console.warn(`[smartv] load failed (${code} ${desc}): ${url}`);
    }
    applyState(s);
  });
  // Consistent way back: Escape always returns Home.
  wc.on("before-input-event", (_e, input) => {
    if (input.type === "keyDown" && input.key === "Escape") showHome();
  });
}

function guardBarView(view: WebContentsView): void {
  // Escape is a no-op on Home itself, but handling it here keeps behavior
  // consistent after clicking around with the mouse (focus may sit in the bar).
  view.webContents.on("before-input-event", (_e, input) => {
    if (input.type === "keyDown" && input.key === "Escape") showHome();
  });
}

interface ShotLog {
  view: string;
  kind: string;
  text: string;
}

const shotLogs: ShotLog[] = [];

function watchShot(view: WebContentsView, name: string): void {
  if (!SHOT_PNG) return;
  view.webContents.on("console-message", (details) => {
    if (shotLogs.length < 100) {
      shotLogs.push({ view: name, kind: `console-${details.level}`, text: details.message.slice(0, 300) });
    }
  });
  view.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    shotLogs.push({
      view: name,
      kind: "fail-load",
      text: `${code} ${desc} ${url} main=${isMainFrame}`.slice(0, 300),
    });
  });
}

async function finishShot(): Promise<void> {
  const summary: Record<string, unknown> = { logs: shotLogs };
  try {
    if (homeView) {
      summary.bridgeType = await homeView.webContents.executeJavaScript("typeof window.smartv");
      summary.cardCount = await homeView.webContents.executeJavaScript(
        "document.querySelectorAll('#cards .card').length",
      );
      summary.clockText = await homeView.webContents.executeJavaScript(
        "document.getElementById('clock').textContent",
      );
      const img = await homeView.webContents.capturePage();
      fs.writeFileSync(SHOT_PNG, img.toPNG());
      summary.shot = SHOT_PNG;
      // Click-through: clicks the first card and captures the service view.
      await homeView.webContents.executeJavaScript(
        "document.querySelector('#cards .card').click()",
      );
      await new Promise((r) => setTimeout(r, 6000));
      if (serviceView) {
        summary.serviceUrl = serviceView.webContents.getURL();
        const simg = await serviceView.webContents.capturePage();
        const spath = SHOT_PNG.replace(/\.png$/i, "-service.png");
        fs.writeFileSync(spath, simg.toPNG());
        summary.serviceShot = spath;
        // Escape path: returns to Home without quitting.
        serviceView.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        serviceView.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
        await new Promise((r) => setTimeout(r, 1500));
        summary.homeCardsAfterEsc = await homeView.webContents.executeJavaScript(
          "document.querySelectorAll('#cards .card').length",
        );
        const himg = await homeView.webContents.capturePage();
        const hpath = SHOT_PNG.replace(/\.png$/i, "-esc.png");
        fs.writeFileSync(hpath, himg.toPNG());
        summary.escShot = hpath;
      }
    }
  } catch (err) {
    summary.error = (err as Error).message;
  }
  console.log(`[smartv-shot] ${JSON.stringify(summary)}`);
  app.exit(0);
}

async function createWindow(): Promise<void> {
  // Ensures the persistent service partition exists (cookies survive restarts).
  session.fromPartition(SERVICE_PARTITION, { cache: true });

  win = new BrowserWindow({
    ...(SHOT_PNG
      ? { show: false, fullscreen: false, width: 1280, height: 800 }
      : { fullscreen: true }),
    autoHideMenuBar: true,
    backgroundColor: "#0b0e14",
    title: "SmartTV",
    webPreferences: { ...COMMON_WEB_PREFS },
  });
  win.on("closed", () => {
    win = null;
  });
  win.on("resize", layout);

  // Offscreen rendering keeps shot mode completely invisible.
  const shotPrefs = SHOT_PNG ? { offscreen: true } : {};
  barView = new WebContentsView({
    webPreferences: { ...COMMON_WEB_PREFS, preload: distFile("preload.cjs"), ...shotPrefs },
  });
  homeView = new WebContentsView({
    webPreferences: { ...COMMON_WEB_PREFS, preload: distFile("preload.cjs"), ...shotPrefs },
  });
  serviceView = new WebContentsView({
    webPreferences: { ...COMMON_WEB_PREFS, partition: SERVICE_PARTITION, ...shotPrefs },
  });
  watchShot(barView, "bar");
  watchShot(homeView, "home");
  watchShot(serviceView, "service");
  guardBarView(barView);
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
  if (SHOT_PNG) {
    // Lets the renderer boot, then captures and quits.
    setTimeout(() => void finishShot(), 4000);
  }
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
  // Opt-in remote control surface for the local agent: exposes CDP on
  // 127.0.0.1 only. Off by default; must be called before app ready.
  try {
    const cdp = parseCdpPort(process.argv);
    if (cdp !== null) {
      app.commandLine.appendSwitch("remote-debugging-port", String(cdp));
      app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
      console.log(`[smartv] CDP listening on 127.0.0.1:${cdp} (local only)`);
    }
  } catch (err) {
    console.warn(`[smartv] ${(err as Error).message}; continuing without CDP`);
  }
  if (SHOT_PNG) {
    // Isolated profile: shot runs never touch (or lock) the real user data,
    // even while the real app is open.
    app.setPath("userData", path.join(os.tmpdir(), "smartv-shot-profile"));
  }
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
  try {
    await createWindow();
  } catch (err) {
    console.error(`[smartv] startup failed: ${(err as Error).message}`);
    app.quit();
    return;
  }
  app.on("activate", () => {
    if (!win) void createWindow();
  });
  app.on("window-all-closed", () => {
    app.quit();
  });
}

main().catch((err) => {
  console.error(`[smartv] fatal: ${(err as Error).message}`);
  app.quit();
});
