import { describeClose } from "@smartv/shared";
import type { ControllerMessage } from "@smartv/shared";

// DOM-free connection logic for /controle: a pure state machine (tested)
// plus a manager that owns exactly one socket and one timer at a time.
// Stale sockets are neutralized via a generation id.

export interface NormalizedUrl {
  url: string;
  notes: string[];
}

// Accepts what the operator pastes (https URL, host only, with or without
// /ws) and produces the wss://../ws URL the control must use.
export function normalizeBackendUrl(raw: string | undefined): NormalizedUrl {
  const s0 = (raw ?? "").trim();
  if (!s0) return { url: "", notes: ["missing"] };
  const notes: string[] = [];
  let s = s0;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) {
    s = `wss://${s}`;
    notes.push("scheme-added");
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { url: "", notes: ["invalid"] };
  }
  if (u.protocol === "https:") {
    u.protocol = "wss:";
    notes.push("https-to-wss");
  } else if (u.protocol === "http:") {
    u.protocol = "ws:";
    notes.push("http-to-ws");
  } else if (u.protocol !== "wss:" && u.protocol !== "ws:") {
    return { url: "", notes: ["invalid"] };
  }
  if (u.pathname === "" || u.pathname === "/") {
    u.pathname = "/ws";
    notes.push("path-added");
  }
  return { url: u.toString(), notes };
}

export type ConnStatus =
  | { name: "loading"; since: number }
  | { name: "connected"; agentOnline: boolean }
  | { name: "error"; kind: "auth" | "origin" | "config" | "network"; autoRetry: boolean };

export type ConnEvent =
  | { type: "hello_ok"; agentOnline: boolean }
  | { type: "state"; agentOnline: boolean }
  | { type: "closed"; code: number }
  | { type: "failed" }
  | { type: "gave_up" };

export function reduceConn(status: ConnStatus, ev: ConnEvent, now: number): ConnStatus {
  switch (ev.type) {
    case "hello_ok":
    case "state":
      return { name: "connected", agentOnline: ev.agentOnline };
    case "closed": {
      const d = describeClose(ev.code);
      if (d.kind === "auth") return { name: "error", kind: "auth", autoRetry: false };
      if (d.kind === "origin") return { name: "error", kind: "origin", autoRetry: false };
      // Retryable close (network/replaced/too_large): back to loading,
      // the manager schedules the retry.
      return { name: "loading", since: status.name === "loading" ? status.since : now };
    }
    case "failed":
      return status.name === "connected"
        ? { name: "loading", since: now }
        : status;
    case "gave_up":
      return { name: "error", kind: "network", autoRetry: false };
  }
}

export interface ConnCallbacks {
  onStatus(s: ConnStatus): void;
  onSendBlocked(): void;
}

const GIVE_UP_AFTER_MS = 60000;

export class RemoteConnection {
  private ws: WebSocket | null = null;
  private timer: number | null = null;
  private generation = 0;
  private status: ConnStatus = { name: "loading", since: Date.now() };
  private failCount = 0;
  private firstFailAt: number | null = null;

  constructor(
    private readonly url: string,
    private readonly getToken: () => string | null,
    private readonly cb: ConnCallbacks,
  ) {}

  get current(): ConnStatus {
    return this.status;
  }

  private set(s: ConnStatus): void {
    this.status = s;
    this.cb.onStatus(s);
  }

  private apply(ev: ConnEvent): void {
    this.set(reduceConn(this.status, ev, Date.now()));
  }

  // Opens a fresh connection, closing any previous socket/timer first.
  connect(): void {
    this.generation += 1;
    const gen = this.generation;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const old = this.ws;
    this.ws = null;
    if (old) {
      old.onopen = null;
      old.onmessage = null;
      old.onclose = null;
      old.onerror = null;
      try {
        old.close();
      } catch {
        /* noop */
      }
    }
    if (this.status.name !== "connected") {
      this.set({ name: "loading", since: Date.now() });
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.onFailure(gen);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (gen !== this.generation) return;
      const token = this.getToken();
      if (!token) {
        try {
          ws.close();
        } catch {
          /* noop */
        }
        return;
      }
      ws.send(JSON.stringify({ type: "hello", role: "controller", token, v: 1 }));
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (gen !== this.generation) return;
      let msg: unknown;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const m = msg as { type?: string; agentOnline?: boolean };
      if (m.type === "state") {
        this.failCount = 0;
        this.firstFailAt = null;
        this.apply({ type: "hello_ok", agentOnline: m.agentOnline === true });
      }
    };
    ws.onerror = () => {
      if (gen !== this.generation) return;
      // The close event follows; counting there avoids double counting.
    };
    ws.onclose = (ev: CloseEvent) => {
      if (gen !== this.generation) return;
      this.ws = null;
      this.apply({ type: "closed", code: ev.code });
      if (!describeClose(ev.code).retry) return; // auth/origin: parked, no loop
      this.onFailure(gen);
    };
  }

  // Manual retry (button / token change / foreground): fresh counters.
  reconnect(): void {
    this.failCount = 0;
    this.firstFailAt = null;
    this.connect();
  }

  private onFailure(gen: number): void {
    if (gen !== this.generation) return;
    const now = Date.now();
    if (this.firstFailAt === null) this.firstFailAt = now;
    this.failCount += 1;
    if (now - this.firstFailAt > GIVE_UP_AFTER_MS) {
      this.apply({ type: "gave_up" });
      return;
    }
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.failCount, 5));
    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (gen === this.generation) this.connect();
    }, delay);
  }

  send(msg: ControllerMessage): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    this.cb.onSendBlocked();
    return false;
  }

  /** Fire-and-forget session control (e.g. `unpair`): not a command. */
  sendRaw(payload: unknown): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(payload));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  dispose(): void {
    this.generation += 1;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* noop */
      }
      this.ws = null;
    }
  }
}
