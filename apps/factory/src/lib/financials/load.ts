/**
 * FP9.4 — per-order financials, once, for every money view. FS1 rewrite: the
 * old path hydrated EVERY order with all lines/payments/invoices (22.5 MB and
 * 2 s at 50k orders — FS0-BASELINE) and its relation-includes carried the N-1
 * P2029 bomb. Now four SQL aggregates join in JS and feed the SAME pure
 * `orderFinancials()` fold via synthetic single-entry collections — sums in,
 * sums out, so every number is identical (enforced by scripts/scale/parity.ts
 * against the legacy implementation on both harness and live data).
 *
 * DateTime columns are TEXT ISO-8601 with a +00:00 suffix; range params
 * compare on the ms-precision prefix (substr 1..23) to avoid Z-vs-offset
 * ordering — same semantics as Prisma's gte/lte.
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "../db";
import { orderFinancials, type OrderFinancials, type FinOrder } from "./rollup";

type BaseRow = {
  id: string;
  number: string;
  state: string;
  createdAt: string | Date;
  partyId: string;
  partyName: string;
  depositPct: number | null;
};
type LineAgg = { orderId: string; netCents: number | bigint; costCents: number | bigint };
type ActualAgg = { orderId: string; actualCents: number | bigint };

const num = (v: number | bigint | null | undefined) => Number(v ?? 0);
const iso = (v: string | Date) => (v instanceof Date ? v : new Date(v)).toISOString();

export async function loadOrderFinancials(
  createdAt?: { gte?: Date; lte?: Date },
  opts?: { excludeStates?: string[]; sorted?: boolean },
): Promise<OrderFinancials[]> {
  const excluded = opts?.excludeStates ?? ["CANCELLED"];
  // rollup-only callers (analytics, deposits) skip the 47k-row sort — their
  // folds are order-independent and re-sort by their own keys
  const orderBy = opts?.sorted === false ? Prisma.empty : Prisma.sql`ORDER BY o."createdAt" DESC`;
  const range = Prisma.sql`${
    createdAt?.gte ? Prisma.sql`AND substr(o."createdAt", 1, 23) >= ${createdAt.gte.toISOString().slice(0, 23)}` : Prisma.empty
  } ${createdAt?.lte ? Prisma.sql`AND substr(o."createdAt", 1, 23) <= ${createdAt.lte.toISOString().slice(0, 23)}` : Prisma.empty}`;

  const [base, lineAggs, paymentAggs, invoiceAggs, actualAggs] = await Promise.all([
    prisma.$queryRaw<BaseRow[]>(Prisma.sql`
      SELECT o."id", o."number", o."state", o."createdAt", p."id" AS "partyId", p."name" AS "partyName", q."depositPct" AS "depositPct"
      FROM "Order" o
      JOIN "Party" p ON p."id" = o."partyId"
      LEFT JOIN "Quote" q ON q."id" = o."bornFromQuoteId"
      WHERE o."state" NOT IN (${Prisma.join(excluded)}) ${range}
      ${orderBy}`),
    prisma.$queryRaw<LineAgg[]>(Prisma.sql`
      SELECT l."orderId" AS "orderId", SUM(l."netPriceCents" * l."qty") AS "netCents", SUM(l."costCents" * l."qty") AS "costCents"
      FROM "OrderLine" l GROUP BY l."orderId"`),
    prisma.payment.groupBy({ by: ["orderId", "kind"], _sum: { amountCents: true } }),
    prisma.invoice.groupBy({ by: ["orderId"], _sum: { amountCents: true } }),
    prisma.$queryRaw<ActualAgg[]>(Prisma.sql`
      SELECT w."orderId" AS "orderId", SUM(ml."qty" * m."costCents") AS "actualCents"
      FROM "MovementLedger" ml
      JOIN "WorkOrder" w ON w."id" = ml."refId"
      JOIN "Material" m ON m."id" = ml."materialId"
      WHERE ml."refType" = 'WorkOrder' AND ml."type" = 'OUT'
      GROUP BY w."orderId"`),
  ]);

  const lines = new Map(lineAggs.map((l) => [l.orderId, l]));
  const payments = new Map<string, { kind: string; amountCents: number }[]>();
  for (const p of paymentAggs) {
    const arr = payments.get(p.orderId) ?? [];
    arr.push({ kind: p.kind, amountCents: p._sum.amountCents ?? 0 });
    payments.set(p.orderId, arr);
  }
  const invoices = new Map(invoiceAggs.map((i) => [i.orderId, num(i._sum.amountCents)]));
  const actual = new Map(actualAggs.map((a) => [a.orderId, Math.round(num(a.actualCents))]));

  return base.map((o) => {
    const l = lines.get(o.id);
    return orderFinancials({
      id: o.id, number: o.number, partyId: o.partyId, partyName: o.partyName, state: o.state, createdAtISO: iso(o.createdAt),
      // synthetic single-entry collections carrying the SQL sums — the pure
      // fold only ever reduces these, so Σ-first is arithmetically identical
      lines: l ? [{ netPriceCents: num(l.netCents), costCents: num(l.costCents), qty: 1 }] : [],
      payments: payments.get(o.id) ?? [],
      invoices: invoices.has(o.id) ? [{ amountCents: invoices.get(o.id)!, paidAt: null }] : [],
      depositPct: o.depositPct,
      actualCostCents: actual.get(o.id) ?? null,
    } satisfies FinOrder);
  });
}
