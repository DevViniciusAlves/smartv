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

// Input-source tracking. The remote arrives as key events: while it drives the
// TV, the mouse must NOT steal focus (hover was fighting the D-pad). Any real
// mouse movement hands control back to the mouse and restores the cursor.
let remoteNav = false;

function setRemoteNav(on: boolean): void {
  if (remoteNav === on) return;
  remoteNav = on;
  document.documentElement.classList.toggle("remote-nav", on);
}

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
    b.addEventListener("mouseenter", () => {
      if (!remoteNav) setFocus(i);
    });
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

// Columns are derived from the actual layout (how many cards share the first
// row) instead of a hardcoded breakpoint, so Up/Down move by real rows even if
// the grid changes.
function columnCount(): number {
  if (cards.length === 0) return 1;
  const firstTop = Math.round(cards[0].getBoundingClientRect().top);
  let n = 0;
  for (const c of cards) {
    if (Math.round(c.getBoundingClientRect().top) !== firstTop) break;
    n += 1;
  }
  return Math.max(1, n);
}

document.addEventListener("keydown", (e: KeyboardEvent) => {
  setRemoteNav(true);
  const cols = columnCount();
  switch (e.key) {
    case "ArrowRight": e.preventDefault(); setFocus(focusIndex + 1); break;
    case "ArrowLeft": e.preventDefault(); setFocus(focusIndex - 1); break;
    case "ArrowDown": e.preventDefault(); setFocus(focusIndex + cols); break;
    case "ArrowUp": e.preventDefault(); setFocus(focusIndex - cols); break;
    case "Enter": e.preventDefault(); void openApp(focusIndex); break;
  }
});

// A real mouse move re-enables the pointer (and hover-driven focus).
document.addEventListener("mousemove", () => setRemoteNav(false), { passive: true });

bridge()?.onStatus((text: string) => {
  const st = document.getElementById("status");
  if (st) st.textContent = text;
});

// Update management
const updateControls = document.getElementById("updateControls") as HTMLElement;
const btnCheck = document.getElementById("btnCheck") as HTMLButtonElement;
const btnDownload = document.getElementById("btnDownload") as HTMLButtonElement;
const btnRestart = document.getElementById("btnRestart") as HTMLButtonElement;

bridge()?.onUpdateEvent?.((ev: string) => {
  updateControls.classList.remove("hidden");
  btnCheck.classList.add("hidden");
  btnDownload.classList.add("hidden");
  btnRestart.classList.add("hidden");

  switch (ev) {
    case "update-available":
      btnDownload.classList.remove("hidden");
      break;
    case "update-downloaded":
      btnRestart.classList.remove("hidden");
      break;
    case "checking-for-update":
      break;
    default:
      btnCheck.classList.remove("hidden");
      break;
  }
});

btnCheck.addEventListener("click", () => void bridge()?.checkUpdates());
btnDownload.addEventListener("click", () => void bridge()?.downloadUpdate());
btnRestart.addEventListener("click", () => void bridge()?.restartApp());

// Monitor selection
const monitorModal = document.getElementById("monitorModal") as HTMLElement;
const monitorList = document.getElementById("monitorList") as HTMLElement;
const btnSelectMonitor = document.getElementById("btnSelectMonitor") as HTMLButtonElement;
const btnCloseMonitor = document.getElementById("btnCloseMonitor") as HTMLButtonElement;
const btnMonitorOk = document.getElementById("btnMonitorOk") as HTMLButtonElement;

let selectedDisplayId: number | null = null;

btnSelectMonitor.addEventListener("click", async () => {
  const displays = await bridge()?.getDisplays() ?? [];
  monitorList.innerHTML = "";
  selectedDisplayId = null;
  
  for (const d of displays) {
    const btn = document.createElement("button");
    btn.className = "monitor-item";
    btn.textContent = d.label;
    btn.addEventListener("click", () => {
      selectedDisplayId = d.id;
      // Highlight selection
      document.querySelectorAll(".monitor-item").forEach(el => el.classList.remove("selected"));
      btn.classList.add("selected");
    });
    monitorList.appendChild(btn);
  }
  monitorModal.classList.remove("hidden");
});

btnMonitorOk.addEventListener("click", () => {
  if (selectedDisplayId !== null) {
    void bridge()?.setDisplay(selectedDisplayId);
  }
  monitorModal.classList.add("hidden");
});

btnCloseMonitor.addEventListener("click", () => {
  monitorModal.classList.add("hidden");
});

// Show update controls initially
updateControls.classList.remove("hidden");

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
