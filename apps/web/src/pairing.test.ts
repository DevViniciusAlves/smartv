import { describe, expect, it, vi } from "vitest";
import {
  isValidPairCode,
  parseBinding,
  parseQrPayload,
  pairFailureMessage,
  toLinkState,
  PairingSession,
} from "./pairing.js";

describe("isValidPairCode", () => {
  it("accepts exactly 6 digits (leading zeros ok)", () => {
    expect(isValidPairCode("123456")).toBe(true);
    expect(isValidPairCode("000042")).toBe(true);
    expect(isValidPairCode("12345")).toBe(false);
    expect(isValidPairCode("1234567")).toBe(false);
    expect(isValidPairCode("12a456")).toBe(false);
    expect(isValidPairCode("")).toBe(false);
  });
});

describe("parseQrPayload", () => {
  it("extracts the code from the PC QR JSON", () => {
    expect(parseQrPayload(JSON.stringify({ v: 1, code: "654321" }))).toBe("654321");
  });
  it("rejects wrong shape, bad codes and secrets", () => {
    expect(parseQrPayload("123456")).toBeNull();
    expect(parseQrPayload(JSON.stringify({ v: 1, code: "12" }))).toBeNull();
    expect(parseQrPayload(JSON.stringify({ v: 2, code: "123456" }))).toBeNull();
    expect(parseQrPayload("not json")).toBeNull();
  });
});

describe("pairFailureMessage", () => {
  it("explains every reason without secrets", () => {
    for (const kind of ["incorrect", "expired", "used", "rate-limited", "unavailable", "network"] as const) {
      const text = pairFailureMessage({ kind });
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toMatch(/token|ROOM|AGENT/i);
    }
  });
});

describe("parseBinding", () => {
  it("reads the persisted binding and rejects garbage", () => {
    expect(parseBinding(null)).toBeNull();
    expect(parseBinding("garbage")).toBeNull();
    expect(parseBinding(JSON.stringify({ token: "short" }))).toBeNull();
    expect(
      parseBinding(JSON.stringify({ token: "pair_abcdefghijklmnop", deviceId: "pc-1" })),
    ).toEqual({ token: "pair_abcdefghijklmnop", deviceId: "pc-1" });
  });
});

describe("toLinkState", () => {
  it("requires credential AND pc online for CONECTADO", () => {
    expect(toLinkState(null, false)).toEqual({ name: "DESCONECTADO", reason: "sem-pareamento" });
    expect(toLinkState({ name: "loading", since: 0 }, true)).toEqual({ name: "CONECTANDO" });
    expect(toLinkState({ name: "connected", agentOnline: true }, true)).toEqual({
      name: "CONECTADO",
    });
    // Server link without the PC is NOT connected.
    expect(toLinkState({ name: "connected", agentOnline: false }, true)).toEqual({
      name: "DESCONECTADO",
      reason: "pc-offline",
    });
    expect(toLinkState({ name: "error", kind: "auth", autoRetry: false }, true)).toEqual({
      name: "DESCONECTADO",
      reason: "token",
    });
    expect(toLinkState({ name: "error", kind: "network", autoRetry: false }, true)).toEqual({
      name: "DESCONECTADO",
      reason: "rede",
    });
  });
});

type Handler = ((ev: { data: string }) => void) | null;

function fakeSocket(): {
  ws: WebSocket;
  sent: string[];
  emitOpen(): void;
  emitMessage(text: string): void;
  emitClose(): void;
} {
  const sent: string[] = [];
  let onopen: (() => void) | null = null;
  let onmessage: Handler = null;
  let onclose: (() => void) | null = null;
  const ws = {
    sent,
    set onopen(f: () => void) {
      onopen = f;
    },
    get onopen(): (() => void) | null {
      return onopen;
    },
    set onmessage(f: Handler) {
      onmessage = f;
    },
    get onmessage(): Handler {
      return onmessage;
    },
    set onclose(f: () => void) {
      onclose = f;
    },
    get onclose(): (() => void) | null {
      return onclose;
    },
    onerror: null,
    send: (d: string) => void sent.push(d),
    close: () => undefined,
  } as unknown as WebSocket;
  return {
    ws,
    sent,
    emitOpen: () => onopen?.(),
    emitMessage: (text: string) => onmessage?.({ data: text }),
    emitClose: () => onclose?.(),
  };
}

describe("PairingSession", () => {
  it("sends pair and resolves on pair-ok", async () => {
    const sock = fakeSocket();
    const s = new PairingSession("wss://srv/ws", () => sock.ws);
    const p = s.pair("123456", 5000);
    sock.emitOpen();
    expect(JSON.parse(sock.sent[0])).toEqual({ type: "pair", code: "123456" });
    sock.emitMessage(JSON.stringify({ type: "pair-ok", deviceId: "pc-1", token: "pair_secret-token-xyz" }));
    await expect(p).resolves.toEqual({ token: "pair_secret-token-xyz", deviceId: "pc-1" });
  });

  it("rejects with the server reason on pair-error", async () => {
    const sock = fakeSocket();
    const s = new PairingSession("wss://srv/ws", () => sock.ws);
    const p = s.pair("000000", 5000);
    sock.emitOpen();
    sock.emitMessage(JSON.stringify({ type: "pair-error", reason: "expired" }));
    await expect(p).rejects.toEqual({ kind: "expired" });
  });

  it("rejects with network when the socket closes first", async () => {
    const sock = fakeSocket();
    const s = new PairingSession("wss://srv/ws", () => sock.ws);
    const p = s.pair("123456", 5000);
    sock.emitOpen();
    sock.emitClose();
    await expect(p).rejects.toEqual({ kind: "network" });
  });

  it("does not hang forever: timeout rejects", async () => {
    vi.useFakeTimers();
    try {
      const sock = fakeSocket();
      const s = new PairingSession("wss://srv/ws", () => sock.ws);
      const p = s.pair("123456", 1000);
      sock.emitOpen();
      const assertion = expect(p).rejects.toEqual({ kind: "network" });
      await vi.advanceTimersByTimeAsync(1500);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
