// Type-only reference to window.smartv (no runtime import: the bridge is
// injected by the preload script, so an `import` would break the bundle).
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./smartv.d.ts" />

import QRCode from "qrcode";

export {};

type Link = "DESCONECTADO" | "CONECTANDO" | "CONECTADO";

function bridge(): Window["smartv"] | null {
  return typeof window.smartv === "object" && window.smartv !== null ? window.smartv : null;
}

function paintPill(el: HTMLElement, link: Link): void {
  el.textContent = link;
  el.className = `pill ${link === "CONECTADO" ? "on" : link === "CONECTANDO" ? "mid" : "off"}`;
}

function setLink(link: Link): void {
  const bar = document.getElementById("linkPill");
  if (bar) paintPill(bar, link);
  const modal = document.getElementById("connPill");
  if (modal) paintPill(modal, link);
}

(document.getElementById("home") as HTMLElement).addEventListener("click", () => {
  void bridge()?.goHome();
});

bridge()?.onStatus((text: string) => {
  const st = document.getElementById("status");
  if (st) st.textContent = text;
});

bridge()?.onRemoteStatus((text: string) => {
  const st = document.getElementById("remoteState");
  if (st) st.textContent = text;
});

// ---- Conexão modal: pairing code + QR + countdown + auto-refresh ----
// One generation per modal session: a single 1s ticker drives BOTH the
// countdown display and the 30s refresh, so duplicate timers and races are
// impossible. Closing the modal stops everything; the server link stays up.

const PAIR_REFRESH_MS = 30 * 1000;

let modalGen = 0;
let ticker: number | null = null;
let expiresAt = 0;
let lastRefreshAt = 0;
let linkedPhones = 0;

function fmtLeft(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function stopTicker(): void {
  modalGen += 1;
  if (ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
}

function paintPhones(): void {
  const el = document.getElementById("pairPhones");
  if (el) {
    el.textContent =
      linkedPhones > 0
        ? `${linkedPhones} celular${linkedPhones > 1 ? "es" : ""} vinculado${linkedPhones > 1 ? "s" : ""}`
        : "Nenhum celular vinculado ainda";
  }
}

async function paintQr(code: string): Promise<void> {
  const img = document.getElementById("pairQr") as HTMLImageElement;
  try {
    // QR carries ONLY the short-lived code (+format version): enough for the
    // phone (already on /controle) to start pairing. No permanent tokens.
    img.src = await QRCode.toDataURL(JSON.stringify({ v: 1, code }), {
      width: 220,
      margin: 1,
    });
  } catch {
    img.removeAttribute("src");
  }
}

function showCode(code: string, exp: number): void {
  const el = document.getElementById("pairCode");
  if (el) el.textContent = code.replace(/(\d{3})(\d{3})/, "$1 $2");
  expiresAt = exp;
  void paintQr(code);
  const count = document.getElementById("pairCount");
  if (count) count.textContent = `Expira em ${fmtLeft(exp - Date.now())}`;
}

function tick(gen: number): void {
  if (gen !== modalGen) return;
  const left = expiresAt - Date.now();
  const count = document.getElementById("pairCount");
  const now = Date.now();
  if (left <= 0) {
    // Expired while open: fetch a fresh one (throttled to one attempt/5s).
    if (count) count.textContent = "Código expirado — gerando novo…";
    if (now - lastRefreshAt > 5000) {
      lastRefreshAt = now;
      void bridge()?.requestPairCode();
    }
    return;
  }
  if (count) count.textContent = `Expira em ${fmtLeft(left)}`;
  if (now - lastRefreshAt >= PAIR_REFRESH_MS) {
    lastRefreshAt = now;
    void bridge()?.requestPairCode();
  }
}

async function openModal(): Promise<void> {
  const modal = document.getElementById("connModal") as HTMLElement;
  modal.classList.remove("hidden");
  stopTicker();
  const gen = modalGen + 1;
  modalGen = gen;
  lastRefreshAt = Date.now();
  const api = bridge();
  if (api) {
    try {
      const info = await api.getRemote();
      setLink(info.link);
      linkedPhones = info.linkedPhones;
      paintPhones();
      const st = document.getElementById("remoteState");
      if (st) st.textContent = info.status;
      const backend = document.getElementById("remoteBackend") as HTMLInputElement;
      if (backend && !backend.value && info.backendUrl) backend.value = info.backendUrl;
      if (!info.enabled && st) {
        st.textContent = `${info.status} — configure o servidor abaixo uma vez.`;
      }
    } catch {
      /* panel still usable */
    }
    void api.requestPairCode();
  }
  ticker = window.setInterval(() => tick(gen), 1000);
}

function closeModal(): void {
  stopTicker();
  (document.getElementById("connModal") as HTMLElement).classList.add("hidden");
}

bridge()?.onPairCode((info) => {
  // Late arrivals from a previous session are ignored (generation guard in
  // tick; here we only paint when the modal is open).
  const modal = document.getElementById("connModal") as HTMLElement;
  if (modal.classList.contains("hidden")) return;
  lastRefreshAt = Date.now();
  showCode(info.code, info.expiresAt);
});

bridge()?.onRemoteLink((info) => {
  setLink(info.link);
  linkedPhones = info.linkedPhones;
  paintPhones();
  const sub = document.getElementById("connSub");
  if (sub) {
    sub.textContent =
      info.link === "CONECTADO"
        ? "PC disponível para receber comandos."
        : info.link === "CONECTANDO"
          ? "Conectando ao servidor…"
          : "Sem conexão — confira o servidor na configuração avançada.";
  }
});

(document.getElementById("connOpen") as HTMLElement).addEventListener("click", () => {
  const modal = document.getElementById("connModal") as HTMLElement;
  if (modal.classList.contains("hidden")) void openModal();
  else closeModal();
});
(document.getElementById("connClose") as HTMLElement).addEventListener("click", closeModal);
(document.getElementById("pairNew") as HTMLElement).addEventListener("click", () => {
  lastRefreshAt = Date.now();
  void bridge()?.requestPairCode();
});
(document.getElementById("remoteSave") as HTMLElement).addEventListener("click", () => {
  const api = bridge();
  if (!api) return;
  const backend = (document.getElementById("remoteBackend") as HTMLInputElement).value.trim();
  const token = (document.getElementById("remoteToken") as HTMLInputElement).value.trim();
  const state = document.getElementById("remoteState");
  if (state) state.textContent = "Salvando…";
  void api.setRemote({ backendUrl: backend, agentToken: token }).then((res) => {
    if (!res.ok) {
      if (state) state.textContent = res.error ?? "Falha ao salvar.";
      return;
    }
    (document.getElementById("remoteToken") as HTMLInputElement).value = "";
    lastRefreshAt = Date.now();
    void api.requestPairCode();
  });
});

// ---- Sair do SmarTV: confirm, graceful link close, full quit ----
// Closing the Conexão modal never quits; only this button does.
(document.getElementById("appQuit") as HTMLElement).addEventListener("click", () => {
  if (confirm("Sair do SmarTV?\n\nO celular será avisado que o PC ficou offline.")) {
    void bridge()?.quit();
  }
});

void (async () => {
  try {
    const info = await bridge()?.getRemote();
    if (info) {
      setLink(info.link);
      linkedPhones = info.linkedPhones;
    }
  } catch {
    /* bar stays usable */
  }
})();
