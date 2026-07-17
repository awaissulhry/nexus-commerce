/**
 * FP4 — one order: GET assembles the ONE-TIMELINE (email → quote → confirmed →
 * payments → work orders → shipment) from the linked records + audit; PATCH
 * drives promise-date edits and lifecycle transitions through the single
 * `canTransition` authority. CONFIRMED→IN_PRODUCTION is refused here (Start
 * production owns it); →CANCELLED is refused here (the cancel action owns it,
 * behind orders.cancel). Money is grain-stripped on the way out.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES, FEATURES } from "@/lib/auth/permissions";
import { orderTotals, depositRequiredCents, depositPaidCents, isDepositMet } from "@/lib/orders/money";
import { orderFinancials, type FinOrder } from "@/lib/financials/rollup";
import { actualCostByOrder } from "@/lib/financials/actual-cost";
import { buildTimeline } from "@/lib/orders/timeline";
import { countSlips, promiseRisk } from "@/lib/orders/promise";
import { type OrderState } from "@/lib/orders/transitions";
import { transitionOrder } from "@/lib/orders/transition-service";

export const permission = { GET: PAGES.orders, PATCH: FEATURES.ordersEdit };

const DETAIL_INCLUDE = {
  party: { select: { id: true, name: true, kind: true, depositDefaultPct: true, priceList: { select: { name: true } } } },
  lines: true,
  payments: { orderBy: { receivedAt: "asc" as const } },
  workOrders: { include: { stages: { orderBy: { sort: "asc" as const } } }, orderBy: { createdAt: "asc" as const } },
  bornFromQuote: { select: { id: true, number: true, createdAt: true, sentAt: true, state: true, depositPct: true } },
  conversation: { select: { id: true, subject: true, createdAt: true } },
  shipments: true,
  invoices: { select: { id: true, number: true, amountCents: true, sentAt: true, paidAt: true, createdAt: true }, orderBy: { createdAt: "asc" as const } }, // EPO.3 — chain chip + timeline
  revisions: { select: { rev: true, netDeltaCents: true, reason: true, createdAt: true }, orderBy: { rev: "asc" as const } }, // EPO.5 — amendments
  orderReturns: { select: { id: true, number: true, createdAt: true, lines: { select: { outcome: true, qty: true } } }, orderBy: { createdAt: "asc" as const } }, // EPO.5 — returns
  reviews: { select: { id: true, createdAt: true } },
};

async function detailPayload(id: string) {
  const order = await prisma.order.findUnique({ where: { id }, include: DETAIL_INCLUDE });
  if (!order) return null;
  const entityIds = [order.id, order.bornFromQuoteId, ...order.workOrders.map((w) => w.id), ...order.payments.map((p) => p.id)].filter(Boolean) as string[];
  const audits = await prisma.auditLog.findMany({ // bounded: per-order children
    where: { entityId: { in: entityIds }, entityType: { in: ["order", "quote", "workorder", "payment"] } },
    orderBy: { createdAt: "asc" },
    select: { entityType: true, action: true, after: true, createdAt: true },
  });
  const totals = orderTotals(order.lines);
  const depositRequired = depositRequiredCents(totals.netCents, order.bornFromQuote?.depositPct);
  const depositPaid = depositPaidCents(order.payments);

  // EPO.2 (E1) — the FULL order-to-cash truth on the order itself, via the
  // SAME FP9 fold the financials drawer uses (consume, never fork — parity by
  // construction). actualCost = Σ ledger OUT × material cost across the WOs.
  const actual = await actualCostByOrder([{ id: order.id, woIds: order.workOrders.map((w) => w.id) }]);
  const fin = orderFinancials({
    id: order.id, number: order.number, partyId: order.party.id, partyName: order.party.name, state: order.state, createdAtISO: order.createdAt.toISOString(),
    lines: order.lines,
    // EPF1 (D-13/D-14): document dates + WO completion keep this fold's
    // semantics identical to the financials drawer/tiles (one truth).
    payments: order.payments.map((p) => ({ kind: p.kind, amountCents: p.amountCents, receivedAtISO: p.receivedAt.toISOString() })),
    invoices: order.invoices.map((i) => ({ amountCents: i.amountCents ?? 0, paidAt: i.paidAt ? i.paidAt.toISOString() : null, issuedAtISO: i.createdAt.toISOString(), number: i.number })),
    depositPct: order.bornFromQuote?.depositPct,
    actualCostCents: actual.get(order.id) ?? null,
    actualComplete: order.workOrders.length > 0 && order.workOrders.every((w) => w.state === "DONE"),
  } satisfies FinOrder);

  // EPO.2 — credit AWARENESS, never a hold (D-rec): what this party still owes
  // on OTHER delivered/closed orders. One bounded aggregate.
  const partyRows = await prisma.$queryRaw<{ bal: number | bigint | null }[]>(Prisma.sql`
    SELECT COALESCE(l."net", 0) - COALESCE(pay."paid", 0) AS "bal"
    FROM "Order" o
    LEFT JOIN (SELECT "orderId", SUM("netPriceCents" * "qty") AS "net" FROM "OrderLine" GROUP BY "orderId") l ON l."orderId" = o."id"
    LEFT JOIN (SELECT "orderId", SUM("amountCents") AS "paid" FROM "Payment" GROUP BY "orderId") pay ON pay."orderId" = o."id"
    WHERE o."partyId" = ${order.party.id} AND o."id" <> ${order.id} AND o."state" IN ('DELIVERED', 'CLOSED')`);
  const owing = partyRows.map((r) => Number(r.bal ?? 0)).filter((b) => b > 0);

  // EPO.4 — promise integrity: slips from the trail, at-risk from remaining
  // stages × the global historical pace (one scalar aggregate).
  const promiseChanges = audits
    .filter((a) => a.entityType === "order" && a.action === "promise-changed")
    .map((a) => (a.after as { promiseDateAt?: string | null } | null)?.promiseDateAt ?? null);
  const remainingStages = order.workOrders
    .filter((w) => w.state !== "CANCELLED" && w.state !== "DONE")
    .reduce((n, w) => n + w.stages.filter((s) => !s.finishedAt).length, 0);
  const paceRow = await prisma.$queryRaw<{ pace: number | null }[]>(Prisma.sql`
    SELECT AVG((julianday("finishedAt") - julianday("startedAt")) * 86400000.0) AS "pace"
    FROM "WorkOrderStage" WHERE "finishedAt" IS NOT NULL AND "startedAt" IS NOT NULL`);
  const risk = promiseRisk({
    promiseAtISO: order.promiseDateAt ? order.promiseDateAt.toISOString() : null,
    state: order.state,
    remainingStages,
    perStageMs: paceRow[0]?.pace ?? null,
    now: Date.now(),
  });

  return {
    order,
    timeline: buildTimeline(order as never, audits as never),
    promise: {
      originalPromiseDateAt: order.originalPromiseDateAt,
      slips: countSlips(order.originalPromiseDateAt ? order.originalPromiseDateAt.toISOString() : null, promiseChanges),
      atRisk: risk.atRisk,
      late: risk.late,
      daysLeft: risk.daysLeft,
      neededDays: risk.neededDays,
    },
    money: {
      netCents: totals.netCents,
      costCents: totals.costCents,
      marginCents: totals.marginCents,
      marginPct: totals.marginPct,
      depositRequiredCents: depositRequired,
      depositPaidCents: depositPaid,
      depositMet: isDepositMet(depositRequired, depositPaid),
      // EPO1.3 (C8) — an order with no originating quote has no deposit terms:
      // the FD13 gate is OFF and the UI must say so instead of hiding the card.
      depositTermsMissing: !order.bornFromQuote,
      // EPO.2 — the fold's order-to-cash + est→actual margin surface
      invoicedCents: fin.invoicedCents,
      paidCents: fin.paidCents,
      balanceCents: fin.balanceCents,
      actualCostCents: fin.actualCostCents,
      actualMarginCents: fin.actualMarginCents,
      actualMarginPct: fin.actualMarginPct,
      actualIsPending: fin.actualIsPending,
      partyOutstandingCents: owing.reduce((s, b) => s + b, 0),
      partyOutstandingOrders: owing.length,
    },
  };
}

export const GET = guarded(PAGES.orders, async (_req, { params, resolved }) => {
  const { id } = await params;
  const payload = await detailPayload(id);
  if (!payload) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return jsonStripped(payload, resolved);
});

const Patch = z.object({
  promiseDateAt: z.string().nullable().optional(),
  state: z.enum(["CONFIRMED", "IN_PRODUCTION", "READY", "SHIPPED", "DELIVERED", "CLOSED", "CANCELLED"]).optional(),
  note: z.string().max(500).optional(),
  // EPO.4 (EPF D-9) — customer reference + urgency, owner-editable
  clientRef: z.string().trim().max(120).nullable().optional(),
  urgent: z.boolean().optional(),
  // EPO1.1 (D-6) — the caller's read stamp; a mismatch means someone else
  // changed the order since it was loaded → 409 instead of last-write-wins.
  expectedUpdatedAt: z.string().optional(),
});

export const PATCH = guarded(FEATURES.ordersEdit, async (req, { params, actor, resolved }) => {
  const { id } = await params;
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const body = parsed.data;

  const order = await prisma.order.findUnique({ where: { id }, select: { id: true, state: true, promiseDateAt: true, originalPromiseDateAt: true } });
  if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const from = order.state as OrderState;
  const hasFieldEdit = body.clientRef !== undefined || body.urgent !== undefined;
  if (body.promiseDateAt === undefined && !hasFieldEdit && (!body.state || body.state === from)) {
    return NextResponse.json({ error: "Nothing to change" }, { status: 400 });
  }

  // EPO1.3 (C3) — promise-date edits: guarded write + audit + a durable event.
  // EPO.4 — the FIRST promise seeds the immutable original; audits carry the
  // before-value so slips are derivable from the trail alone.
  if (body.promiseDateAt !== undefined) {
    const promiseDateAt = body.promiseDateAt ? new Date(body.promiseDateAt) : null;
    const res = await prisma.order.updateMany({
      where: { id, ...(body.expectedUpdatedAt && !body.state ? { updatedAt: new Date(body.expectedUpdatedAt) } : {}) },
      data: {
        promiseDateAt,
        ...(order.originalPromiseDateAt == null && promiseDateAt ? { originalPromiseDateAt: promiseDateAt } : {}),
      },
    });
    if (res.count === 0) return NextResponse.json({ error: "The order changed elsewhere — refresh and retry" }, { status: 409 });
    void audit({ actorId: actor!.id, entityType: "order", entityId: id, action: "promise-changed", before: { promiseDateAt: order.promiseDateAt }, after: { promiseDateAt } });
    await publishEventDurable("order.updated", { orderId: id, via: "promise-changed", promiseDateAt: promiseDateAt?.toISOString() ?? null });
  }

  // EPO.4 (D-9) — clientRef / urgent: audited field edits, live to SSE
  if (hasFieldEdit) {
    const data: { clientRef?: string | null; urgent?: boolean } = {};
    if (body.clientRef !== undefined) data.clientRef = body.clientRef === null || body.clientRef === "" ? null : body.clientRef;
    if (body.urgent !== undefined) data.urgent = body.urgent;
    await prisma.order.update({ where: { id }, data });
    void audit({ actorId: actor!.id, entityType: "order", entityId: id, action: "field-edited", after: data });
    await publishEventDurable("order.updated", { orderId: id, via: "field-edited" });
  }

  // EPO1.1 (C1/C2/C9) — state changes go through the ONE writer.
  if (body.state && body.state !== from) {
    const to = body.state as OrderState;
    if (to === "CANCELLED") return NextResponse.json({ error: "Use the Cancel action" }, { status: 422 });
    const outcome = await transitionOrder({
      orderId: id,
      to,
      via: from === "CANCELLED" && to === "CONFIRMED" ? "reopen" : "manual",
      actorId: actor!.id,
      note: body.note,
      // the promise write above already bumped updatedAt — only pin the stamp
      // when this PATCH is a pure state change.
      expectedUpdatedAt: body.promiseDateAt === undefined ? body.expectedUpdatedAt : undefined,
    });
    if (!outcome.ok) {
      return NextResponse.json({ error: outcome.error, useStartProduction: outcome.useStartProduction ?? false }, { status: outcome.status });
    }
  }

  const payload = await detailPayload(id);
  return jsonStripped(payload, resolved);
});
