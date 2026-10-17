import { z } from "zod";
import { APP_IDS } from "./apps.js";

export const PROTOCOL_VERSION = 1;
export const MAX_TEXT_LENGTH = 500;
export const MAX_MESSAGE_BYTES = 64 * 1024;

export const helloSchema = z.object({
  type: z.literal("hello"),
  role: z.enum(["controller", "agent"]),
  token: z.string().min(1).max(256),
  v: z.literal(1),
  // Installation id reported by the agent (desktop app). Lets the server bind
  // pairing codes and controller sessions to the right installation when more
  // than one PC exists. Optional: old agents simply omit it.
  deviceId: z.string().min(1).max(128).optional(),
});

export const keySchema = z.object({
  type: z.literal("key"),
  key: z.enum(["up", "down", "left", "right", "enter", "back", "home"]),
});

export const mediaSchema = z.object({
  type: z.literal("media"),
  action: z.enum([
    "playpause",
    "play",
    "pause",
    "seekForward",
    "seekBackward",
    "fullscreen",
    "next",
  ]),
});

export const volumeSchema = z.object({
  type: z.literal("volume"),
  action: z.enum(["up", "down", "mute"]),
  step: z.number().int().min(1).max(10).optional(),
});

export const appSchema = z.object({
  type: z.literal("app"),
  id: z.string().refine((v) => APP_IDS.includes(v), { message: "unknown app id" }),
});

export const textSchema = z.object({
  type: z.literal("text"),
  value: z.string().max(MAX_TEXT_LENGTH),
});

export const textKeySchema = z.object({
  type: z.literal("textKey"),
  key: z.enum(["backspace", "enter"]),
});

export const mouseMoveSchema = z.object({
  type: z.literal("mouseMove"),
  dx: z.number().min(-2000).max(2000),
  dy: z.number().min(-2000).max(2000),
});

export const mouseClickSchema = z.object({
  type: z.literal("mouseClick"),
  button: z.enum(["left", "right"]),
});

export const scrollSchema = z.object({
  type: z.literal("scroll"),
  dy: z.number().min(-2000).max(2000),
});

export const powerSchema = z.object({
  type: z.literal("power"),
  action: z.literal("screenOff"),
});

export const pingSchema = z.object({ type: z.literal("ping") });
export const pongSchema = z.object({ type: z.literal("pong") });

// Mensagens controller -> server -> agent (whitelist v1)
export const controllerMessageSchema = z.discriminatedUnion("type", [
  keySchema,
  mediaSchema,
  volumeSchema,
  appSchema,
  textSchema,
  textKeySchema,
  mouseMoveSchema,
  mouseClickSchema,
  scrollSchema,
  powerSchema,
  pingSchema,
]);

export type ControllerMessage = z.infer<typeof controllerMessageSchema>;

// Mensagens agent -> server -> controllers (estado)
export const agentStateSchema = z.object({
  type: z.literal("state"),
  agentOnline: z.boolean(),
  volume: z.number().min(0).max(100).optional(),
  muted: z.boolean().optional(),
  error: z.string().max(300).optional(),
});

export type AgentState = z.infer<typeof agentStateSchema>;

export const serverToAgentSchema = controllerMessageSchema;
export type ServerToAgentMessage = ControllerMessage;

// ---- Pairing (6-digit codes + QR) ----
// The ONLY way a phone gets in: it redeems a code shown on the PC and gets a
// random per-device session token. There is no fixed controller token; codes
// never carry permanent secrets (no AGENT_TOKEN in codes/QR).

export const PAIR_CODE_TTL_MS = 5 * 60 * 1000;
export const PAIR_REFRESH_MS = 30 * 1000;

// agent -> server: asks for a fresh pairing code for its installation.
// The server invalidates the previous active code for that device.
export const pairCodeRequestSchema = z.object({ type: z.literal("pair-code-request") });

// server -> agent: the code to show (big digits + QR) with absolute expiry.
export const pairCodeSchema = z.object({
  type: z.literal("pair-code"),
  code: z.string().regex(/^\d{6}$/),
  expiresAt: z.number().int().positive(),
});

// controller (phone) -> server, BEFORE auth: redeems the code from the PC.
// Sent on a fresh socket; on success the server answers pair-ok + state.
export const pairRequestSchema = z.object({
  type: z.literal("pair"),
  code: z.string().min(1).max(16),
});

export const pairErrorReasonSchema = z.enum([
  "incorrect",
  "expired",
  "used",
  "rate-limited",
  "unavailable",
]);
export type PairErrorReason = z.infer<typeof pairErrorReasonSchema>;

// server -> controller: pairing accepted. `token` is a random per-device
// session token to persist (localStorage) and reuse in `hello`.
export const pairOkSchema = z.object({
  type: z.literal("pair-ok"),
  deviceId: z.string().min(1).max(128),
  token: z.string().min(16).max(256),
});

// server -> controller: pairing rejected (socket stays open for retries
// inside the hello window; never includes secrets).
export const pairErrorSchema = z.object({
  type: z.literal("pair-error"),
  reason: pairErrorReasonSchema,
});

// controller -> server, AFTER auth: ends THIS session only (per-token).
export const unpairSchema = z.object({ type: z.literal("unpair") });

// server -> controller: this session was ended (followed by close).
export const unpairedSchema = z.object({ type: z.literal("unpaired") });

// server -> agent: how many controllers are currently linked (for the PC
// "Conexão" modal: "N celular(es) vinculado(s)").
export const presenceSchema = z.object({
  type: z.literal("presence"),
  controllers: z.number().int().min(0),
});

export type PairCode = z.infer<typeof pairCodeSchema>;
export type PairOk = z.infer<typeof pairOkSchema>;
