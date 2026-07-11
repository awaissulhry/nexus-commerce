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
  const headers = ["number", "party", "state", "net", ...(canMoney ? ["margin_pct", "deposit_required", "deposit_paid"] : []), "promise_date", "confirmed", "work_orders", "updated"];

  // FS1 — two-phase streamed export: ONE id-list query carries the sort
  // (cursor-seek re-sorting per page was O(n²) — measured 3 s at 50k), then
  // fixed-size id batches hydrate and emit in id-list order. Memory stays flat
  // at any order count, ordering is exactly the legacy promiseDate/updated sort.
  const BATCH = 500; // stays well under SQLite's bound-parameter limit (N-1)
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(headers.join(",")));
        const ids = (
          await prisma.order.findMany({ orderBy: [{ promiseDateAt: "asc" }, { updatedAt: "desc" }, { id: "asc" }], select: { id: true } })
        ).map((o) => o.id); // bounded: id-only sort spine for the streamed export
        for (let i = 0; i < ids.length; i += BATCH) {
          const chunk = ids.slice(i, i + BATCH);
          const orders = await prisma.order.findMany({
            where: { id: { in: chunk } },
            take: BATCH, // bounded: id-batch hydration
            include: {
              party: { select: { name: true } },
              lines: { select: { netPriceCents: true, costCents: true, qty: true } },
              payments: { select: { kind: true, amountCents: true } },
              bornFromQuote: { select: { depositPct: true } },
              _count: { select: { workOrders: true } },
            },
          });
          const byId = new Map(orders.map((o) => [o.id, o]));
          const rows = chunk.flatMap((id) => {
            const o = byId.get(id);
            if (!o) return [];
            const t = orderTotals(o.lines);
            const req = depositRequiredCents(t.netCents, o.bornFromQuote?.depositPct);
            return [[
              o.number, o.party.name, o.state, money(t.netCents),
              ...(canMoney ? [t.marginPct.toFixed(1), money(req), money(depositPaidCents(o.payments))] : []),
              day(o.promiseDateAt), day(o.createdAt), o._count.workOrders, day(o.updatedAt),
            ]];
          });
          controller.enqueue(encoder.encode(csvRowsOnly(rows)));
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="orders.csv"' } });
});

/**
 * CSV body lines for one page. toCsv([], rows) yields "\n" + joined rows —
 * the leading newline is exactly the separator from the previous chunk (the
 * header chunk carries none), so chunks concatenate into one valid CSV.
 */
function csvRowsOnly(rows: (string | number | null)[][]): string {
  return rows.length === 0 ? "" : toCsv([], rows);
}
