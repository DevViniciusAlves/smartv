import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { CLOSE_CODES } from "@smartv/shared";
import { attachRelay, createRoomState } from "./relay.js";
import { createApp } from "./app.js";
import { attachUpgradeHandler } from "./upgrade.js";
import { createLogger } from "./logger.js";

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
  attachRelay(wss, { agentToken: AGENT, allowedOrigins: allowed }, room, log);
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
  // Single persistent queue per socket: `once("message")` waiters lose
  // messages when presence + reply arrive back-to-back, so buffer everything.
  const inbox: string[] = [];
  const waiters: Array<(v: string) => void> = [];
  ws.on("message", (data: Buffer) => {
    const text = data.toString("utf8");
    const w = waiters.shift();
    if (w) w(text);
    else inbox.push(text);
  });
  (ws as unknown as { __take: (timeoutMs: number) => Promise<string> }).__take = (
    timeoutMs: number,
  ) =>
    new Promise<string>((resolve, reject) => {
      const pending = inbox.shift();
      if (pending !== undefined) {
        resolve(pending);
        return;
      }
      const t = setTimeout(() => reject(new Error("message timeout")), timeoutMs);
      waiters.push((v: string) => {
        clearTimeout(t);
        resolve(v);
      });
    });
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
  return (ws as unknown as { __take: (t: number) => Promise<string> }).__take(5000);
}

