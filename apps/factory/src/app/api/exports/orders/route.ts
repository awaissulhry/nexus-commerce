/** FP4.4 — orders CSV export (money columns grain-gated, filter called explicitly). */
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { FEATURES, FIELDS } from "@/lib/auth/permissions";
import { toCsv } from "@/lib/csv";
import { orderTotals, depositRequiredCents, depositPaidCents } from "@/lib/orders/money";

export const permission = FEATURES.exportsRun;

const money = (c: number) => (c / 100).toFixed(2);
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");

export const GET = guarded(FEATURES.exportsRun, async (_req, { resolved }) => {
  const canMoney = !!resolved && (resolved.isOwner || resolved.permissions.has(FIELDS.marginsView));
  const orders = await prisma.order.findMany({
    orderBy: [{ promiseDateAt: "asc" }, { updatedAt: "desc" }],
    include: {
      party: { select: { name: true } },
      lines: { select: { netPriceCents: true, costCents: true, qty: true } },
      payments: { select: { kind: true, amountCents: true } },
      bornFromQuote: { select: { depositPct: true } },
      _count: { select: { workOrders: true } },
    },
  });
  const headers = ["number", "party", "state", "net", ...(canMoney ? ["margin_pct", "deposit_required", "deposit_paid"] : []), "promise_date", "confirmed", "work_orders", "updated"];
  const rows = orders.map((o) => {
    const t = orderTotals(o.lines);
    const req = depositRequiredCents(t.netCents, o.bornFromQuote?.depositPct);
    return [
      o.number, o.party.name, o.state, money(t.netCents),
      ...(canMoney ? [t.marginPct.toFixed(1), money(req), money(depositPaidCents(o.payments))] : []),
      day(o.promiseDateAt), day(o.createdAt), o._count.workOrders, day(o.updatedAt),
    ];
  });
  return new Response(toCsv(headers, rows), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="orders.csv"' } });
});
