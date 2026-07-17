/**
 * EPF1 — topNewest must equal sort-then-slice exactly (incl. the orderId ASC
 * tie-break the loader uses) for any n vs list-size relation.
 */
import { describe, expect, it } from "vitest";
import { topNewest, type OrderFinancials } from "../financials/rollup";

const fin = (orderId: string, createdAtISO: string) => ({ orderId, createdAtISO }) as OrderFinancials;

const reference = (fins: OrderFinancials[], n: number) =>
  [...fins]
    .sort((a, b) => (a.createdAtISO === b.createdAtISO ? (a.orderId < b.orderId ? -1 : 1) : a.createdAtISO > b.createdAtISO ? -1 : 1))
    .slice(0, n);

describe("topNewest", () => {
  it("matches sort+slice on a randomized list incl. same-instant ties", () => {
    const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed / 2 ** 31);
    const r = rng(42);
    const fins = Array.from({ length: 2500 }, (_, i) =>
      fin(`o${i.toString().padStart(4, "0")}`, new Date(1700000000000 + Math.floor(r() * 500) * 60_000).toISOString()),
    );
    for (const n of [1, 7, 200, 2500, 3000]) {
      expect(topNewest(fins, n).map((f) => f.orderId)).toEqual(reference(fins, n).map((f) => f.orderId));
    }
  });

  it("handles empty input and n=0", () => {
    expect(topNewest([], 200)).toEqual([]);
    expect(topNewest([fin("a", "2026-01-01T00:00:00.000Z")], 0)).toEqual([]);
  });
});
