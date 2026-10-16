// Persistent remote config: %AppData%/SmartTV/smartv-remote.json
// (app.getPath("userData")). Only backend URL + agent token. No logs here
// ever include the token (use maskToken for display).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StoredRemoteConfig } from "./remote-config.js";

const FILE_NAME = "smartv-remote.json";

export function remoteConfigPath(userDataPath: string): string {
  return join(userDataPath, FILE_NAME);
}

export function loadStoredRemoteConfig(userDataPath: string): StoredRemoteConfig {
  try {
    const raw = readFileSync(remoteConfigPath(userDataPath), "utf8");
    const parsed = JSON.parse(raw) as StoredRemoteConfig;
    return {
      backendUrl: typeof parsed.backendUrl === "string" ? parsed.backendUrl : "",
      agentToken: typeof parsed.agentToken === "string" ? parsed.agentToken : "",
    };
  } catch {
    return {};
  }
}

export function saveStoredRemoteConfig(userDataPath: string, cfg: StoredRemoteConfig): void {
  mkdirSync(userDataPath, { recursive: true });
  writeFileSync(
    remoteConfigPath(userDataPath),
    JSON.stringify(
      { backendUrl: cfg.backendUrl ?? "", agentToken: cfg.agentToken ?? "" },
      null,
      2,
    ),
    "utf8",
  );
}
