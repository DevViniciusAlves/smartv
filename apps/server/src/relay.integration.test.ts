import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { CLOSE_CODES } from "@smartv/shared";
import { attachRelay, createRoomState } from "./relay.js";
import { createApp } from "./app.js";
import { attachUpgradeHandler } from "./upgrade.js";
import { createLogger } from "./logger.js";

const ROOM = "room-token-abc123";
const AGENT = "agent-token-xyz789";
const GOOD_ORIGIN = "https://app.vercel.app";

interface TestServer {
  port: number;
  lines: string[];
  clients: WebSocket[];
  close(): Promise<void>;
}

let servers: Array<() => Promise<void>> = [];
let sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets) {
    try {
      ws.terminate();
    } catch {
      /* noop */
    }
  }
  sockets = [];
  for (const close of servers) await close();
  servers = [];
});

async function startServer(): Promise<TestServer> {
  const lines: string[] = [];
  const log = createLogger("debug", (line) => lines.push(line));
  const room = createRoomState();
  const allowed = [GOOD_ORIGIN];
  const http: Server = createServer(createApp(room, allowed));
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  attachUpgradeHandler(http, wss, log);
  attachRelay(wss, { roomToken: ROOM, agentToken: AGENT, allowedOrigins: allowed }, room, log);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;
  const done = (): Promise<void> =>
    new Promise<void>((resolve) => {
      wss.close(() => http.close(() => resolve()));
    });
  servers.push(done);
  return {
    port,
    lines,
    clients: sockets,
    close: done,
  };
}

function open(url: string, origin?: string): WebSocket {
  const ws = new WebSocket(url, origin ? { headers: { Origin: origin } } : undefined);
  sockets.push(ws);
  return ws;
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("open timeout")), 5000);
    ws.once("open", () => {
      clearTimeout(t);
      resolve();
    });
    ws.once("error", (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

function waitClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    ws.once("close", (code: number) => resolve(code));
  });
}

function waitMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("message timeout")), 5000);
    ws.once("message", (data: Buffer) => {
      clearTimeout(t);
      resolve(data.toString("utf8"));
    });
  });
}

