// Remote-control (agent) configuration for the installed desktop app.
//
// The shipped Electron app must connect to the Render relay BY ITSELF as
// `role: "agent"` — otherwise /controle always reports "PC offline" unless
// the user also runs the separate Node.js agent. A single agent process may
// hold the room: if the standalone agent (apps/agent) runs with the same
// AGENT_TOKEN, the server kicks the older one (4400) and both flap.
//
// Priority (first non-empty wins):
//   CLI  --smartv-backend=<wss://host/ws>  --smartv-agent-token=<token>
//        --smartv-remote-off  (forces the embedded agent off, e.g. Edge mode)
//   env  SMARTV_BACKEND_URL / BACKEND_URL, SMARTV_AGENT_TOKEN / AGENT_TOKEN
//   file %AppData%/SmartTV/smartv-remote.json  { backendUrl, agentToken }
//        (written by the in-app ⚙ Controle panel; never logged with the token)
//
// This module is pure (no Electron import) so it is unit-tested.

export interface StoredRemoteConfig {
  backendUrl?: string;
  agentToken?: string;
}

export interface ResolvedRemoteConfig {
  enabled: boolean;
  backendUrl: string;
  agentToken: string;
  source: "cli" | "env" | "file" | "none";
  disabledByFlag: boolean;
}

export function parseRemoteArgs(argv: string[]): {
  backend?: string;
  token?: string;
  disabled: boolean;
} {
  let backend: string | undefined;
  let token: string | undefined;
  let disabled = false;
  for (const a of argv) {
    if (a === "--smartv-remote-off") disabled = true;
    else if (a.startsWith("--smartv-backend=")) backend = a.slice("--smartv-backend=".length);
    else if (a.startsWith("--smartv-agent-token=")) token = a.slice("--smartv-agent-token=".length);
  }
  return { backend, token, disabled };
}

export function normalizeRemoteUrl(raw: string | undefined): string {
  const s0 = (raw ?? "").trim();
  if (!s0) return "";
  let s = s0;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) s = `wss://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return "";
  }
  if (u.protocol === "https:") u.protocol = "wss:";
  else if (u.protocol === "http:") u.protocol = "ws:";
  else if (u.protocol !== "wss:" && u.protocol !== "ws:") return "";
  if (u.pathname === "" || u.pathname === "/") u.pathname = "/ws";
  return u.toString();
}

export function maskToken(token: string): string {
  if (!token) return "(não definido)";
  if (token.length <= 8) return "***";
  return `${token.slice(0, 3)}***${token.slice(-2)}`;
}

export function resolveRemoteConfig(
  argv: string[],
  env: Record<string, string | undefined>,
  stored: StoredRemoteConfig,
): ResolvedRemoteConfig {
  const args = parseRemoteArgs(argv);
  if (args.disabled) {
    return { enabled: false, backendUrl: "", agentToken: "", source: "none", disabledByFlag: true };
  }
  const cliBackend = normalizeRemoteUrl(args.backend);
  const cliToken = (args.token ?? "").trim();
  if (cliBackend || cliToken) {
    return {
      enabled: Boolean(cliBackend && cliToken),
      backendUrl: cliBackend,
      agentToken: cliToken,
      source: "cli",
      disabledByFlag: false,
    };
  }
  const envBackend = normalizeRemoteUrl(env.SMARTV_BACKEND_URL ?? env.BACKEND_URL);
  const envToken = (env.SMARTV_AGENT_TOKEN ?? env.AGENT_TOKEN ?? "").trim();
  if (envBackend || envToken) {
    return {
      enabled: Boolean(envBackend && envToken),
      backendUrl: envBackend,
      agentToken: envToken,
      source: "env",
      disabledByFlag: false,
    };
  }
  const fileBackend = normalizeRemoteUrl(stored.backendUrl);
  const fileToken = (stored.agentToken ?? "").trim();
  return {
    enabled: Boolean(fileBackend && fileToken),
    backendUrl: fileBackend,
    agentToken: fileToken,
    source: fileBackend || fileToken ? "file" : "none",
    disabledByFlag: false,
  };
}
