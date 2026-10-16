// Shared WebSocket close codes (4000-4999 = application use).
// Used by server, agent and web so every side interprets closures the same way.
export const CLOSE_CODES = {
  REPLACED_BY_NEW_AGENT: 4400,
  AUTH_FAILED: 4401,
  ORIGIN_NOT_ALLOWED: 4403,
  MESSAGE_TOO_LARGE: 4409,
} as const;

export type CloseKind = "auth" | "origin" | "replaced" | "too_large" | "network";

export interface CloseDescription {
  kind: CloseKind;
  // Whether the client should keep retrying automatically with backoff.
  // Auth/origin failures never retry: they need user action (token/origins).
  retry: boolean;
}

export function describeClose(code: number): CloseDescription {
  switch (code) {
    case CLOSE_CODES.AUTH_FAILED:
      return { kind: "auth", retry: false };
    case CLOSE_CODES.ORIGIN_NOT_ALLOWED:
      return { kind: "origin", retry: false };
    case CLOSE_CODES.REPLACED_BY_NEW_AGENT:
      return { kind: "replaced", retry: true };
    case CLOSE_CODES.MESSAGE_TOO_LARGE:
      return { kind: "too_large", retry: true };
    default:
      return { kind: "network", retry: true };
  }
}
