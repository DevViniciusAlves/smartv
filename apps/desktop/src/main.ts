import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, WebContentsView, ipcMain, session } from "electron";
import { STREAMING_APPS, controllerMessageSchema } from "@smartv/shared";
import type { ControllerMessage } from "@smartv/shared";
import { appUrl, isAllowedAppId, isAllowedNavigation } from "./security.js";
import { parseCdpPort } from "./cdp.js";
import { initAutoUpdate, type UpdaterLike } from "./updater.js";
// electron-updater is CommonJS without detectable named exports once packed
// inside app.asar, so the default import + destructure is required here.
import updaterPkg from "electron-updater";

const { autoUpdater } = updaterPkg as unknown as { autoUpdater: UpdaterLike };
import { LOAD_ERROR_TEXT, ViewRouter, type RouterSnapshot, type Surface } from "./router.js";
import {
  normalizeRemoteUrl,
  resolveRemoteConfig,
  maskToken,
} from "./remote-config.js";
import { loadStoredRemoteConfig, saveStoredRemoteConfig, getOrCreateInstallationId } from "./remote-store.js";
import { EmbeddedAgent } from "./remote-agent.js";
import { describeAction, systemScriptFor } from "./command-runner.js";

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

// Embedded remote agent: this app IS the controllable device. No separate
// Node.js agent process is needed (and running one with the same AGENT_TOKEN
// would fight over the room: the server keeps only the newest agent).
let remoteAgent: EmbeddedAgent | null = null;
let remoteStatusText = "Controle: não configurado";
// Tri-state link for the Conexão modal (shared vocabulary with /controle).
// DESCONECTADO: no link. CONECTANDO: socket opening/hello. CONECTADO: the
// server accepted us as agent (phone pairing is counted separately below).
let remoteLink: "DESCONECTADO" | "CONECTANDO" | "CONECTADO" = "DESCONECTADO";
let linkedPhones = 0;

function pushRemoteStatus(text: string): void {
  remoteStatusText = text;
  // Never includes the token (status strings are static; tokens stay in the
  // userData JSON file and in memory only).
  console.log(`[smartv-remote] ${text}`);
  barView?.webContents.send("smartv:remote-status", text);
  homeView?.webContents.send("smartv:remote-status", text);
}

function pushRemoteLink(): void {
  const payload = { link: remoteLink, linkedPhones };
  barView?.webContents.send("smartv:remote-link", payload);
  homeView?.webContents.send("smartv:remote-link", payload);
}

function setRemoteLink(link: typeof remoteLink): void {
  remoteLink = link;
  pushRemoteLink();
}

function pushPairCode(info: { code: string; expiresAt: number }): void {
  barView?.webContents.send("smartv:pair-code", info);
  homeView?.webContents.send("smartv:pair-code", info);
}

function runPowerShell(script: string): Promise<void> {
  if (!script) return Promise.resolve();
  if (process.platform !== "win32") {
    console.warn("[smartv-remote] system action ignored (not Windows)");
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true },
      (err) => {
        if (err) console.warn(`[smartv-remote] system action failed: ${err.message}`);
        resolve();
      },
    );
  });
}

function focusedContents(): { sendInputEvent(ev: unknown): void; focus(): void } | null {
  const surface = router.snapshot().surface;
  const view = surface === "service" ? serviceView : homeView;
  if (!view) return null;
  try {
    view.webContents.focus();
  } catch {
    /* noop */
  }
  return view.webContents as unknown as { sendInputEvent(ev: unknown): void; focus(): void };
}

function runRemoteCommand(msg: ControllerMessage): void {
  // Defense in depth: the transport already validated via zod, re-validate.
  const parsed = controllerMessageSchema.safeParse(msg);
  if (!parsed.success) return;
  const action = describeAction(parsed.data);
  if (action.kind === "ignore") return;
  if (action.kind === "go-home") {
    showHome();
    return;
  }
  if (action.kind === "open-app") {
    const res = openService(action.id);
    if (!res.ok) console.warn(`[smartv-remote] open-app rejected: ${action.id}`);
    return;
  }
  if (action.kind === "press") {
    const target = focusedContents();
    if (!target) return;
    for (const ev of action.events) {
      try {
        target.sendInputEvent(ev);
      } catch (err) {
        console.warn(`[smartv-remote] input failed: ${(err as Error).message}`);
        break;
      }
    }
    return;
  }
  // System-level (volume/power/mouse): PowerShell via user32.dll.
  const script = systemScriptFor(action);
  void runPowerShell(script);
}

function currentRemoteConfig(): { backendUrl: string; agentToken: string; deviceId: string } | null {
  try {
    const stored = loadStoredRemoteConfig(app.getPath("userData"));
    const resolved = resolveRemoteConfig(process.argv, process.env, stored);
    if (!resolved.enabled) return null;
    return {
      backendUrl: resolved.backendUrl,
      agentToken: resolved.agentToken,
      deviceId: getOrCreateInstallationId(app.getPath("userData")),
    };
  } catch {
    return null;
  }
}

