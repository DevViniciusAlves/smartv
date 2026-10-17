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

describe("durable (signed) sessions", () => {
  function signedPairing(secret = "agent-token-xyz789") {
    const base = makePairing();
    base.mgr.setSessionSecret(secret);
    return base;
  }

  it("mints stateless tokens that survive a brand-new manager (restart)", () => {
    const { mgr } = signedPairing();
    const token = mgr.mintSessionToken("pc-1");
    expect(token).toMatch(/^p1\./);
    expect(mgr.deviceOfToken(token)).toBe("pc-1");

    // Simulates the free instance restarting: a fresh process with the same
    // secret must accept the token the phone still has in localStorage.
    const restarted = new PairingManager({ sessionSecret: "agent-token-xyz789" });
    expect(restarted.deviceOfToken(token)).toBe("pc-1");
  });

  it("never expires (login stays valid as long as the phone keeps it)", () => {
    const { mgr, advance } = signedPairing();
    const token = mgr.mintSessionToken("pc-1");
    advance(365 * 24 * 60 * 60 * 1000); // one year later
    expect(mgr.deviceOfToken(token)).toBe("pc-1");
  });

  it("rejects tokens signed with another secret (different server)", () => {
    const { mgr } = signedPairing("server-a");
    const token = mgr.mintSessionToken("pc-1");
    const other = new PairingManager({ sessionSecret: "server-b" });
    expect(other.deviceOfToken(token)).toBeNull();
  });

  it("rejects tampered payloads (deviceId swap)", () => {
    const { mgr } = signedPairing();
    const token = mgr.mintSessionToken("pc-1");
    const parts = token.split(".");
    const forgedDevice = Buffer.from("pc-2", "utf8").toString("base64url");
    const forged = [parts[0], forgedDevice, parts[2], parts[3], parts[4]].join(".");
    expect(mgr.deviceOfToken(forged)).toBeNull();
    expect(mgr.deviceOfToken("p1.aaaa.1.bbbb.cccc")).toBeNull();
    expect(mgr.deviceOfToken("garbage")).toBeNull();
    expect(mgr.deviceOfToken("")).toBeNull();
  });

  it("revokes durable tokens (Encerrar conexão) even though they are stateless", () => {
    const { mgr } = signedPairing();
    const keep = mgr.mintSessionToken("pc-1");
    const drop = mgr.mintSessionToken("pc-1");
    expect(mgr.revokeToken(drop)).toBe(true);
    expect(mgr.deviceOfToken(drop)).toBeNull();
    expect(mgr.deviceOfToken(keep)).toBe("pc-1");
  });

  it("keeps minting legacy in-memory tokens when no secret is configured", () => {
    const { mgr } = makePairing();
    const token = mgr.mintSessionToken("pc-1");
    expect(token.startsWith("p1.")).toBe(false);
    expect(mgr.deviceOfToken(token)).toBe("pc-1");
    expect(new PairingManager().deviceOfToken(token)).toBeNull(); // not durable
  });
});
