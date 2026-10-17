import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, WebContentsView, ipcMain, session, screen, type WebContents, type BrowserWindowConstructorOptions } from "electron";
import { STREAMING_APPS, controllerMessageSchema } from "@smartv/shared";
import type { ControllerMessage } from "@smartv/shared";
import { appUrl, isAllowedAppId, isAllowedNavigation } from "./security.js";
import { parseCdpPort } from "./cdp.js";
import { initManualUpdate, type UpdaterLike } from "./updater.js";
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
import { loadStoredRemoteConfig, saveStoredRemoteConfig, getOrCreateInstallationId, loadStoredDisplayId, saveStoredDisplayId, clearStoredDisplayId } from "./remote-store.js";
import { DEFAULT_BACKEND_URL, DEFAULT_AGENT_TOKEN } from "./defaults.js";
import { EmbeddedAgent } from "./remote-agent.js";
import { describeAction, systemScriptFor } from "./command-runner.js";
import { ElectronBlocker } from "@ghostery/adblocker-electron";
import {
  BraveManager,
  braveUserDataDir,
  defaultPreloadPath,
} from "./brave-manager.js";

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

// Baked-in server + agent token (filled at build time by scripts/gen-defaults.mjs).
// Empty in a plain dev build; real values in the released app => zero config.
const BAKED_DEFAULTS = {
  backendUrl: DEFAULT_BACKEND_URL,
  agentToken: DEFAULT_AGENT_TOKEN,
};

let win: BrowserWindow | null = null;
let barView: WebContentsView | null = null;
let homeView: WebContentsView | null = null;
let serviceView: WebContentsView | null = null;
let pairView: WebContentsView | null = null;
// Conexão overlay: a dedicated full-window WebContentsView. It lives OUTSIDE
// the 56px bar (where the old modal was clipped) and covers everything, so it
// can never be cut off. Only one overlay exists; it is shown/hidden by bounds.
let connOpen = false;

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
// DESCONECTADO: no controller is connected. CONECTANDO: the agent socket is
// opening/reconnecting. CONECTADO: at least one controller is really linked.
let remoteLink: "DESCONECTADO" | "CONECTANDO" | "CONECTADO" = "DESCONECTADO";
let linkedPhones = 0;

// Brave renders the streaming services when installed (native Widevine DRM for
// HBO Max / Netflix with zero setup). It is created lazily: apps stay closed
// until the phone opens one, and the manager is null when Brave is absent.
let brave: BraveManager | null = null;
let braveEnabled = false;

/** Lazily resolves Brave. Returns the manager, or null when not installed. */
function ensureBrave(): BraveManager | null {
  if (!brave) {
    brave = new BraveManager({
      userDataDir: braveUserDataDir(app.getPath("userData")),
      preloadPath: defaultPreloadPath(DIST),
      log: (line) => console.log(line),
    });
  }
  return brave.resolveExecutable() ? brave : null;
}

function pushRemoteStatus(text: string): void {
  remoteStatusText = text;
  // Never includes the token (status strings are static; tokens stay in the
  // userData JSON file and in memory only).
  console.log(`[smartv-remote] ${text}`);
  barView?.webContents.send("smartv:remote-status", text);
  homeView?.webContents.send("smartv:remote-status", text);
  pairView?.webContents.send("smartv:remote-status", text);
}

function pushRemoteLink(): void {
  const payload = { link: remoteLink, linkedPhones };
  barView?.webContents.send("smartv:remote-link", payload);
  homeView?.webContents.send("smartv:remote-link", payload);
  pairView?.webContents.send("smartv:remote-link", payload);
}

function setRemoteLink(link: typeof remoteLink): void {
  remoteLink = link;
  pushRemoteLink();
}

