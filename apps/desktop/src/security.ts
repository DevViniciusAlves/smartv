import { STREAMING_APPS, getAppUrl } from "@smartv/shared";

// Navigation and destination allowlist for the desktop app.
// Only official service URLs from packages/shared are reachable.
// Everything else (popups, ads, trackers navigating top-level, typos)
// is blocked and logged. No arbitrary URLs are ever accepted.
export function allowedHosts(): string[] {
  const hosts = new Set<string>();
  for (const app of STREAMING_APPS) {
    try {
      hosts.add(new URL(app.url).hostname.toLowerCase());
    } catch {
      /* invalid entry: simply not allowed */
    }
  }
  return [...hosts];
}

export function isAllowedAppId(id: string): boolean {
  return STREAMING_APPS.some((a) => a.id === id);
}

export function appUrl(id: string): string | undefined {
  if (!isAllowedAppId(id)) return undefined;
  return getAppUrl(id);
}

// Top-level navigation is allowed only to the exact hosts of the
// allowlisted services (login pages live on those same hosts).
export function isAllowedNavigation(dest: string): boolean {
  let host: string;
  try {
    const u = new URL(dest);
    if (u.protocol !== "https:") return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowedHosts().includes(host);
}
