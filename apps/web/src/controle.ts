import { STREAMING_APPS } from "@smartv/shared";
import type { ControllerMessage } from "@smartv/shared";
import { normalizeBackendUrl, RemoteConnection, type ConnStatus } from "./connection.js";

const RAW_BACKEND_URL: string =
  (import.meta as unknown as { env: Record<string, string> }).env?.VITE_BACKEND_URL ?? "";
const TOKEN_KEY = "smartv_token";

const statusEl = document.getElementById("status") as HTMLElement;
const subEl = document.getElementById("substatus") as HTMLElement;
const errorPanel = document.getElementById("errorPanel") as HTMLElement;
const errorText = document.getElementById("errorText") as HTMLElement;
const tokenPanel = document.getElementById("tokenPanel") as HTMLElement;
const tokenMsg = document.getElementById("tokenMsg") as HTMLElement;
const tokenInput = document.getElementById("tokenInput") as HTMLInputElement;

function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

// Token via ?k=TOKEN na primeira abertura: salva e limpa a URL.
{
  const q = new URLSearchParams(location.search).get("k");
  if (q?.trim()) localStorage.setItem(TOKEN_KEY, q.trim());
  if (q !== null) history.replaceState(null, "", location.pathname);
}

function buzz(): void {
  try {
    (navigator as Navigator & { vibrate?: (p: number) => boolean }).vibrate?.(10);
  } catch {
    /* noop */
  }
}

let subTimer: number | null = null;

function paint(color: "yellow" | "green" | "orange" | "red", text: string, sub = ""): void {
  statusEl.textContent = text;
  statusEl.className = `status st-${color}`;
  subEl.textContent = sub;
  if (subTimer !== null) {
    clearTimeout(subTimer);
    subTimer = null;
  }
}

function renderStatus(s: ConnStatus): void {
  errorPanel.classList.add("hidden");
  switch (s.name) {
    case "loading":
      paint("yellow", "Carregando…");
      // Cold start do plano gratuito pode levar até ~1 min.
      subTimer = window.setTimeout(() => {
        if (conn?.current.name === "loading") {
          subEl.textContent = "O servidor gratuito pode levar até 1 minuto para acordar";
        }
      }, 5000);
      break;
    case "connected":
      if (s.agentOnline) paint("green", "Conectado");
      else paint("orange", "Conectado ao servidor, PC offline");
      break;
    case "error":
      if (s.kind === "auth") {
        paint("red", "Erro: token inválido");
        openTokenPanel("Token inválido, digite de novo.");
      } else if (s.kind === "origin") {
        paint("red", "Erro: origem não permitida");
        errorText.textContent =
          `O servidor recusou esta origem: ${location.origin}. ` +
          `Coloque exatamente isto em ALLOWED_ORIGINS no Render.`;
        errorPanel.classList.remove("hidden");
      } else if (s.kind === "config") {
        paint("red", "Erro: servidor não configurado");
        errorText.textContent = "Falta VITE_BACKEND_URL no deploy da Vercel. Faça o redeploy após configurar.";
        errorPanel.classList.remove("hidden");
      } else {
        paint("red", "Erro: não consegui conectar ao servidor");
        subEl.textContent = "";
        errorPanel.classList.remove("hidden");
        errorText.textContent = "Verifique a internet e o backend no Render.";
      }
      break;
  }
}

function flashStatus(): void {
  statusEl.classList.add("flash");
  window.setTimeout(() => statusEl.classList.remove("flash"), 350);
}

const { url: BACKEND_URL, notes } = normalizeBackendUrl(RAW_BACKEND_URL);
if (notes.includes("invalid")) {
  // Configuração quebrada: não tenta conectar.
  paint("red", "Erro: servidor não configurado");
}

let conn: RemoteConnection | null = null;

function send(msg: ControllerMessage): void {
  buzz();
  // Real state: the socket can be open (server reachable) while the PC app
  // is offline. Sending then would silently drop the command on the server,
  // so block it here with a useful message instead of faking "connected".
  const st = conn?.current;
  if (st && st.name === "connected" && st.agentOnline === false) {
    flashStatus();
    subEl.textContent = "PC offline — comando não enviado. Ligue o app SmartTV no PC.";
    return;
  }
  conn?.send(msg);
}

