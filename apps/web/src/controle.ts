import { STREAMING_APPS } from "@smartv/shared";
import type { ControllerMessage } from "@smartv/shared";
import { normalizeBackendUrl, RemoteConnection, type ConnStatus } from "./connection.js";
import {
  isValidPairCode,
  parseBinding,
  parseQrPayload,
  pairFailureMessage,
  toLinkState,
  PairingSession,
  type PairBinding,
  type PairFailure,
} from "./pairing.js";

const RAW_BACKEND_URL: string =
  (import.meta as unknown as { env: Record<string, string> }).env?.VITE_BACKEND_URL ?? "";
const TOKEN_KEY = "smartv_token";
const PAIR_KEY = "smartv_pair";

const statusEl = document.getElementById("status") as HTMLElement;
const subEl = document.getElementById("substatus") as HTMLElement;
const errorPanel = document.getElementById("errorPanel") as HTMLElement;
const errorText = document.getElementById("errorText") as HTMLElement;
const tokenPanel = document.getElementById("tokenPanel") as HTMLElement;
const tokenMsg = document.getElementById("tokenMsg") as HTMLElement;
const tokenInput = document.getElementById("tokenInput") as HTMLInputElement;

// ---- credentials: pair binding (new) wins, legacy ROOM_TOKEN still works ----

function getPairBinding(): PairBinding | null {
  return parseBinding(localStorage.getItem(PAIR_KEY));
}

function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

/** Whatever authenticates this phone: pair session token or legacy token. */
function getCredential(): string | null {
  return getPairBinding()?.token ?? getToken();
}

// Legacy token via ?k=TOKEN na primeira abertura: salva e limpa a URL.
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

// Tri-state pill shared with the PC modal: CONECTADO requires the phone
// credential AND the PC actually online. A bare server link is never shown
// as connected.
function renderStatus(s: ConnStatus): void {
  errorPanel.classList.add("hidden");
  const link = toLinkState(s, getCredential() !== null);
  if (pairingBusy) {
    paint("yellow", "CONECTANDO", "Pareando com o SmarTV…");
    return;
  }
  switch (link.name) {
    case "CONECTANDO":
      paint("yellow", "CONECTANDO");
      subTimer = window.setTimeout(() => {
        if (conn?.current.name === "loading") {
          subEl.textContent = "O servidor gratuito pode levar até 1 minuto para acordar";
        }
      }, 5000);
      break;
    case "CONECTADO":
      paint("green", "CONECTADO");
      break;
    case "DESCONECTADO":
      if (link.reason === "sem-pareamento") {
        paint("yellow", "DESCONECTADO", "Toque em 🔗 Conexão para parear com o PC");
      } else if (link.reason === "pc-offline") {
        paint("orange", "DESCONECTADO", "PC offline — abra o SmarTV no PC");
      } else       if (link.reason === "token") {
        if (s.name === "error" && s.kind === "auth") {
          if (getPairBinding()) {
            paint("red", "DESCONECTADO", "Sessão inválida — pareie de novo em 🔗 Conexão");
          } else {
            paint("red", "DESCONECTADO", "Token inválido");
            openTokenPanel("Token inválido, digite de novo.");
          }
        } else if (s.name === "error" && s.kind === "origin") {
          paint("red", "Erro: origem não permitida");
          errorText.textContent =
            `O servidor recusou esta origem: ${location.origin}. ` +
            `Coloque exatamente isto em ALLOWED_ORIGINS no Render.`;
          errorPanel.classList.remove("hidden");
        } else {
          paint("red", "DESCONECTADO", "Configuração inválida — confira o servidor");
          errorText.textContent = "Falta VITE_BACKEND_URL no deploy da Vercel. Faça o redeploy após configurar.";
          errorPanel.classList.remove("hidden");
        }
      } else {
        paint("red", "DESCONECTADO", "Sem conexão — verifique a internet");
        errorPanel.classList.remove("hidden");
        errorText.textContent = "Verifique a internet e o backend no Render.";
      }
      break;
  }
  paintConnPill(link.name);
}

function flashStatus(): void {
  statusEl.classList.add("flash");
  window.setTimeout(() => statusEl.classList.remove("flash"), 350);
}

