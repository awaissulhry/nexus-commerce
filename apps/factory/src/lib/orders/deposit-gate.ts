/**
 * EPF1.6 (D-10) — THE deposit-gate/WO-unblock logic (FD13), extracted from the
 * FP4 payments route so the bank-import apply runs EXACTLY the same rule
 * (unblock parity — the import path used to skip it entirely). Called with the
 * caller's transaction client: the WO state flips and their audit rows commit
 * or roll back WITH the payment that triggered them. Events are NOT published
 * here — the caller publishes after its transaction commits (an event must
 * never announce a rolled-back write).
 */
import { orderTotals, depositRequiredCents, depositPaidCents, isDepositMet } from "./money";

/** The slice of a transaction client (or a test fake) the gate needs. */
export type DepositGateDb = {
  workOrder: {
    updateMany(args: {
      where: { id: { in: string[] } };
      data: { state: "READY"; blockedReason: null };
    }): Promise<{ count: number }>;
  };
  auditLog: {
    create(args: {
      data: { actorId: string | null; entityType: string; entityId: string; action: string; after?: object };
    }): Promise<unknown>;
  };
};

export type DepositGateOrder = {
  id: string;
  lines: { netPriceCents: number; costCents: number; qty: number }[];
  /** MUST include the payment being recorded in this transaction. */
  payments: { kind: string; amountCents: number }[];
  depositPct: number | null | undefined;
  workOrders: { id: string; number: string; state: string }[];
};

export type DepositGateResult = { unblocked: number; unblockedWoIds: string[] };

export async function applyDepositGate(
  db: DepositGateDb,
  order: DepositGateOrder,
  actorId: string | null,
): Promise<DepositGateResult> {
  const required = depositRequiredCents(orderTotals(order.lines).netCents, order.depositPct);
  const paid = depositPaidCents(order.payments);
  if (!isDepositMet(required, paid)) return { unblocked: 0, unblockedWoIds: [] };

  const blocked = order.workOrders.filter((w) => w.state === "BLOCKED");
  if (blocked.length === 0) return { unblocked: 0, unblockedWoIds: [] };

  const res = await db.workOrder.updateMany({
    where: { id: { in: blocked.map((w) => w.id) } },
    data: { state: "READY", blockedReason: null },
  });
  await db.auditLog.create({
    data: { actorId, entityType: "order", entityId: order.id, action: "deposit-met", after: { unblocked: res.count } },
  });
  // EPO1.3 (C3) — per-WO trail: each unblock is its own audit row
  for (const w of blocked) {
    await db.auditLog.create({
      data: { actorId, entityType: "workorder", entityId: w.id, action: "unblocked", after: { orderId: order.id, number: w.number, via: "deposit-met" } },
    });
  }
  return { unblocked: res.count, unblockedWoIds: blocked.map((w) => w.id) };
}
