import { describe, expect, it } from "vitest";
import { PAIR_CODE_TTL_MS } from "@smartv/shared";
import { PairingManager } from "./pairing.js";

function makePairing() {
  let t = 1_000_000;
  let seq = 0;
  const codes = ["123456", "654321", "000042", "111111", "222222"];
  return {
    mgr: new PairingManager({
      now: () => t,
      randomSixDigits: () => codes[seq++ % codes.length],
      randomToken: () => `pair_test-token-${seq++}`,
    }),
    advance: (ms: number) => (t += ms),
    now: () => t,
  };
}

describe("PairingManager", () => {
  it("issues 6-digit codes (leading zeros kept) with 5 min expiry", () => {
    const { mgr, now } = makePairing();
    const { code, expiresAt } = mgr.issue("pc-1");
    expect(code).toMatch(/^\d{6}$/);
    expect(expiresAt - now()).toBe(PAIR_CODE_TTL_MS);
  });

  it("redeems once, then reports used", () => {
    const { mgr } = makePairing();
    const { code } = mgr.issue("pc-1");
    const ok = mgr.redeem(code);
    expect(ok).toEqual({ ok: true, deviceId: "pc-1" });
    expect(mgr.redeem(code)).toEqual({ ok: false, reason: "used" });
  });

  it("rejects unknown codes as incorrect and expired ones as expired", () => {
    const { mgr, advance } = makePairing();
    expect(mgr.redeem("999999")).toEqual({ ok: false, reason: "incorrect" });
    const { code } = mgr.issue("pc-1");
    advance(PAIR_CODE_TTL_MS + 1000);
    expect(mgr.redeem(code)).toEqual({ ok: false, reason: "expired" });
  });

  it("issuing a new code invalidates the previous one", () => {
    const { mgr } = makePairing();
    const first = mgr.issue("pc-1");
    mgr.issue("pc-1");
    expect(mgr.redeem(first.code)).toEqual({ ok: false, reason: "used" });
  });

  it("isolates installations: codes are device-bound", () => {
    const { mgr } = makePairing();
    mgr.issue("pc-1");
    const b = mgr.issue("pc-2");
    expect(mgr.redeem(b.code)).toEqual({ ok: true, deviceId: "pc-2" });
  });

  it("mints per-device session tokens, revokable individually", () => {
    const { mgr } = makePairing();
    const t1 = mgr.mintSessionToken("pc-1");
    const t2 = mgr.mintSessionToken("pc-1");
    expect(t1).not.toBe(t2);
    expect(mgr.deviceOfToken(t1)).toBe("pc-1");
    expect(mgr.revokeToken(t1)).toBe(true);
    expect(mgr.deviceOfToken(t1)).toBeNull();
    expect(mgr.deviceOfToken(t2)).toBe("pc-1"); // the other session is kept
  });
});