describe("server integration", () => {
  it("accepts controller with correct origin and token", async () => {
    const srv = await startServer();
    const ws = open(`ws://127.0.0.1:${srv.port}/ws`, GOOD_ORIGIN);
    await waitOpen(ws);
    ws.send(JSON.stringify({ type: "hello", role: "controller", token: ROOM, v: 1 }));
    const msg = JSON.parse(await waitMessage(ws)) as { type: string; agentOnline: boolean };
    expect(msg.type).toBe("state");
    expect(msg.agentOnline).toBe(false);
    expect(srv.lines.some((l) => l.includes("hello_ok") && l.includes("role=controller"))).toBe(true);
  });

  it("rejects wrong origin with 4403", async () => {
    const srv = await startServer();
    const ws = open(`ws://127.0.0.1:${srv.port}/ws`, "https://evil.example");
    expect(await waitClose(ws)).toBe(CLOSE_CODES.ORIGIN_NOT_ALLOWED);
    expect(srv.lines.some((l) => l.includes("origin_not_allowed"))).toBe(true);
  });

  it("accepts origin with trailing slash and uppercase", async () => {
    for (const variant of ["https://app.vercel.app/", "HTTPS://APP.VERCEL.APP"]) {
      const srv = await startServer();
      const ws = open(`ws://127.0.0.1:${srv.port}/ws`, variant);
      await waitOpen(ws);
      ws.send(JSON.stringify({ type: "hello", role: "controller", token: ROOM, v: 1 }));
      const msg = JSON.parse(await waitMessage(ws)) as { type: string };
      expect(msg.type).toBe("state");
    }
  });

  it("rejects wrong token with 4401 and never logs the token", async () => {
    const srv = await startServer();
    const ws = open(`ws://127.0.0.1:${srv.port}/ws`, GOOD_ORIGIN);
    await waitOpen(ws);
    ws.send(JSON.stringify({ type: "hello", role: "controller", token: "wrong-token", v: 1 }));
    expect(await waitClose(ws)).toBe(CLOSE_CODES.AUTH_FAILED);
    expect(srv.lines.some((l) => l.includes("hello_fail") && l.includes("bad_token"))).toBe(true);
    const all = srv.lines.join("\n");
    expect(all).not.toContain(ROOM);
    expect(all).not.toContain(AGENT);
    expect(all).not.toContain("wrong-token");
  });

  it("answers 404 on wrong websocket path", async () => {
    const srv = await startServer();
    const ws = open(`ws://127.0.0.1:${srv.port}/`, GOOD_ORIGIN);
    await expect(waitOpen(ws)).rejects.toThrow(/404/);
    expect(srv.lines.some((l) => l.includes("upgrade_rejected") && l.includes("bad_path"))).toBe(true);
  });

  it("brings agent online and replaces it with a newer one", async () => {
    const srv = await startServer();
    const ctl = open(`ws://127.0.0.1:${srv.port}/ws`, GOOD_ORIGIN);
    await waitOpen(ctl);
    ctl.send(JSON.stringify({ type: "hello", role: "controller", token: ROOM, v: 1 }));
    await waitMessage(ctl); // agentOnline: false
    const agent1 = open(`ws://127.0.0.1:${srv.port}/ws`, GOOD_ORIGIN);
    await waitOpen(agent1);
    agent1.send(JSON.stringify({ type: "hello", role: "agent", token: AGENT, v: 1 }));
    const online = JSON.parse(await waitMessage(ctl)) as { type: string; agentOnline: boolean };
    expect(online.agentOnline).toBe(true);
    const agent2 = open(`ws://127.0.0.1:${srv.port}/ws`, GOOD_ORIGIN);
    await waitOpen(agent2);
    agent2.send(JSON.stringify({ type: "hello", role: "agent", token: AGENT, v: 1 }));
    expect(await waitClose(agent1)).toBe(CLOSE_CODES.REPLACED_BY_NEW_AGENT);
    expect(srv.lines.some((l) => l.includes("agent_replaced"))).toBe(true);
  });

  it("accepts a native agent WITHOUT Origin header (Node/Electron ws)", async () => {
    // Regression test: the real Windows agent sends no Origin header.
    // With ALLOWED_ORIGINS configured, it must still connect (token auth
    // happens in the hello message, after the upgrade).
    const srv = await startServer();
    const ctl = open(`ws://127.0.0.1:${srv.port}/ws`, GOOD_ORIGIN);
    await waitOpen(ctl);
    ctl.send(JSON.stringify({ type: "hello", role: "controller", token: ROOM, v: 1 }));
    await waitMessage(ctl); // agentOnline: false
    const agent = open(`ws://127.0.0.1:${srv.port}/ws`); // no Origin
    await waitOpen(agent);
    agent.send(JSON.stringify({ type: "hello", role: "agent", token: AGENT, v: 1 }));
    const online = JSON.parse(await waitMessage(ctl)) as { type: string; agentOnline: boolean };
    expect(online.agentOnline).toBe(true);
  });

  it("serves /health with CORS only for allowed origins", async () => {
    const srv = await startServer();
    const ok = await fetch(`http://127.0.0.1:${srv.port}/health`, {
      headers: { Origin: GOOD_ORIGIN },
    });
    expect(ok.headers.get("access-control-allow-origin")).toBe(GOOD_ORIGIN);
    const body = (await ok.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body).toHaveProperty("uptimeSec");
    expect(body).toHaveProperty("agentOnline");
    expect(body).toHaveProperty("controllers");
    expect(body).toHaveProperty("version");
    const evil = await fetch(`http://127.0.0.1:${srv.port}/health`, {
      headers: { Origin: "https://evil.example" },
    });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });
});
