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
import { canTransition, isStopgap, type OrderState } from "@/lib/orders/transitions";

export const permission = { GET: PAGES.orders, PATCH: FEATURES.ordersEdit };

const DETAIL_INCLUDE = {
  party: { select: { id: true, name: true, kind: true, depositDefaultPct: true, priceList: { select: { name: true } } } },
  lines: true,
  payments: { orderBy: { receivedAt: "asc" as const } },
  workOrders: { include: { stages: { orderBy: { sort: "asc" as const } } }, orderBy: { createdAt: "asc" as const } },
  bornFromQuote: { select: { id: true, number: true, createdAt: true, sentAt: true, state: true, depositPct: true } },
  conversation: { select: { id: true, subject: true, createdAt: true } },
  shipments: true,
  reviews: { select: { id: true, createdAt: true } },
};

async function detailPayload(id: string) {
  const order = await prisma.order.findUnique({ where: { id }, include: DETAIL_INCLUDE });
  if (!order) return null;
  const entityIds = [order.id, order.bornFromQuoteId, ...order.workOrders.map((w) => w.id), ...order.payments.map((p) => p.id)].filter(Boolean) as string[];
  const audits = await prisma.auditLog.findMany({
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
});

export const PATCH = guarded(FEATURES.ordersEdit, async (req, { params, actor, resolved }) => {
  const { id } = await params;
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const body = parsed.data;

  const order = await prisma.order.findUnique({ where: { id }, select: { id: true, number: true, state: true } });
  if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const from = order.state as OrderState;

  const data: { promiseDateAt?: Date | null; state?: OrderState; cancelReason?: null } = {};

  if (body.promiseDateAt !== undefined) {
    data.promiseDateAt = body.promiseDateAt ? new Date(body.promiseDateAt) : null;
  }

  if (body.state && body.state !== from) {
    const to = body.state as OrderState;
    if (to === "CANCELLED") return NextResponse.json({ error: "Use the Cancel action" }, { status: 400 });
    const chk = canTransition(from, to);
    if (!chk.ok) return NextResponse.json({ error: chk.reason, useStartProduction: chk.useStartProduction ?? false }, { status: 400 });
    data.state = to;
    if (from === "CANCELLED" && to === "CONFIRMED") data.cancelReason = null; // reopen clears the reason
  }

  if (Object.keys(data).length === 0) return NextResponse.json({ error: "Nothing to change" }, { status: 400 });

  await prisma.order.update({ where: { id }, data });

  if (data.state) {
    void audit({ actorId: actor!.id, entityType: "order", entityId: id, action: "state-changed", before: { from }, after: { to: data.state, note: body.note ?? null, stopgap: isStopgap(from, data.state) } });
    await publishEventDurable("order.updated", { orderId: id, from, to: data.state });
  }
  if (data.promiseDateAt !== undefined && !data.state) {
    void audit({ actorId: actor!.id, entityType: "order", entityId: id, action: "promise-changed", after: { promiseDateAt: data.promiseDateAt } });
  }

  const payload = await detailPayload(id);
  return jsonStripped(payload, resolved);
});
