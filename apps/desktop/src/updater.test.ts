import { describe, expect, it } from "vitest";
import {
  initManualUpdate,
  statusFor,
  statusForError,
  type UpdateEvent,
  type UpdaterLike,
} from "./updater.js";

function fakeUpdater(): {
  updater: UpdaterLike;
  handlers: Map<UpdateEvent, (...args: unknown[]) => void>;
} {
  const handlers = new Map<UpdateEvent, (...args: unknown[]) => void>();
  const updater: UpdaterLike = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on: (ev, cb) => {
      handlers.set(ev, cb);
    },
    checkForUpdates: async () => undefined,
    downloadUpdate: async () => undefined,
    quitAndInstall: () => undefined,
  };
  return { updater, handlers };
}

describe("update statuses", () => {
  it("maps every event to a PT-BR line (manual policy)", () => {
    expect(statusFor("checking-for-update")).toBe("Verificando atualização…");
    expect(statusFor("update-available")).toBe("Atualização disponível.");
    expect(statusFor("download-progress")).toBe("Baixando atualização…");
    expect(statusFor("update-downloaded")).toBe("Atualização pronta.");
    expect(statusFor("update-not-available")).toBe("App atualizado.");
    expect(statusFor("error")).toBe("Falha ao verificar atualização");
  });
});

describe("statusForError", () => {
  it("names private repo / missing release on 404", () => {
    expect(statusForError(new Error("HttpError: 404 Not Found"))).toContain("repositório privado");
    expect(statusForError(new Error("No published versions on GitHub"))).toContain("repositório privado");
  });
  it("names offline network failures", () => {
    expect(statusForError(new Error("getaddrinfo ENOTFOUND api.github.com"))).toContain("Sem internet");
  });
  it("falls back to the generic message", () => {
    expect(statusForError(new Error("weird"))).toBe("Falha ao verificar atualização");
    expect(statusForError("plain string")).toBe("Falha ao verificar atualização");
  });
});

describe("initManualUpdate", () => {
  it("disables automatic download and install-on-quit", () => {
    const { updater } = fakeUpdater();
    initManualUpdate(updater, { onStatus: () => undefined, onEvent: () => undefined });
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
  });

  it("forwards every event to onEvent and onStatus", () => {
    const { updater, handlers } = fakeUpdater();
    const events: UpdateEvent[] = [];
    const statuses: string[] = [];
    initManualUpdate(updater, {
      onEvent: (e) => events.push(e),
      onStatus: (t) => statuses.push(t),
    });
    handlers.get("checking-for-update")?.();
    handlers.get("update-available")?.();
    handlers.get("update-downloaded")?.();
    expect(events).toEqual(["checking-for-update", "update-available", "update-downloaded"]);
    expect(statuses).toEqual([
      "Verificando atualização…",
      "Atualização disponível.",
      "Atualização pronta.",
    ]);
  });

  it("reports check failures through statusForError", () => {
    const { updater, handlers } = fakeUpdater();
    const statuses: string[] = [];
    initManualUpdate(updater, {
      onEvent: () => undefined,
      onStatus: (t) => statuses.push(t),
    });
    handlers.get("error")?.(new Error("HttpError: 404 Not Found"));
    expect(statuses).toContain("Falha: release não encontrado (repositório privado?)");
  });
});
