import { describe, expect, it, vi } from "vitest";
import { BraveManager, braveUserDataDir, defaultPreloadPath } from "./brave-manager.js";
import { CdpConnection, type WebSocketLike } from "./cdp-client.js";

type SentRequest = { id?: number; method?: string; params?: unknown; sessionId?: string };

/** CDP double: answers every request as soon as it is written. */
function fakeCdp() {
  const sent: SentRequest[] = [];
  const answers: Record<string, Record<string, unknown>> = {
    "Browser.getWindowForTarget": { windowId: 7 },
    "Page.getNavigationHistory": { currentIndex: 1, entries: [{ id: 10 }, { id: 11 }] },
  };
  const handlers: Record<string, (...args: never[]) => void> = {};
  const ws: WebSocketLike = {
    send: (d: string) => {
      const msg = JSON.parse(d) as SentRequest;
      sent.push(msg);
      if (typeof msg.id === "number") {
        // Synchronous reply: pending entry is registered before send().
        handlers.message?.(
          JSON.stringify({ id: msg.id, result: answers[msg.method ?? ""] ?? {} }) as never,
        );
      }
    },
    close: () => undefined,
    on: (ev: string, cb: (...args: never[]) => void) => void (handlers[ev] = cb),
  };
  const conn = new CdpConnection(ws);
  return { conn, sent };
}

function fakeChild() {
  const listeners: Record<string, (...a: never[]) => void> = {};
  const state = { killed: false };
  const child = {
    listeners,
    kill() {
      state.killed = true;
      return true;
    },
    on(ev: string, cb: (...a: never[]) => void) {
      listeners[ev] = cb;
    },
  };
  return { child, state };
}

function makeManager(overrides: Partial<ConstructorParameters<typeof BraveManager>[0]> = {}) {
  const spawns: Array<{ cmd: string; args: string[] }> = [];
  const { child, state } = fakeChild();
  const cdp = fakeCdp();
  const logs: string[] = [];
  const reads = vi.fn(() => "exports.pickNext = () => 0;");
  const manager = new BraveManager({
    platform: "win32",
    env: {},
    exists: (p) => p.includes("Program Files"),
    readFile: reads,
    spawn: (cmd, args) => {
      spawns.push({ cmd, args });
      return child;
    },
    connect: async () => ({ conn: cdp.conn, sessionId: "sess-abc", targetId: "t-1" }),
    log: (l) => void logs.push(l),
    userDataDir: "C:\\ud",
    preloadPath: "C:\\dist\\service-preload.cjs",
    debugPort: 9333,
    ...overrides,
  });
  return { manager, spawns, child, state, cdp, logs, reads };
}

describe("paths", () => {
  it("keeps the Brave profile and the nav preload under the app dirs", () => {
    expect(braveUserDataDir("C:\\ud")).toContain("brave");
    expect(defaultPreloadPath("C:\\dist")).toContain("service-preload.cjs");
  });
});

