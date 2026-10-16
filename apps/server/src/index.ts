import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { attachRelay, createRoomState } from "./relay.js";
import { createApp } from "./app.js";
import { attachUpgradeHandler } from "./upgrade.js";
import { parseAllowedOrigins } from "./origins.js";
import { createLogger, levelFromEnv } from "./logger.js";

const log = createLogger(levelFromEnv(process.env.LOG_LEVEL));

process.on("uncaughtException", (err) => {
  log.error("uncaught_exception", { error: String(err?.message ?? err).slice(0, 200) });
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log.error("unhandled_rejection", { error: String(reason).slice(0, 200) });
  process.exit(1);
});

const PORT = Number(process.env.PORT ?? "3001");
const NODE_ENV = process.env.NODE_ENV ?? "development";
const ROOM_TOKEN = process.env.ROOM_TOKEN ?? "";
const AGENT_TOKEN = process.env.AGENT_TOKEN ?? "";
const { allowed: ALLOWED_ORIGINS, invalid: INVALID_ORIGINS } = parseAllowedOrigins(
  process.env.ALLOWED_ORIGINS,
);

if (!ROOM_TOKEN || !AGENT_TOKEN) {
  log.error("fatal", { reason: "ROOM_TOKEN and AGENT_TOKEN must be set" });
  process.exit(1);
}
if (ROOM_TOKEN === AGENT_TOKEN) {
  log.error("fatal", { reason: "ROOM_TOKEN and AGENT_TOKEN must differ" });
  process.exit(1);
}
if (ALLOWED_ORIGINS.length === 0 && NODE_ENV === "production") {
  log.error("fatal", { reason: "ALLOWED_ORIGINS is empty in production" });
  process.exit(1);
}
for (const bad of INVALID_ORIGINS) {
  log.warn("invalid_origin_ignored", { value: bad.slice(0, 120) });
}

const room = createRoomState();
const app = createApp(room, ALLOWED_ORIGINS);
const http = createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
attachUpgradeHandler(http, wss, log);

attachRelay(
  wss,
  { roomToken: ROOM_TOKEN, agentToken: AGENT_TOKEN, allowedOrigins: ALLOWED_ORIGINS },
  room,
  log,
);

http.listen(PORT, () => {
  log.info("boot", {
    port: PORT,
    node_env: NODE_ENV,
    allowed_origins: ALLOWED_ORIGINS.join(",") || "-",
    room_token_set: ROOM_TOKEN !== "",
    agent_token_set: AGENT_TOKEN !== "",
  });
});
