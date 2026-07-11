/** FS3 — useResizablePanes pure core: clamp, persist round-trip, delta/invert, reset. */
import { describe, expect, it } from "vitest";
import {
  applyPaneDelta,
  clampPane,
  defaultWidths,
  loadPaneWidths,
  serializePaneWidths,
  type PaneDef,
} from "@/lib/virtual/panes";

const LIST: PaneDef = { min: 280, max: 640, defaultSize: 360 };
const RAIL: PaneDef = { min: 240, max: 520, defaultSize: 300, invert: true };
const PANES = [LIST, RAIL];

describe("clampPane / defaultWidths", () => {
  it("clamps below min and above max", () => {
    expect(clampPane(100, LIST)).toBe(280);
    expect(clampPane(9000, LIST)).toBe(640);
    expect(clampPane(400, LIST)).toBe(400);
  });

  it("defaults are themselves clamped (a bad config cannot start out of range)", () => {
    expect(defaultWidths(PANES)).toEqual([360, 300]);
    expect(defaultWidths([{ min: 200, max: 300, defaultSize: 999 }])).toEqual([300]);
  });
});

describe("applyPaneDelta", () => {
  it("grows/shrinks the target pane only, clamped", () => {
    expect(applyPaneDelta([360, 300], 0, 50, PANES)).toEqual([410, 300]);
    expect(applyPaneDelta([360, 300], 0, -500, PANES)).toEqual([280, 300]);
    expect(applyPaneDelta([360, 300], 0, 5000, PANES)).toEqual([640, 300]);
  });

  it("invert: a handle on the pane's leading edge — dragging right SHRINKS it", () => {
    expect(applyPaneDelta([360, 300], 1, 40, PANES)).toEqual([360, 260]);
    expect(applyPaneDelta([360, 300], 1, -40, PANES)).toEqual([360, 340]);
  });

  it("unknown index is a no-op", () => {
    expect(applyPaneDelta([360, 300], 5, 40, PANES)).toEqual([360, 300]);
  });
});

describe("persistence (serialize → load round-trip)", () => {
  it("round-trips widths through the stored JSON", () => {
    const stored = serializePaneWidths([410.4, 260.6]);
    expect(loadPaneWidths(stored, PANES)).toEqual([410, 261]);
  });

  it("clamps values that were saved under looser old bounds", () => {
    expect(loadPaneWidths(JSON.stringify([9000, 10]), PANES)).toEqual([640, 240]);
  });

  it("falls back to defaults on garbage, wrong shape, wrong length, or nulls", () => {
    expect(loadPaneWidths("not json{", PANES)).toEqual([360, 300]);
    expect(loadPaneWidths(JSON.stringify({ list: 400 }), PANES)).toEqual([360, 300]);
    expect(loadPaneWidths(JSON.stringify([400]), PANES)).toEqual([360, 300]);
    expect(loadPaneWidths(null, PANES)).toEqual([360, 300]);
    expect(loadPaneWidths(undefined, PANES)).toEqual([360, 300]);
  });

  it("a non-numeric entry falls back for THAT pane only (per-pane recovery)", () => {
    expect(loadPaneWidths(JSON.stringify([400, "wide"]), PANES)).toEqual([400, 300]);
  });

  it("non-finite numbers fall back per pane", () => {
    expect(loadPaneWidths(JSON.stringify([Infinity, 400]), PANES)).toEqual([360, 400]);
  });
});

describe("reset", () => {
  it("reset = defaults again, and persists cleanly", () => {
    const afterDrag = applyPaneDelta(applyPaneDelta([360, 300], 0, 100, PANES), 1, -60, PANES);
    expect(afterDrag).toEqual([460, 360]);
    const reset = defaultWidths(PANES);
    expect(reset).toEqual([360, 300]);
    expect(loadPaneWidths(serializePaneWidths(reset), PANES)).toEqual([360, 300]);
  });
});
