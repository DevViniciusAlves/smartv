import { describe, expect, it } from "vitest";
import { pickNext } from "./spatial.js";

const box = (x: number, y: number) => ({ x, y, width: 10, height: 10 });

describe("pickNext", () => {
  it("picks element to the right", () => {
    const cur = box(0, 0);
    expect(pickNext(cur, "right", [box(-50, 0), box(50, 0), box(30, 100)])).toBe(1);
  });
  it("picks element below", () => {
    expect(pickNext(box(0, 0), "down", [box(0, -50), box(0, 60)])).
      toBe(1);
  });
  it("returns -1 when nothing in direction", () => {
    expect(pickNext(box(0, 0), "left", [box(50, 0)])).toBe(-1);
  });
  it("prefers aligned over closer diagonal", () => {
    const cur = box(100, 100);
    expect(pickNext(cur, "right", [box(120, 200), box(200, 102)])).toBe(1);
  });
});