const { url: BACKEND_URL, notes } = normalizeBackendUrl(RAW_BACKEND_URL);
if (notes.includes("invalid")) {
  // Configuração quebrada: não tenta conectar.
  paint("red", "DESCONECTADO", "Servidor não configurado");
}

let conn: RemoteConnection | null = null;
let pairingBusy = false;

function isConnected(): boolean {
  const st = conn?.current;
  return !!st && st.name === "connected" && st.agentOnline === true;
}

function send(msg: ControllerMessage): void {
  buzz();
  // Encerra o envio imediatamente quando não há controle real: sem vínculo
  // ou PC offline. Nunca finge "conectado".
  if (!isConnected()) {
    flashStatus();
    const st = conn?.current;
    subEl.textContent =
      st && st.name === "connected"
        ? "PC offline — comando não enviado. Ligue o app SmartTV no PC."
        : "Sem conexão — pareie em 🔗 Conexão.";
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
  const credential = getCredential();
  if (!credential) {
    paint("yellow", "DESCONECTADO", "Toque em 🔗 Conexão para parear com o PC");
    paintConnPill("DESCONECTADO");
    return;
  }
  conn?.dispose();
  conn = new RemoteConnection(BACKEND_URL, () => getCredential(), {
    onStatus: renderStatus,
    onSendBlocked: flashStatus,
  });
  conn.connect();
}

// Painel de token legado (engrenagem): mantido como avançado.
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
  paint("yellow", "DESCONECTADO", "Toque em 🔗 Conexão para parear com o PC");
});
(document.getElementById("btnRetry") as HTMLElement).addEventListener("click", () => {
  if (conn) conn.reconnect();
  else startConnection();
});

// ---- Conexão modal: parear por código ou QR, encerrar vínculo ----

const connModal = document.getElementById("connModal") as HTMLElement;
const connPill = document.getElementById("connPill") as HTMLElement;
const connMsg = document.getElementById("connMsg") as HTMLElement;
const pairInput = document.getElementById("pairInput") as HTMLInputElement;
const scanVideo = document.getElementById("scanVideo") as HTMLVideoElement;

function paintConnPill(link: "CONECTADO" | "CONECTANDO" | "DESCONECTADO"): void {
  connPill.textContent = link;
  connPill.className = `status ${link === "CONECTADO" ? "st-green" : link === "CONECTANDO" ? "st-yellow" : "st-red"}`;
}

function setConnMsg(text: string): void {
  connMsg.textContent = text;
}

function openConn(): void {
  connModal.classList.remove("hidden");
  setConnMsg("");
  pairInput.value = "";
  showTab("code");
  refreshConnPill();
}

function closeConn(): void {
  stopScan();
  connModal.classList.add("hidden");
}

function refreshConnPill(): void {
  paintConnPill(toLinkState(conn?.current ?? null, getCredential() !== null).name);
}

function showTab(which: "code" | "scan"): void {
  (document.getElementById("tabCode") as HTMLElement).classList.toggle("active", which === "code");
  (document.getElementById("tabScan") as HTMLElement).classList.toggle("active", which === "scan");
  (document.getElementById("paneCode") as HTMLElement).classList.toggle("hidden", which !== "code");
  (document.getElementById("paneScan") as HTMLElement).classList.toggle("hidden", which !== "scan");
  if (which !== "scan") stopScan();
}

(document.getElementById("btnConn") as HTMLElement).addEventListener("click", () => {
  if (connModal.classList.contains("hidden")) openConn();
  else closeConn();
});
(document.getElementById("connClose") as HTMLElement).addEventListener("click", closeConn);
(document.getElementById("tabCode") as HTMLElement).addEventListener("click", () => showTab("code"));
(document.getElementById("tabScan") as HTMLElement).addEventListener("click", () => showTab("scan"));

async function doPair(code: string): Promise<void> {
  const clean = code.trim();
  if (!isValidPairCode(clean)) {
    setConnMsg("Digite os 6 dígitos mostrados no PC.");
    return;
  }
  if (!BACKEND_URL) {
    setConnMsg("Servidor não configurado neste /controle. Confira o deploy da Vercel.");
    return;
  }
  pairingBusy = true;
  paint("yellow", "CONECTANDO", "Pareando com o SmarTV…");
  paintConnPill("CONECTANDO");
  setConnMsg("Conectando…");
  const session = new PairingSession(BACKEND_URL);
  try {
    const res = await session.pair(clean);
    localStorage.setItem(PAIR_KEY, JSON.stringify({ token: res.token, deviceId: res.deviceId }));
    setConnMsg("");
    pairingBusy = false;
    startConnection();
    closeConn();
  } catch (e) {
    pairingBusy = false;
    setConnMsg(pairFailureMessage(e as PairFailure));
    refreshAfterPairFail();
  }
}

