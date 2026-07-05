/**
 * FP6 — the shop-floor Worker is cost-blind by construction (Katana verdict).
 * The board payload composes with the caller's grains; a Worker (no financial
 * grains) must never receive a cost/margin field. This pins that boundary.
 */
import { describe, expect, it } from "vitest";
import { stripFinancials } from "../auth/strip-financials";
import type { Resolved } from "../auth/rbac";

const worker = { isOwner: false, permissions: new Set<string>(["pages.production", "workorders.advance", "materials.consume"]) } as Resolved;
const owner = { isOwner: true, permissions: new Set<string>() } as Resolved;

const board = {
  worker: true,
  workOrders: [{ id: "w1", number: "ORD-1/1", party: "Rossi", estCostCents: 29000, current: { stage: "CUTTING" }, coverage: "OK" }],
};

describe("worker production payload", () => {
  it("carries no cost/margin for a cost-blind worker", () => {
    const out = stripFinancials(board, worker) as { workOrders: Record<string, unknown>[] };
    expect(out.workOrders[0].number).toBe("ORD-1/1");
    expect(out.workOrders[0].party).toBe("Rossi");
    expect("estCostCents" in out.workOrders[0]).toBe(false);
    // the whole serialized payload has no *Cents anywhere
    expect(JSON.stringify(out)).not.toMatch(/Cents/);
  });

  it("keeps cost for the owner", () => {
    const out = stripFinancials(board, owner) as { workOrders: Record<string, unknown>[] };
    expect(out.workOrders[0].estCostCents).toBe(29000);
  });
});
