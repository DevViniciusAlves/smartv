import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { STREAMING_APPS } from "@smartv/shared";
import type { AgentConfig } from "./config.js";
import type { Automation } from "./automation.js";
import { TvBrowser } from "./browser.js";

interface FakeCdp {
  server: Server;
  wss: WebSocketServer;
  port: number;
  navigated: string[];
  closed: string[];
  connections: number;
  setPages(n: number): void;
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
    close: async () => undefined,
  };
  let pageCount = 1;
  fake.setPages = (n: number): void => {
    pageCount = n;
  };
  fake.server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const wsBase = `ws://127.0.0.1:${fake.port}`;
    if (url.pathname === "/json/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ webSocketDebuggerUrl: `${wsBase}/browser` }));
    } else if (url.pathname === "/json/list") {
      const pages = Array.from({ length: pageCount }, (_, i) => ({
        id: `page-${i}`,
        type: "page",
        url: "https://example.com/tv",
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

function configFor(port: number): AgentConfig {
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
});
