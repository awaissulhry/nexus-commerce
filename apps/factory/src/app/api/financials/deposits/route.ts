/**
 * FP9.3 — deposits outstanding (FD13): orders whose required deposit isn't in,
 * with the count of work orders BLOCKED waiting on it — the money that's holding
 * up the floor. Drills to the order (record the deposit there and FP4 unblocks).
 * FS1 — folds via the shared SQL-aggregate loader (state scope preserved:
 * notIn CANCELLED/CLOSED) instead of hydrating every live order.
 * depositsOutstanding() reads only deposit fields, which the aggregates carry
 * identically (parity-checked). EPF2: same Rome-day window + `?party=` scope
 * as the siblings, and each row now carries `firstBlockedWoId` so the
 * "N blocked" pill can deep-link the EPO-built `/production?wo=` reader.
 */
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";
import { depositsOutstanding } from "@/lib/financials/rollup";
import { loadOrderFinancials } from "@/lib/financials/load";
import { romeDayWindowUtc } from "@/lib/financials/rome-time";

export const permission = PAGES.financials;

export const GET = guarded(PAGES.financials, async (req, { resolved }) => {
  const url = new URL(req.url);
  const createdAt = romeDayWindowUtc(url.searchParams.get("from"), url.searchParams.get("to"));
  const partyId = url.searchParams.get("party")?.trim() || undefined;
  const [fins, blocked] = await Promise.all([
    loadOrderFinancials(createdAt, { excludeStates: ["CANCELLED", "CLOSED"], sorted: false, partyId }),
    // row-level ids are needed for the /production?wo= deep link, which groupBy cannot provide
    // bounded: BLOCKED WOs are the active floor's waiting set (≈240 of 1.2k active WOs at the 50k harness)
    prisma.workOrder.findMany({ where: { state: "BLOCKED" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, orderId: true } }),
  ]);
  const blockedByOrder = new Map<string, { count: number; firstWoId: string }>();
  for (const w of blocked) {
    const e = blockedByOrder.get(w.orderId);
    if (e) e.count += 1;
    else blockedByOrder.set(w.orderId, { count: 1, firstWoId: w.id });
  }
  const deposits = depositsOutstanding(fins).map((d) => ({
    ...d,
    blockedWorkOrders: blockedByOrder.get(d.orderId)?.count ?? 0,
    firstBlockedWoId: blockedByOrder.get(d.orderId)?.firstWoId ?? null,
  }));
  return jsonStripped({ deposits }, resolved);
});