function pushPairCode(info: { code: string; expiresAt: number }): void {
  barView?.webContents.send("smartv:pair-code", info);
  homeView?.webContents.send("smartv:pair-code", info);
  pairView?.webContents.send("smartv:pair-code", info);
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

function focusedContents(): {
  sendInputEvent(ev: unknown): void;
  focus(): void;
  executeJavaScript(code: string): Promise<unknown>;
} | null {
  const surface = router.snapshot().surface;
  const view = surface === "service" ? serviceView : homeView;
  if (!view) return null;
  try {
    view.webContents.focus();
  } catch {
    /* noop */
  }
  return view.webContents as unknown as {
    sendInputEvent(ev: unknown): void;
    focus(): void;
    executeJavaScript(code: string): Promise<unknown>;
  };
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
  if (action.kind === "go-back") {
    // Real remote semantics: leave the current page first, then Home.
    if (connOpen) closeConn();
    else goBack();
    return;
  }
  if (action.kind === "open-app") {
    const res = openService(action.id);
    if (!res.ok) console.warn(`[smartv-remote] open-app rejected: ${action.id}`);
    return;
  }
  if (action.kind === "media-play" || action.kind === "media-pause") {
    const method = action.kind === "media-play" ? "play" : "pause";
    if (braveEnabled && brave?.isShowing()) {
      void brave.playPause(method).catch(() => undefined);
      return;
    }
    const target = focusedContents();
    if (!target) return;
    void target
      .executeJavaScript(
        `for (const v of document.querySelectorAll("video")) { try { v.${method}(); } catch (e) {} }`,
      )
      .catch(() => undefined);
    return;
  }
  if (action.kind === "press") {
    if (braveEnabled && brave?.isShowing()) {
      void brave.dispatchKeys(action.events).catch((err: unknown) =>
        console.warn(`[smartv] brave input failed: ${(err as Error).message}`),
      );
      return;
    }
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
    const resolved = resolveRemoteConfig(process.argv, process.env, stored, BAKED_DEFAULTS);
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
      // "online" only means that the PC agent reached the relay. It does not
      // mean that a phone/controller is connected; presence below is the
      // source of truth for the user-facing connection tag.
      if (text.startsWith("Controle: online")) {
        setRemoteLink(linkedPhones > 0 ? "CONECTADO" : "DESCONECTADO");
      }
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
      setRemoteLink(n > 0 ? "CONECTADO" : "DESCONECTADO");
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
    console.log("[smartv-remote] not configured: set server + token in Conexão → Configuração avançada");
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
  try {
    brave?.stop();
  } catch {
    /* noop */
  }
  setRemoteLink("DESCONECTADO");
  app.quit();
}

const COMMON_WEB_PREFS = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
} as const;

// Sign-in flows open popups (OAuth). They must be real windows with an opener,
// so window.opener/postMessage works; we keep them sandboxed and guard their
// navigation with the same allowlist as the service view.
const POPUP_WINDOW_OPTIONS: BrowserWindowConstructorOptions = {
  width: 520,
  height: 720,
  autoHideMenuBar: true,
  backgroundColor: "#0b0e14",
  webPreferences: { ...COMMON_WEB_PREFS },
};

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
  // With Brave in front, the built-in service view stays collapsed: the real
  // window is Brave's, and keeping a second copy loaded would waste memory.
  if (router.snapshot().surface === "service" && !braveEnabled) {
    homeView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    serviceView.setBounds(content);
  } else {
    serviceView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    homeView.setBounds(content);
  }
  // The Conexão overlay covers the whole window (bar included) when open, and
  // is collapsed to nothing otherwise. It is added last, so it is always on top.
  if (pairView) {
    pairView.setBounds(connOpen ? { x: 0, y: 0, width, height } : { x: 0, y: 0, width: 0, height: 0 });
  }
}

// Whether the visible surface has somewhere to go "back" to. Home is the root,
// so Back is only offered while a streaming app is open.
function canGoBack(): boolean {
  if (braveEnabled && brave?.isShowing()) return true;
  try {
    if (router.snapshot().surface !== "service" || !serviceView) return false;
    return serviceView.webContents.navigationHistory.canGoBack();
  } catch {
    return false;
  }
}

function pushCanGoBack(): void {
  barView?.webContents.send("smartv:can-go-back", canGoBack());
}

function goBack(): { ok: boolean; error?: string } {
  if (braveEnabled && brave?.isShowing()) {
    void brave
      .goBack()
      .then((went) => {
        // Nothing in Brave's history: Back means "leave the app" -> Home.
        if (!went) showHome();
      })
      .catch(() => showHome());
    return { ok: true };
  }
  if (!serviceView) return { ok: false, error: "no view" };
  try {
    if (serviceView.webContents.navigationHistory.canGoBack()) {
      serviceView.webContents.navigationHistory.goBack();
      return { ok: true };
    }
  } catch {
    /* fall through to Home */
  }
  // Nothing in history: Back means "leave the app", i.e. return Home.
  showHome();
  return { ok: true };
}

