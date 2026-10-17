import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import {
  helloSchema,
  controllerMessageSchema,
  agentStateSchema,
  pairCodeRequestSchema,
  pairRequestSchema,
  unpairSchema,
  MAX_MESSAGE_BYTES,
  safeEqual,
  CLOSE_CODES,
} from "@smartv/shared";
import type { Logger } from "./logger.js";
import { isOriginAllowed, normalizeOrigin } from "./origins.js";
import { PairingManager } from "./pairing.js";

export interface RoomConfig {
  agentToken: string;
  allowedOrigins: string[];
}

// Token bucket simples por conexão: 60 msg/s (burst 60).
const RATE_LIMIT_PER_SEC = 60;
// Anti-brute-force do pareamento: 10 tentativas de código por minuto/socket.
const PAIR_MAX_ATTEMPTS = 10;
const PAIR_WINDOW_MS = 60 * 1000;
// Janela de hello estendida quando o celular está pareando (rede lenta).
const PAIR_HELLO_GRACE_MS = 20000;

type Role = "controller" | "agent";

interface Client {
  ws: WebSocket;
  role: Role;
  authed: boolean;
  tokens: number;
  lastRefill: number;
  alive: boolean;
  // Pareamento (só controllers): token de sessão emitido no pair-ok.
  pairToken: string | null;
  pairDeviceId: string | null;
  pairAttempts: number;
  pairWindowStart: number;
}

