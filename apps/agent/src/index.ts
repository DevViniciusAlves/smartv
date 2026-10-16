import "dotenv/config";
import WebSocket from "ws";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { controllerMessageSchema } from "@smartv/shared";
import { loadConfig } from "./config.js";
import { createAutomation } from "./automation.js";
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
  // Abre o launcher no boot para virar "smart TV" sozinho.
  if (config.launcherUrl && config.browserProfileDir) {
    const { openInBrowser } = await import("./automation.js");
    try {
      openInBrowser(
        config.browserPath,
        config.browserProfileDir,
        config.launcherUrl,
        config.tvWindowX,
        config.tvWindowY,
      );
    } catch (err) {
      log(`launcher open failed: ${(err as Error).message}`);
    }
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

    ws.on("message", async (data: Buffer) => {
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }
      const parsed = controllerMessageSchema.safeParse(msg);
      if (!parsed.success) return; // nunca executa fora da whitelist
      if (parsed.data.type === "ping") {
        ws?.send(JSON.stringify({ type: "pong" }));
        return;
      }
      try {
        await handleCommand(auto, config, parsed.data);
      } catch (err) {
        log(`command failed: ${(err as Error).message}`);
        // Informa o controle sem derrubar o processo.
        void dirname;
      }
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

  // Ping periódico: mantém o Render gratuito acordado e detecta queda.
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