function startEmbeddedAgent(): void {
  if (remoteAgent) return;
  remoteAgent = new EmbeddedAgent(currentRemoteConfig, {
    onStatus: (text) => {
      pushRemoteStatus(text);
      // Derive the tri-state link from the status line the agent reports.
      if (text.startsWith("Controle: online")) setRemoteLink("CONECTADO");
      else if (text.startsWith("Controle: conectando")) setRemoteLink("CONECTANDO");
      else if (text.startsWith("Controle: reconectando")) setRemoteLink("CONECTANDO");
      else if (text.startsWith("Controle: não configurado")) setRemoteLink("DESCONECTADO");
      else if (text.includes("token inválido") || text.includes("origem recusada")) {
        setRemoteLink("DESCONECTADO");
      } else if (text.includes("outro agente assumiu")) {
        // Kicked by a duplicate agent: link is down until backoff reconnects.
        setRemoteLink("CONECTANDO");
      }
    },
    onCommand: runRemoteCommand,
    onPairCode: pushPairCode,
    onPresence: (n) => {
      linkedPhones = n;
      pushRemoteLink();
      console.log(`[smartv-remote] linked phones: ${n}`);
    },
    onLog: (line) => console.log(line),
  });
  const cfg = currentRemoteConfig();
  if (cfg) {
    setRemoteLink("CONECTANDO");
    console.log(`[smartv-remote] configured (source ok, token ${maskToken(cfg.agentToken)})`);
  } else {
    setRemoteLink("DESCONECTADO");
    console.log("[smartv-remote] not configured: set server + token in the ⚙ Controle panel");
  }
  remoteAgent.start();
}

/** Graceful exit for "Sair do SmarTV": closes the server link (the backend
 *  immediately marks the PC offline for the phones), frees resources, quits.
 *  Never touches foreign processes: only this app's own agent is stopped. */
function quitAppGracefully(): void {
  console.log("[smartv] sair: closing remote link and quitting");
  try {
    remoteAgent?.stop();
  } catch {
    /* noop */
  }
  remoteAgent = null;
  setRemoteLink("DESCONECTADO");
  app.quit();
}

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
  // Updates only make sense in the installed app: dev runs have no Releases
  // metadata and must never phone home.
  if (app.isPackaged && !SHOT_PNG) {
    initAutoUpdate(autoUpdater, { onStatus: setStatus });
  }
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
  ipcMain.handle("smartv:get-remote", () => {
    const stored = loadStoredRemoteConfig(app.getPath("userData"));
    const resolved = resolveRemoteConfig(process.argv, process.env, stored);
    return {
      backendUrl: resolved.backendUrl || stored.backendUrl || "",
      hasToken: Boolean(resolved.agentToken),
      tokenMasked: maskToken(resolved.agentToken),
      enabled: resolved.enabled,
      status: remoteStatusText,
      source: resolved.source,
      link: remoteLink,
      linkedPhones,
    };
  });
  ipcMain.handle("smartv:set-remote", (_e, payload: unknown) => {
    const p = (payload ?? {}) as { backendUrl?: unknown; agentToken?: unknown };
    const backendUrl = normalizeRemoteUrl(typeof p.backendUrl === "string" ? p.backendUrl : "");
    const stored = loadStoredRemoteConfig(app.getPath("userData"));
    // Empty token field keeps the saved token (so the UI never needs to
    // echo it back); an explicit non-empty value replaces it.
    const rawToken = typeof p.agentToken === "string" ? p.agentToken.trim() : "";
    const agentToken = rawToken || stored.agentToken || "";
    if (!backendUrl || !agentToken) {
      return { ok: false, error: "Informe servidor e token." };
    }
    saveStoredRemoteConfig(app.getPath("userData"), { backendUrl, agentToken });
    remoteAgent?.reconnect();
    return { ok: true, status: remoteStatusText };
  });
  ipcMain.handle("smartv:pair-code-request", () => {
    const ok = remoteAgent?.requestPairCode() ?? false;
    return { ok };
  });
  ipcMain.handle("smartv:quit", () => {
    quitAppGracefully();
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
    // The installed app is itself the controllable device (no standalone
    // agent needed). Shot mode stays offline: no network from diagnostics.
    if (!SHOT_PNG) startEmbeddedAgent();
  } catch (err) {
    console.error(`[smartv] startup failed: ${(err as Error).message}`);
    app.quit();
    return;
  }
  app.on("activate", () => {
    if (!win) void createWindow();
  });
  app.on("window-all-closed", () => {
    remoteAgent?.stop();
    app.quit();
  });
  app.on("before-quit", () => {
    remoteAgent?.stop();
  });
}

main().catch((err) => {
  console.error(`[smartv] fatal: ${(err as Error).message}`);
  app.quit();
});