export function createRoomState() {
  return {
    agent: null as Client | null,
    controllers: new Set<Client>(),
    pairing: new PairingManager(),
    // Installation id reported by the current agent (null = legacy agent
    // without deviceId). Pairing codes/sessions bind to it.
    deviceId: null as string | null,
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
  // Durable phone sessions: signed with the server secret so a restart of the
  // free instance never forces the phone to pair again (see pairing.ts).
  room.pairing.setSessionSecret(config.agentToken);

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
      pairToken: null,
      pairDeviceId: null,
      pairAttempts: 0,
      pairWindowStart: Date.now(),
    };

    let helloTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      helloTimer = null;
      if (!client.authed) {
        log.warn("hello_fail", { reason: "timeout", role: "?" });
        ws.close(CLOSE_CODES.AUTH_FAILED, "auth timeout");
      }
    }, 5000);
    helloTimer.unref?.();

    // Gives the phone more time while it is actively pairing (slow nets).
    const extendHelloWindow = (): void => {
      if (client.authed || helloTimer === null) return;
      clearTimeout(helloTimer);
      helloTimer = setTimeout(() => {
        helloTimer = null;
        if (!client.authed) {
          log.warn("hello_fail", { reason: "timeout", role: "pair" });
          ws.close(CLOSE_CODES.AUTH_FAILED, "auth timeout");
        }
      }, PAIR_HELLO_GRACE_MS);
      helloTimer.unref?.();
    };

    const clearHelloTimer = (): void => {
      if (helloTimer !== null) {
        clearTimeout(helloTimer);
        helloTimer = null;
      }
    };

    const authenticateAgent = (deviceId?: string): void => {
      client.authed = true;
      client.role = "agent";
      clearHelloTimer();
      log.info("hello_ok", { role: "agent" });
      if (deviceId) room.deviceId = deviceId;
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
      sendPresence(room);
    };

    const authenticateController = (pairToken: string | null, deviceId: string | null): void => {
      client.authed = true;
      client.role = "controller";
      client.pairToken = pairToken;
      client.pairDeviceId = deviceId;
      clearHelloTimer();
      log.info("hello_ok", { role: "controller" });
      room.controllers.add(client);
      log.info("controller_online", { controllers: controllerCount(room) });
      // Informa ao controle recém-chegado se o PC está online.
      sendState(client.ws, room.agent !== null);
      sendPresence(room);
    };

    const handlePairAttempt = (raw: unknown): void => {
      // Rate limit per socket: constant window, no token/secret in replies.
      const t = Date.now();
      if (t - client.pairWindowStart > PAIR_WINDOW_MS) {
        client.pairWindowStart = t;
        client.pairAttempts = 0;
      }
      client.pairAttempts += 1;
      if (client.pairAttempts > PAIR_MAX_ATTEMPTS) {
        log.warn("pair_fail", { reason: "rate-limited" });
        sendPairError(ws, "rate-limited");
        return;
      }
      const parsed = pairRequestSchema.safeParse(raw);
      if (!parsed.success) return;
      const res = room.pairing.redeem(parsed.data.code, t);
      if (!res.ok) {
        log.warn("pair_fail", { reason: res.reason });
        sendPairError(ws, res.reason);
        extendHelloWindow();
        return;
      }
      if (room.agent === null) {
        // Code valid but the PC is offline: do not mint a session on a dead
        // room; the phone shows DESCONECTADO and retries after the PC links.
        log.warn("pair_fail", { reason: "unavailable" });
        sendPairError(ws, "unavailable");
        extendHelloWindow();
        return;
      }
      const token = room.pairing.mintSessionToken(res.deviceId);
      log.info("pair_ok", { controllers: controllerCount(room) + 1 });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "pair-ok", deviceId: res.deviceId, token }));
      }
      authenticateController(token, res.deviceId);
    };

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
        // Pairing attempt (phone redeeming the PC code) may arrive instead
        // of hello. Validated here, server-side; never trusted from frontend.
        const pair = pairRequestSchema.safeParse(msg);
        if (pair.success) {
          handlePairAttempt(msg);
          return;
        }
        const hello = helloSchema.safeParse(msg);
        if (!hello.success || hello.data.v !== 1) {
          log.warn("hello_fail", { reason: "bad_hello", role: "?" });
          ws.close(CLOSE_CODES.AUTH_FAILED, "bad hello");
          return;
        }
        if (hello.data.role === "agent") {
          if (!safeEqual(hello.data.token, config.agentToken)) {
            log.warn("hello_fail", { reason: "bad_token", role: "agent" });
            ws.close(CLOSE_CODES.AUTH_FAILED, "bad token");
            return;
          }
          authenticateAgent(hello.data.deviceId);
          return;
        }
        // Controller: SOMENTE session token emitido via pareamento (código).
        // Não existe mais token fixo: sem pair-ok prévio, não há controle.
        const boundDevice = room.pairing.deviceOfToken(hello.data.token);
        if (boundDevice !== null && (room.deviceId === null || boundDevice === room.deviceId)) {
          authenticateController(hello.data.token, boundDevice);
          return;
        }
        log.warn("hello_fail", { reason: "bad_token", role: "controller" });
        ws.close(CLOSE_CODES.AUTH_FAILED, "bad token");
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
        // Encerrar conexão: invalida SÓ esta sessão (por token) e fecha.
        // Outros celulares vinculados não são afetados. O PC continua ligado.
        if (unpairSchema.safeParse(msg).success) {
          if (client.pairToken) room.pairing.revokeToken(client.pairToken);
          client.pairToken = null;
          log.info("controller_unpaired", { controllers: controllerCount(room) });
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "unpaired" }));
          try {
            ws.close(1000, "unpaired");
          } catch {
            /* noop */
          }
          return;
        }
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
        // agent -> server: pedido de código de pareamento para o modal Conexão.
        if (pairCodeRequestSchema.safeParse(msg).success) {
          const device = room.deviceId ?? "default";
          const { code, expiresAt } = room.pairing.issue(device);
          log.info("pair_code_issued", { controllers: controllerCount(room) });
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "pair-code", code, expiresAt }));
          }
          return;
        }
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
      clearHelloTimer();
      const reasonText = reason.toString("utf8").slice(0, 80);
      if (client.role === "agent" && room.agent === client) {
        room.agent = null;
        log.info("agent_offline", { code, reason: reasonText || "-" });
        // O celular deve sair de CONECTADO na hora: PC fechou/caiu.
        broadcastAgentOnline(room, false);
      } else {
        // Pair session tokens survive normal drops so the phone reconnects
        // without pairing again; only `unpair` revokes them.
        room.controllers.delete(client);
        if (client.authed) {
          log.info("controller_offline", {
            code,
            reason: reasonText || "-",
            controllers: controllerCount(room),
          });
          sendPresence(room);
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

function sendPairError(ws: WebSocket, reason: string): void {
  // Never leaks tokens: fixed reason enum only.
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "pair-error", reason }));
}

function sendPresence(room: RoomState): void {
  if (room.agent && room.agent.ws.readyState === WebSocket.OPEN) {
    room.agent.ws.send(JSON.stringify({ type: "presence", controllers: controllerCount(room) }));
  }
}

function broadcastAgentOnline(room: RoomState, online: boolean): void {
  broadcast(room, JSON.stringify({ type: "state", agentOnline: online }));
}
