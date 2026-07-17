/**
 * FP9.4 — per-order financials, once, for every money view. FS1 rewrite: the
 * old path hydrated EVERY order with all lines/payments/invoices (22.5 MB and
 * 2 s at 50k orders — FS0-BASELINE) and its relation-includes carried the N-1
 * P2029 bomb. Lines and actual cost stay SQL aggregates; EPF1 (D-13/D-14)
 * moved payments/invoices to skinny per-row reads (orderId + cents + date —
 * the fold now buckets by document date in Europe/Rome, which an orderId-sum
 * can't carry) and added one grouped WO query for `actualComplete`. Parity
 * with the row-hydrating fold is enforced by scripts/scale/parity.ts.
 *
 * DateTime columns are TEXT ISO-8601 with a +00:00 suffix; range params
 * compare on the ms-precision prefix (substr 1..23) to avoid Z-vs-offset
 * ordering — same semantics as Prisma's gte/lte.
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "../db";
import { orderFinancials, type OrderFinancials, type FinOrder, type FinPayment, type FinInvoice } from "./rollup";

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
type WoAgg = { orderId: string; total: number | bigint; done: number | bigint };

const num = (v: number | bigint | null | undefined) => Number(v ?? 0);
const iso = (v: string | Date) => (v instanceof Date ? v : new Date(v)).toISOString();

export async function loadOrderFinancials(
  createdAt?: { gte?: Date; lte?: Date },
  opts?: {
    excludeStates?: string[];
    sorted?: boolean;
    /**
     * EPF1 (D-04): also load CANCELLED orders that carry money (≥1 payment or
     * invoice) even though CANCELLED is excluded — the caller splits them into
     * the `cancelledWithMoney` bucket by `state`.
     */
    includeCancelledMoney?: boolean;
  },
): Promise<OrderFinancials[]> {
  const excluded = opts?.excludeStates ?? ["CANCELLED"];
  // rollup-only callers (analytics, deposits) skip the 47k-row sort — their
  // folds are order-independent and re-sort by their own keys
  const orderBy = opts?.sorted === false ? Prisma.empty : Prisma.sql`ORDER BY o."createdAt" DESC`;
  const range = Prisma.sql`${
    createdAt?.gte ? Prisma.sql`AND substr(o."createdAt", 1, 23) >= ${createdAt.gte.toISOString().slice(0, 23)}` : Prisma.empty
  } ${createdAt?.lte ? Prisma.sql`AND substr(o."createdAt", 1, 23) <= ${createdAt.lte.toISOString().slice(0, 23)}` : Prisma.empty}`;
  const stateScope = opts?.includeCancelledMoney
    ? Prisma.sql`(o."state" NOT IN (${Prisma.join(excluded)}) OR (o."state" = 'CANCELLED' AND (EXISTS (SELECT 1 FROM "Payment" pp WHERE pp."orderId" = o."id") OR EXISTS (SELECT 1 FROM "Invoice" ii WHERE ii."orderId" = o."id"))))`
    : Prisma.sql`o."state" NOT IN (${Prisma.join(excluded)})`;

  const [base, lineAggs, paymentRows, invoiceRows, actualAggs, woAggs] = await Promise.all([
    prisma.$queryRaw<BaseRow[]>(Prisma.sql`
      SELECT o."id", o."number", o."state", o."createdAt", p."id" AS "partyId", p."name" AS "partyName", q."depositPct" AS "depositPct"
      FROM "Order" o
      JOIN "Party" p ON p."id" = o."partyId"
      LEFT JOIN "Quote" q ON q."id" = o."bornFromQuoteId"
      WHERE ${stateScope} ${range}
      ${orderBy}`),
    prisma.$queryRaw<LineAgg[]>(Prisma.sql`
      SELECT l."orderId" AS "orderId", SUM(l."netPriceCents" * l."qty") AS "netCents", SUM(l."costCents" * l."qty") AS "costCents"
      FROM "OrderLine" l GROUP BY l."orderId"`),
    // EPF1 (D-13): skinny per-row reads — 4 columns each, no relations. The
    // fold needs each document's own date for Rome-month bucketing. $queryRaw,
    // not findMany: Prisma model materialization of 90k rows costs ~230ms at
    // the 50k-order harness; raw rows keep the whole loader inside the FS1
    // p50 budget (measured — see EPF1-REPORT).
    prisma.$queryRaw<{ orderId: string; kind: string; amountCents: number; receivedAt: string | Date }[]>(
      Prisma.sql`SELECT "orderId", "kind", "amountCents", "receivedAt" FROM "Payment"`,
    ),
    prisma.$queryRaw<{ orderId: string; number: string; amountCents: number; createdAt: string | Date }[]>(
      Prisma.sql`SELECT "orderId", "number", "amountCents", "createdAt" FROM "Invoice" ORDER BY "createdAt" ASC`,
    ),
    prisma.$queryRaw<ActualAgg[]>(Prisma.sql`
      SELECT w."orderId" AS "orderId", SUM(ml."qty" * m."costCents") AS "actualCents"
      FROM "MovementLedger" ml
      JOIN "WorkOrder" w ON w."id" = ml."refId"
      JOIN "Material" m ON m."id" = ml."materialId"
      WHERE ml."refType" = 'WorkOrder' AND ml."type" = 'OUT'
      GROUP BY w."orderId"`),
    // EPF1 (D-14): actualComplete = the order has WOs and ALL are DONE
    prisma.$queryRaw<WoAgg[]>(Prisma.sql`
      SELECT w."orderId" AS "orderId", COUNT(*) AS "total", SUM(CASE WHEN w."state" = 'DONE' THEN 1 ELSE 0 END) AS "done"
      FROM "WorkOrder" w GROUP BY w."orderId"`),
  ]);

  const lines = new Map(lineAggs.map((l) => [l.orderId, l]));
  const payments = new Map<string, FinPayment[]>();
  for (const p of paymentRows) {
    const arr = payments.get(p.orderId) ?? [];
    arr.push({ kind: p.kind, amountCents: p.amountCents, receivedAtISO: iso(p.receivedAt) });
    payments.set(p.orderId, arr);
  }
  const invoices = new Map<string, FinInvoice[]>();
  for (const i of invoiceRows) {
    const arr = invoices.get(i.orderId) ?? [];
    arr.push({ amountCents: i.amountCents, paidAt: null, issuedAtISO: iso(i.createdAt), number: i.number });
    invoices.set(i.orderId, arr);
  }
  const actual = new Map(actualAggs.map((a) => [a.orderId, Math.round(num(a.actualCents))]));
  const woDone = new Map(woAggs.map((w) => [w.orderId, num(w.total) > 0 && num(w.done) === num(w.total)]));

  return base.map((o) => {
    const l = lines.get(o.id);
    return orderFinancials({
      id: o.id, number: o.number, partyId: o.partyId, partyName: o.partyName, state: o.state, createdAtISO: iso(o.createdAt),
      // synthetic single-entry line collection carrying the SQL sums — the pure
      // fold only ever reduces these, so Σ-first is arithmetically identical
      lines: l ? [{ netPriceCents: num(l.netCents), costCents: num(l.costCents), qty: 1 }] : [],
      payments: payments.get(o.id) ?? [],
      invoices: invoices.get(o.id) ?? [],
      depositPct: o.depositPct,
      actualCostCents: actual.get(o.id) ?? null,
      actualComplete: woDone.get(o.id) ?? false,
    } satisfies FinOrder);
  });
}
