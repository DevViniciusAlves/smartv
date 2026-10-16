import type { Server } from "node:http";
import type { Socket } from "node:net";
import type { WebSocketServer } from "ws";
import type { Logger } from "./logger.js";
import { normalizeOrigin } from "./origins.js";

// Manual upgrade: logs every attempt and rejects wrong paths with 404
// (the ws library would answer 400 before the connection event, unlogged).
export function attachUpgradeHandler(http: Server, wss: WebSocketServer, log: Logger): void {
  http.on("upgrade", (req, socket: Socket, head: Buffer) => {
    let pathname = req.url ?? "/";
    try {
      pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      /* keep raw */
    }
    const ua = String(req.headers["user-agent"] ?? "").slice(0, 80);
    log.info("upgrade", { path: pathname, origin: normalizeOrigin(req.headers.origin) || "-", ua });
    if (pathname !== "/ws") {
      log.warn("upgrade_rejected", { reason: "bad_path", path: pathname });
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 9\r\n\r\nNot Found");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
}
