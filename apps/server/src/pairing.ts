// Temporary 6-digit pairing codes + per-device controller session tokens.
//
// Security model:
// - Codes are short-lived (5 min), single-use, and bound to one installation
//   (deviceId). Issuing a new code invalidates the previous active one.
// - Codes are NOT authentication: redeeming one mints a session token that
//   the phone persists and uses in `hello`. There is no fixed controller
//   token: only a code-issued session connects a phone. Permanent secrets
//   (AGENT_TOKEN) never travel in codes, QR or errors.
// - Anti-guessing is enforced in two layers: codes expire in 5 minutes and
//   are single-use (tiny window), and the relay rate-limits pair attempts
//   per socket (10/min) so brute force is infeasible.
// - Pure logic (injectable now/rng) so it is fully unit-tested.
//
// Durable sessions (why they are signed, not random):
// - The relay used to keep tokens in memory only. The free Render instance
//   sleeps/restarts, every token vanished, and the phone was forced to pair
//   again ("Sessão inválida — pareie de novo") even though the login on the
//   phone was never removed.
// - Now a token is an HMAC over the installation id, signed with a server
//   secret derived from AGENT_TOKEN: any instance can verify it WITHOUT
//   state, so the login survives restarts, deploys and sleeps for as long as
//   the phone keeps it (until the user taps "Encerrar conexão" or the PC
//   installation changes).
// - Fallback: with no secret configured (unit tests, ad-hoc runs) the old
//   random in-memory token is minted instead, so nothing is forged by
//   accident with a well-known key.

import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { PAIR_CODE_TTL_MS } from "@smartv/shared";

export type RedeemResult =
  | { ok: true; deviceId: string }
  | { ok: false; reason: "incorrect" | "expired" | "used" };

interface CodeRecord {
  code: string;
  deviceId: string;
  expiresAt: number;
  consumed: boolean;
}

export interface PairingDeps {
  now?: () => number;
  randomSixDigits?: () => string;
  randomToken?: () => string;
  /** Server secret for signed, durable session tokens (AGENT_TOKEN). */
  sessionSecret?: string;
}

function defaultSixDigits(): string {
  // crypto.randomInt is uniform and CSPRNG-backed. Padded so "42" -> "000042".
  return String(randomInt(0, 1000000)).padStart(6, "0");
}

function defaultToken(): string {
  return `pair_${randomBytes(32).toString("base64url")}`;
}

// Token layout (versioned, so a future format can coexist):
//   p1.<base64url(deviceId)>.<issuedAt>.<nonce>.<base64url(hmac-sha256)>
// The MAC covers everything before it, so a token cannot be forged (the key
// never leaves the server) and cannot be edited (deviceId swap breaks it).
const TOKEN_PREFIX = "p1";
const REVOKED_CAP = 512;

function b64(buf: Buffer): string {
  return buf.toString("base64url");
}

function safeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export class PairingManager {
  private readonly codes = new Map<string, CodeRecord>();
  private readonly tokens = new Map<string, string>(); // legacy: sessionToken -> deviceId
  private readonly revoked = new Set<string>();
  private readonly now: () => number;
  private readonly randomSixDigits: () => string;
  private readonly randomToken: () => string;
  private sessionSecret: string | null;

  constructor(deps: PairingDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.randomSixDigits = deps.randomSixDigits ?? defaultSixDigits;
    this.randomToken = deps.randomToken ?? defaultToken;
    this.sessionSecret = deps.sessionSecret ?? null;
  }

  /**
   * Enables durable (stateless, signed) session tokens. Called by the relay
   * with the server's AGENT_TOKEN; without it only legacy in-memory tokens
   * are minted (used by unit tests / ad-hoc runs).
   */
  setSessionSecret(secret: string): void {
    this.sessionSecret = secret || null;
  }

  /** Issues a fresh code for a device, invalidating its previous active one. */
  issue(deviceId: string): { code: string; expiresAt: number } {
    const t = this.now();
    for (const rec of this.codes.values()) {
      if (rec.deviceId === deviceId && !rec.consumed && rec.expiresAt > t) {
        rec.consumed = true; // invalidated by replacement (reported as "used")
      }
    }
    let code = this.randomSixDigits();
    // No duplicate active codes across devices (tiny space, cheap loop).
    let guard = 0;
    while (this.isActiveCode(code, t) && guard++ < 50) code = this.randomSixDigits();
    const expiresAt = t + PAIR_CODE_TTL_MS;
    this.codes.set(code, { code, deviceId, expiresAt, consumed: false });
    this.sweep(t);
    return { code, expiresAt };
  }

  redeem(code: string, now?: number): RedeemResult {
    const t = now ?? this.now();
    const rec = this.codes.get(code.trim());
    if (!rec) return { ok: false, reason: "incorrect" };
    if (rec.consumed) return { ok: false, reason: "used" };
    if (rec.expiresAt <= t) return { ok: false, reason: "expired" };
    // Successful redeem consumes the code: single-use, never reusable.
    rec.consumed = true;
    return { ok: true, deviceId: rec.deviceId };
  }

  /** Mints a session token for a device (signed + durable when a secret is set). */
  mintSessionToken(deviceId: string): string {
    if (this.sessionSecret) {
      const payload = [
        b64(Buffer.from(deviceId, "utf8")),
        String(this.now()),
        b64(randomBytes(8)),
      ].join(".");
      return `${TOKEN_PREFIX}.${payload}.${this.sign(payload)}`;
    }
    const token = this.randomToken();
    this.tokens.set(token, deviceId);
    return token;
  }

  /** deviceId for a token, or null when unknown/tampered/revoked. */
  deviceOfToken(token: string): string | null {
    if (!token) return null;
    if (this.revoked.has(token)) return null;
    const durable = this.verifySigned(token);
    if (durable !== null) return durable;
    return this.tokens.get(token) ?? null;
  }

  /**
   * Ends a session. Signed tokens cannot be deleted from memory, so they are
   * added to a bounded denylist instead (honored by deviceOfToken above).
   */
  revokeToken(token: string): boolean {
    const had = this.tokens.delete(token);
    if (!token) return had;
    if (this.verifySigned(token) !== null) {
      this.revoked.add(token);
      while (this.revoked.size > REVOKED_CAP) {
        const oldest = this.revoked.values().next().value;
        if (oldest === undefined) break;
        this.revoked.delete(oldest);
      }
      return true;
    }
    return had;
  }

  private sign(payload: string): string {
    return b64(createHmac("sha256", this.sessionSecret ?? "").update(payload).digest());
  }

  private verifySigned(token: string): string | null {
    if (!this.sessionSecret || !token.startsWith(`${TOKEN_PREFIX}.`)) return null;
    const parts = token.split(".");
    // p1, deviceId, issuedAt, nonce, mac
    if (parts.length !== 5 || parts[0] !== TOKEN_PREFIX) return null;
    const payload = `${parts[1]}.${parts[2]}.${parts[3]}`;
    if (!safeEqualStr(parts[4], this.sign(payload))) return null;
    try {
      const deviceId = Buffer.from(parts[1], "base64url").toString("utf8");
      return deviceId ? deviceId : null;
    } catch {
      return null;
    }
  }

  activeCodeCount(): number {
    const t = this.now();
    let n = 0;
    for (const rec of this.codes.values()) {
      if (!rec.consumed && rec.expiresAt > t) n++;
    }
    return n;
  }

  private isActiveCode(code: string, t: number): boolean {
    const rec = this.codes.get(code);
    return !!rec && !rec.consumed && rec.expiresAt > t;
  }

  private sweep(t: number): void {
    // Bounded memory: drop consumed/expired records beyond a cap.
    if (this.codes.size < 500) return;
    for (const [k, rec] of this.codes) {
      if (rec.consumed || rec.expiresAt <= t) this.codes.delete(k);
      if (this.codes.size < 400) break;
    }
  }
}