function refreshAfterPairFail(): void {
  if (conn) conn.reconnect();
  else startConnection();
}

(document.getElementById("pairGo") as HTMLElement).addEventListener("click", () => void doPair(pairInput.value));
pairInput.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter") void doPair(pairInput.value);
});

// ---- QR scan (BarcodeDetector + câmera; manual continua funcionando) ----

let scanGen = 0;
let scanStream: MediaStream | null = null;

interface DetectorLike {
  detect(video: HTMLVideoElement): Promise<Array<{ rawValue?: string }>>;
}

function stopScan(): void {
  scanGen += 1;
  if (scanStream) {
    try {
      scanStream.getTracks().forEach((t) => t.stop());
    } catch {
      /* noop */
    }
    scanStream = null;
  }
  scanVideo.classList.add("hidden");
  (document.getElementById("scanStop") as HTMLElement).classList.add("hidden");
}

async function startScan(): Promise<void> {
  setConnMsg("");
  if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    setConnMsg("A câmera exige HTTPS. Digite o código manualmente.");
    return;
  }
  const Detector = (window as unknown as { BarcodeDetector?: new (opts: { formats: string[] }) => DetectorLike }).BarcodeDetector;
  if (!Detector) {
    setConnMsg("Leitura de QR não suportada neste navegador — digite o código.");
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    setConnMsg("Câmera indisponível — digite o código.");
    return;
  }
  const gen = scanGen + 1;
  scanGen = gen;
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
  } catch {
    if (gen !== scanGen) return;
    setConnMsg("Permissão de câmera negada — permita o acesso ou digite o código.");
    return;
  }
  if (gen !== scanGen) return;
  scanVideo.srcObject = scanStream;
  scanVideo.classList.remove("hidden");
  (document.getElementById("scanStop") as HTMLElement).classList.remove("hidden");
  try {
    await scanVideo.play();
  } catch {
    /* autoplay bloqueado: o usuário toca no vídeo */
  }
  const detector = new Detector({ formats: ["qr_code"] });
  const loop = async (): Promise<void> => {
    if (gen !== scanGen) return;
    try {
      const found = await detector.detect(scanVideo);
      const raw = found?.[0]?.rawValue ?? "";
      const code = raw ? parseQrPayload(raw) : null;
      if (code) {
        stopScan();
        await doPair(code);
        return;
      }
    } catch {
      /* frame ilegível: tenta o próximo */
    }
    window.setTimeout(() => void loop(), 400);
  };
  void loop();
}

(document.getElementById("scanStart") as HTMLElement).addEventListener("click", () => void startScan());
(document.getElementById("scanStop") as HTMLElement).addEventListener("click", stopScan);

// ---- Encerrar conexão: só ESTA sessão; o PC continua ligado ----

(document.getElementById("connEnd") as HTMLElement).addEventListener("click", () => {
  if (!getPairBinding() && !getCredential()) {
    setConnMsg("Nenhuma conexão ativa.");
    return;
  }
  if (!confirm("Encerrar a conexão com o SmarTV?\n\nO PC continua ligado; outros celulares não são afetados.")) {
    return;
  }
  // Avisa o backend para invalidar este vínculo (fire-and-forget)...
  conn?.sendRaw({ type: "unpair" });
  // ...e derruba na hora do lado do celular: sem espera de rede.
  conn?.dispose();
  conn = null;
  localStorage.removeItem(PAIR_KEY);
  pairingBusy = false;
  paint("yellow", "DESCONECTADO", "Conexão encerrada — pareie de novo em 🔗 Conexão");
  paintConnPill("DESCONECTADO");
  setConnMsg("Conexão encerrada. Para controlar de novo, pareie com outro código.");
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
// no readyState do socket antigo. Sem credencial, não há o que reconectar.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (conn && getCredential()) conn.reconnect();
    else if (getCredential()) startConnection();
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
