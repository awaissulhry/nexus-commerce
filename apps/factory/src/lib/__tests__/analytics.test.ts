/**
 * FP10 — the analytics folds are pure and carry the risk (week bucketing, stage
 * medians + bottleneck, the on-time boundary, win/loss + reasons, product margin).
 */
import { describe, expect, it } from "vitest";
import { throughputByWeek, weekStartISO } from "../analytics/throughput";
import { stageLeadTimes, bottleneck, median, type StageRow } from "../analytics/lead-time";
import { onTimeRate } from "../analytics/on-time";
import { quoteWinLoss } from "../analytics/win-loss";
import { marginByProduct } from "../analytics/margin-by-product";

const H = 3_600_000;

describe("throughput", () => {
  it("buckets finishes to their Monday (UTC)", () => {
    expect(weekStartISO("2026-07-01T10:00:00Z")).toBe("2026-06-29"); // Wed → Mon 06-29
    expect(weekStartISO("2026-07-08T10:00:00Z")).toBe("2026-07-06");
    const t = throughputByWeek(["2026-07-01T10:00:00Z", "2026-07-03T10:00:00Z", "2026-07-08T10:00:00Z"]);
    expect(t).toEqual([{ weekKey: "2026-06-29", count: 2 }, { weekKey: "2026-07-06", count: 1 }]);
  });
});

describe("stage lead time + bottleneck", () => {
  const st = (stage: string, startISO: string, finISO: string | null): StageRow => ({ stage, startedAt: startISO, finishedAt: finISO, pausedMs: 0, pausedAt: null });
  const stages: StageRow[] = [
    st("CUTTING", "2026-07-01T09:00:00Z", "2026-07-01T10:00:00Z"), // 1h
    st("CUTTING", "2026-07-01T09:00:00Z", "2026-07-01T12:00:00Z"), // 3h → median 2h
    st("STITCHING", "2026-07-01T09:00:00Z", "2026-07-01T14:00:00Z"), // 5h
    st("PACKING", "2026-07-01T09:00:00Z", null), // unfinished → excluded
  ];
  it("medians completed stages and flags the slowest", () => {
    expect(median([1, 3])).toBe(2);
    const rows = stageLeadTimes(stages, 0);
    expect(rows.find((r) => r.stage === "CUTTING")).toEqual({ stage: "CUTTING", medianMs: 2 * H, count: 2 });
    expect(rows.find((r) => r.stage === "PACKING")).toBeUndefined(); // not finished
    expect(bottleneck(rows)?.stage).toBe("STITCHING");
  });
});

describe("on-time rate", () => {
  it("counts settled rows only, by calendar day", () => {
    const r = onTimeRate([
      { promiseISO: "2026-07-10", shippedISO: "2026-07-08" }, // on time
      { promiseISO: "2026-07-10", shippedISO: "2026-07-10" }, // on time (same day)
      { promiseISO: "2026-07-10", shippedISO: "2026-07-12" }, // late
      { promiseISO: null, shippedISO: "2026-07-01" }, // unknown
    ]);
    expect(r).toMatchObject({ onTime: 2, late: 1, unknown: 1 });
    expect(r.rate).toBeCloseTo(66.67, 1);
  });
});

describe("quote win/loss", () => {
  it("wins vs decided, tallies loss reasons, open doesn't count", () => {
    const w = quoteWinLoss([
      { state: "ACCEPTED", lostReason: null },
      { state: "REJECTED", lostReason: "price" },
      { state: "EXPIRED", lostReason: null },
      { state: "SENT", lostReason: null },
      { state: "DRAFT", lostReason: null },
    ]);
    expect(w).toMatchObject({ won: 1, lost: 2, open: 2 });
    expect(w.rate).toBeCloseTo(33.33, 1);
    expect(w.byReason).toEqual([{ reason: "price", count: 1 }, { reason: "unspecified", count: 1 }]);
  });
});

describe("margin by product", () => {
  it("groups lines and sums estimated margin, biggest revenue first", () => {
    const m = marginByProduct([
      { product: "Jacket", netPriceCents: 50000, costCents: 25000, qty: 1 },
      { product: "Jacket", netPriceCents: 40000, costCents: 20000, qty: 2 },
      { product: "Pants", netPriceCents: 30000, costCents: 18000, qty: 1 },
    ]);
    expect(m[0]).toMatchObject({ product: "Jacket", orders: 2, netCents: 130000, estMarginCents: 65000 });
    expect(m[1]).toMatchObject({ product: "Pants", netCents: 30000, estMarginCents: 12000 });
  });
});
