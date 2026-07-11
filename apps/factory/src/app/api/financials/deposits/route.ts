/**
 * FP9.3 — deposits outstanding (FD13): orders whose required deposit isn't in,
 * with the count of work orders BLOCKED waiting on it — the money that's holding
 * up the floor. Drills to the order (record the deposit there and FP4 unblocks).
 * FS1 — folds via the shared SQL-aggregate loader (state scope preserved:
 * notIn CANCELLED/CLOSED) instead of hydrating every live order; blocked-WO
 * counts via groupBy. depositsOutstanding() reads only deposit fields, which
 * the aggregates carry identically (parity-checked).
 */
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";
import { depositsOutstanding } from "@/lib/financials/rollup";
import { loadOrderFinancials } from "@/lib/financials/load";

export const permission = PAGES.financials;

export const GET = guarded(PAGES.financials, async (_req, { resolved }) => {
  const [fins, blockedCounts] = await Promise.all([
    loadOrderFinancials(undefined, { excludeStates: ["CANCELLED", "CLOSED"], sorted: false }),
    prisma.workOrder.groupBy({ by: ["orderId"], where: { state: "BLOCKED" }, _count: { _all: true } }),
  ]);
  const blockedByOrder = new Map(blockedCounts.map((b) => [b.orderId, b._count._all]));
  const deposits = depositsOutstanding(fins).map((d) => ({ ...d, blockedWorkOrders: blockedByOrder.get(d.orderId) ?? 0 }));
  return jsonStripped({ deposits }, resolved);
});
