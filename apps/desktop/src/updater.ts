// Automatic updates via electron-updater + GitHub Releases.
//
// Policy: Check manually, download on demand, install on demand. Never loops,
// never restarts the app by itself, never breaks offline use.
export type UpdateEvent =
  | "checking-for-update"
  | "update-available"
  | "update-not-available"
  | "download-progress"
  | "update-downloaded"
  | "error";

// Minimal surface used from electron-updater (injectable for tests).
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: UpdateEvent, cb: (...args: unknown[]) => void): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface UpdateOptions {
  onStatus(text: string): void;
  onEvent(event: UpdateEvent): void;
}

export function statusFor(event: UpdateEvent): string {
  switch (event) {
    case "checking-for-update":
      return "Verificando atualização…";
    case "update-available":
      return "Atualização disponível.";
    case "download-progress":
      return "Baixando atualização…";
    case "update-downloaded":
      return "Atualização pronta.";
    case "update-not-available":
      return "App atualizado.";
    case "error":
      return "Falha ao verificar atualização";
  }
}

// Tells 404 (private repo / missing release) apart from offline, so the bar
// shows the real cause instead of a generic failure. Never includes tokens.
export function statusForError(err: unknown): string {
  const msg = err instanceof Error ? `${err.message} ${(err as { stack?: string }).stack ?? ""}` : String(err);
  if (/status code 404|404 Not Found|no published versions/i.test(msg)) {
    return "Falha: release não encontrado (repositório privado?)";
  }
  if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|network|offline|ECONNREFUSED|ETIMEDOUT/i.test(msg)) {
    return "Sem internet para verificar atualização";
  }
  return statusFor("error");
}

export function initManualUpdate(updater: UpdaterLike, opts: UpdateOptions): void {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;

  const events: UpdateEvent[] = [
    "checking-for-update",
    "update-available",
    "update-not-available",
    "download-progress",
    "update-downloaded",
    "error",
  ];
  for (const ev of events) {
    updater.on(ev, (...args: unknown[]) => {
      opts.onEvent(ev);
      opts.onStatus(ev === "error" ? statusForError(args[0]) : statusFor(ev));
    });
  }
}
