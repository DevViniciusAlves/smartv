import { pairErrorReasonSchema } from "@smartv/shared";
import type { ConnStatus } from "./connection.js";

// Pairing + tri-state link logic for /controle. DOM-free and tested; the
// camera/QR wiring lives in controle.ts.

// ---- code / QR payload ----

export function isValidPairCode(s: string): boolean {
  return /^\d{6}$/.test(s.trim());
}

/** QR payload written by the PC modal: {"v":1,"code":"123456"}. No secrets. */
export function parseQrPayload(text: string): string | null {
  try {
    const p = JSON.parse(text) as { v?: unknown; code?: unknown };
    if (p.v === 1 && typeof p.code === "string" && isValidPairCode(p.code)) {
      return p.code.trim();
    }
    return null;
  } catch {
    return null;
  }
}

export type PairFailure =
  | { kind: "incorrect" }
  | { kind: "expired" }
  | { kind: "used" }
  | { kind: "rate-limited" }
  | { kind: "unavailable" }
  | { kind: "network" };

export function pairFailureMessage(f: PairFailure): string {
  switch (f.kind) {
    case "incorrect":
      return "Código incorreto. Confira os 6 dígitos no PC e tente de novo.";
    case "expired":
      return "Código expirado. Gere um novo no PC (o código dura 5 minutos).";
    case "used":
      return "Código já utilizado. Gere um novo no PC.";
    case "rate-limited":
      return "Muitas tentativas. Aguarde um minuto e tente de novo.";
    case "unavailable":
      return "PC offline. Abra o SmarTV no PC e tente de novo.";
    case "network":
      return "Falha de conexão. Verifique a internet e o servidor.";
  }
}

function toPairFailure(reason: string): PairFailure {
  const parsed = pairErrorReasonSchema.safeParse(reason);
  if (parsed.success) return { kind: parsed.data };
  return { kind: "network" };
}

// ---- persisted binding ----

export interface PairBinding {
  token: string;
  deviceId: string;
}

export function parseBinding(raw: string | null): PairBinding | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as { token?: unknown; deviceId?: unknown };
    if (typeof p.token === "string" && p.token.length >= 16) {
      return { token: p.token, deviceId: typeof p.deviceId === "string" ? p.deviceId : "" };
    }
    return null;
  } catch {
    return null;
  }
}

// ---- tri-state link (shared vocabulary with the PC modal) ----

export type LinkState =
  | { name: "CONECTADO" }
  | { name: "CONECTANDO" }
  | { name: "DESCONECTADO"; reason: "sem-pareamento" | "pc-offline" | "rede" | "token" };

/**
 * Single source of truth for the phone pill. Server link alone is NOT
 * "connected": CONECTADO requires a credential (pair binding or legacy
 * token) AND the PC actually online (agentOnline). Anything else is an
 * explicit DESCONECTADO reason or CONECTANDO during transitions.
 */
export function toLinkState(
  conn: ConnStatus | null,
  hasCredential: boolean,
): LinkState {
  if (!hasCredential || conn === null) {
    return hasCredential ? { name: "CONECTANDO" } : { name: "DESCONECTADO", reason: "sem-pareamento" };
  }
  switch (conn.name) {
    case "loading":
      return { name: "CONECTANDO" };
    case "connected":
      return conn.agentOnline
        ? { name: "CONECTADO" }
        : { name: "DESCONECTADO", reason: "pc-offline" };
    case "error":
      if (conn.kind === "auth" || conn.kind === "origin" || conn.kind === "config") {
        return { name: "DESCONECTADO", reason: "token" };
      }
      return { name: "DESCONECTADO", reason: "rede" };
  }
}

// ---- short-lived pairing socket ----

export type WsFactory = (url: string) => WebSocket;

export interface PairResult {
  token: string;
  deviceId: string;
}

/**
 * One-shot socket that redeems a 6-digit code. Never reused for commands:
 * on pair-ok the caller persists the binding and opens the regular
 * RemoteConnection with the minted token.
 */
export class PairingSession {
  private ws: WebSocket | null = null;
  private settled = false;

  constructor(
    private readonly url: string,
    private readonly createWs: WsFactory = (u) => new WebSocket(u),
  ) {}

  pair(code: string, timeoutMs = 20000): Promise<PairResult> {
    this.cancel();
    this.settled = false;
    return new Promise<PairResult>((resolve, reject) => {
      const done = (fn: () => void): void => {
        if (this.settled) return;
        this.settled = true;
        try {
          fn();
        } catch {
          /* result already decided */
        }
        this.destroy();
      };
      let ws: WebSocket;
      try {
        ws = this.createWs(this.url);
      } catch {
        done(() => reject({ kind: "network" }));
        return;
      }
      this.ws = ws;
      const timer = setTimeout(() => {
        done(() => reject({ kind: "network" } satisfies PairFailure));
      }, timeoutMs);
      const clear = (): void => clearTimeout(timer);
      ws.onopen = () => {
        try {
          ws.send(JSON.stringify({ type: "pair", code: code.trim() }));
        } catch {
          clear();
          done(() => reject({ kind: "network" } satisfies PairFailure));
        }
      };
      ws.onmessage = (ev: MessageEvent) => {
        let m: { type?: unknown; reason?: unknown; token?: unknown; deviceId?: unknown };
        try {
          m = JSON.parse(String(ev.data)) as typeof m;
        } catch {
          return;
        }
        if (m.type === "pair-ok" && typeof m.token === "string") {
          clear();
          const token = m.token;
          const deviceId = typeof m.deviceId === "string" ? m.deviceId : "";
          done(() => resolve({ token, deviceId }));
        } else if (m.type === "pair-error") {
          clear();
          const f = toPairFailure(typeof m.reason === "string" ? m.reason : "");
          done(() => reject(f));
        }
        // `state` may arrive after pair-ok on the same socket; ignore it,
        // the regular connection re-reads presence on hello.
      };
      ws.onclose = () => {
        clear();
        done(() => reject({ kind: "network" } satisfies PairFailure));
      };
      ws.onerror = () => {
        // onclose follows with the real outcome; its done() wins if first.
      };
    });
  }

  cancel(): void {
    this.settled = true;
    this.destroy();
  }

  private destroy(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* noop */
      }
    }
  }
}
