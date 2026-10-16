// Automatic updates via electron-updater + GitHub Releases.
//
// Policy: download in background, install on quit/restart. Never loops,
// never restarts the app by itself, never breaks offline use: every failure
// surfaces as a status line and the current version keeps running.
// Only GitHub Releases of this repo are ever consulted (publish config in
// electron-builder.yml); arbitrary URLs/installers are never executed.
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
  on(event: UpdateEvent, cb: (...args: never[]) => void): void;
  checkForUpdates(): Promise<unknown>;
}

export interface UpdateOptions {
  onStatus(text: string): void;
  // Delay before the first check so boot stays fast.
  deferMs?: number;
  // Interval between background checks. 0 disables repetition.
  checkIntervalMs?: number;
}

const DEFAULT_DEFER_MS = 15000;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function statusFor(event: UpdateEvent): string {
  switch (event) {
    case "checking-for-update":
      return "Verificando atualização…";
    case "update-available":
      return "Atualização disponível, baixando…";
    case "download-progress":
      return "Baixando atualização…";
    case "update-downloaded":
      return "Atualização pronta — reinicie o app para instalar";
    case "update-not-available":
      return "";
    case "error":
      return "Falha ao verificar atualização";
  }
}

export function initAutoUpdate(updater: UpdaterLike, opts: UpdateOptions): () => void {
  const deferMs = opts.deferMs ?? DEFAULT_DEFER_MS;
  const intervalMs = opts.checkIntervalMs ?? DEFAULT_INTERVAL_MS;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;

  let stopped = false;
  const safeCheck = (): void => {
    if (stopped) return;
    updater.checkForUpdates().catch(() => {
      // Offline / GitHub down / dev mode: keep running this version.
      if (!stopped) opts.onStatus(statusFor("error"));
    });
  };

  const events: UpdateEvent[] = [
    "checking-for-update",
    "update-available",
    "update-not-available",
    "download-progress",
    "update-downloaded",
    "error",
  ];
  for (const ev of events) {
    updater.on(ev, () => {
      if (!stopped) opts.onStatus(statusFor(ev));
    });
  }

  const first = setTimeout(safeCheck, deferMs);
  const timer = intervalMs > 0 ? setInterval(safeCheck, intervalMs) : null;
  if (timer) timer.unref?.();

  return () => {
    stopped = true;
    clearTimeout(first);
    if (timer) clearInterval(timer);
  };
}
