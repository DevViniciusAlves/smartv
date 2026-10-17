// Origin normalization: trim, lowercase, drop trailing slashes.
// "https://app.vercel.app/" and "HTTPS://APP.VERCEL.APP" become
// "https://app.vercel.app", so harmless variants are accepted.
export function normalizeOrigin(raw: string | undefined): string {
  if (!raw) return "";
  return raw.trim().toLowerCase().replace(/\/+$/, "");
}

const VALID_ORIGIN = /^https?:\/\/[a-z0-9.-]+(?::\d+)?$/;

export interface ParsedOrigins {
  allowed: string[];
  invalid: string[];
}

export function parseAllowedOrigins(raw: string | undefined): ParsedOrigins {
  if (!raw) return { allowed: [], invalid: [] };
  const allowed: string[] = [];
  const invalid: string[] = [];
  for (const part of raw.split(",")) {
    const norm = normalizeOrigin(part);
    if (!norm) continue;
    if (!VALID_ORIGIN.test(norm)) {
      invalid.push(part.trim());
      continue;
    }
    if (!allowed.includes(norm)) allowed.push(norm);
  }
  return { allowed, invalid };
}

export function isOriginAllowed(origin: string | undefined, allowed: string[]): boolean {
  // No list configured: only acceptable outside production (dev).
  // Production refuses to run without ALLOWED_ORIGINS (see index.ts).
  if (allowed.length === 0) return true;
  const norm = normalizeOrigin(origin);
  // Native non-browser clients (the Windows agent: Node.js/Electron `ws`)
  // never send an Origin header. Browsers always do, so an attacker using a
  // browser cannot suppress it. Agent auth (AGENT_TOKEN) still applies after
  // the upgrade, so allowing the empty origin only unblocks the agent
  // without weakening controller checks (controllers authenticate solely
  // with a code-issued session token).
  if (!norm) return true;
  return allowed.includes(norm);
}
