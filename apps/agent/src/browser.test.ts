import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { STREAMING_APPS } from "@smartv/shared";
import type { AgentConfig } from "./config.js";
import type { Automation, KeyName, Modifier, MouseButton } from "./automation.js";
import { TvBrowser } from "./browser.js";

interface FakeCdp {
  server: Server;
  wss: WebSocketServer;
  port: number;
  navigated: string[];
  closed: string[];
  connections: number;
  setPages(n: number): void;
  setTargets(urls: string[]): void;
  close(): Promise<void>;
}

async function startFakeCdp(): Promise<FakeCdp> {
  const fake: FakeCdp = {
    server: null as unknown as Server,
    wss: null as unknown as WebSocketServer,
    port: 0,
    navigated: [],
    closed: [],
    connections: 0,
    setPages: () => undefined,
    setTargets: () => undefined,
    close: async () => undefined,
  };
  let pageCount = 1;
  let customUrls: string[] | null = null;
  fake.setPages = (n: number): void => {
    pageCount = n;
    customUrls = null;
  };
  fake.setTargets = (urls: string[]): void => {
    customUrls = urls;
  };
  fake.server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const wsBase = `ws://127.0.0.1:${fake.port}`;
    if (url.pathname === "/json/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ webSocketDebuggerUrl: `${wsBase}/browser` }));
    } else if (url.pathname === "/json/list") {
      const urls = customUrls ?? Array.from({ length: pageCount }, () => "https://example.com/tv");
      const pages = urls.map((pageUrl, i) => ({
        id: `page-${i}`,
        type: "page",
        url: pageUrl,
        webSocketDebuggerUrl: `${wsBase}/page-${i}`,
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(pages));
    } else if (url.pathname.startsWith("/json/close/")) {
      fake.closed.push(url.pathname.split("/").pop() ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  fake.wss = new WebSocketServer({ server: fake.server });
  fake.wss.on("connection", (ws) => {
    fake.connections += 1;
    ws.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString("utf8")) as { id?: number; method?: string; params?: { url?: string } };
        if (msg.method === "Page.navigate" && msg.params?.url) {
          fake.navigated.push(msg.params.url);
        }
        ws.send(JSON.stringify({ id: msg.id, result: {} }));
      } catch {
        /* ignore */
      }
    });
  });
  await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  fake.port = (fake.server.address() as AddressInfo).port;
  fake.close = () =>
    new Promise<void>((resolve) => {
      fake.wss.close(() => fake.server.close(() => resolve()));
    });
  return fake;
}

let fakes: FakeCdp[] = [];
afterEach(async () => {
  await Promise.all(fakes.map((f) => f.close()));
  fakes = [];
});

const noopAuto = {
  tap: async () => undefined,
  combo: async () => undefined,
  typeViaClipboard: async () => undefined,
  backspace: async () => undefined,
  moveMouse: async () => undefined,
  click: async () => undefined,
  scroll: async () => undefined,
  volumeUp: async () => undefined,
  volumeDown: async () => undefined,
  volumeMute: async () => undefined,
  screenOff: async () => undefined,
} satisfies Automation;

class RecordingAuto implements Automation {
  calls: string[] = [];
  async tap(key: KeyName): Promise<void> {
    this.calls.push(`tap:${key}`);
  }
  async combo(mods: Modifier[], key: KeyName): Promise<void> {
    this.calls.push(`combo:${mods.join("+")}+${key}`);
  }
  async typeViaClipboard(text: string): Promise<void> {
    this.calls.push(`type:${text.length}`);
  }
  async backspace(): Promise<void> {
    this.calls.push("backspace");
  }
  async moveMouse(dx: number, dy: number): Promise<void> {
    this.calls.push(`move:${dx},${dy}`);
  }
  async click(button: MouseButton): Promise<void> {
    this.calls.push(`click:${button}`);
  }
  async scroll(dy: number): Promise<void> {
    this.calls.push(`scroll:${dy}`);
  }
  async volumeUp(step = 2): Promise<void> {
    this.calls.push(`volUp:${step}`);
  }
  async volumeDown(step = 2): Promise<void> {
    this.calls.push(`volDown:${step}`);
  }
  async volumeMute(): Promise<void> {
    this.calls.push("mute");
  }
  async screenOff(): Promise<void> {
    this.calls.push("screenOff");
  }
}

async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

function configFor(port: number, tvTarget: "edge" | "electron" = "edge"): AgentConfig {
  return {
    backendUrl: "ws://127.0.0.1:1/ws",
    agentToken: "test",
    browserPath: "edge",
    browserProfileDir: "profile",
    launcherUrl: "https://example.com/tv",
    tvWindowX: 0,
    tvWindowY: 0,
    backBehavior: "alt-left",
    tvMode: "kiosk",
    tvTarget,
    cdpPort: port,
  };
}

describe("TvBrowser", () => {
  it("navigates to whitelisted URLs over CDP", async () => {
    const fake = await startFakeCdp();
    fakes.push(fake);
    const tv = new TvBrowser(configFor(fake.port), noopAuto, () => undefined);
    const target = STREAMING_APPS[0].url;
    expect(await tv.navigate(target)).toBe(true);
    expect(fake.navigated).toEqual([target]);
  });
  it("rejects URLs outside the whitelist without touching CDP", async () => {
    const fake = await startFakeCdp();
    fakes.push(fake);
    const tv = new TvBrowser(configFor(fake.port), noopAuto, () => undefined);
    expect(await tv.navigate("https://evil.example/phish")).toBe(false);
    expect(fake.connections).toBe(0);
    expect(fake.navigated).toEqual([]);
  });
  it("closes extra tabs keeping a single page", async () => {
    const fake = await startFakeCdp();
    fakes.push(fake);
    fake.setPages(3);
    const tv = new TvBrowser(configFor(fake.port), noopAuto, () => undefined);
    expect(await tv.collapseToSingleTab()).toBe(1);
    expect(fake.closed.sort()).toEqual(["page-1", "page-2"]);
  });
  it("accepts the launcher URL", async () => {
    const fake = await startFakeCdp();
    fakes.push(fake);
    const tv = new TvBrowser(configFor(fake.port), noopAuto, () => undefined);
    expect(tv.isAllowed("https://example.com/tv")).toBe(true);
  });
  it("electron mode navigates the http surface and closes nothing", async () => {
    const fake = await startFakeCdp();
    fakes.push(fake);
    // App-like targets: local bar/home plus the remote service view.
    fake.setTargets(["file:///bar.html", "file:///home.html", "https://www.youtube.com/"]);
    const tv = new TvBrowser(configFor(fake.port, "electron"), noopAuto, () => undefined);
    expect(await tv.ensureRunning()).toBe("already-running");
    const target = STREAMING_APPS[1].url;
    expect(await tv.navigate(target)).toBe(true);
    expect(fake.navigated).toEqual([target]);
    expect(fake.closed).toEqual([]);
  });
  it("electron mode fails closed without Edge fallbacks when CDP is down", async () => {
    const port = await closedPort();
    const rec = new RecordingAuto();
    const logs: string[] = [];
    const tv = new TvBrowser(configFor(port, "electron"), rec, (m) => logs.push(m));
    expect(await tv.navigate(STREAMING_APPS[0].url)).toBe(false);
    expect(rec.calls).toEqual([]);
    expect(await tv.ensureRunning()).toBe("failed");
    expect(logs.some((l) => l.includes("--smartv-cdp"))).toBe(true);
  });
});
