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
});

export const keySchema = z.object({
  type: z.literal("key"),
  key: z.enum(["up", "down", "left", "right", "enter", "back", "home"]),
});

export const mediaSchema = z.object({
  type: z.literal("media"),
  action: z.enum(["playpause", "seekForward", "seekBackward", "fullscreen", "next"]),
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
