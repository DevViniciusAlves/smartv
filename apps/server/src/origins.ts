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
  return allowed.includes(normalizeOrigin(origin));
}
