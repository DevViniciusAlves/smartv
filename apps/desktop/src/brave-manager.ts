// Spawns and drives the Brave window that renders the streaming services.
//
// One Brave process per SmartTV instance, with its own profile directory (the
// user's daily browser is never touched) and CDP bound to 127.0.0.1. The
// window is shown for a service and minimized back to the TV Home, which keeps
// the Electron shell (bar/home/pairing) exactly as it is today.
//
// All side effects go through BraveDeps, so the state machine is testable in
// plain Node without spawning a browser.

import path from "node:path";
import fs from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import {
  BRAVE_CDP_PORT,
  buildBraveArgs,
  cdpKeyParams,
  findBraveExecutable,
  wrapServicePreload,
  type CdpKeyEventLike,
} from "./brave.js";
import { connectBrowser, type CdpConnection } from "./cdp-client.js";

export interface BraveChildLike {
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "exit", cb: (code: number | null) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
}

export interface BraveDeps {
  exists?: (p: string) => boolean;
  readFile?: (p: string) => string;
  spawn?: (cmd: string, args: string[]) => BraveChildLike;
  connect?: (port: number) => Promise<{ conn: CdpConnection; sessionId: string; targetId: string }>;
  log?: (line: string) => void;
  platform?: string;
  env?: Record<string, string | undefined>;
  userDataDir?: string;
  preloadPath?: string;
  debugPort?: number;
}

export class BraveManager {
  private readonly deps: Required<
    Pick<BraveDeps, "exists" | "readFile" | "spawn" | "connect" | "log" | "platform" | "env">
  > &
    BraveDeps;
  private child: BraveChildLike | null = null;
  private conn: CdpConnection | null = null;
  private sessionId: string | null = null;
  private targetId: string | null = null;
  private windowId: number | null = null;
  private executable: string | null = null;
  private visible = false;
  private connecting: Promise<void> | null = null;
  private currentUrl = "";

  constructor(deps: BraveDeps = {}) {
    this.deps = {
      exists: deps.exists ?? ((p) => fs.existsSync(p)),
      readFile: deps.readFile ?? ((p) => fs.readFileSync(p, "utf8")),
      spawn: deps.spawn ?? ((cmd, args) => nodeSpawn(cmd, args, { windowsHide: true, stdio: "ignore" })),
      connect: deps.connect ?? ((port) => connectBrowser(port)),
      log: deps.log ?? ((line) => console.log(line)),
      platform: deps.platform ?? process.platform,
      env: deps.env ?? process.env,
      userDataDir: deps.userDataDir,
      preloadPath: deps.preloadPath,
      debugPort: deps.debugPort,
    };
  }

  /** Finds the Brave executable once; null when Brave is not installed. */
  resolveExecutable(): string | null {
    if (this.executable !== null) return this.executable;
    this.executable = findBraveExecutable(this.deps.platform, this.deps.env, this.deps.exists);
    return this.executable;
  }

  isRunning(): boolean {
    return this.conn !== null && this.child !== null;
  }

  isShowing(): boolean {
    return this.isRunning() && this.visible;
  }

  getDebugPort(): number {
    return this.deps.debugPort ?? BRAVE_CDP_PORT;
  }

  /**
   * Launches Brave on `url` (or navigates the running window) and returns
   * true when Brave is in charge of the streaming surface. Returns false when
   * Brave is not installed — the caller falls back to the Electron view.
   */
  async ensureRunning(url: string): Promise<boolean> {
    if (!this.resolveExecutable()) return false;
    this.currentUrl = url;
    if (this.isRunning()) {
      await this.navigate(url);
      await this.show();
      return true;
    }
    if (!this.connecting) this.connecting = this.launch();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
    return this.isRunning();
  }

  private async launch(): Promise<void> {
    const exe = this.resolveExecutable();
    if (!exe) return;
    const userDataDir = this.deps.userDataDir ?? "";
    const port = this.getDebugPort();
    this.deps.log(`[smartv-brave] launching ${exe} (${this.currentUrl})`);
    const child = this.deps.spawn(exe, buildBraveArgs({ url: this.currentUrl, userDataDir, debugPort: port }));
    this.child = child;
    child.on("exit", (code) => {
      this.deps.log(`[smartv-brave] exited (code ${code ?? "null"})`);
      this.child = null;
      this.conn?.close();
      this.conn = null;
      this.sessionId = null;
      this.targetId = null;
      this.windowId = null;
      this.visible = false;
    });
    child.on("error", (err) => {
      this.deps.log(`[smartv-brave] spawn error: ${err.message}`);
    });

    try {
      const { conn, sessionId, targetId } = await this.deps.connect(port);
      this.conn = conn;
      this.sessionId = sessionId;
      this.targetId = targetId;
      // Brave can still create a second page target for links opened by a
      // site (or by a native window.open call). SmartTV has one controlled
      // surface, so keep the original target and close those extra tabs.
      await this.conn.send("Target.setDiscoverTargets", { discover: true });
      this.conn.on("Target.targetCreated", (params) => {
        const info = params.targetInfo as { targetId?: string; type?: string } | undefined;
        if (info?.type !== "page" || !info.targetId || info.targetId === this.targetId) return;
        void this.conn
          ?.send("Target.closeTarget", { targetId: info.targetId })
          .catch((err) => this.deps.log(`[smartv-brave] extra tab closed: ${err.message}`));
      });
      await this.injectNavigation();
      await this.rememberWindowId();
      this.visible = true;
      this.deps.log(`[smartv-brave] attached (session ${sessionId.slice(0, 8)}…)`);
    } catch (err) {
      this.deps.log(`[smartv-brave] attach failed: ${(err as Error).message}`);
      this.conn?.close();
      this.conn = null;
      this.child = null;
    }
  }

