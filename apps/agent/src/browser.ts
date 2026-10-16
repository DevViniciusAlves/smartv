import { spawn } from "node:child_process";
import WebSocket from "ws";
import { STREAMING_APPS } from "@smartv/shared";
import type { Automation } from "./automation.js";
import type { AgentConfig } from "./config.js";

// Single Edge window (dedicated profile) driven over CDP on 127.0.0.1 only.
// Home and the app shortcuts navigate this same window; no second process,
// tab, window or default browser is ever opened by the happy path.
export interface BrowserNavigator {
  navigate(url: string): Promise<boolean>;
}

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

interface CdpVersion {
  webSocketDebuggerUrl: string;
}

const FETCH_TIMEOUT_MS = 2500;

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function cdpSend(debuggerUrl: string, method: string, params?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(debuggerUrl);
    const done = (fn: () => void): void => {
      try {
        fn();
      } catch {
        /* noop */
      }
      try {
        ws.close();
      } catch {
        /* noop */
      }
    };
    const timer = setTimeout(() => done(() => reject(new Error("cdp timeout"))), 8000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ id: 1, method, params: params ?? {} }));
    });
    ws.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString("utf8")) as { id?: number; result?: unknown };
        if (msg.id === 1) {
          clearTimeout(timer);
          done(() => resolve(msg.result));
        }
      } catch {
        /* ignore non-JSON */
      }
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      done(() => reject(err));
    });
  });
}

export class TvBrowser implements BrowserNavigator {
  constructor(
    private readonly config: AgentConfig,
    private readonly auto: Automation,
    private readonly log: (msg: string) => void,
  ) {}

  private cdpBase(): string {
    return `http://127.0.0.1:${this.config.cdpPort}`;
  }

  private static normalize(url: string): string {
    return url.replace(/\/+$/, "");
  }

  allowedTargets(): string[] {
    const urls = STREAMING_APPS.map((a) => a.url);
    if (this.config.launcherUrl) urls.push(this.config.launcherUrl);
    return urls;
  }

  isAllowed(url: string): boolean {
    const want = TvBrowser.normalize(url);
    return this.allowedTargets().some((u) => TvBrowser.normalize(u) === want);
  }

  private launchArgs(startUrl: string): string[] {
    const c = this.config;
    const base = [
      `--user-data-dir=${c.browserProfileDir}`,
      `--remote-debugging-port=${c.cdpPort}`,
      "--remote-debugging-address=127.0.0.1",
      `--window-position=${c.tvWindowX},${c.tvWindowY}`,
      "--no-first-run",
      "--disable-session-crashed-bubble",
    ];
    if (c.tvMode === "app") {
      return [...base, `--app=${startUrl}`, "--start-fullscreen"];
    }
    return [...base, "--kiosk", startUrl, "--edge-kiosk-type=fullscreen"];
  }

