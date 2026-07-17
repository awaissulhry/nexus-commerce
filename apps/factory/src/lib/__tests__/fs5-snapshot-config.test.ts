/** FS5 (S-15) — snapshot.config folding: defaults, clamps, field-wise fallback. */
import { describe, expect, it } from "vitest";
import { resolveSnapshotConfig, SNAPSHOT_DEFAULTS } from "../snapshot-config";

describe("resolveSnapshotConfig", () => {
  it("returns the historic defaults for absent / null / non-object values", () => {
    expect(resolveSnapshotConfig(undefined)).toEqual({ hour: 3, keep: 14 });
    expect(resolveSnapshotConfig(null)).toEqual(SNAPSHOT_DEFAULTS);
    expect(resolveSnapshotConfig("3")).toEqual(SNAPSHOT_DEFAULTS);
    expect(resolveSnapshotConfig(42)).toEqual(SNAPSHOT_DEFAULTS);
  });

  it("accepts a full valid config", () => {
    expect(resolveSnapshotConfig({ hour: 22, keep: 30 })).toEqual({ hour: 22, keep: 30 });
  });

  it("folds field-by-field (a partial value keeps the other default)", () => {
    expect(resolveSnapshotConfig({ hour: 5 })).toEqual({ hour: 5, keep: 14 });
    expect(resolveSnapshotConfig({ keep: 7 })).toEqual({ hour: 3, keep: 7 });
  });

  it("treats boundary values as valid (midnight hour 0, keep 1)", () => {
    expect(resolveSnapshotConfig({ hour: 0, keep: 1 })).toEqual({ hour: 0, keep: 1 });
    expect(resolveSnapshotConfig({ hour: 23, keep: 365 })).toEqual({ hour: 23, keep: 365 });
  });

  it("rejects out-of-range or non-integer fields individually", () => {
    expect(resolveSnapshotConfig({ hour: 24 })).toEqual(SNAPSHOT_DEFAULTS);
    expect(resolveSnapshotConfig({ hour: -1 })).toEqual(SNAPSHOT_DEFAULTS);
    expect(resolveSnapshotConfig({ hour: 3.5 })).toEqual(SNAPSHOT_DEFAULTS);
    expect(resolveSnapshotConfig({ keep: 0 })).toEqual(SNAPSHOT_DEFAULTS);
    expect(resolveSnapshotConfig({ keep: 366 })).toEqual(SNAPSHOT_DEFAULTS);
    expect(resolveSnapshotConfig({ hour: "22", keep: "30" })).toEqual(SNAPSHOT_DEFAULTS);
  });

  it("a bad field never poisons a good one", () => {
    expect(resolveSnapshotConfig({ hour: 24, keep: 7 })).toEqual({ hour: 3, keep: 7 });
    expect(resolveSnapshotConfig({ hour: 1, keep: "x" })).toEqual({ hour: 1, keep: 14 });
  });
});
