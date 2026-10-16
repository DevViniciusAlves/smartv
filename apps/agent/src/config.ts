export interface AgentConfig {
  backendUrl: string;
  agentToken: string;
  browserPath: string;
  browserProfileDir: string;
  launcherUrl: string;
  tvWindowX: number;
  tvWindowY: number;
  backBehavior: "alt-left" | "esc";
  tvMode: "kiosk" | "app";
  cdpPort: number;
  // Navigation target: the Edge window (default) or the Electron desktop app.
  // A single agent process drives exactly one target; never both.
  tvTarget: "edge" | "electron";
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const backendUrl = env.BACKEND_URL ?? "";
  const agentToken = env.AGENT_TOKEN ?? "";
  if (!backendUrl) throw new Error("BACKEND_URL não definido");
  if (!agentToken) throw new Error("AGENT_TOKEN não definido");
  const back = env.BACK_BEHAVIOR === "esc" ? "esc" : "alt-left";
  const tvMode = env.TV_MODE === "app" ? "app" : "kiosk";
  const tvTarget = env.TV_TARGET === "electron" ? "electron" : "edge";
  const cdpPort = num(env.CDP_PORT, 9222);
  if (!Number.isInteger(cdpPort) || cdpPort < 1024 || cdpPort > 65535) {
    throw new Error("CDP_PORT must be an integer between 1024 and 65535");
  }
  return {
    backendUrl,
    agentToken,
    browserPath:
      env.BROWSER_PATH ??
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    browserProfileDir: env.BROWSER_PROFILE_DIR ?? "",
    launcherUrl: env.LAUNCHER_URL ?? "",
    tvWindowX: num(env.TV_WINDOW_X, 0),
    tvWindowY: num(env.TV_WINDOW_Y, 0),
    backBehavior: back,
    tvMode,
    tvTarget,
    cdpPort,
  };
}
