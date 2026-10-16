// Adaptadores por site: seletores de elementos focáveis.
// Ajuste aqui quando um site mudar o layout.
export const SITE_SELECTORS: Record<string, string[]> = {
  default: ['a[href]', "button:not([disabled])", '[role="button"]', '[tabindex]:not([tabindex="-1"])'],
  youtube: ['a#thumbnail', "ytd-compact-video-renderer a", "button:not([disabled])", "a[href]"],
  netflix: ['a[href]', "button:not([disabled])", '[role="button"]', ".title-card a"],
  hbo: ['a[href]', "button:not([disabled])", '[role="button"]'],
  disney: ['a[href]', "button:not([disabled])", '[role="button"]'],
};

export function selectorsFor(host: string): string[] {
  if (host.includes("youtube")) return SITE_SELECTORS.youtube;
  if (host.includes("netflix")) return SITE_SELECTORS.netflix;
  if (host.includes("hbomax") || host.includes("max.com")) return SITE_SELECTORS.hbo;
  if (host.includes("disney")) return SITE_SELECTORS.disney;
  return SITE_SELECTORS.default;
}
