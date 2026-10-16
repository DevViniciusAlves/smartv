// Temporary 6-digit pairing codes + per-device controller session tokens.
//
// Security model:
// - Codes are short-lived (5 min), single-use, and bound to one installation
//   (deviceId). Issuing a new code invalidates the previous active one.
// - Codes are NOT authentication: redeeming one mints a random 256-bit
//   session token that the phone persists and uses in `hello`. Permanent
//   tokens (ROOM_TOKEN/AGENT_TOKEN) never travel in codes, QR or errors.
// - Anti-guessing is enforced in two layers: codes expire in 5 minutes and
//   are single-use (tiny window), and the relay rate-limits pair attempts
//   per socket (10/min) so brute force is infeasible.
// - Pure logic (injectable now/rng) so it is fully unit-tested.

import { randomBytes, randomInt } from "node:crypto";
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
}

function defaultSixDigits(): string {
  // crypto.randomInt is uniform and CSPRNG-backed. Padded so "42" -> "000042".
  return String(randomInt(0, 1000000)).padStart(6, "0");
}

function defaultToken(): string {
  return `pair_${randomBytes(32).toString("base64url")}`;
}

export class PairingManager {
  private readonly codes = new Map<string, CodeRecord>();
  private readonly tokens = new Map<string, string>(); // sessionToken -> deviceId
  private readonly now: () => number;
  private readonly randomSixDigits: () => string;
  private readonly randomToken: () => string;

  constructor(deps: PairingDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.randomSixDigits = deps.randomSixDigits ?? defaultSixDigits;
    this.randomToken = deps.randomToken ?? defaultToken;
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

  mintSessionToken(deviceId: string): string {
    const token = this.randomToken();
    this.tokens.set(token, deviceId);
    return token;
  }

  deviceOfToken(token: string): string | null {
    return this.tokens.get(token) ?? null;
  }

  revokeToken(token: string): boolean {
    return this.tokens.delete(token);
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
