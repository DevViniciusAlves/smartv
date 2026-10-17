// Minimal Chrome DevTools Protocol client (browser + page sessions) over a
// local WebSocket. Used to drive the Brave window launched by brave-manager.
//
// Only what SmartTV needs: connect to 127.0.0.1, attach to the first page
// target, evaluate JS, dispatch keys, navigate and move the window. Everything
// takes injected transports so unit tests never need a real browser.

export interface WebSocketLike {
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  send(data: string): void;
  close(): void;
}

export interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

/** Sends CDP requests and demultiplexes responses/events over one socket. */
export class CdpConnection {
  private readonly ws: WebSocketLike;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();
  private readonly listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();
  private closed = false;

  constructor(ws: WebSocketLike) {
    this.ws = ws;
    ws.on("message", (data) => this.onMessage(String(data)));
    ws.on("close", () => this.failAll(new Error("CDP connection closed")));
    ws.on("error", (err) => this.failAll(err));
  }

  private onMessage(raw: string): void {
    let msg: CdpMessage;
    try {
      msg = JSON.parse(raw) as CdpMessage;
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message ?? "CDP error"));
      else entry.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) {
      for (const cb of this.listeners.get(msg.method) ?? []) {
        try {
          cb(msg.params ?? {});
        } catch {
          /* listener errors must not break the socket */
        }
      }
    }
  }

  private failAll(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, entry] of this.pending) entry.reject(err);
    this.pending.clear();
  }

  send<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("CDP connection closed"));
    const id = this.nextId++;
    const payload: CdpMessage = { id, method, params: params ?? {} };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  /** Subscribes to a CDP event; returns an unsubscribe function. */
  on(method: string, cb: (params: Record<string, unknown>) => void): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  }

  close(): void {
    this.closed = true;
    this.failAll(new Error("CDP connection closed"));
    try {
      this.ws.close();
    } catch {
      /* noop */
    }
  }
}

export interface CdpTarget {
  targetId: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl?: string;
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`CDP http ${res.status} for ${url}`);
  return (await res.json()) as T;
}

/** Lists the debug targets of a running Chrome/Brave (`/json/list`). */
export async function listTargets(port: number, timeoutMs = 2000): Promise<CdpTarget[]> {
  const list = await fetchJson<CdpTarget[]>(`http://127.0.0.1:${port}/json/list`, timeoutMs);
  return Array.isArray(list) ? list : [];
}

/** Browser-level websocket (`/json/version`): window + target management. */
export async function browserWebSocketUrl(port: number, timeoutMs = 2000): Promise<string> {
  const info = await fetchJson<{ webSocketDebuggerUrl?: string }>(
    `http://127.0.0.1:${port}/json/version`,
    timeoutMs,
  );
  if (!info.webSocketDebuggerUrl) throw new Error("CDP /json/version has no websocket url");
  return info.webSocketDebuggerUrl;
}

export interface ConnectDeps {
  WebSocketImpl?: new (url: string) => WebSocketLike;
  fetchTargets?: (port: number) => Promise<CdpTarget[]>;
  fetchVersion?: (port: number) => Promise<string>;
}

/**
 * Connects to the browser websocket, waits for a page target and attaches to
 * it (flattened protocol: every page command carries the session id).
 */
export async function connectBrowser(
  port: number,
  deps: ConnectDeps = {},
): Promise<{ conn: CdpConnection; sessionId: string; targetId: string }> {
  const Ws = deps.WebSocketImpl ?? (await import("ws")).default;
  const version = deps.fetchVersion ?? browserWebSocketUrl;
  const targets = deps.fetchTargets ?? listTargets;
  const url = await version(port);
  const conn = new CdpConnection(new Ws(url));

  // Wait briefly for the first page target (Brave may still be starting up).
  let page: CdpTarget | undefined;
  for (let i = 0; i < 20 && !page; i++) {
    const list = await targets(port).catch(() => [] as CdpTarget[]);
    page = list.find((t) => t.type === "page");
    if (!page) await new Promise((r) => setTimeout(r, 250));
  }
  if (!page) {
    conn.close();
    throw new Error("no CDP page target (Brave window not found)");
  }
  const attached = await conn.send<{ sessionId: string }>("Target.attachToTarget", {
    targetId: page.targetId,
    flatten: true,
  });
  return { conn, sessionId: attached.sessionId, targetId: page.targetId };
}
