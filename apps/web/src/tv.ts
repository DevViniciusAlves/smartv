import { STREAMING_APPS } from "@smartv/shared";

const grid = document.getElementById("cards") as HTMLElement;
let focusIndex = 0;
let cards: HTMLElement[] = [];

function iconSvg(id: string): string {
  // Wordmarks próprios simples (sem baixar logos protegidos).
  const label: Record<string, string> = {
    youtube: "▶ YouTube",
    netflix: "N NETFLIX",
    hbo: "HBO",
    disney: "Disney+",
  };
  return `<span class="wordmark">${label[id] ?? id}</span>`;
}

function render(): void {
  grid.innerHTML = "";
  cards = STREAMING_APPS.map((app, i) => {
    const b = document.createElement("button");
    b.className = "card";
    b.style.setProperty("--brand", app.color);
    b.dataset.index = String(i);
    b.setAttribute("aria-label", app.name);
    b.innerHTML = `${iconSvg(app.id)}<span class="name">${app.name}</span>`;
    b.addEventListener("click", () => openApp(i));
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

function openApp(i: number): void {
  const app = STREAMING_APPS[i];
  if (app) window.location.href = app.url;
}

document.addEventListener("keydown", (e: KeyboardEvent) => {
  const cols = window.innerWidth > 900 ? 4 : 2;
  switch (e.key) {
    case "ArrowRight": e.preventDefault(); setFocus(focusIndex + 1); break;
    case "ArrowLeft": e.preventDefault(); setFocus(focusIndex - 1); break;
    case "ArrowDown": e.preventDefault(); setFocus(focusIndex + cols); break;
    case "ArrowUp": e.preventDefault(); setFocus(focusIndex - cols); break;
    case "Enter": e.preventDefault(); openApp(focusIndex); break;
  }
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
render();
