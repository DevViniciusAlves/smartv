// Type-only reference to window.smartv (no runtime import: the bridge is
// injected by the preload script, so an `import` would break the bundle).
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./smartv.d.ts" />

export {};

function bridge(): Window["smartv"] | null {
  return typeof window.smartv === "object" && window.smartv !== null ? window.smartv : null;
}

(document.getElementById("home") as HTMLElement).addEventListener("click", () => {
  void bridge()?.goHome();
});

bridge()?.onStatus((text: string) => {
  const st = document.getElementById("status");
  if (st) st.textContent = text;
});

// Embedded-agent status + one-time setup (server URL + AGENT_TOKEN).
// The token is never echoed back: the main process only reports a mask.
function paintRemote(text: string): void {
  const pill = document.getElementById("remoteStatus");
  if (pill) pill.textContent = text;
  const state = document.getElementById("remoteState");
  if (state) state.textContent = text;
}

bridge()?.onRemoteStatus(paintRemote);

async function refreshRemote(): Promise<void> {
  const api = bridge();
  if (!api) return;
  try {
    const info = await api.getRemote();
    paintRemote(info.status);
    const backend = document.getElementById("remoteBackend") as HTMLInputElement;
    if (backend && !backend.value && info.backendUrl) backend.value = info.backendUrl;
    const state = document.getElementById("remoteState");
    if (state && !info.enabled) {
      state.textContent = `${info.status} — salve servidor + token abaixo (use o AGENT_TOKEN do Render).`;
    }
  } catch {
    paintRemote("Controle: indisponível");
  }
}

(document.getElementById("remoteGear") as HTMLElement).addEventListener("click", () => {
  (document.getElementById("remotePanel") as HTMLElement).classList.toggle("hidden");
  void refreshRemote();
});
(document.getElementById("remoteClose") as HTMLElement).addEventListener("click", () => {
  (document.getElementById("remotePanel") as HTMLElement).classList.add("hidden");
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
    void refreshRemote();
  });
});

void refreshRemote();
