// Persistent remote config: %AppData%/SmartTV/smartv-remote.json
// (app.getPath("userData")). Only backend URL + agent token. No logs here
// ever include the token (use maskToken for display).
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { StoredRemoteConfig } from "./remote-config.js";

const FILE_NAME = "smartv-remote.json";
const INSTALL_FILE_NAME = "smartv-installation.json";
const DISPLAY_FILE_NAME = "smartv-display.json";

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

/**
 * Stable installation id for this PC (created once, persisted). Sent as
 * `deviceId` in the agent hello so pairing codes bind to THIS installation
 * and a phone can never take over a different PC by guessing a code.
 */
export function getOrCreateInstallationId(userDataPath: string): string {
  const file = join(userDataPath, INSTALL_FILE_NAME);
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as { installationId?: unknown };
    if (typeof parsed.installationId === "string" && parsed.installationId.length >= 8) {
      return parsed.installationId;
    }
  } catch {
    /* missing/corrupt: create fresh below */
  }
  const installationId = randomUUID();
  try {
    mkdirSync(userDataPath, { recursive: true });
    writeFileSync(file, JSON.stringify({ installationId }, null, 2), "utf8");
  } catch {
    /* non-fatal: pairing still works with an ephemeral id for this run */
  }
  return installationId;
}

export function loadStoredDisplayId(userDataPath: string): number | null {
  try {
    const raw = readFileSync(join(userDataPath, DISPLAY_FILE_NAME), "utf8");
    const parsed = JSON.parse(raw) as { displayId?: unknown };
    return typeof parsed.displayId === "number" && Number.isInteger(parsed.displayId)
      ? parsed.displayId
      : null;
  } catch {
    return null;
  }
}

export function saveStoredDisplayId(userDataPath: string, displayId: number): void {
  mkdirSync(userDataPath, { recursive: true });
  writeFileSync(join(userDataPath, DISPLAY_FILE_NAME), JSON.stringify({ displayId }, null, 2), "utf8");
}

export function clearStoredDisplayId(userDataPath: string): void {
  try {
    unlinkSync(join(userDataPath, DISPLAY_FILE_NAME));
  } catch {
    /* already absent */
  }
}
