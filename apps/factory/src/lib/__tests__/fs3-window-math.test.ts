/** FS3 — windowing math: range bounds, overscan clamping, spacer heights. */
import { describe, expect, it } from "vitest";
import { extractRange, spacerHeights } from "@/lib/virtual/window-math";

describe("extractRange", () => {
  it("returns the visible window widened by overscan", () => {
    expect(extractRange({ startIndex: 10, endIndex: 14, overscan: 3, count: 100 })).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it("clamps at the top of the list", () => {
    expect(extractRange({ startIndex: 0, endIndex: 2, overscan: 5, count: 100 })).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("clamps at the bottom of the list", () => {
    expect(extractRange({ startIndex: 97, endIndex: 99, overscan: 5, count: 100 })).toEqual([92, 93, 94, 95, 96, 97, 98, 99]);
  });

  it("zero overscan renders exactly the window", () => {
    expect(extractRange({ startIndex: 5, endIndex: 6, overscan: 0, count: 10 })).toEqual([5, 6]);
  });

  it("empty list renders nothing", () => {
    expect(extractRange({ startIndex: 0, endIndex: 0, overscan: 10, count: 0 })).toEqual([]);
  });

  it("single item list renders the item regardless of overscan", () => {
    expect(extractRange({ startIndex: 0, endIndex: 0, overscan: 10, count: 1 })).toEqual([0]);
  });

  it("window fully covering a short list stays in bounds", () => {
    expect(extractRange({ startIndex: 0, endIndex: 50, overscan: 4, count: 3 })).toEqual([0, 1, 2]);
  });

  it("startIndex beyond the end (rows shrank mid-scroll) clamps safely", () => {
    const out = extractRange({ startIndex: 500, endIndex: 520, overscan: 2, count: 10 });
    expect(out[0]).toBeGreaterThanOrEqual(0);
    expect(out[out.length - 1]).toBe(9);
  });

  it("negative overscan is treated as zero", () => {
    expect(extractRange({ startIndex: 4, endIndex: 5, overscan: -3, count: 10 })).toEqual([4, 5]);
  });
});

describe("spacerHeights", () => {
  it("computes leading and trailing filler around the window", () => {
    const items = [
      { start: 400, end: 440 },
      { start: 440, end: 480 },
      { start: 480, end: 520 },
    ];
    expect(spacerHeights(items, 4000)).toEqual({ top: 400, bottom: 3480 });
  });

  it("window at the very top has no leading filler", () => {
    expect(spacerHeights([{ start: 0, end: 40 }], 400)).toEqual({ top: 0, bottom: 360 });
  });

  it("window at the very bottom has no trailing filler", () => {
    expect(spacerHeights([{ start: 360, end: 400 }], 400)).toEqual({ top: 360, bottom: 0 });
  });

  it("empty window has no fillers", () => {
    expect(spacerHeights([], 1234)).toEqual({ top: 0, bottom: 0 });
  });

  it("never returns negative heights when measurements overshoot the total", () => {
    expect(spacerHeights([{ start: 0, end: 500 }], 400)).toEqual({ top: 0, bottom: 0 });
  });
});
