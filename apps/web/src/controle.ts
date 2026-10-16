import { STREAMING_APPS } from "@smartv/shared";
import type { ControllerMessage } from "@smartv/shared";

const BACKEND_URL: string =
  (import.meta as unknown as { env: Record<string, string> }).env?.VITE_BACKEND_URL ?? "";
const TOKEN_KEY = "smartv_token";
const statusEl = document.getElementById("status") as HTMLElement;

let ws: WebSocket | null = null;
let attempt = 0;
let token: string | null = localStorage.getItem(TOKEN_KEY);
let agentOnline = false;

// Token via ?k=TOKEN na primeira abertura: salva e limpa a URL.
{
  const q = new URLSearchParams(location.search).get("k");
  if (q) {
    token = q.trim();
    if (token) localStorage.setItem(TOKEN_KEY, token);
    history.replaceState(null, "", location.pathname);
  }
}

function setStatus(s: string): void {
  statusEl.textContent = s;
}

function buzz(): void {
  try {
    (navigator as Navigator & { vibrate?: (p: number) => boolean }).vibrate?.(10);
  } catch {
    /* noop */
  }
}

export function send(msg: ControllerMessage): void {
  buzz();
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function parseHold(spec: string): ControllerMessage {
  const [t, v] = spec.split(":");
  if (t === "key") return { type: "key", key: v as "up" } as ControllerMessage;
  if (t === "volume") return { type: "volume", action: v as "up" } as ControllerMessage;
  throw new Error("bad hold spec");
}

function connect(): void {
  if (!token) {
    document.getElementById("tokenPanel")?.classList.remove("hidden");
    setStatus("Sem token");
    return;
  }
  if (!BACKEND_URL) {
    setStatus("Sem servidor configurado");
    return;
  }
  attempt += 1;
  setStatus(attempt === 1 ? "Conectando…" : "Acordando servidor…");
  ws = new WebSocket(BACKEND_URL);
  let authed = false;

  // Se o Render gratuito estiver dormindo, a conexão demora; mostra estado.
  const wakeTimer = setTimeout(() => {
    if (!authed) setStatus("Acordando servidor…");
  }, 2500);

  ws.onopen = () => {
    ws?.send(JSON.stringify({ type: "hello", role: "controller", token, v: 1 }));
  };
  ws.onmessage = (ev: MessageEvent) => {
    let msg: unknown;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    const m = msg as { type?: string; agentOnline?: boolean };
    if (m.type === "state") {
      authed = true;
      clearTimeout(wakeTimer);
      agentOnline = m.agentOnline === true;
      setStatus(agentOnline ? "Conectado" : "PC offline");
    }
  };
  ws.onclose = () => {
    clearTimeout(wakeTimer);
    setStatus("Acordando servidor…");
    const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
    setTimeout(connect, delay);
  };
  ws.onerror = () => {
    try {
      ws?.close();
    } catch {
      /* noop */
    }
  };
}

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
  let twoLastY = 0;
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
    if (twoFinger && e.touches[1]) twoLastY = e.touches[1].clientY;
  }, { passive: false });
  area.addEventListener("touchmove", (e: TouchEvent) => {
    e.preventDefault();
    if (!tracking) return;
    if (e.touches.length === 2 && e.touches[0]) {
      const y = e.touches[0].clientY;
      const dy = (y - lastY) * 2;
      lastY = y;
      void twoLastY;
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

// Token manual.
{
  const save = (): void => {
    const v = (document.getElementById("tokenInput") as HTMLInputElement).value.trim();
    if (!v) return;
    token = v;
    localStorage.setItem(TOKEN_KEY, v);
    document.getElementById("tokenPanel")?.classList.add("hidden");
    attempt = 0;
    connect();
  };
  (document.getElementById("tokenSave") as HTMLElement).addEventListener("click", save);
}

// Wake Lock opcional + reconexão ao voltar do segundo plano.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && (!ws || ws.readyState !== WebSocket.OPEN)) {
    attempt = 0;
    connect();
  }
});
{
  const lock = async (): Promise<void> => {
    try {
      await (navigator as Navigator & { wakeLock?: { request: (k: string) => Promise<unknown> } }).wakeLock?.request("screen");
    } catch {
      /* noop */
    }
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void lock();
  });
  void lock();
}

connect();