// Applies a router decision: repositions views, refreshes status (always,
// so stale "loading" text can never stick) and moves focus only when the
// visible surface actually changes.
function applyState(s: RouterSnapshot): void {
  layout();
  setStatus(s.status);
  pushCanGoBack();
  if (s.surface !== lastSurface) {
    lastSurface = s.surface;
    (s.surface === "service" ? serviceView : homeView)?.webContents.focus();
  }
}

function showHome(): void {
  // Brave stays open (its window is just minimized), so the login/session and
  // playback state survive; reopening a service reuses it. The Electron view
  // is only hidden for the duration Brave is in front.
  if (braveEnabled && brave?.isShowing()) void brave.hide().catch(() => undefined);
  applyState(router.goHome());
}

function openService(id: string): { ok: boolean; error?: string } {
  const url = appUrl(id);
  if (!url) return { ok: false, error: "unknown app" };
  // Brave first: native Widevine DRM works out of the box. Falls back to the
  // bundled Electron view when Brave is not installed.
  const b = braveEnabled ? ensureBrave() : null;
  if (b) {
    applyState(router.openApp(id, url));
    void b.ensureRunning(url).then((ok) => {
      if (ok) return;
      // Brave vanished between the check and the launch: use the Electron view.
      console.warn("[smartv] Brave unavailable, using built-in view");
      // Brave mode keeps the built-in view collapsed. Switch modes before
      // loading the fallback, otherwise the page loads behind the Home view
      // and the remote appears stuck on "Carregando…".
      braveEnabled = false;
      layout();
      serviceView?.webContents.loadURL(url).catch(() => undefined);
    });
    return { ok: true };
  }
  if (!serviceView) return { ok: false, error: "unknown app" };
  applyState(router.openApp(id, url));
  serviceView.webContents.loadURL(url).catch((err: unknown) => {
    console.warn(`[smartv] loadURL failed: ${(err as Error).message}`);
  });
  return { ok: true };
}

// Allowlist guard shared by the service view and every login popup it opens.
// Redirects (3xx) are intentionally NOT blocked: auth flows hop through
// providers and back. Only user/page-initiated top-level navigations and new
// windows are policed.
function installNavGuard(wc: WebContents, onEscape: () => void): void {
  wc.on("will-navigate", (e, url) => {
    if (!isAllowedNavigation(url)) {
      e.preventDefault();
      console.warn(`[smartv] blocked navigation: ${url}`);
    }
  });
  // New windows: allowlisted destinations (and blank OAuth popups) open as a
  // real, sandboxed child window so window.opener-based sign-in works.
  wc.setWindowOpenHandler(({ url }) => {
    if (isAllowedNavigation(url) || url === "about:blank") {
      return { action: "allow", overrideBrowserWindowOptions: POPUP_WINDOW_OPTIONS };
    }
    console.warn(`[smartv] blocked popup: ${url}`);
    return { action: "deny" };
  });
  // Guard the popup it just created (recursively), and let Esc close it.
  wc.on("did-create-window", (child) => {
    installNavGuard(child.webContents, () => child.close());
  });
  wc.on("before-input-event", (_e, input) => {
    if (input.type === "keyDown" && input.key === "Escape") onEscape();
  });
}

function guardServiceView(view: WebContentsView): void {
  const wc = view.webContents;
  // Top-level navigation locked to the allowlist; Escape returns Home.
  installNavGuard(wc, showHome);
  wc.on("did-start-loading", () => applyState(router.onStarted()));
  wc.on("did-stop-loading", () => applyState(router.onStopped()));
  wc.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    const s = router.onFailed(code, isMainFrame, url);
    if (s.status === LOAD_ERROR_TEXT) {
      console.warn(`[smartv] load failed (${code} ${desc}): ${url}`);
    }
    applyState(s);
  });
}

function guardBarView(view: WebContentsView): void {
  // Escape is a no-op on Home itself, but handling it here keeps behavior
  // consistent after clicking around with the mouse (focus may sit in the bar).
  view.webContents.on("before-input-event", (_e, input) => {
    if (input.type === "keyDown" && input.key === "Escape") {
      if (connOpen) closeConn();
      else showHome();
    }
  });
}

