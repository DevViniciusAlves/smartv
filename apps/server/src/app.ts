import express from "express";
import type { Express } from "express";
import { createRequire } from "node:module";
import { controllerCount, agentOnline, type RoomState } from "./relay.js";
import { normalizeOrigin } from "./origins.js";

const require = createRequire(import.meta.url);
const { version: VERSION } = require("../package.json") as { version: string };

export function createApp(room: RoomState, allowedOrigins: string[]): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  app.get("/health", (req, res) => {
    // CORS only for explicitly allowed origins (lets the /diag page probe us).
    const origin = normalizeOrigin(req.headers.origin as string | undefined);
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", req.headers.origin as string);
      res.setHeader("Vary", "Origin");
    }
    res.json({
      ok: true,
      uptimeSec: Math.floor(process.uptime()),
      agentOnline: agentOnline(room),
      controllers: controllerCount(room),
      version: VERSION,
    });
  });
  return app;
}
