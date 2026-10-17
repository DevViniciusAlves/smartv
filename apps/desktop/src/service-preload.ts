// Service-page focus navigation (isolated-world preload for the streaming view).
//
// Remote streaming pages are ordinary websites built for a mouse and keyboard.
// This preload gives them a real Smart-TV focus ring: the phone's D-pad (sent
// as arrow key events) moves focus among the page's focusable elements using
// spatial geometry, Enter activates the focused element, and a visible ring
// marks it. While a video is playing the arrow keys keep their native meaning
// (seek/scrub), mirroring the Edge extension (apps/extension/src/content.ts).
//
// It runs in its own isolated world and exposes NOTHING to the page: no bridge,
// no IPC, no globals. Only key events are observed and the DOM is manipulated.
// This is deliberately NOT the trusted bridge preload (preload.ts): remote
// pages must never gain access to `window.smartv`.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Direction = "up" | "down" | "left" | "right";

function center(r: Rect): { x: number; y: number } {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

// Picks the closest focusable in the given direction, favouring axis alignment.
// Self-contained on purpose: sandboxed preloads cannot require() modules, so
// this pure math is mirrored here instead of imported (covered by
// service-preload.test.ts, and kept in sync with the shared/extension picker).
export function pickNext(current: Rect, dir: Direction, candidates: Rect[]): number {
  const c = center(current);
  let best = -1;
  let bestScore = Infinity;
  candidates.forEach((r, i) => {
    const p = center(r);
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    if (dir === "right" && dx <= 4) return;
    if (dir === "left" && dx >= -4) return;
    if (dir === "down" && dy <= 4) return;
    if (dir === "up" && dy >= -4) return;
    const primary = dir === "left" || dir === "right" ? Math.abs(dx) : Math.abs(dy);
    const secondary = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    const score = primary + secondary * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

// Per-site focusable selectors (mirrors the Edge extension adapters). Adjust
// here when a service changes its layout.
const SITE_SELECTORS: Record<string, string[]> = {
  default: ['a[href]', "button:not([disabled])", '[role="button"]', '[tabindex]:not([tabindex="-1"])'],
  youtube: ['a#thumbnail', "ytd-compact-video-renderer a", "button:not([disabled])", "a[href]"],
  netflix: ['a[href]', "button:not([disabled])", '[role="button"]', ".title-card a"],
  hbo: ['a[href]', "button:not([disabled])", '[role="button"]'],
  disney: ['a[href]', "button:not([disabled])", '[role="button"]'],
};

function selectorsFor(host: string): string[] {
  if (host.includes("youtube")) return SITE_SELECTORS.youtube;
  if (host.includes("netflix")) return SITE_SELECTORS.netflix;
  if (host.includes("hbomax") || host.includes("max.com")) return SITE_SELECTORS.hbo;
  if (host.includes("disney")) return SITE_SELECTORS.disney;
  return SITE_SELECTORS.default;
}

const HIGHLIGHT_ID = "smartv-focus-style";
const FOCUS_CLASS = "smartv-focused";

function ensureStyle(): void {
  if (document.getElementById(HIGHLIGHT_ID)) return;
  const s = document.createElement("style");
  s.id = HIGHLIGHT_ID;
  s.textContent =
    `.${FOCUS_CLASS}{outline:4px solid #fff !important;outline-offset:3px !important;` +
    `box-shadow:0 0 0 6px rgba(80,140,255,.8) !important;border-radius:8px;}`;
  document.head.appendChild(s);
}

function isEditable(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
}

// While a video plays, arrows keep their native meaning (seek/volume).
function playerActive(): boolean {
  const videos = Array.from(document.querySelectorAll("video")) as HTMLVideoElement[];
  return videos.some(
    (v) => !v.paused && !v.ended && (v.currentTime > 0 || document.fullscreenElement !== null),
  );
}

function focusables(): HTMLElement[] {
  const sel = selectorsFor(location.hostname).join(",");
  return Array.from(document.querySelectorAll(sel)).filter((el): el is HTMLElement => {
    if (!(el instanceof HTMLElement)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  }).slice(0, 400);
}

function currentRect(): Rect {
  const ae = document.activeElement;
  if (ae instanceof HTMLElement) {
    const r = ae.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return { x: r.x, y: r.y, width: r.width, height: r.height };
  }
  // No focus yet: start from the centre of the viewport.
  return { x: window.innerWidth / 2 - 1, y: window.innerHeight / 2 - 1, width: 2, height: 2 };
}

function move(dir: Direction): void {
  ensureStyle();
  Array.from(document.querySelectorAll(`.${FOCUS_CLASS}`)).forEach((el) =>
    el.classList.remove(FOCUS_CLASS),
  );
  const els = focusables();
  if (els.length === 0) return;
  const rects = els.map((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const idx = pickNext(currentRect(), dir, rects);
  if (idx >= 0) {
    const el = els[idx];
    el.classList.add(FOCUS_CLASS);
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }
}

const DIRS: Record<string, Direction> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

function onKeyDown(e: KeyboardEvent): void {
  if (isEditable(document.activeElement) || isEditable(e.target as Element)) return;
  if (playerActive()) return;
  const dir = DIRS[e.key];
  if (dir) {
    e.preventDefault();
    e.stopPropagation();
    move(dir);
    return;
  }
  if (e.key === "Enter" && document.activeElement instanceof HTMLElement) {
    const active = document.activeElement;
    if (active.classList.contains(FOCUS_CLASS)) {
      e.preventDefault();
      e.stopPropagation();
      active.click();
    }
  }
}

// Guarded so the pure `pickNext` can be imported by unit tests (Node has no DOM).
if (typeof document !== "undefined") {
  document.addEventListener("keydown", onKeyDown, true);
}
