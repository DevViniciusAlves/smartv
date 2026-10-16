import { describe, expect, it } from "vitest";
import { controllerMessageSchema } from "../src/protocol.js";
import { safeEqual } from "../src/auth.js";

describe("protocol whitelist", () => {
  it("accepts valid dpad key", () => {
    expect(controllerMessageSchema.safeParse({ type: "key", key: "up" }).success).toBe(true);
  });
  it("rejects arbitrary keys", () => {
    expect(
      controllerMessageSchema.safeParse({ type: "key", key: "F13; rm -rf" }).success,
    ).toBe(false);
  });
  it("rejects unknown message types", () => {
    expect(controllerMessageSchema.safeParse({ type: "exec", cmd: "calc" }).success).toBe(false);
  });
  it("rejects oversized text", () => {
    expect(
      controllerMessageSchema.safeParse({ type: "text", value: "x".repeat(501) }).success,
    ).toBe(false);
  });
  it("rejects unknown app id", () => {
    expect(controllerMessageSchema.safeParse({ type: "app", id: "hacker" }).success).toBe(false);
  });
  it("clamps mouse deltas", () => {
    expect(controllerMessageSchema.safeParse({ type: "mouseMove", dx: 99999, dy: 0 }).success).toBe(
      false,
    );
  });
});

describe("safeEqual", () => {
  it("matches equal tokens", () => {
    expect(safeEqual("abc123", "abc123")).toBe(true);
  });
  it("rejects different tokens", () => {
    expect(safeEqual("abc123", "abc124")).toBe(false);
  });
  it("rejects different lengths", () => {
    expect(safeEqual("short", "much-longer-token")).toBe(false);
  });
});