function parseHold(spec: string): ControllerMessage {
  const [t, v] = spec.split(":");
  if (t === "key") return { type: "key", key: v as "up" } as ControllerMessage;
  if (t === "volume") return { type: "volume", action: v as "up" } as ControllerMessage;
  throw new Error("bad hold spec");
}

function startConnection(): void {
  if (!BACKEND_URL) {
    renderStatus({ name: "error", kind: "config", autoRetry: false });
    return;
  }
  if (!getToken()) {
    tokenPanel.classList.remove("hidden");
    paint("yellow", "Sem token — digite abaixo");
    return;
  }
  conn?.dispose();
  conn = new RemoteConnection(BACKEND_URL, getToken, {
    onStatus: renderStatus,
    onSendBlocked: flashStatus,
  });
  conn.connect();
}

// Painel de token (engrenagem): editável a qualquer hora.
function openTokenPanel(msg = ""): void {
  tokenMsg.textContent = msg;
  tokenInput.value = "";
  tokenPanel.classList.remove("hidden");
}
(document.getElementById("btnGear") as HTMLElement).addEventListener("click", () => {
  tokenPanel.classList.toggle("hidden");
  tokenMsg.textContent = "";
});
(document.getElementById("btnTokenShow") as HTMLElement).addEventListener("click", () => {
  tokenInput.type = tokenInput.type === "password" ? "text" : "password";
});
(document.getElementById("tokenSave") as HTMLElement).addEventListener("click", () => {
  const v = tokenInput.value.trim();
  if (!v) return;
  localStorage.setItem(TOKEN_KEY, v);
  tokenPanel.classList.add("hidden");
  tokenMsg.textContent = "";
  startConnection();
});
(document.getElementById("tokenLogout") as HTMLElement).addEventListener("click", () => {
  localStorage.removeItem(TOKEN_KEY);
  conn?.dispose();
  conn = null;
  tokenMsg.textContent = "";
  tokenPanel.classList.remove("hidden");
  paint("yellow", "Sem token — digite abaixo");
});
(document.getElementById("btnRetry") as HTMLElement).addEventListener("click", () => {
  if (conn) conn.reconnect();
  else startConnection();
});

// Renderiza botões de apps a partir da config compartilhada.
{
  const wrap = document.getElementById("apps") as HTMLElement;
  for (const app of STREAMING_APPS) {
    const b = document.createElement("button");
    b.className = "btn";
    b.style.setProperty("--brand", app.color);
    b.textContent = app.name;
    b.addEventListener("click", () => send({ type: "app", id: app.id } as ControllerMessage));
    wrap.appendChild(b);
  }
}

// data-send: envio simples. data-hold: repete enquanto segurado.
document.querySelectorAll<HTMLElement>("[data-send]").forEach((el) => {
  el.addEventListener("click", () => {
    send(JSON.parse(el.dataset.send as string) as ControllerMessage);
  });
});
document.querySelectorAll<HTMLElement>("[data-hold]").forEach((el) => {
  let timer: number | null = null;
  const start = (e: Event): void => {
    e.preventDefault();
    send(parseHold(el.dataset.hold as string));
    timer = window.setInterval(() => send(parseHold(el.dataset.hold as string)), 120);
  };
  const stop = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  el.addEventListener("pointerdown", start);
  el.addEventListener("pointerup", stop);
  el.addEventListener("pointerleave", stop);
  el.addEventListener("pointercancel", stop);
});

// Power com toque longo + confirmação.
{
  const btn = document.getElementById("btnPower") as HTMLElement;
  let t: number | null = null;
  btn.addEventListener("pointerdown", () => {
    t = window.setTimeout(() => {
      if (confirm("Apagar a tela da TV?")) send({ type: "power", action: "screenOff" });
    }, 600);
  });
  const cancel = (): void => {
    if (t !== null) {
      clearTimeout(t);
      t = null;
    }
  };
  btn.addEventListener("pointerup", cancel);
  btn.addEventListener("pointerleave", cancel);
}
(document.getElementById("btnHome") as HTMLElement).addEventListener("click", () =>
  send({ type: "key", key: "home" }),
);

