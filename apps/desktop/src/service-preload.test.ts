import { describe, expect, it } from "vitest";
import { pickNext, pickNextWrap, type Rect } from "./service-preload.js";

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

describe("pickNextWrap (TV row wrap-around)", () => {
  it("at the end of a row, jumps to the element farthest behind", () => {
    // Focused on the last tile (x=200); wrapping Right picks the first (x=0).
    expect(pickNextWrap(box(200, 0), "right", [box(0, 0), box(100, 0)])).toBe(0);
  });
  it("wraps vertically too (bottom -> top)", () => {
    expect(pickNextWrap(box(0, 400), "down", [box(0, 0), box(0, 200)])).toBe(0);
  });
  it("keeps the farthest-first order so a full row cycles", () => {
    // Middle of the row pressing Left: wrap goes to the far right tile.
    expect(pickNextWrap(box(100, 0), "left", [box(0, 0), box(200, 0)])).toBe(1);
  });
  it("returns -1 when there is nothing to wrap to", () => {
    // Pressing Up at the top with a single tile ABOVE (nothing below to wrap to).
    expect(pickNextWrap(box(0, 0), "up", [box(0, -50)])).toBe(-1);
    expect(pickNextWrap(box(0, 0), "right", [])).toBe(-1);
  });
});