// Opens the full-window Conexão overlay. It is the single place where the
// phone pairs (6-digit code + QR) and where the server can be configured.
function openConn(): void {
  connOpen = true;
  layout();
  // The overlay refreshes itself (getRemote + requestPairCode) when active.
  pairView?.webContents.send("smartv:pair-active", true);
  try {
    pairView?.webContents.focus();
  } catch {
    /* noop */
  }
}

function closeConn(): void {
  connOpen = false;
  pairView?.webContents.send("smartv:pair-active", false);
  layout();
  (router.snapshot().surface === "service" ? serviceView : homeView)?.webContents.focus();
}

function guardPairView(view: WebContentsView): void {
  // Escape (and the overlay's own Back/Close) always dismisses the overlay.
  view.webContents.on("before-input-event", (_e, input) => {
    if (input.type === "keyDown" && input.key === "Escape") closeConn();
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
      // Conexão overlay: the old modal was clipped inside the 56px bar. Prove
      // the new full-window view renders the pairing UI end to end.
      if (pairView) {
        openConn();
        await new Promise((r) => setTimeout(r, 1200));
        summary.pairCodeText = await pairView.webContents.executeJavaScript(
          "document.getElementById('pairCode').textContent",
        );
        summary.pairQrPresent = await pairView.webContents.executeJavaScript(
          "Boolean(document.getElementById('pairQr').getAttribute('src'))",
        );
        const pimg = await pairView.webContents.capturePage();
        const ppath = SHOT_PNG.replace(/\.png$/i, "-pair.png");
        fs.writeFileSync(ppath, pimg.toPNG());
        summary.pairShot = ppath;
        closeConn();
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
  const serviceSession = session.fromPartition(SERVICE_PARTITION, { cache: true });

  // Ad blocker (same engine as Brave: EasyList + EasyPrivacy + anti-tracking).
  if (!SHOT_PNG) {
    ElectronBlocker.fromPrebuiltAdsAndTracking()
      .then((blocker) => {
        blocker.enableBlockingInSession(serviceSession);
        console.log("[smartv] Ad blocker enabled (Ghostery/Brave engine)");
      })
      .catch((err) => {
        console.warn(`[smartv] Ad blocker failed: ${err.message}`);
      });
  }

  win = new BrowserWindow({
    ...(SHOT_PNG
      ? { show: false, fullscreen: false, width: 1280, height: 800 }
      : { fullscreen: true }),
    autoHideMenuBar: true,
    backgroundColor: "#0b0e14",
    title: "SmartTV",
    webPreferences: { ...COMMON_WEB_PREFS },
  });
  const storedDisplayId = loadStoredDisplayId(app.getPath("userData"));
  if (storedDisplayId !== null) {
    const storedDisplay = screen.getAllDisplays().find((d) => d.id === storedDisplayId);
    if (storedDisplay) win.setBounds(storedDisplay.bounds);
    else clearStoredDisplayId(app.getPath("userData"));
  }
  win.on("closed", () => {
    win = null;
    barView = null;
    homeView = null;
    serviceView = null;
    pairView = null;
    connOpen = false;
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
  // The streaming view gets its OWN, bridge-less preload that turns the phone's
  // D-pad into a real focus navigation ring (see service-preload.ts). It never
  // exposes window.smartv, so remote pages stay untrusted.
  serviceView = new WebContentsView({
    webPreferences: {
      ...COMMON_WEB_PREFS,
      partition: SERVICE_PARTITION,
      preload: distFile("service-preload.cjs"),
      plugins: true,
      ...shotPrefs,
    },
  });
  pairView = new WebContentsView({
    webPreferences: { ...COMMON_WEB_PREFS, preload: distFile("preload.cjs"), ...shotPrefs },
  });
  watchShot(barView, "bar");
  watchShot(homeView, "home");
  watchShot(serviceView, "service");
  watchShot(pairView, "pair");
  guardBarView(barView);
  guardServiceView(serviceView);
  guardPairView(pairView);
  // No remote debugging in the shipped app. Local dev only, explicit flag.
  if (DEV_DEBUG) {
    console.warn("[smartv] dev mode");
  }

  win.contentView.addChildView(barView);
  win.contentView.addChildView(homeView);
  win.contentView.addChildView(serviceView);
  win.contentView.addChildView(pairView);

  await barView.webContents.loadFile(distFile("renderer/bar.html"));
  await homeView.webContents.loadFile(distFile("renderer/home.html"));
  await pairView.webContents.loadFile(distFile("renderer/pair.html"));
  layout();
  showHome();
  // Updates only make sense in the installed app: dev runs have no Releases
  // metadata and must never phone home.
  if (app.isPackaged && !SHOT_PNG) {
    initManualUpdate(autoUpdater, {
      onStatus: setStatus,
      onEvent: (ev) => {
        barView?.webContents.send("smartv:update-event", ev);
        homeView?.webContents.send("smartv:update-event", ev);
      },
    });
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
    closeConn();
    showHome();
  });
  ipcMain.handle("smartv:go-back", () => goBack());
  ipcMain.handle("smartv:conn-open", () => {
    openConn();
  });
  ipcMain.handle("smartv:conn-close", () => {
    closeConn();
  });
  ipcMain.handle("smartv:get-remote", () => {
    const stored = loadStoredRemoteConfig(app.getPath("userData"));
    const resolved = resolveRemoteConfig(process.argv, process.env, stored, BAKED_DEFAULTS);
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
  ipcMain.handle("smartv:check-updates", () => {
    return autoUpdater.checkForUpdates();
  });
  ipcMain.handle("smartv:download-update", () => {
    return autoUpdater.downloadUpdate();
  });
  ipcMain.handle("smartv:restart-app", () => {
    autoUpdater.quitAndInstall();
  });
  ipcMain.handle("smartv:get-displays", () => {
    return screen.getAllDisplays().map((d, i) => ({
      id: d.id,
      label: d.label || `Monitor ${i + 1}`,
      bounds: d.bounds,
    }));
  });
  ipcMain.handle("smartv:set-display", (_e, displayId: number) => {
    const displays = screen.getAllDisplays();
    const display = displays.find((d) => d.id === displayId);
    if (!display) return;
    saveStoredDisplayId(app.getPath("userData"), display.id);
    if (win) {
      win.setBounds(display.bounds);
      win.setFullScreen(true);
    }
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
  // Widevine DRM support (HBO Max, Netflix, Disney+, etc.).
  // MUST be before app.whenReady() — Chromium reads these switches at init.
  if (!SHOT_PNG) {
    app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
    const widevineDir = path.join(DIST, "WidevineCdm");
    const widevineManifest = path.join(widevineDir, "manifest.json");
    const widevineDll = path.join(widevineDir, "_platform_specific", "win_x64", "widevinecdm.dll");
    if (fs.existsSync(widevineDll) && fs.existsSync(widevineManifest)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(widevineManifest, "utf8")) as { version?: string };
        const version = manifest.version ?? "4.10.3112.0";
        app.commandLine.appendSwitch("widevine-cdm-path", widevineDir);
        app.commandLine.appendSwitch("widevine-cdm-version", version);
        console.log(`[smartv] Widevine DRM enabled (v${version})`);
      } catch {
        console.warn("[smartv] Failed to read Widevine manifest");
      }
    } else {
      console.warn("[smartv] Widevine CDM not found — DRM content will not play");
    }
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
  screen.on("display-removed", (_event, removedDisplay) => {
    if (loadStoredDisplayId(app.getPath("userData")) === removedDisplay.id) {
      clearStoredDisplayId(app.getPath("userData"));
    }
  });
  try {
    await createWindow();
    // The installed app is itself the controllable device (no standalone
    // agent needed). Shot mode stays offline: no network from diagnostics.
    if (!SHOT_PNG) {
      startEmbeddedAgent();
      // Brave renders streaming services when installed (native Widevine DRM).
      braveEnabled = ensureBrave() !== null;
      console.log(
        `[smartv] DRM renderer: ${braveEnabled ? "Brave (native Widevine)" : "built-in view (no Brave found)"}`,
      );
    }
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
    brave?.stop();
    app.quit();
  });
  app.on("before-quit", () => {
    remoteAgent?.stop();
    brave?.stop();
  });
}

main().catch((err) => {
  console.error(`[smartv] fatal: ${(err as Error).message}`);
  app.quit();
});