  /** Injects the D-pad focus ring (service-preload) into every new document. */
  private async injectNavigation(): Promise<void> {
    if (!this.conn || !this.sessionId) return;
    const preloadPath = this.deps.preloadPath;
    if (!preloadPath) return;
    try {
      const source = this.deps.readFile(preloadPath);
      await this.conn.send(
        "Page.addScriptToEvaluateOnNewDocument",
        { source: wrapServicePreload(source), runImmediately: true },
        this.sessionId,
      );
      this.deps.log("[smartv-brave] TV navigation injected");
    } catch (err) {
      this.deps.log(`[smartv-brave] navigation injection failed: ${(err as Error).message}`);
    }
  }

  private async rememberWindowId(): Promise<void> {
    if (!this.conn || !this.sessionId || !this.targetId) return;
    try {
      const res = await this.conn.send<{ windowId?: number }>(
        "Browser.getWindowForTarget",
        { targetId: this.targetId },
        this.sessionId,
      );
      if (typeof res.windowId === "number") this.windowId = res.windowId;
    } catch {
      /* older builds: window bounds stay best-effort */
    }
  }

  private async setWindowState(state: "fullscreen" | "minimized" | "normal"): Promise<void> {
    if (!this.conn || this.windowId === null) return;
    await this.conn.send("Browser.setWindowBounds", {
      windowId: this.windowId,
      bounds: { windowState: state },
    });
  }

  async show(): Promise<void> {
    if (!this.isRunning()) return;
    try {
      await this.setWindowState("fullscreen");
      await this.conn?.send("Page.bringToFront", {}, this.sessionId ?? undefined);
      this.visible = true;
    } catch (err) {
      this.deps.log(`[smartv-brave] show failed: ${(err as Error).message}`);
    }
  }

  /** Hides Brave so the TV Home (Electron window) is visible again. */
  async hide(): Promise<void> {
    if (!this.isRunning()) return;
    try {
      await this.setWindowState("minimized");
      this.visible = false;
    } catch (err) {
      this.deps.log(`[smartv-brave] hide failed: ${(err as Error).message}`);
    }
  }

  async navigate(url: string): Promise<void> {
    if (!this.conn || !this.sessionId) return;
    this.currentUrl = url;
    try {
      await this.conn.send("Page.navigate", { url }, this.sessionId);
    } catch (err) {
      this.deps.log(`[smartv-brave] navigate failed: ${(err as Error).message}`);
    }
  }

  /** True when navigation actually went back (false at the first page). */
  async goBack(): Promise<boolean> {
    if (!this.conn || !this.sessionId) return false;
    try {
      const hist = await this.conn.send<{
        currentIndex?: number;
        entries?: { id: number }[];
      }>("Page.getNavigationHistory", {}, this.sessionId);
      const idx = hist.currentIndex ?? 0;
      const prev = hist.entries?.[idx - 1];
      if (!prev) return false;
      await this.conn.send("Page.navigateToHistoryEntry", { entryId: prev.id }, this.sessionId);
      return true;
    } catch {
      return false;
    }
  }

  /** Dispatches the phone's key events into the Brave page. */
  async dispatchKeys(events: CdpKeyEventLike[]): Promise<void> {
    if (!this.conn || !this.sessionId) return;
    for (const ev of events) {
      const params = cdpKeyParams(ev);
      if (!params) continue;
      try {
        await this.conn.send(
          "Input.dispatchKeyEvent",
          { ...params, autoRepeat: false, isKeypad: false },
          this.sessionId,
        );
      } catch (err) {
        this.deps.log(`[smartv-brave] key ${ev.keyCode} failed: ${(err as Error).message}`);
        break;
      }
    }
  }

  /** Runs JS in the streaming page (media play/pause, status probes). */
  async evalJs(expression: string): Promise<unknown> {
    if (!this.conn || !this.sessionId) return null;
    const res = await this.conn.send<{ result?: { value?: unknown } }>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      this.sessionId,
    );
    return res.result?.value ?? null;
  }

  async playPause(action: "play" | "pause"): Promise<void> {
    await this.evalJs(
      `for (const v of document.querySelectorAll("video")) { try { v.${action}(); } catch (e) {} }`,
    );
  }

  /** Graceful shutdown: ask Brave to close, then hard-kill if it lingers. */
  stop(): void {
    if (!this.child) return;
    this.conn?.send("Browser.close", {}).catch(() => undefined);
    const child = this.child;
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }, 1500).unref?.();
    this.child = null;
    this.conn = null;
    this.sessionId = null;
    this.targetId = null;
    this.windowId = null;
    this.visible = false;
  }
}

/** Default profile dir inside the app's userData (cookies/logins survive). */
export function braveUserDataDir(userDataDir: string): string {
  return path.join(userDataDir, "brave");
}

/** Default path of the compiled TV-navigation module (dist/service-preload.cjs). */
export function defaultPreloadPath(distDir: string): string {
  return path.join(distDir, "service-preload.cjs");
}
