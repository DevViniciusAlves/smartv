import { LAUNCHER_URL, OVERLAY_ENABLED, OVERLAY_HIDE_MS } from "./config.js";

const HOST_ID = "smartv-overlay-host";
let hideTimer: number | null = null;
let clockTimer: number | null = null;

function ensureHost(): HTMLElement | null {
  if (!OVERLAY_ENABLED) return null;
  const existing = document.getElementById(HOST_ID);
  if (existing) return existing;
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.setAttribute("aria-hidden", "true");
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = [
    ":host{position:fixed;top:max(16px, env(safe-area-inset-top));right:16px;z-index:2147483647;opacity:0;pointer-events:none;transition:opacity .25s ease;}",
    ":host(.visible){opacity:1;pointer-events:auto;}",
    ".box{display:flex;align-items:center;gap:10px;background:rgba(10,14,20,.85);color:#fff;border-radius:12px;padding:8px 12px;font:600 15px/1.2 system-ui,sans-serif;}",
    "button{border:0;border-radius:8px;background:#2e4a7a;color:#fff;font:700 15px system-ui,sans-serif;min-width:48px;min-height:40px;cursor:pointer;}",
  ].join("");
  const box = document.createElement("div");
  box.className = "box";
  const clock = document.createElement("span");
  const home = document.createElement("button");
  home.textContent = "Início";
  home.addEventListener("click", () => {
    window.location.href = LAUNCHER_URL;
  });
  box.appendChild(clock);
  box.appendChild(home);
  shadow.appendChild(style);
  shadow.appendChild(box);
  const tick = (): void => {
    clock.textContent = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  };
  tick();
  if (clockTimer === null) clockTimer = window.setInterval(tick, 15000);
  document.documentElement.appendChild(host);
  return host;
}

// Shows the overlay and schedules auto-hide. Call on mouse or dpad activity.
// NOTE: while a video is fullscreen only the fullscreen element is rendered,
// so the overlay cannot appear there (browser limitation).
export function pokeOverlay(): void {
  const host = ensureHost();
  if (!host) return;
  host.classList.add("visible");
  if (hideTimer !== null) window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => host.classList.remove("visible"), OVERLAY_HIDE_MS);
}

export function initOverlay(): void {
  if (!OVERLAY_ENABLED) return;
  document.addEventListener("mousemove", () => pokeOverlay(), { passive: true });
}
