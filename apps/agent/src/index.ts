import "dotenv/config";
import WebSocket from "ws";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { controllerMessageSchema } from "@smartv/shared";
import { loadConfig } from "./config.js";
import { createAutomation } from "./automation.js";
import { TvBrowser } from "./browser.js";
import { handleCommand } from "./commands.js";

function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    const dir = join(homedir(), ".smartv");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "agent.log"), line);
  } catch {
    /* noop */
  }
  console.log(line.trim());
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { auto, backend } = await createAutomation();
  log(`automation backend: ${backend}`);
  const tv = new TvBrowser(config, auto, log);
  // Boot straight into the single TV window (kiosk/app, dedicated profile).
  try {
    await tv.ensureRunning();
  } catch (err) {
    log(`browser ensure failed: ${(err as Error).message}`);
  }

  let attempt = 0;
  let ws: WebSocket | null = null;

  const connect = (): void => {
    attempt += 1;
    log(`connecting (attempt ${attempt}) to ${config.backendUrl}`);
    ws = new WebSocket(config.backendUrl);

    ws.on("open", () => {
      attempt = 0;
      ws?.send(JSON.stringify({ type: "hello", role: "agent", token: config.agentToken, v: 1 }));
      log("connected as agent");
    });

    ws.on("message", (data: Buffer) => {
      void (async () => {
        let msg: unknown;
        try {
          msg = JSON.parse(data.toString("utf8"));
        } catch {
          return;
        }
        const parsed = controllerMessageSchema.safeParse(msg);
        if (!parsed.success) return; // never executes outside the whitelist
        if (parsed.data.type === "ping") {
          ws?.send(JSON.stringify({ type: "pong" }));
          return;
        }
        try {
          await handleCommand(auto, config, tv, parsed.data);
        } catch (err) {
          // Per-command failure is logged (no typed text, no tokens) and the
          // process keeps running.
          log(`command failed: ${(err as Error).message}`);
        }
      })();
    });

    ws.on("close", () => {
      log("disconnected, retrying with backoff");
      scheduleReconnect();
    });
    ws.on("error", (err) => {
      log(`ws error: ${(err as Error).message}`);
    });
  };

  const scheduleReconnect = (): void => {
    const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
    setTimeout(connect, delay).unref?.();
  };

  // Periodic ping: keeps the free Render service awake and detects drops.
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, 30000).unref?.();

  connect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
