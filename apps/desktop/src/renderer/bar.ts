// Type-only reference to window.smartv (no runtime import: the bridge is
// injected by the preload script, so an `import` would break the bundle).
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./smartv.d.ts" />

export {};

type Link = "DESCONECTADO" | "CONECTANDO" | "CONECTADO";

function bridge(): Window["smartv"] | null {
  return typeof window.smartv === "object" && window.smartv !== null ? window.smartv : null;
}

function paintPill(link: Link): void {
  const bar = document.getElementById("linkPill");
  if (bar) {
    bar.textContent = link;
    bar.className = `pill ${link === "CONECTADO" ? "on" : link === "CONECTANDO" ? "mid" : "off"}`;
  }
}

(document.getElementById("home") as HTMLElement).addEventListener("click", () => {
  void bridge()?.goHome();
});

(document.getElementById("back") as HTMLElement).addEventListener("click", () => {
  void bridge()?.goBack();
});

(document.getElementById("connOpen") as HTMLElement).addEventListener("click", () => {
  void bridge()?.openConn();
});

bridge()?.onStatus((text: string) => {
  const st = document.getElementById("status");
  if (st) st.textContent = text;
});

bridge()?.onRemoteLink((info) => {
  paintPill(info.link);
});

// The Back button mirrors what the surface can actually do: enabled only when
// a streaming app is open (Home is already the root). Main drives it.
bridge()?.onCanGoBack((can) => {
  (document.getElementById("back") as HTMLButtonElement).disabled = !can;
});

// ---- Sair do SmarTV: confirm, graceful link close, full quit ----
// Closing the Conexão overlay never quits; only this button does.
(document.getElementById("appQuit") as HTMLElement).addEventListener("click", () => {
  if (confirm("Sair do SmarTV?\n\nO celular será avisado que o PC ficou offline.")) {
    void bridge()?.quit();
  }
});

void (async () => {
  try {
    const info = await bridge()?.getRemote();
    if (info) paintPill(info.link);
  } catch {
    /* bar stays usable */
  }
})();
