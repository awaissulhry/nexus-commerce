/**
 * FP7 — the floor needs STOCK counts but must never see supplier COST. The
 * materials payload composes with the caller's grains: a Worker (no financial
 * grains) keeps In stock / Committed / Expected / Available and loses costCents.
 */
import { describe, expect, it } from "vitest";
import { stripFinancials } from "../auth/strip-financials";
import type { Resolved } from "../auth/rbac";

const worker = { isOwner: false, permissions: new Set(["pages.materials", "materials.consume"]) } as Resolved;
const owner = { isOwner: true, permissions: new Set<string>() } as Resolved;
const payload = { materials: [{ id: "m1", name: "Kangaroo hide", unit: "SQM", inStock: 80, committed: 25, expected: 40, available: 55, costCents: 4200 }] };

describe("materials grain strip", () => {
  it("a cost-blind worker keeps stock counts, loses cost", () => {
    const out = stripFinancials(payload, worker) as { materials: Record<string, unknown>[] };
    const m = out.materials[0];
    expect(m.inStock).toBe(80);
    expect(m.committed).toBe(25);
    expect(m.expected).toBe(40);
    expect(m.available).toBe(55);
    expect("costCents" in m).toBe(false);
    expect(JSON.stringify(out)).not.toMatch(/Cents/);
  });
  it("the owner sees cost too", () => {
    const out = stripFinancials(payload, owner) as { materials: Record<string, unknown>[] };
    expect(out.materials[0].costCents).toBe(4200);
    expect(out.materials[0].available).toBe(55);
  });
});
