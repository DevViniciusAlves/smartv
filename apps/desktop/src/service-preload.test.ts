import { describe, expect, it } from "vitest";
import { pickNext, type Rect } from "./service-preload.js";

const box = (x: number, y: number): Rect => ({ x, y, width: 10, height: 10 });

describe("pickNext (service focus navigation)", () => {
  it("picks the element to the right", () => {
    expect(pickNext(box(0, 0), "right", [box(-50, 0), box(50, 0), box(30, 100)])).toBe(1);
  });
  it("picks the element below", () => {
    expect(pickNext(box(0, 0), "down", [box(0, -50), box(0, 60)])).toBe(1);
  });
  it("returns -1 when nothing lies in that direction", () => {
    expect(pickNext(box(0, 0), "left", [box(50, 0)])).toBe(-1);
  });
  it("prefers axis-aligned over a closer diagonal", () => {
    expect(pickNext(box(100, 100), "right", [box(120, 200), box(200, 102)])).toBe(1);
  });
});
