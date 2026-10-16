import { selectorsFor } from "./adapters.js";
import { pickNext, type Direction } from "./spatial.js";
import { initOverlay, pokeOverlay } from "./overlay.js";

const HIGHLIGHT_ID = "smartv-focus-style";

function ensureStyle(): void {
  if (document.getElementById(HIGHLIGHT_ID)) return;
  const s = document.createElement("style");
  s.id = HIGHLIGHT_ID;
  s.textContent = `.smartv-focused{outline:4px solid #fff !important;outline-offset:3px !important;box-shadow:0 0 0 6px rgba(80,140,255,.8) !important;border-radius:8px;}`;
  document.head.appendChild(s);
}

function isEditable(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName.toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    el.isContentEditable ||
    tag === "select"
  );
}

// Não interfere quando um player de vídeo está ativo: setas mantêm o
// comportamento nativo (seek/volume). Heurística configurável.
function playerActive(): boolean {
  const videos = [...document.querySelectorAll("video")] as HTMLVideoElement[];
  return videos.some(
    (v) => !v.paused && !v.ended && (v.currentTime > 0 || document.fullscreenElement !== null),
  );
}

function focusables(): HTMLElement[] {
  const sel = selectorsFor(location.hostname).join(",");
  return [...document.querySelectorAll(sel)]
    .filter((el): el is HTMLElement => {
      if (!(el instanceof HTMLElement)) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return false;
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden";
    })
    .slice(0, 400);
}

function currentRect(): DOMRect {
  const ae = document.activeElement;
  if (ae instanceof HTMLElement) {
    const r = ae.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return r;
  }
  return new DOMRect(window.innerWidth / 2 - 1, window.innerHeight / 2 - 1, 2, 2);
}

function move(dir: Direction): void {
  ensureStyle();
  document.querySelectorAll(".smartv-focused").forEach((el) => el.classList.remove("smartv-focused"));
  const els = focusables();
  if (els.length === 0) return;
  const cur = currentRect();
  const rects = els.map((el) => el.getBoundingClientRect());
  const idx = pickNext(cur, dir, rects);
  if (idx >= 0) {
    const el = els[idx];
    el.classList.add("smartv-focused");
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }
}

document.addEventListener(
  "keydown",
  (e: KeyboardEvent) => {
    if (isEditable(document.activeElement) || isEditable(e.target as Element)) return;
    if (playerActive()) return; // deixa o player usar as setas nativamente
    const map: Record<string, Direction> = {
      ArrowUp: "up",
      ArrowDown: "down",
      ArrowLeft: "left",
      ArrowRight: "right",
    };
    const dir = map[e.key];
    if (dir) {
      // Se não há foco ainda, assume o controle; senão, só age quando não há
      // scroll nativo óbvio? Mantemos simples: sempre navega espacialmente.
      e.preventDefault();
      e.stopPropagation();
      pokeOverlay();
      move(dir);
    } else if (e.key === "Enter" && document.activeElement instanceof HTMLElement) {
      if (document.activeElement.classList.contains("smartv-focused")) {
        e.preventDefault();
        document.activeElement.click();
      }
    }
  },
  true,
);

// Mantém a janela única: links same-domain com target=_blank navegam na
// mesma aba em vez de abrir outra.
document.addEventListener(
  "click",
  (e: MouseEvent) => {
    const el = e.target instanceof Element ? e.target.closest('a[target="_blank"]') : null;
    if (!(el instanceof HTMLAnchorElement)) return;
    try {
      const dest = new URL(el.href, window.location.href);
      if (dest.hostname === window.location.hostname) {
        e.preventDefault();
        e.stopPropagation();
        window.location.href = dest.toString();
      }
    } catch {
      /* href inválida: deixa o comportamento padrão */
    }
  },
  true,
);

initOverlay();
