// Type-only reference to window.smartv (no runtime import: the bridge is
// injected by the preload script, so an `import` would break the bundle).
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./smartv.d.ts" />

export {};

const grid = document.getElementById("cards") as HTMLElement;

// The bridge is injected by the preload script. If it is missing (stale
// build, broken preload), the UI must say so instead of dying silently:
// clock, keyboard and mouse keep working.
function bridge(): Window["smartv"] | null {
  return typeof window.smartv === "object" && window.smartv !== null ? window.smartv : null;
}

function showFatal(text: string): void {
  grid.innerHTML = "";
  const p = document.createElement("p");
  p.className = "fatal";
  p.textContent = text;
  grid.appendChild(p);
  cards = [];
}
let apps: Array<{ id: string; name: string; color: string }> = [];
let focusIndex = 0;
let cards: HTMLElement[] = [];

async function load(): Promise<void> {
  const api = bridge();
  if (!api) {
    showFatal("Falha na ponte com o aplicativo. Reconstrua (npm run build -w apps/desktop) e reinicie.");
    return;
  }
  try {
    apps = await api.getApps();
  } catch {
    showFatal("Não foi possível carregar os serviços. Reinicie o aplicativo.");
    return;
  }
  if (apps.length === 0) {
    showFatal("Nenhum serviço configurado.");
    return;
  }
  render();
}

function render(): void {
  grid.innerHTML = "";
  cards = apps.map((app, i) => {
    const b = document.createElement("button");
    b.className = "card";
    b.style.setProperty("--brand", app.color);
    b.setAttribute("aria-label", app.name);
    b.innerHTML = `<span class="wordmark">${app.name}</span>`;
    b.addEventListener("click", () => void openApp(i));
    b.addEventListener("mouseenter", () => setFocus(i));
    grid.appendChild(b);
    return b;
  });
  setFocus(0);
}

function setFocus(i: number): void {
  if (cards.length === 0) return;
  focusIndex = (i + cards.length) % cards.length;
  cards.forEach((c, k) => c.classList.toggle("focused", k === focusIndex));
  cards[focusIndex].focus({ preventScroll: true });
}

async function openApp(i: number): Promise<void> {
  const app = apps[i];
  const api = bridge();
  if (!app || !api) return;
  const res = await api.openApp(app.id);
  if (!res.ok) {
    const st = document.getElementById("status");
    if (st) st.textContent = "Não foi possível abrir. Tente de novo.";
  }
}

document.addEventListener("keydown", (e: KeyboardEvent) => {
  const cols = window.innerWidth > 900 ? 4 : 2;
  switch (e.key) {
    case "ArrowRight": e.preventDefault(); setFocus(focusIndex + 1); break;
    case "ArrowLeft": e.preventDefault(); setFocus(focusIndex - 1); break;
    case "ArrowDown": e.preventDefault(); setFocus(focusIndex + cols); break;
    case "ArrowUp": e.preventDefault(); setFocus(focusIndex - cols); break;
    case "Enter": e.preventDefault(); void openApp(focusIndex); break;
  }
});

bridge()?.onStatus((text: string) => {
  const st = document.getElementById("status");
  if (st) st.textContent = text;
});

function tick(): void {
  const now = new Date();
  const c = document.getElementById("clock");
  const d = document.getElementById("date");
  if (c) c.textContent = now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  if (d) d.textContent = now.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "2-digit" });
}
setInterval(tick, 10000);
tick();
void load();
