/**
 * FS5 (S-15) — nightly-snapshot configuration, folded from the AppSetting
 * `snapshot.config` value: `{ "hour": 0-23, "keep": 1-365 }`. Defaults are
 * the historic constants (03:xx, keep 14) and apply field-by-field — a
 * partial or malformed value never breaks the snapshot schedule, it just
 * falls back. Pure + unit-tested; the worker reads it each minute tick
 * (one PK row read against the local file — negligible).
 */

export const SNAPSHOT_DEFAULTS = { hour: 3, keep: 14 } as const;

export type SnapshotConfig = { hour: number; keep: number };

const intIn = (v: unknown, min: number, max: number): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;

export function resolveSnapshotConfig(value: unknown): SnapshotConfig {
  const v = (typeof value === "object" && value !== null ? value : {}) as { hour?: unknown; keep?: unknown };
  return {
    hour: intIn(v.hour, 0, 23) ?? SNAPSHOT_DEFAULTS.hour,
    keep: intIn(v.keep, 1, 365) ?? SNAPSHOT_DEFAULTS.keep,
  };
}
