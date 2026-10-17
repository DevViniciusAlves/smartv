import { normalizeBackendUrl } from "./connection.js";
import { CLOSE_CODES } from "@smartv/shared";
import { parseBinding } from "./pairing.js";

const RAW: string =
  (import.meta as unknown as { env: Record<string, string> }).env?.VITE_BACKEND_URL ?? "";
const PAIR_KEY = "smartv_pair";
const stepsEl = document.getElementById("steps") as HTMLElement;
const report: string[] = [];

function step(title: string): { ok: (detail: string) => void; fail: (detail: string) => void } {
  const div = document.createElement("div");
  div.className = "panel step";
  const icon = document.createElement("div");
  icon.className = "icon";
  icon.textContent = "⏳";
  const body = document.createElement("div");
  const h = document.createElement("div");
  h.innerHTML = `<b>${title}</b>`;
  const detail = document.createElement("div");
  detail.className = "detail";
  body.appendChild(h);
  body.appendChild(detail);
  div.appendChild(icon);
  div.appendChild(body);
  stepsEl.appendChild(div);
  const done = (mark: string, text: string): void => {
    icon.textContent = mark;
    detail.textContent = text;
    report.push(`${mark} ${title}: ${text}`);
  };
  return { ok: (t) => done("✅", t), fail: (t) => done("❌", t) };
}

function wsToHttp(wsUrl: string): string {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  u.pathname = "/health";
  u.search = "";
  return u.toString();
}

async function run(): Promise<void> {
  stepsEl.innerHTML = "";
  report.length = 0;

  // 1. Configuração.
  const s1 = step("1. Configuração do servidor");
  const norm = normalizeBackendUrl(RAW);
  if (!norm.url) {
    s1.fail("VITE_BACKEND_URL não configurada ou inválida. Configure na Vercel e faça redeploy.");
    return;
  }
  s1.ok(`URL em uso: ${norm.url}` + (norm.notes.length > 0 ? ` (ajustes: ${norm.notes.join(", ")})` : ""));

  // 2. Vínculo de pareamento (única credencial: sessão emitida pelo código).
  const s2 = step("2. Celular pareado");
  const binding = parseBinding(localStorage.getItem(PAIR_KEY));
  if (!binding) {
    s2.fail("Nenhum pareamento salvo. No /controle, abra 🔗 Conexão e digite o código de 6 dígitos do PC.");
    return;
  }
  const token = binding.token;
  s2.ok("Celular pareado com o PC. (O valor nunca é exibido.)");

  // 3. Servidor no ar.
  const s3 = step("3. Servidor no ar (/health)");
  const healthUrl = wsToHttp(norm.url);
  const t0 = Date.now();
  let health: { agentOnline?: boolean } | null = null;
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(70000) });
    health = (await res.json()) as { agentOnline?: boolean };
    s3.ok(`Servidor respondeu em ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
  } catch {
    s3.fail(
      "Sem resposta em 70 s. Provável URL errada ou backend fora do ar no Render. " +
        "Confira VITE_BACKEND_URL e se o serviço está rodando.",
    );
    return;
  }

  // 4. Handshake WebSocket.
  const s4 = step("4. Login no servidor (WebSocket)");
  const hs: { ok: boolean; agentOnline?: boolean; code?: number } = await new Promise((resolve) => {
    let settled = false;
    const done = (v: { ok: boolean; agentOnline?: boolean; code?: number }): void => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    let ws: WebSocket;
    try {
      ws = new WebSocket(norm.url);
    } catch {
      done({ ok: false });
      return;
    }
    const timer = window.setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      done({ ok: false });
    }, 30000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", role: "controller", token, v: 1 }));
    ws.onmessage = (ev: MessageEvent) => {
      try {
        const m = JSON.parse(String(ev.data)) as { type?: string; agentOnline?: boolean };
        if (m.type === "state") {
          window.clearTimeout(timer);
          const online = m.agentOnline === true;
          try {
            ws.close();
          } catch {
            /* noop */
          }
          done({ ok: true, agentOnline: online });
        }
      } catch {
        /* ignore */
      }
    };
    ws.onclose = (ev: CloseEvent) => {
      window.clearTimeout(timer);
      done({ ok: false, code: ev.code });
    };
    ws.onerror = () => {
      // onclose vem em seguida com o código real.
    };
  });
  if (hs.ok) {
    s4.ok("Login aceito pelo servidor.");
  } else if (hs.code === CLOSE_CODES.AUTH_FAILED) {
    s4.fail("Sessão inválida (código 4401). No /controle, abra 🔗 Conexão e pareie de novo com o código do PC.");
    return;
  } else if (hs.code === CLOSE_CODES.ORIGIN_NOT_ALLOWED) {
    s4.fail(
      `Origem não permitida (código 4403). Coloque exatamente isto em ALLOWED_ORIGINS no Render: ${location.origin}`,
    );
    return;
  } else {
    s4.fail(
      "Erro de rede no WebSocket. Provável URL errada (falta /ws?) ou servidor fora do ar.",
    );
    return;
  }

  // 5. PC online?
  const s5 = step("5. PC online?");
  if (hs.agentOnline) s5.ok("PC conectado ao servidor. O controle deve funcionar.");
  else if (health?.agentOnline) s5.ok("PC aparece online no /health. Tente de novo no controle.");
  else
    s5.fail(
      "PC offline: o agente do Windows não está conectado. Ligue o PC, confira o .env (AGENT_TOKEN, BACKEND_URL) e o log em %USERPROFILE%\\.smartv\\agent.log.",
    );
}

(document.getElementById("btnRun") as HTMLElement).addEventListener("click", () => void run());
(document.getElementById("btnCopy") as HTMLElement).addEventListener("click", async () => {
  const text = ["Relatório SmartTV (sem segredos):", ...report].join("\n");
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* clipboard indisponível */
  }
});

void run();
