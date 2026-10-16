import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { attachRelay, parseAllowedOrigins, createRoomState } from "./relay.js";

const PORT = Number(process.env.PORT ?? "3001");
const ROOM_TOKEN = process.env.ROOM_TOKEN ?? "";
const AGENT_TOKEN = process.env.AGENT_TOKEN ?? "";
const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);

if (!ROOM_TOKEN || !AGENT_TOKEN) {
  console.error("FATAL: ROOM_TOKEN e AGENT_TOKEN devem estar definidos.");
  process.exit(1);
}
if (ROOM_TOKEN === AGENT_TOKEN) {
  console.error("FATAL: ROOM_TOKEN e AGENT_TOKEN devem ser diferentes.");
  process.exit(1);
}

const app = express();
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const http = createServer(app);
const wss = new WebSocketServer({ server: http, path: "/ws", maxPayload: 64 * 1024 });
attachRelay(wss, { roomToken: ROOM_TOKEN, agentToken: AGENT_TOKEN, allowedOrigins: ALLOWED_ORIGINS }, createRoomState());

http.listen(PORT, () => {
  console.log(`server listening on :${PORT}`);
});
