import { describe, expect, it, vi } from "vitest";
import { initAutoUpdate, statusFor, statusForError, type UpdaterLike } from "./updater.js";

function fakeUpdater(): UpdaterLike & { handlers: Map<string, () => void>; checks: number } {
  const handlers = new Map<string, () => void>();
  const fake: UpdaterLike & { handlers: Map<string, () => void>; checks: number } = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    handlers,
    checks: 0,
    on: (ev, cb) => {
      handlers.set(ev, cb as () => void);
    },
    checkForUpdates: async () => {
      fake.checks += 1;
    },
  };
  return fake;
}

describe("update statuses", () => {
  it("maps every event to a PT-BR line", () => {
    expect(statusFor("checking-for-update")).toBe("Verificando atualização…");
    expect(statusFor("update-available")).toContain("baixando");
    expect(statusFor("update-downloaded")).toContain("reinicie");
    expect(statusFor("error")).toContain("Falha");
    expect(statusFor("update-not-available")).toBe("");
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

describe("initAutoUpdate", () => {
  it("enables background download + install on quit, checks once deferred", async () => {
    vi.useFakeTimers();
    try {
      const updater = fakeUpdater();
      const seen: string[] = [];
      initAutoUpdate(updater, { onStatus: (t) => seen.push(t), deferMs: 1000, checkIntervalMs: 0 });
      expect(updater.autoDownload).toBe(true);
      expect(updater.autoInstallOnAppQuit).toBe(true);
      expect(updater.checks).toBe(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(updater.checks).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("forwards updater events to status and survives check failures", async () => {
    vi.useFakeTimers();
    try {
      const updater = fakeUpdater();
      updater.checkForUpdates = async () => {
        throw new Error("boom");
      };
      const seen: string[] = [];
      initAutoUpdate(updater, { onStatus: (t) => seen.push(t), deferMs: 10, checkIntervalMs: 0 });
      await vi.advanceTimersByTimeAsync(10);
      expect(seen).toContain("Falha ao verificar atualização");
      updater.handlers.get("update-downloaded")?.();
      expect(seen).toContain("Atualização pronta — reinicie o app para instalar");
    } finally {
      vi.useRealTimers();
    }
  });
  it("stop() cancels pending and periodic checks", async () => {
    vi.useFakeTimers();
    try {
      const updater = fakeUpdater();
      const stop = initAutoUpdate(updater, { onStatus: () => undefined, deferMs: 50, checkIntervalMs: 50 });
      stop();
      await vi.advanceTimersByTimeAsync(1000);
      expect(updater.checks).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