// Teclado: envia em tempo real com debounce curto + botões.
{
  const panel = document.getElementById("keyboardPanel") as HTMLElement;
  const input = document.getElementById("kbdInput") as HTMLInputElement;
  (document.getElementById("btnKeyboard") as HTMLElement).addEventListener("click", () => {
    panel.classList.toggle("hidden");
    if (!panel.classList.contains("hidden")) input.focus();
  });
  let last = "";
  let deb: number | null = null;
  input.addEventListener("input", () => {
    if (deb !== null) clearTimeout(deb);
    deb = window.setTimeout(() => {
      const cur = input.value;
      if (cur.startsWith(last)) {
        const added = cur.slice(last.length);
        if (added) send({ type: "text", value: added.slice(-500) });
      } else if (cur.length < last.length) {
        for (let i = 0; i < last.length - cur.length; i++) send({ type: "textKey", key: "backspace" });
        const tail = cur.slice(0);
        if (tail) send({ type: "text", value: tail.slice(-500) });
      } else {
        if (cur) send({ type: "text", value: cur.slice(-500) });
      }
      last = cur;
    }, 120);
  });
  (document.getElementById("kbdSend") as HTMLElement).addEventListener("click", () => {
    if (input.value && input.value !== last) send({ type: "text", value: input.value.slice(-500) });
    last = input.value;
  });
  (document.getElementById("kbdEnter") as HTMLElement).addEventListener("click", () =>
    send({ type: "textKey", key: "enter" }),
  );
  (document.getElementById("kbdBack") as HTMLElement).addEventListener("click", () =>
    send({ type: "textKey", key: "backspace" }),
  );
}

// Touchpad: agrupa eventos (~60 Hz).
{
  const panel = document.getElementById("touchPanel") as HTMLElement;
  const area = document.getElementById("touchArea") as HTMLElement;
  (document.getElementById("btnTouch") as HTMLElement).addEventListener("click", () =>
    panel.classList.toggle("hidden"),
  );
  (document.getElementById("touchBack") as HTMLElement).addEventListener("click", () =>
    panel.classList.add("hidden"),
  );
  let lastX = 0;
  let lastY = 0;
  let tracking = false;
  let acc = { dx: 0, dy: 0 };
  let flushTimer: number | null = null;
  let twoFinger = false;
  let moved = false;

  const flush = (): void => {
    if (acc.dx !== 0 || acc.dy !== 0) {
      send({ type: "mouseMove", dx: Math.trunc(acc.dx), dy: Math.trunc(acc.dy) });
      acc = { dx: 0, dy: 0 };
    }
    flushTimer = null;
  };
  area.addEventListener("touchstart", (e: TouchEvent) => {
    e.preventDefault();
    const t = e.touches[0];
    lastX = t.clientX;
    lastY = t.clientY;
    tracking = true;
    moved = false;
    twoFinger = e.touches.length === 2;
  }, { passive: false });
  area.addEventListener("touchmove", (e: TouchEvent) => {
    e.preventDefault();
    if (!tracking) return;
    if (e.touches.length === 2 && e.touches[0]) {
      const y = e.touches[0].clientY;
      const dy = (y - lastY) * 2;
      lastY = y;
      send({ type: "scroll", dy: Math.trunc(dy) });
      moved = true;
      return;
    }
    const t = e.touches[0];
    if (!t) return;
    acc.dx += (t.clientX - lastX) * 1.5;
    acc.dy += (t.clientY - lastY) * 1.5;
    lastX = t.clientX;
    lastY = t.clientY;
    if (Math.abs(acc.dx) + Math.abs(acc.dy) > 4) moved = true;
    if (flushTimer === null) flushTimer = window.setTimeout(flush, 16);
  }, { passive: false });
  area.addEventListener("touchend", (e: TouchEvent) => {
    e.preventDefault();
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flush();
    }
    if (!moved) send({ type: "mouseClick", button: twoFinger ? "right" : "left" });
    tracking = false;
  });
}

// Ao voltar do segundo plano (iOS inclusive): recria a conexão, sem confiar
// no readyState do socket antigo.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (conn) conn.reconnect();
    else startConnection();
  }
  if (document.visibilityState === "visible") void lockScreen();
});
let wakeLock: unknown = null;
async function lockScreen(): Promise<void> {
  try {
    wakeLock = await (
      navigator as Navigator & { wakeLock?: { request: (k: string) => Promise<unknown> } }
    ).wakeLock?.request("screen");
    void wakeLock;
  } catch {
    /* noop */
  }
}
void lockScreen();

startConnection();