describe("BraveManager", () => {
  it("reports disabled when Brave is not installed", async () => {
    const { manager, spawns } = makeManager({ exists: () => false });
    expect(manager.resolveExecutable()).toBeNull();
    await expect(manager.ensureRunning("https://netflix.com")).resolves.toBe(false);
    expect(spawns.length).toBe(0);
    expect(manager.isRunning()).toBe(false);
  });

  it("spawns once, attaches over CDP and injects the TV navigation", async () => {
    const { manager, spawns, logs, reads } = makeManager();
    await expect(manager.ensureRunning("https://netflix.com")).resolves.toBe(true);
    expect(spawns.length).toBe(1);
    expect(spawns[0].args).toContain("--app=https://netflix.com");
    expect(spawns[0].args.some((a) => a.startsWith("--user-data-dir="))).toBe(true);
    expect(manager.isRunning()).toBe(true);
    expect(manager.isShowing()).toBe(true);
    expect(reads).toHaveBeenCalledWith("C:\\dist\\service-preload.cjs");
    expect(logs.some((l) => l.includes("TV navigation injected"))).toBe(true);
  });

  it("reuses the running window: navigate + show, no second spawn", async () => {
    const { manager, spawns, cdp } = makeManager();
    await manager.ensureRunning("https://netflix.com");
    await manager.ensureRunning("https://max.com");
    expect(spawns.length).toBe(1);
    expect(cdp.sent.some((r) => r.method === "Page.navigate")).toBe(true);
    expect(spawns.length).toBe(1);
  });

  it("hides (minimizes) for Home and restores fullscreen on show", async () => {
    const { manager, cdp } = makeManager();
    await manager.ensureRunning("https://netflix.com");
    await manager.hide();
    expect(manager.isShowing()).toBe(false);
    const bounds = cdp.sent.filter((r) => r.method === "Browser.setWindowBounds");
    expect(bounds.length).toBeGreaterThanOrEqual(1);
    expect((bounds[0].params as { bounds: { windowState: string } }).bounds.windowState).toBe(
      "minimized",
    );
    await manager.show();
    expect(manager.isShowing()).toBe(true);
  });

  it("goBack walks one history entry", async () => {
    const { manager, cdp } = makeManager();
    await manager.ensureRunning("https://netflix.com");
    await expect(manager.goBack()).resolves.toBe(true);
    const nav = cdp.sent.find((r) => r.method === "Page.navigateToHistoryEntry");
    expect((nav?.params as { entryId: number }).entryId).toBe(10);
  });

  it("goBack returns false when there is nothing behind", async () => {
    const { manager } = makeManager({
      connect: async () => {
        const sent: SentRequest[] = [];
        const handlers: Record<string, (...args: never[]) => void> = {};
        const ws: WebSocketLike = {
          send: (d: string) => {
            const msg = JSON.parse(d) as SentRequest;
            sent.push(msg);
            const result =
              msg.method === "Page.getNavigationHistory"
                ? { currentIndex: 0, entries: [{ id: 1 }] }
                : {};
            handlers.message?.(JSON.stringify({ id: msg.id, result }) as never);
          },
          close: () => undefined,
          on: (ev: string, cb: (...args: never[]) => void) => void (handlers[ev] = cb),
        };
        return { conn: new CdpConnection(ws), sessionId: "s", targetId: "t" };
      },
    });
    await manager.ensureRunning("https://netflix.com");
    await expect(manager.goBack()).resolves.toBe(false);
  });

  it("dispatches the phone keys through CDP", async () => {
    const { manager, cdp } = makeManager();
    await manager.ensureRunning("https://netflix.com");
    await manager.dispatchKeys([
      { type: "keyDown", keyCode: "Up" },
      { type: "keyUp", keyCode: "Up" },
    ]);
    const keys = cdp.sent.filter((r) => r.method === "Input.dispatchKeyEvent");
    expect(keys.length).toBe(2);
    expect(keys[0].params).toMatchObject({ key: "ArrowUp", windowsVirtualKeyCode: 38 });
    expect(keys[0].sessionId).toBe("sess-abc");
  });

  it("runs media play/pause in the page", async () => {
    const { manager, cdp } = makeManager();
    await manager.ensureRunning("https://netflix.com");
    await manager.playPause("pause");
    const evals = cdp.sent.filter((r) => r.method === "Runtime.evaluate");
    expect(evals.length).toBe(1);
    expect(String((evals[0].params as { expression: string }).expression)).toContain("v.pause()");
  });

  it("clears everything when the Brave process exits", async () => {
    const { manager, child } = makeManager();
    await manager.ensureRunning("https://netflix.com");
    expect(manager.isRunning()).toBe(true);
    child.listeners.exit?.(null as never);
    expect(manager.isRunning()).toBe(false);
    expect(manager.isShowing()).toBe(false);
  });

  it("stop() closes the window and forgets the session", async () => {
    const { manager, cdp } = makeManager();
    await manager.ensureRunning("https://netflix.com");
    manager.stop();
    expect(manager.isRunning()).toBe(false);
    expect(cdp.sent.some((r) => r.method === "Browser.close")).toBe(true);
  });

  it("does nothing for keys/navigate/back when not running", async () => {
    const { manager, cdp } = makeManager();
    await manager.dispatchKeys([{ type: "keyDown", keyCode: "Up" }]);
    await manager.navigate("https://x");
    expect(await manager.goBack()).toBe(false);
    expect(cdp.sent.length).toBe(0);
  });
});
