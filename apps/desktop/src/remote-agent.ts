// Embedded agent: the installed Electron app connects to the Render relay
// BY ITSELF as `role: "agent"`.
//
// Why: before this, only the standalone Node.js agent (apps/agent) held the
// room. Installing SmartTV Setup.exe alone left /controle on "PC offline"
// forever, and running both agents with the same AGENT_TOKEN makes the server
// kick the older one (4400 REPLACED_BY_NEW_AGENT) in a flap loop.
//
// Behavior:
//   - hello role=agent with AGENT_TOKEN, heartbeat ping every 30 s (also keeps
//     the free Render service awake), exponential-backoff reconnect (max 30 s)
//   - 4401/4403 NEVER retry in a loop: they need user action (fix token in the
//     Configuração panel or ALLOWED_ORIGINS on Render)
//   - 4400 (replaced): warn loudly — almost always the standalone agent with
//     the same token still running — then retry (last writer wins)
//   - incoming messages are validated by the shared zod whitelist; anything
//     else is ignored, never executed
//
// Transport is injected (default: `ws`) so tests run without a network.

import WebSocket from "ws";
import {
  controllerMessageSchema,
  pairCodeSchema,
  presenceSchema,
  describeClose,
} from "@smartv/shared";
import type { ControllerMessage } from "@smartv/shared";

export interface RemoteAgentConfig {
  backendUrl: string;
  agentToken: string;
  /** Stable installation id (persisted in userData). Binds pairing codes. */
  deviceId?: string;
}

export interface PairCodeInfo {
  code: string;
  expiresAt: number;
}

export interface RemoteAgentEvents {
  onStatus(text: string): void;
  onCommand(msg: ControllerMessage): void;
  onPairCode?(info: PairCodeInfo): void;
  onPresence?(controllers: number): void;
  onLog?(line: string): void;
}

export type WsLike = {
  send(data: string): void;
  close(): void;
  on(event: "open" | "message" | "close" | "error", cb: (...args: never[]) => void): void;
};

export function backoffDelayMs(attempt: number): number {
  return Math.min(30000, 1000 * 2 ** Math.min(Math.max(0, attempt), 5));
}

export class EmbeddedAgent {
  private ws: WsLike | null = null;
  private stopped = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly getConfig: () => RemoteAgentConfig | null,
    private readonly events: RemoteAgentEvents,
    private readonly createWs: (url: string) => WsLike = defaultCreateWs,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  /** Re-reads config (after the user saves in Configuração) and reconnects now. */
  reconnect(): void {
    this.cleanupSocket();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.attempt = 0;
    if (!this.stopped) this.connect();
  }

  /** Asks the server for a fresh pairing code (invalidates the previous). */
  requestPairCode(): boolean {
    if (!this.ws) return false;
    try {
      this.ws.send(JSON.stringify({ type: "pair-code-request" }));
      return true;
    } catch {
      return false;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.cleanupSocket();
  }

  private log(line: string): void {
    try {
      this.events.onLog?.(line);
    } catch {
      /* noop */
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const cfg = this.getConfig();
    if (!cfg) {
      this.events.onStatus("Controle: não configurado — abra Configuração e salve servidor + token");
      return;
    }
    this.attempt += 1;
    this.events.onStatus("Controle: conectando…");
    let ws: WsLike;
    try {
      ws = this.createWs(cfg.backendUrl);
    } catch (err) {
      this.log(`[remote] ws create failed: ${(err as Error).message}`);
      this.schedule();
      return;
    }
    this.ws = ws;
    const token = cfg.agentToken;
    const deviceId = cfg.deviceId;
    ws.on("open", (() => {
      this.attempt = 0;
      try {
        ws.send(
          JSON.stringify({
            type: "hello",
            role: "agent",
            token,
            v: 1,
            ...(deviceId ? { deviceId } : {}),
          }),
        );
      } catch {
        /* noop */
      }
      this.log("[remote] hello sent as agent");
      this.events.onStatus("Controle: online — celular pode conectar");
      this.startHeartbeat();
    }) as (...args: never[]) => void);
    ws.on("message", ((data: unknown) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      // Server-to-agent service messages (pairing/presence) are handled
      // before the command whitelist.
      if (pairCodeSchema.safeParse(msg).success) {
        const info = msg as PairCodeInfo;
        this.log(`[remote] pair code received (expires ${new Date(info.expiresAt).toISOString()})`);
        try {
          this.events.onPairCode?.(info);
        } catch {
          /* noop */
        }
        return;
      }
      if (presenceSchema.safeParse(msg).success) {
        try {
          this.events.onPresence?.((msg as { controllers: number }).controllers);
        } catch {
          /* noop */
        }
        return;
      }
      const parsed = controllerMessageSchema.safeParse(msg);
      if (!parsed.success) return;
      if (parsed.data.type === "ping") {
        try {
          ws.send(JSON.stringify({ type: "pong" }));
        } catch {
          /* noop */
        }
        return;
      }
      try {
        this.events.onCommand(parsed.data);
      } catch (err) {
        this.log(`[remote] command failed: ${(err as Error).message}`);
      }
    }) as (...args: never[]) => void);
    ws.on("close", ((code: unknown, reason: unknown) => {
      const num = typeof code === "number" ? code : 1006;
      const text = reason == null ? "" : String(reason).slice(0, 80);
      this.onClose(num, text);
    }) as (...args: never[]) => void);
    ws.on("error", ((err: unknown) => {
      this.log(`[remote] ws error: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
    }) as (...args: never[]) => void);
  }

  private startHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      try {
        this.ws?.send(JSON.stringify({ type: "ping" }));
      } catch {
        /* noop */
      }
    }, 30000);
    unrefTimer(this.heartbeat);
  }

  private onClose(code: number, reason: string): void {
    this.cleanupSocket();
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (this.stopped) return;
    const desc = describeClose(code);
    this.log(`[remote] closed code=${code} kind=${desc.kind} reason=${reason || "-"}`);
    if (desc.kind === "auth") {
      this.events.onStatus("Controle: token inválido — confira o token em Configuração e no Render");
      return; // parked: needs user action
    }
    if (desc.kind === "origin") {
      this.events.onStatus("Controle: origem recusada — atualize o servidor (Render)");
      return; // parked: server needs ALLOWED_ORIGINS / deploy
    }
    if (desc.kind === "replaced") {
      this.events.onStatus(
        "Controle: outro agente assumiu a sala — pare o agente standalone (mesmo token)",
      );
    } else {
      this.events.onStatus("Controle: reconectando…");
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped || this.timer) return;
    const delay = backoffDelayMs(this.attempt);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
    unrefTimer(this.timer);
  }

  private cleanupSocket(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    }
  }
}

function unrefTimer(t: unknown): void {
  try {
    (t as { unref?: () => void } | null | undefined)?.unref?.();
  } catch {
    /* noop */
  }
}

function defaultCreateWs(url: string): WsLike {
  return new WebSocket(url) as unknown as WsLike;
}