  private spawnEdge(startUrl: string): void {
    const child = spawn(this.config.browserPath, this.launchArgs(startUrl), {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
  }

  private async waitForCdp(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const v = await fetchJson<CdpVersion>(`${this.cdpBase()}/json/version`);
      if (v?.webSocketDebuggerUrl) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  // Guarantees the TV window exists (kiosk/app, dedicated profile).
  async ensureRunning(): Promise<"already-running" | "started" | "failed" | "skipped"> {
    const c = this.config;
    if (!c.browserProfileDir) {
      this.log("browser skipped: BROWSER_PROFILE_DIR not set");
      return "skipped";
    }
    const up = await fetchJson<CdpVersion>(`${this.cdpBase()}/json/version`);
    if (up?.webSocketDebuggerUrl) {
      this.log("browser already running, reusing window");
      await this.collapseToSingleTab();
      return "already-running";
    }
    this.log(`browser starting (mode=${c.tvMode})`);
    this.spawnEdge(c.launcherUrl);
    const ok = await this.waitForCdp(15000);
    if (!ok) {
      this.log("browser failed: CDP endpoint did not come up");
      return "failed";
    }
    if (c.tvMode === "app") await this.moveToTvMonitor();
    this.log("browser started");
    return "started";
  }

  // Moves the app-mode window to the TV monitor and makes it fullscreen.
  private async moveToTvMonitor(): Promise<void> {
    try {
      const version = await fetchJson<CdpVersion>(`${this.cdpBase()}/json/version`);
      const targets = await fetchJson<CdpTarget[]>(`${this.cdpBase()}/json/list`);
      const page = targets?.find((t) => t.type === "page");
      if (!version?.webSocketDebuggerUrl || !page) return;
      const { windowId } = (await cdpSend(version.webSocketDebuggerUrl, "Browser.getWindowForTarget", {
        targetId: page.id,
      })) as { windowId: number };
      const c = this.config;
      await cdpSend(version.webSocketDebuggerUrl, "Browser.setWindowBounds", {
        windowId,
        bounds: { left: c.tvWindowX, top: c.tvWindowY, windowState: "normal" },
      });
      await cdpSend(version.webSocketDebuggerUrl, "Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "fullscreen" },
      });
      this.log("browser moved to TV monitor (fullscreen)");
    } catch (err) {
      this.log(`browser move failed: ${(err as Error).message}`);
    }
  }

  // Navigates the single TV window. Only whitelisted URLs are accepted;
  // a URL from the network can never drive the browser.
  async navigate(url: string): Promise<boolean> {
    if (!this.isAllowed(url)) {
      this.log("browser navigate rejected: URL not in whitelist");
      return false;
    }
    try {
      await this.navigateViaCdp(url);
      this.log("browser navigate: cdp");
      return true;
    } catch (err) {
      this.log(`browser cdp failed (${(err as Error).message}), trying fallback`);
    }
    try {
      await this.navigateViaAddressBar(url);
      this.log("browser navigate: fallback address-bar");
      return true;
    } catch (err) {
      this.log(`browser address-bar fallback failed (${(err as Error).message}), trying respawn`);
    }
    try {
      // Same --user-data-dir: Edge forwards to the running instance instead
      // of opening a second window.
      this.spawnEdge(url);
      this.log("browser navigate: fallback respawn");
      return true;
    } catch (err) {
      this.log(`browser navigate failed: ${(err as Error).message}`);
      return false;
    }
  }

  private async navigateViaCdp(url: string): Promise<void> {
    const targets = await fetchJson<CdpTarget[]>(`${this.cdpBase()}/json/list`);
    const page = targets?.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (!page) throw new Error("no page target");
    await cdpSend(page.webSocketDebuggerUrl, "Page.navigate", { url });
    await cdpSend(page.webSocketDebuggerUrl, "Page.bringToFront");
    await this.collapseToSingleTab(page.id);
  }

  // Closes extra page targets (e.g. a target=_blank link that escaped),
  // keeping a single tab. Returns the number of pages kept.
  async collapseToSingleTab(keepId?: string): Promise<number> {
    try {
      const targets = await fetchJson<CdpTarget[]>(`${this.cdpBase()}/json/list`);
      const pages = (targets ?? []).filter((t) => t.type === "page");
      if (pages.length === 0) return 0;
      const keep = keepId ?? pages[0].id;
      for (const p of pages) {
        if (p.id !== keep) await fetchJson(`${this.cdpBase()}/json/close/${p.id}`);
      }
      if (pages.length > 1) this.log(`browser closed ${pages.length - 1} extra tab(s)`);
      return 1;
    } catch (err) {
      this.log(`browser collapse failed: ${(err as Error).message}`);
      return 0;
    }
  }

  // Fallback 1: focus the address bar (Ctrl+L), paste the URL, Enter.
  private async navigateViaAddressBar(url: string): Promise<void> {
    await this.auto.combo(["ctrl"], "l");
    await this.auto.typeViaClipboard(url);
    await this.auto.tap("enter");
  }
}
