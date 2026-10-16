import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import {
  helloSchema,
  controllerMessageSchema,
  agentStateSchema,
  MAX_MESSAGE_BYTES,
  safeEqual,
  CLOSE_CODES,
} from "@smartv/shared";
import type { Logger } from "./logger.js";
import { isOriginAllowed, normalizeOrigin } from "./origins.js";

export interface RoomConfig {
  roomToken: string;
  agentToken: string;
  allowedOrigins: string[];
}

// Token bucket simples por conexão: 60 msg/s (burst 60).
const RATE_LIMIT_PER_SEC = 60;

type Role = "controller" | "agent";

interface Client {
  ws: WebSocket;
  role: Role;
  authed: boolean;
  tokens: number;
  lastRefill: number;
  alive: boolean;
}

export function createRoomState() {
  return {
    agent: null as Client | null,
    controllers: new Set<Client>(),
  };
}

export type RoomState = ReturnType<typeof createRoomState>;

export function controllerCount(room: RoomState): number {
  return room.controllers.size;
}

export function agentOnline(room: RoomState): boolean {
  return room.agent !== null;
}

function noopLogger(): Logger {
  const noop = (): void => undefined;
  return { debug: noop, info: noop, warn: noop, error: noop };
}

export function attachRelay(
  wss: WebSocketServer,
  config: RoomConfig,
  room: RoomState,
  log: Logger = noopLogger(),
): void {
  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const origin = req.headers.origin as string | undefined;
    if (!isOriginAllowed(origin, config.allowedOrigins)) {
      log.warn("origin_not_allowed", {
        origin: normalizeOrigin(origin) || "-",
        allowed: config.allowedOrigins.join(",") || "-",
      });
      ws.close(CLOSE_CODES.ORIGIN_NOT_ALLOWED, "origin not allowed");
      return;
    }

    const client: Client = {
      ws,
      role: "controller",
      authed: false,
      tokens: RATE_LIMIT_PER_SEC,
      lastRefill: Date.now(),
      alive: true,
    };

    const helloTimer = setTimeout(() => {
      if (!client.authed) {
        log.warn("hello_fail", { reason: "timeout", role: "?" });
        ws.close(CLOSE_CODES.AUTH_FAILED, "auth timeout");
      }
    }, 5000);
    helloTimer.unref?.();

    ws.on("pong", () => {
      client.alive = true;
    });

    ws.on("message", (data: Buffer) => {
      if (Buffer.byteLength(data as Buffer) > MAX_MESSAGE_BYTES) {
        ws.close(CLOSE_CODES.MESSAGE_TOO_LARGE, "message too large");
        return;
      }
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        return; // ignora JSON inválido sem derrubar
      }
      if (!client.authed) {
        const hello = helloSchema.safeParse(msg);
        if (!hello.success || hello.data.v !== 1) {
          log.warn("hello_fail", { reason: "bad_hello", role: "?" });
          ws.close(CLOSE_CODES.AUTH_FAILED, "bad hello");
          return;
        }
        const expected = hello.data.role === "agent" ? config.agentToken : config.roomToken;
        if (!safeEqual(hello.data.token, expected)) {
          log.warn("hello_fail", { reason: "bad_token", role: hello.data.role });
          ws.close(CLOSE_CODES.AUTH_FAILED, "bad token");
          return;
        }
        client.authed = true;
        client.role = hello.data.role;
        clearTimeout(helloTimer);
        log.info("hello_ok", { role: client.role });
        if (client.role === "agent") {
          // Apenas um agente ativo: substitui o anterior.
          if (room.agent && room.agent.ws.readyState === WebSocket.OPEN) {
            try {
              room.agent.ws.close(CLOSE_CODES.REPLACED_BY_NEW_AGENT, "replaced by new agent");
            } catch {
              /* noop */
            }
            log.info("agent_replaced", {});
          }
          room.agent = client;
          log.info("agent_online", { controllers: controllerCount(room) });
          broadcastAgentOnline(room, true);
        } else {
          room.controllers.add(client);
          log.info("controller_online", { controllers: controllerCount(room) });
          // Informa ao controle recém-chegado se o PC está online.
          sendState(client.ws, room.agent !== null);
        }
        return;
      }

      // Rate limit
      const now = Date.now();
      const elapsed = (now - client.lastRefill) / 1000;
      client.tokens = Math.min(RATE_LIMIT_PER_SEC, client.tokens + elapsed * RATE_LIMIT_PER_SEC);
      client.lastRefill = now;
      if (client.tokens < 1) return; // descarta excesso silenciosamente
      client.tokens -= 1;

      if (client.role === "controller") {
        const parsed = controllerMessageSchema.safeParse(msg);
        if (!parsed.success) return;
        log.debug("cmd", { cmd: parsed.data.type });
        const raw = JSON.stringify(parsed.data);
        if (room.agent && room.agent.ws.readyState === WebSocket.OPEN) {
          room.agent.ws.send(raw);
        } else {
          // Sem agente: avisa o controle que o PC está offline.
          sendState(client.ws, false, "PC offline");
        }
      } else {
        // agent -> controllers: apenas eventos de estado validados.
        if (
          typeof msg === "object" &&
          msg !== null &&
          (msg as Record<string, unknown>).type === "pong"
        ) {
          return;
        }
        const parsed = agentStateSchema.safeParse(msg);
        if (!parsed.success) return;
        broadcast(room, JSON.stringify(parsed.data));
      }
    });

    ws.on("close", (code: number, reason: Buffer) => {
      clearTimeout(helloTimer);
      const reasonText = reason.toString("utf8").slice(0, 80);
      if (client.role === "agent" && room.agent === client) {
        room.agent = null;
        log.info("agent_offline", { code, reason: reasonText || "-" });
        broadcastAgentOnline(room, false);
      } else {
        room.controllers.delete(client);
        if (client.authed) {
          log.info("controller_offline", {
            code,
            reason: reasonText || "-",
            controllers: controllerCount(room),
          });
        } else {
          log.info("close", { code, reason: reasonText || "-", authed: false });
        }
      }
    });
  });

  const hb = setInterval(() => {
    for (const c of allClients(room)) {
      if (!c.alive) {
        try {
          c.ws.terminate();
        } catch {
          /* noop */
        }
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
        /* noop */
      }
    }
  }, 30000);
  hb.unref?.();
}

function allClients(room: RoomState): Client[] {
  const list: Client[] = [...room.controllers];
  if (room.agent) list.push(room.agent);
  return list;
}

function broadcast(room: RoomState, raw: string): void {
  for (const c of room.controllers) {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(raw);
  }
}

function sendState(ws: WebSocket, agentOnline: boolean, error?: string): void {
  const payload: Record<string, unknown> = { type: "state", agentOnline };
  if (error) payload.error = error;
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcastAgentOnline(room: RoomState, online: boolean): void {
  broadcast(room, JSON.stringify({ type: "state", agentOnline: online }));
}
