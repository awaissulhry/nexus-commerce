/**
 * EPF1 (D-10) — the bank-import apply core + the extracted FD13 deposit gate,
 * driven against an in-memory fake of the exact db slice the production code
 * uses (the route passes a Prisma transaction client to the SAME functions).
 * Pins: sha256 importKey idempotency (same CSV twice → 0 new payments, within
 * one batch AND across runs), amount ≤ live balance (errored, not applied),
 * bank date → receivedAt, audit rows written, and UNBLOCK PARITY — the import
 * runs the identical gate the FP4 payments route runs.
 */
import { describe, expect, it } from "vitest";
import { applyBankRows, bankImportKey, type BankApplyDb, type BankApplyRow } from "../financials/bank-apply";
import { applyDepositGate } from "../orders/deposit-gate";
import { parseBankDate } from "../financials/bank-match";

type FakeOrder = {
  id: string;
  number: string;
  lines: { netPriceCents: number; costCents: number; qty: number }[];
  payments: { kind: string; amountCents: number }[];
  bornFromQuote: { depositPct: number | null } | null;
  workOrders: { id: string; number: string; state: string }[];
};

function makeDb(orders: FakeOrder[]) {
  const payments: { id: string; orderId: string; importKey: string; amountCents: number; receivedAt: Date; notes: string | null }[] = [];
  const audits: { entityType: string; entityId: string; action: string; after?: object }[] = [];
  const byId = new Map(orders.map((o) => [o.id, o]));
  let seq = 0;
  const db: BankApplyDb = {
    payment: {
      findUnique: async ({ where }) => payments.find((p) => p.importKey === where.importKey) ?? null,
      create: async ({ data }) => {
        const row = { id: `pay-${++seq}`, orderId: data.orderId, importKey: data.importKey, amountCents: data.amountCents, receivedAt: data.receivedAt, notes: data.notes };
        payments.push(row);
        byId.get(data.orderId)?.payments.push({ kind: data.kind, amountCents: data.amountCents }); // live balance moves within the tx
        return { id: row.id };
      },
    },
    order: { findUnique: async ({ where }) => byId.get(where.id) ?? null },
    workOrder: {
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const o of byId.values()) {
          for (const w of o.workOrders) {
            if (where.id.in.includes(w.id)) {
              w.state = data.state;
              count++;
            }
          }
        }
        return { count };
      },
    },
    auditLog: { create: async ({ data }) => (audits.push(data), undefined) },
  };
  return { db, payments, audits };
}

const order = (over: Partial<FakeOrder> = {}): FakeOrder => ({
  id: "o1",
  number: "ORD-1",
  lines: [{ netPriceCents: 50000, costCents: 20000, qty: 1 }],
  payments: [],
  bornFromQuote: null,
  workOrders: [],
  ...over,
});

const row = (over: Partial<BankApplyRow> = {}): BankApplyRow => ({
  orderId: "o1",
  amountCents: 30000,
  date: "2026-07-01",
  description: "Bonifico ORD-1",
  ...over,
});

