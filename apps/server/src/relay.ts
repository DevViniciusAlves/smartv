import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import {
  helloSchema,
  controllerMessageSchema,
  agentStateSchema,
  MAX_MESSAGE_BYTES,
  safeEqual,
} from "@smartv/shared";

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

export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isOriginAllowed(
  origin: string | undefined,
  allowed: string[],
): boolean {
  // Sem lista configurada: em dev permite tudo; em produção o operador deve configurar.
  if (allowed.length === 0) return true;
  if (!origin) return false;
  return allowed.includes(origin);
}

export function createRoomState() {
  return {
    agent: null as Client | null,
    controllers: new Set<Client>(),
  };
}

export type RoomState = ReturnType<typeof createRoomState>;

export function attachRelay(wss: WebSocketServer, config: RoomConfig, room: RoomState): void {
  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const origin = req.headers.origin as string | undefined;
    if (!isOriginAllowed(origin, config.allowedOrigins)) {
      ws.close(4403, "origin not allowed");
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
      if (!client.authed) ws.close(4401, "auth timeout");
    }, 5000);
    helloTimer.unref?.();

    ws.on("pong", () => {
      client.alive = true;
    });

    ws.on("message", (data: Buffer) => {
      if (Buffer.byteLength(data as Buffer) > MAX_MESSAGE_BYTES) {
        ws.close(4409, "message too large");
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
          ws.close(4401, "bad hello");
          return;
        }
        const expected = hello.data.role === "agent" ? config.agentToken : config.roomToken;
        if (!safeEqual(hello.data.token, expected)) {
          ws.close(4401, "bad token");
          return;
        }
        client.authed = true;
        client.role = hello.data.role;
        clearTimeout(helloTimer);
        if (client.role === "agent") {
          // Apenas um agente ativo: substitui o anterior.
          if (room.agent && room.agent.ws.readyState === WebSocket.OPEN) {
            try {
              room.agent.ws.close(4400, "replaced by new agent");
            } catch {
              /* noop */
            }
          }
          room.agent = client;
          broadcastAgentOnline(room, true);
        } else {
          room.controllers.add(client);
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

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (client.role === "agent" && room.agent === client) {
        room.agent = null;
        broadcastAgentOnline(room, false);
      } else {
        room.controllers.delete(client);
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
