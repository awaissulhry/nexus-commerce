/**
 * FP9.4 — per-order financials, once, for every money view. FS1 rewrite: the
 * old path hydrated EVERY order with all lines/payments/invoices (22.5 MB and
 * 2 s at 50k orders — FS0-BASELINE) and its relation-includes carried the N-1
 * P2029 bomb.
 *
 * EPF1 split-path (D-13 semantics at FS1 cost): materializing 90k doc rows
 * into JS per request measured ~540ms at the 50k harness — intrinsic
 * transport, not Prisma overhead. So ONE exported API, two assembly paths:
 *
 * - HOT (default — tiles/by-order/party/deposits/import/export): payments
 *   `GROUP BY orderId, kind` and invoices `GROUP BY orderId` (SUM +
 *   GROUP_CONCAT of numbers). The pure fold receives PSEUDO doc entries
 *   carrying the sums — it only ever Σ-reduces them, so every per-order
 *   figure is arithmetically identical to folding the raw rows (the FS1
 *   Σ-first argument; parity-enforced). Pseudo entries carry NO dates, so the
 *   per-order Rome-month buckets DEGRADE to the documented no-date fallback
 *   (everything under the order's creation month) — hot callers must not
 *   read them; tiles' month figures come from `loadMonthMoney` instead.
 * - DOC-DATES (`{docDates: true}` — period + analytics by-month tables):
 *   per-row skinny raw selects, each document's own date driving the
 *   Rome-month buckets. Off the hot p50 gate by design.
 *
 * `cancelledWithMoney`, deposit fields and actualComplete/actualIsPending are
 * path-independent. Parity for BOTH paths vs the row-hydrating legacy fold is
 * enforced by scripts/scale/parity.ts.
 *
 * DateTime columns are TEXT ISO-8601 with a +00:00 suffix; range params
 * compare on the ms-precision prefix (substr 1..23) to avoid Z-vs-offset
 * ordering — same semantics as Prisma's gte/lte.
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "../db";
import { orderFinancials, type OrderFinancials, type FinOrder, type FinPayment, type FinInvoice, type MonthMoney } from "./rollup";
import { romeMonthWindowUtc } from "./rome-time";

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
type PaymentKindAgg = { orderId: string; kind: string; amountCents: number | bigint };
type InvoiceAgg = { orderId: string; totalCents: number | bigint; numbers: string | null };
type PaymentRow = { orderId: string; kind: string; amountCents: number; receivedAt: string | Date };
type InvoiceRow = { orderId: string; number: string; amountCents: number; createdAt: string | Date };

/** GROUP_CONCAT separator — US char, can never appear in a document number. */
const SEP = String.fromCharCode(31);

const num = (v: number | bigint | null | undefined) => Number(v ?? 0);
const iso = (v: string | Date) => (v instanceof Date ? v : new Date(v)).toISOString();

export type LoadOrderFinancialsOpts = {
  excludeStates?: string[];
  sorted?: boolean;
  /**
   * EPF1 (D-04): also load CANCELLED orders that carry money (≥1 payment or
   * invoice) even though CANCELLED is excluded — the caller splits them into
   * the `cancelledWithMoney` bucket by `state`.
   */
  includeCancelledMoney?: boolean;
  /**
   * Opt into per-row document reads so `invoicedByMonthCents` /
   * `paidByMonthCents` carry REAL Rome-month buckets (period + analytics
   * by-month tables). Default = hot aggregates (buckets degraded, ~90k rows
   * of transport avoided).
   */
  docDates?: boolean;
  /** EPF2 (?party= filter, EPO D-5 law) — scope the fold to one customer (WHERE o.partyId, index-backed). */
  partyId?: string;
};