describe("server integration", () => {
  // Phones enter ONLY via a code-issued session token (no fixed token).
  // Helper: links an agent, issues a code, pairs a phone, returns the
  // authenticated controller socket (state message already consumed).
  async function pairedController(
    srv: TestServer,
    origin: string = GOOD_ORIGIN,
  ): Promise<WebSocket> {
    const agent = open(`ws://127.0.0.1:${srv.port}/ws`);
    await waitOpen(agent);
    agent.send(JSON.stringify({ type: "hello", role: "agent", token: AGENT, v: 1 }));
    agent.send(JSON.stringify({ type: "pair-code-request" }));
    let code = "";
    for (let i = 0; i < 10; i++) {
      const m = JSON.parse(await waitMessage(agent)) as { type?: string; code?: string };
      if (m.type === "pair-code" && m.code) {
        code = m.code;
        break;
      }
    }
    if (!code) throw new Error("pair-code not received");
    const ws = open(`ws://127.0.0.1:${srv.port}/ws`, origin);
    await waitOpen(ws);
    ws.send(JSON.stringify({ type: "pair", code }));
    const first = JSON.parse(await waitMessage(ws)) as { type: string };
    if (first.type !== "pair-ok") throw new Error(`pairing failed: ${first.type}`);
    await waitMessage(ws); // state
    return ws;
  }

  it("accepts controller paired by code", async () => {
    const srv = await startServer();
    await pairedController(srv);
    expect(srv.lines.some((l) => l.includes("hello_ok") && l.includes("role=controller"))).toBe(true);
    expect(srv.lines.some((l) => l.includes("pair_ok"))).toBe(true);
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
      await pairedController(srv, variant);
    }
  });

  it("rejects unknown hello token with 4401 and never logs secrets", async () => {
    const srv = await startServer();
    const ws = open(`ws://127.0.0.1:${srv.port}/ws`, GOOD_ORIGIN);
    await waitOpen(ws);
    ws.send(JSON.stringify({ type: "hello", role: "controller", token: "wrong-token", v: 1 }));
    expect(await waitClose(ws)).toBe(CLOSE_CODES.AUTH_FAILED);
    expect(srv.lines.some((l) => l.includes("hello_fail") && l.includes("bad_token"))).toBe(true);
    const all = srv.lines.join("\n");
    expect(all).not.toContain(AGENT);
    expect(all).not.toContain("wrong-token");
  });

  it("rejects the retired fixed token: only pair sessions connect", async () => {
    const srv = await startServer();
    const ws = open(`ws://127.0.0.1:${srv.port}/ws`, GOOD_ORIGIN);
    await waitOpen(ws);
    ws.send(JSON.stringify({ type: "hello", role: "controller", token: "any-old-fixed-token", v: 1 }));
    expect(await waitClose(ws)).toBe(CLOSE_CODES.AUTH_FAILED);
  });

  it("answers 404 on wrong websocket path", async () => {
    const srv = await startServer();
    const ws = open(`ws://127.0.0.1:${srv.port}/`, GOOD_ORIGIN);
    await expect(waitOpen(ws)).rejects.toThrow(/404/);
    expect(srv.lines.some((l) => l.includes("upgrade_rejected") && l.includes("bad_path"))).toBe(true);
  });

  it("brings agent online and replaces it with a newer one", async () => {
    const srv = await startServer();
    const ctl = await pairedController(srv);
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
    await pairedController(srv);
    const agent = open(`ws://127.0.0.1:${srv.port}/ws`); // no Origin
    await waitOpen(agent);
    agent.send(JSON.stringify({ type: "hello", role: "agent", token: AGENT, v: 1 }));
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

describe("pairing flow", () => {
  async function linkAgent(port: number, deviceId?: string): Promise<WebSocket> {
    const agent = open(`ws://127.0.0.1:${port}/ws`);
    await waitOpen(agent);
    agent.send(
      JSON.stringify({
        type: "hello",
        role: "agent",
        token: AGENT,
        v: 1,
        ...(deviceId ? { deviceId } : {}),
      }),
    );
    return agent;
  }

  async function requestCode(agent: WebSocket): Promise<{ code: string; expiresAt: number }> {
    agent.send(JSON.stringify({ type: "pair-code-request" }));
    // The agent socket also receives `presence` updates; skip them.
    for (let i = 0; i < 10; i++) {
      const m = JSON.parse(await waitMessage(agent)) as { type?: string; code?: string };
      if (m.type === "pair-code") return m as { code: string; expiresAt: number };
    }
    throw new Error("pair-code not received");
  }

  async function pairPhone(
    port: number,
    code: string,
  ): Promise<{ ws: WebSocket; first: Record<string, unknown> }> {
    const ws = open(`ws://127.0.0.1:${port}/ws`, GOOD_ORIGIN);
    await waitOpen(ws);
    ws.send(JSON.stringify({ type: "pair", code }));
    const first = JSON.parse(await waitMessage(ws)) as Record<string, unknown>;
    return { ws, first };
  }

  it("pairs by code: pair-ok + state, commands reach only the linked agent", async () => {
    const srv = await startServer();
    const agent = await linkAgent(srv.port, "pc-1");
    const { code } = await requestCode(agent);
    expect(code).toMatch(/^\d{6}$/);
    const { first } = await pairPhone(srv.port, code);
    expect(first.type).toBe("pair-ok");
    expect(first.deviceId).toBe("pc-1");
    expect(typeof first.token).toBe("string");
    // Reconnect with the minted session token works (persisted binding).
    const token = first.token as string;
    const ctl2 = open(`ws://127.0.0.1:${srv.port}/ws`, GOOD_ORIGIN);
    await waitOpen(ctl2);
    ctl2.send(JSON.stringify({ type: "hello", role: "controller", token, v: 1 }));
    const st = JSON.parse(await waitMessage(ctl2)) as { type: string; agentOnline: boolean };
    expect(st.type).toBe("state");
    expect(st.agentOnline).toBe(true);
  });

  it("rejects incorrect codes and consumed codes cannot be reused", async () => {
    const srv = await startServer();
    await linkAgent(srv.port, "pc-1");
    const { first } = await pairPhone(srv.port, "000000");
    expect(first).toEqual({ type: "pair-error", reason: "incorrect" });
    const agent = open(`ws://127.0.0.1:${srv.port}/ws`);
    await waitOpen(agent);
    agent.send(JSON.stringify({ type: "hello", role: "agent", token: AGENT, v: 1, deviceId: "pc-9" }));
    agent.send(JSON.stringify({ type: "pair-code-request" }));
    // Skip `presence` updates also delivered on the agent socket.
    let pc: { code: string; type?: string } = { code: "" };
    for (let i = 0; i < 10; i++) {
      pc = JSON.parse(await waitMessage(agent)) as { code: string; type?: string };
      if (pc.type === "pair-code") break;
    }
    const ok = await pairPhone(srv.port, pc.code);
    expect(ok.first.type).toBe("pair-ok");
    const reuse = await pairPhone(srv.port, pc.code);
    expect(reuse.first).toEqual({ type: "pair-error", reason: "used" });
  });

  it("a new code invalidates the previous one", async () => {
    const srv = await startServer();
    const agent = await linkAgent(srv.port, "pc-1");
    const first = await requestCode(agent);
    await requestCode(agent);
    const { first: err } = await pairPhone(srv.port, first.code);
    expect(err).toEqual({ type: "pair-error", reason: "used" });
  });

  it("rate-limits guessing: 11th attempt in a minute is rejected", async () => {
    const srv = await startServer();
    await linkAgent(srv.port, "pc-1");
    const ws = open(`ws://127.0.0.1:${srv.port}/ws`, GOOD_ORIGIN);
    await waitOpen(ws);
    let last = "";
    for (let i = 0; i < 11; i++) {
      ws.send(JSON.stringify({ type: "pair", code: "000000" }));
      last = await waitMessage(ws);
    }
    expect(JSON.parse(last)).toEqual({ type: "pair-error", reason: "rate-limited" });
  });

  it("unpair ends only that session; others keep controlling", async () => {
    const srv = await startServer();
    const agent = await linkAgent(srv.port, "pc-1");
    const c1 = await requestCode(agent);
    const phone1 = await pairPhone(srv.port, c1.code);
    const token1 = phone1.first.token as string;
    const c2 = await requestCode(agent);
    const phone2 = await pairPhone(srv.port, c2.code);
    expect(phone2.first.type).toBe("pair-ok");
    // Phone 1 unpairs: gets `unpaired` then close; phone 2 still works.
    // (Drain the `state` queued right after pair-ok first.)
    const drained = JSON.parse(await waitMessage(phone1.ws)) as { type: string };
    expect(drained.type).toBe("state");
    const closed = waitClose(phone1.ws);
    phone1.ws.send(JSON.stringify({ type: "unpair" }));
    const bye = JSON.parse(await waitMessage(phone1.ws)) as { type: string };
    expect(bye.type).toBe("unpaired");
    await closed;
    phone2.ws.send(JSON.stringify({ type: "key", key: "up" }));
    // Skip `presence` updates queued on the agent socket.
    let got: { type: string; key?: string } = { type: "" };
    for (let i = 0; i < 10; i++) {
      got = JSON.parse(await waitMessage(agent)) as { type: string; key?: string };
      if (got.type === "key") break;
    }
    expect(got).toEqual({ type: "key", key: "up" });
    // Revoked token cannot hello again.
    const retry = open(`ws://127.0.0.1:${srv.port}/ws`, GOOD_ORIGIN);
    await waitOpen(retry);
    retry.send(JSON.stringify({ type: "hello", role: "controller", token: token1, v: 1 }));
    expect(await waitClose(retry)).toBe(CLOSE_CODES.AUTH_FAILED);
  });

  it("pairing when the PC is offline reports unavailable (no orphan session)", async () => {
    const srv = await startServer();
    // No agent linked, but a code object exists nowhere: use incorrect path.
    // First link + issue, then kill the agent, then redeem the (valid) code.
    const agent = await linkAgent(srv.port, "pc-1");
    const { code } = await requestCode(agent);
    agent.terminate();
    await new Promise((r) => setTimeout(r, 200));
    const { first } = await pairPhone(srv.port, code);
    expect(first).toEqual({ type: "pair-error", reason: "unavailable" });
  });
});
