import { STREAMING_APPS, getAppUrl } from "@smartv/shared";

// Navigation and destination allowlist for the desktop app.
//
// Login flows are the tricky part: they leave the service host and hop through
// identity providers (accounts.google.com, appleid.apple.com, bamgrid.com for
// Disney+, …) and usually open a popup. Blocking that made "Sign in" silently
// do nothing. So the allowlist is domain-based (host + subdomains), split in:
//   1. the registrable domain of every configured service (covers
//      www./play./auth./accounts. subdomains without listing each one), plus
//      brand aliases (hbomax.com <-> max.com, disneyplus.com <-> disney.com);
//   2. the identity providers the sign-in flows talk to.
// Everything else is blocked and logged. No arbitrary URL is ever accepted.

const SERVICE_ALIASES: string[] = [
  "youtube.com",
  "netflix.com",
  "hbomax.com",
  "max.com", // HBO Max -> Max (kept as default is hbomax.com)
  "disneyplus.com",
  "disney.com",
];

// Identity providers / auth backends seen in sign-in redirects and popups.
const IDENTITY_DOMAINS: string[] = [
  "google.com", // accounts.google.com (YouTube/Google sign-in)
  "googleusercontent.com",
  "apple.com", // appleid.apple.com (Sign in with Apple)
  "facebook.com", // Sign in with Facebook
  "fbcdn.net",
  "microsoftonline.com",
  "live.com",
  "go.com", // registerdisney.go.com (Disney identity)
  "bamgrid.com", // Disney+ identity backend
];

// Good-enough registrable domain (last two labels). The services and identity
// providers here are all single-TLD (".com"), so this is exact for our cases.
function registrableDomain(host: string): string {
  const parts = host.toLowerCase().split(".").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join(".") : parts.join(".");
}

function appBaseDomains(): string[] {
  const out = new Set<string>();
  for (const app of STREAMING_APPS) {
    try {
      out.add(registrableDomain(new URL(app.url).hostname));
    } catch {
      /* invalid entry: simply not allowed */
    }
  }
  return [...out];
}

/** All allowed base domains (service hosts + brand aliases + identity providers). */
export function allowedDomains(): string[] {
  return [...new Set([...appBaseDomains(), ...SERVICE_ALIASES, ...IDENTITY_DOMAINS])];
}

export function isAllowedAppId(id: string): boolean {
  return STREAMING_APPS.some((a) => a.id === id);
}

export function appUrl(id: string): string | undefined {
  if (!isAllowedAppId(id)) return undefined;
  return getAppUrl(id);
}

/** True when the host is, or is a subdomain of, an allowed base domain. */
export function isAllowedHost(host: string): boolean {
  const h = host.toLowerCase();
  return allowedDomains().some((d) => h === d || h.endsWith(`.${d}`));
}

// Back-compat name used by tests/logs: the list of allowed base domains.
export function allowedHosts(): string[] {
  return allowedDomains();
}

// Top-level navigation is allowed only to https and to the allowlisted domains
// (their own pages and the identity providers used for login).
export function isAllowedNavigation(dest: string): boolean {
  let host: string;
  try {
    const u = new URL(dest);
    if (u.protocol !== "https:") return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  return isAllowedHost(host);
}