export async function loadOrderFinancials(
  createdAt?: { gte?: Date; lte?: Date },
  opts?: LoadOrderFinancialsOpts,
): Promise<OrderFinancials[]> {
  const excluded = opts?.excludeStates ?? ["CANCELLED"];
  // rollup-only callers (analytics, deposits) skip the 47k-row sort — their
  // folds are order-independent and re-sort by their own keys
  const orderBy = opts?.sorted === false ? Prisma.empty : Prisma.sql`ORDER BY o."createdAt" DESC`;
  const range = Prisma.sql`${
    createdAt?.gte ? Prisma.sql`AND substr(o."createdAt", 1, 23) >= ${createdAt.gte.toISOString().slice(0, 23)}` : Prisma.empty
  } ${createdAt?.lte ? Prisma.sql`AND substr(o."createdAt", 1, 23) <= ${createdAt.lte.toISOString().slice(0, 23)}` : Prisma.empty} ${
    opts?.partyId ? Prisma.sql`AND o."partyId" = ${opts.partyId}` : Prisma.empty
  }`;
  const stateScope = opts?.includeCancelledMoney
    ? Prisma.sql`(o."state" NOT IN (${Prisma.join(excluded)}) OR (o."state" = 'CANCELLED' AND (EXISTS (SELECT 1 FROM "Payment" pp WHERE pp."orderId" = o."id") OR EXISTS (SELECT 1 FROM "Invoice" ii WHERE ii."orderId" = o."id"))))`
    : Prisma.sql`o."state" NOT IN (${Prisma.join(excluded)})`;

  const docDates = opts?.docDates === true;

  const [base, lineAggs, paymentData, invoiceData, actualAggs, woAggs] = await Promise.all([
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
    docDates
      ? // DOC-DATES: skinny per-row reads — each document's own date feeds the
        // Rome-month buckets ($queryRaw, not findMany: model materialization
        // of 90k rows costs ~230ms at the 50k harness)
        prisma.$queryRaw<PaymentRow[]>(Prisma.sql`SELECT "orderId", "kind", "amountCents", "receivedAt" FROM "Payment"`)
      : // HOT: one row per (order, kind) — Σ-first
        prisma.$queryRaw<PaymentKindAgg[]>(Prisma.sql`
          SELECT "orderId", "kind", SUM("amountCents") AS "amountCents" FROM "Payment" GROUP BY "orderId", "kind"`),
    docDates
      ? // same (createdAt, id) tie-break as the hot aggregate — same-ms invoice
        // pairs must order identically on every path (parity-enforced)
        prisma.$queryRaw<InvoiceRow[]>(Prisma.sql`SELECT "orderId", "number", "amountCents", "createdAt" FROM "Invoice" ORDER BY "createdAt" ASC, "id" ASC`)
      : // HOT: one row per order — total + the numbers (import matching reads
        // them in bulk), issue-ordered via ORDER BY inside the aggregate
        prisma.$queryRaw<InvoiceAgg[]>(Prisma.sql`
          SELECT "orderId", SUM("amountCents") AS "totalCents", GROUP_CONCAT("number", ${SEP} ORDER BY "createdAt" ASC, "id" ASC) AS "numbers"
          FROM "Invoice" GROUP BY "orderId"`),
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
  if (docDates) {
    for (const p of paymentData as PaymentRow[]) {
      const arr = payments.get(p.orderId) ?? [];
      arr.push({ kind: p.kind, amountCents: p.amountCents, receivedAtISO: iso(p.receivedAt) });
      payments.set(p.orderId, arr);
    }
  } else {
    // pseudo entries: one per kind, carrying the SQL sum. The fold only ever
    // Σ-reduces payments (paidCents; depositPaidCents filters kind DEPOSIT),
    // so Σ-first is arithmetically identical. No dates on purpose.
    for (const p of paymentData as PaymentKindAgg[]) {
      const arr = payments.get(p.orderId) ?? [];
      arr.push({ kind: p.kind, amountCents: num(p.amountCents) });
      payments.set(p.orderId, arr);
    }
  }

  const invoices = new Map<string, FinInvoice[]>();
  if (docDates) {
    for (const i of invoiceData as InvoiceRow[]) {
      const arr = invoices.get(i.orderId) ?? [];
      arr.push({ amountCents: i.amountCents, paidAt: null, issuedAtISO: iso(i.createdAt), number: i.number });
      invoices.set(i.orderId, arr);
    }
  } else {
    // pseudo collection per order: N entries where entry 0 carries the SQL
    // total and the rest 0 — Σ = totalCents (invoicedCents exact) and every
    // number is present (invoiceNumbers exact, issue-ordered). The fold only
    // Σ-reduces amounts and collects numbers, so this is a faithful
    // aggregate of the raw rows.
    for (const i of invoiceData as InvoiceAgg[]) {
      const numbers = (i.numbers ?? "").split(SEP).filter(Boolean);
      invoices.set(
        i.orderId,
        numbers.length
          ? numbers.map((n, idx) => ({ amountCents: idx === 0 ? num(i.totalCents) : 0, paidAt: null, number: n }))
          : [{ amountCents: num(i.totalCents), paidAt: null }],
      );
    }
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

/**
 * EPF1 hot-path tiles (D-13, TZ-exact, O(1) transport): the given Rome
 * month's invoiced/paid figures via two range-bounded SQL sums over the
 * month's exact UTC instant window. Same state scope as the tiles fold
 * (payments/invoices on excluded-state orders don't count; `createdAt`
 * mirrors the route's order-creation range filter).
 */
export async function loadMonthMoney(
  monthKey: string,
  scope?: { excludeStates?: string[]; createdAt?: { gte?: Date; lte?: Date }; partyId?: string },
): Promise<MonthMoney> {
  const window = romeMonthWindowUtc(monthKey);
  if (!window) return { monthKey, invoicedCents: 0, paidCents: 0 };
  const start = window.gte.toISOString().slice(0, 23);
  const end = window.lt.toISOString().slice(0, 23);
  const excluded = scope?.excludeStates ?? ["CANCELLED"];
  const orderScope = Prisma.sql`o."state" NOT IN (${Prisma.join(excluded)}) ${
    scope?.createdAt?.gte ? Prisma.sql`AND substr(o."createdAt", 1, 23) >= ${scope.createdAt.gte.toISOString().slice(0, 23)}` : Prisma.empty
  } ${scope?.createdAt?.lte ? Prisma.sql`AND substr(o."createdAt", 1, 23) <= ${scope.createdAt.lte.toISOString().slice(0, 23)}` : Prisma.empty} ${
    scope?.partyId ? Prisma.sql`AND o."partyId" = ${scope.partyId}` : Prisma.empty
  }`;

  const [paid, invoiced] = await Promise.all([
    prisma.$queryRaw<{ c: number | bigint | null }[]>(Prisma.sql`
      SELECT SUM(pay."amountCents") AS "c" FROM "Payment" pay
      JOIN "Order" o ON o."id" = pay."orderId"
      WHERE substr(pay."receivedAt", 1, 23) >= ${start} AND substr(pay."receivedAt", 1, 23) < ${end} AND ${orderScope}`),
    prisma.$queryRaw<{ c: number | bigint | null }[]>(Prisma.sql`
      SELECT SUM(inv."amountCents") AS "c" FROM "Invoice" inv
      JOIN "Order" o ON o."id" = inv."orderId"
      WHERE substr(inv."createdAt", 1, 23) >= ${start} AND substr(inv."createdAt", 1, 23) < ${end} AND ${orderScope}`),
  ]);
  return { monthKey, invoicedCents: num(invoiced[0]?.c), paidCents: num(paid[0]?.c) };
}