describe("applyBankRows", () => {
  it("creates a BALANCE payment with the BANK date as receivedAt and audits it", async () => {
    const { db, payments, audits } = makeDb([order()]);
    const res = await applyBankRows(db, [row()], "u1");
    expect(res).toEqual([{ index: 0, status: "created", orderId: "o1", orderNumber: "ORD-1", paymentId: "pay-1", amountCents: 30000, unblocked: 0 }]);
    expect(payments[0].receivedAt.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(payments[0].importKey).toBe(bankImportKey({ date: "2026-07-01", amountCents: 30000, description: "Bonifico ORD-1" }));
    expect(audits.some((a) => a.entityType === "payment" && a.action === "recorded")).toBe(true);
  });
  it("IDEMPOTENT: the same CSV applied twice creates 0 new payments the second time", async () => {
    const { db, payments } = makeDb([order()]);
    const rows = [row(), row({ amountCents: 20000, date: "2026-07-02", description: "saldo ORD-1" })];
    const first = await applyBankRows(db, rows, "u1");
    expect(first.every((r) => r.status === "created")).toBe(true);
    const second = await applyBankRows(db, rows, "u1");
    expect(second.every((r) => r.status === "skipped" && r.reason === "duplicate")).toBe(true);
    expect(payments).toHaveLength(2);
  });
  it("duplicate statement lines WITHIN one batch collapse too", async () => {
    const { db, payments } = makeDb([order()]);
    const res = await applyBankRows(db, [row(), row()], "u1");
    expect(res[0].status).toBe("created");
    expect(res[1].status).toBe("skipped");
    expect(payments).toHaveLength(1);
  });
  it("amount > live balance is ERRORED, not applied — and earlier rows count toward the balance", async () => {
    const { db, payments } = makeDb([order()]); // net 50000
    const res = await applyBankRows(
      db,
      [row({ amountCents: 60000 }), row({ amountCents: 30000, date: "2026-07-02" }), row({ amountCents: 30000, date: "2026-07-03" })],
      "u1",
    );
    expect(res[0].status).toBe("error"); // 60000 > 50000
    expect(res[1].status).toBe("created"); // 30000 ≤ 50000
    expect(res[2]).toMatchObject({ status: "error" }); // 30000 > remaining 20000 (row 2 already applied)
    expect((res[2] as { reason: string }).reason).toContain("open balance");
    expect(payments).toHaveLength(1);
  });
  it("unknown order and unparseable dates degrade safely (error row / now-fallback)", async () => {
    const { db, payments } = makeDb([order()]);
    const res = await applyBankRows(db, [row({ orderId: "ghost" }), row({ date: "not a date" })], "u1");
    expect(res[0]).toMatchObject({ status: "error", reason: "order not found" });
    expect(res[1].status).toBe("created");
    expect(Math.abs(payments[0].receivedAt.getTime() - Date.now())).toBeLessThan(5_000);
  });
  it("UNBLOCK PARITY (FD13): the import unblocks a BLOCKED WO exactly like the FP4 route's gate", async () => {
    // deposit requirement already satisfied (no depositPct) → gate opens on any recorded payment
    const blocked = order({ workOrders: [{ id: "w1", number: "ORD-1/1", state: "BLOCKED" }] });
    const { db, audits } = makeDb([blocked]);
    const res = await applyBankRows(db, [row({ amountCents: 10000 })], "u1");
    expect(res[0]).toMatchObject({ status: "created", unblocked: 1 });
    expect(blocked.workOrders[0].state).toBe("READY");
    expect(audits.some((a) => a.entityType === "workorder" && a.action === "unblocked")).toBe(true);
    expect(audits.some((a) => a.entityType === "order" && a.action === "deposit-met")).toBe(true);
  });
  it("…and leaves the WO BLOCKED while the deposit requirement is unmet (BALANCE ≠ deposit)", async () => {
    const gated = order({ bornFromQuote: { depositPct: 30 }, workOrders: [{ id: "w1", number: "ORD-1/1", state: "BLOCKED" }] });
    const { db } = makeDb([gated]);
    const res = await applyBankRows(db, [row({ amountCents: 20000 })], "u1"); // BALANCE, not DEPOSIT
    expect(res[0]).toMatchObject({ status: "created", unblocked: 0 });
    expect(gated.workOrders[0].state).toBe("BLOCKED");
  });
});

describe("applyDepositGate (the ONE shared rule)", () => {
  it("unblocks when DEPOSIT payments meet the requirement, audits per WO", async () => {
    const o = order({
      bornFromQuote: { depositPct: 30 }, // requires 15000
      payments: [{ kind: "DEPOSIT", amountCents: 15000 }],
      workOrders: [
        { id: "w1", number: "ORD-1/1", state: "BLOCKED" },
        { id: "w2", number: "ORD-1/2", state: "READY" },
      ],
    });
    const { db, audits } = makeDb([o]);
    const res = await applyDepositGate(db, { id: o.id, lines: o.lines, payments: o.payments, depositPct: 30, workOrders: o.workOrders }, "u1");
    expect(res.unblocked).toBe(1);
    expect(res.unblockedWoIds).toEqual(["w1"]);
    expect(o.workOrders[0].state).toBe("READY");
    expect(audits.filter((a) => a.action === "unblocked")).toHaveLength(1);
  });
  it("does nothing while the requirement is unmet or nothing is blocked", async () => {
    const o = order({ workOrders: [{ id: "w1", number: "ORD-1/1", state: "BLOCKED" }] });
    const { db, audits } = makeDb([o]);
    const unmet = await applyDepositGate(db, { id: o.id, lines: o.lines, payments: [{ kind: "DEPOSIT", amountCents: 100 }], depositPct: 30, workOrders: o.workOrders }, "u1");
    expect(unmet.unblocked).toBe(0);
    expect(o.workOrders[0].state).toBe("BLOCKED");
    expect(audits).toHaveLength(0);
  });
});

describe("parseBankDate", () => {
  it("ISO and Italian dd/mm/yyyy forms", () => {
    expect(parseBankDate("2026-07-01")?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(parseBankDate("01/07/2026")?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(parseBankDate("1.7.2026")?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });
  it("rejects garbage and impossible dates", () => {
    expect(parseBankDate("soon")).toBeNull();
    expect(parseBankDate("31/02/2026")).toBeNull();
    expect(parseBankDate("")).toBeNull();
  });
});
