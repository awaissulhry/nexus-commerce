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
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES, FEATURES } from "@/lib/auth/permissions";
import { orderTotals, depositRequiredCents, depositPaidCents, isDepositMet } from "@/lib/orders/money";
import { buildTimeline } from "@/lib/orders/timeline";
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
  return {
    order,
    timeline: buildTimeline(order as never, audits as never),
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
  // EPO1.1 (D-6) — the caller's read stamp; a mismatch means someone else
  // changed the order since it was loaded → 409 instead of last-write-wins.
  expectedUpdatedAt: z.string().optional(),
});

export const PATCH = guarded(FEATURES.ordersEdit, async (req, { params, actor, resolved }) => {
  const { id } = await params;
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const body = parsed.data;

  const order = await prisma.order.findUnique({ where: { id }, select: { id: true, state: true } });
  if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const from = order.state as OrderState;
  if (body.promiseDateAt === undefined && (!body.state || body.state === from)) {
    return NextResponse.json({ error: "Nothing to change" }, { status: 400 });
  }

  // EPO1.3 (C3) — promise-date edits: guarded write + audit + a durable event
  // (they were audited but silent to SSE — live boards never saw them).
  if (body.promiseDateAt !== undefined) {
    const promiseDateAt = body.promiseDateAt ? new Date(body.promiseDateAt) : null;
    const res = await prisma.order.updateMany({
      where: { id, ...(body.expectedUpdatedAt && !body.state ? { updatedAt: new Date(body.expectedUpdatedAt) } : {}) },
      data: { promiseDateAt },
    });
    if (res.count === 0) return NextResponse.json({ error: "The order changed elsewhere — refresh and retry" }, { status: 409 });
    void audit({ actorId: actor!.id, entityType: "order", entityId: id, action: "promise-changed", after: { promiseDateAt } });
    await publishEventDurable("order.updated", { orderId: id, via: "promise-changed", promiseDateAt: promiseDateAt?.toISOString() ?? null });
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
