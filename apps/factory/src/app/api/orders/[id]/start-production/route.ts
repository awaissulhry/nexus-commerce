/**
 * FP4 — Start production: one click turns a CONFIRMED order into work. Creates
 * a WorkOrder per line (per size for size-runs) with a stage row per the
 * Settings pipeline, applies the deposit gate (FD13 — unmet ⇒ WO BLOCKED
 * "awaiting deposit"), and advances the order to IN_PRODUCTION. Idempotent:
 * refuses if work orders already exist. Does NOT reserve stock (Katana verdict —
 * reservation is FP6/FP7).
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { orderTotals, depositRequiredCents, depositPaidCents, isDepositMet } from "@/lib/orders/money";
import { planWorkOrders, DEFAULT_STAGES } from "@/lib/orders/production";
import { reserveWorkOrder } from "@/lib/production/reserve-service";
import { transitionOrder } from "@/lib/orders/transition-service";

export const permission = FEATURES.ordersEdit;

export const POST = guarded(FEATURES.ordersEdit, async (_req, { params, actor }) => {
  const { id } = await params;
  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      lines: true,
      payments: { select: { kind: true, amountCents: true } },
      bornFromQuote: { select: { depositPct: true } },
      workOrders: { select: { id: true } },
    },
  });
  if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (order.state !== "CONFIRMED") return NextResponse.json({ error: "Only a confirmed order can start production" }, { status: 400 });
  if (order.workOrders.length > 0) return NextResponse.json({ error: "Production already started" }, { status: 409 });
  if (order.lines.length === 0) return NextResponse.json({ error: "Add at least one line before starting production" }, { status: 400 });

  const stageRow = await prisma.appSetting.findUnique({ where: { key: "production.stages" } });
  const stages = (((stageRow?.value as { stages?: string[] } | null)?.stages ?? DEFAULT_STAGES) as string[]).filter((s) => typeof s === "string" && s.trim().length > 0);

  const totals = orderTotals(order.lines);
  const required = depositRequiredCents(totals.netCents, order.bornFromQuote?.depositPct);
  const paid = depositPaidCents(order.payments);
  const depositMet = isDepositMet(required, paid);

  const planned = planWorkOrders(order.number, order.lines.map((l) => ({ lineId: l.id, description: l.description, qty: l.qty, costCents: l.costCents, sizeRun: l.sizeRun })), depositMet);

  // EPO1.2 — the state change and the WO explosion commit atomically through
  // the one transition writer (via "start-production" legalizes the edge).
  const createdWos: { id: string; number: string; orderLineId: string | null; state: string }[] = [];
  const outcome = await transitionOrder({
    orderId: id,
    to: "IN_PRODUCTION",
    via: "start-production",
    actorId: actor!.id,
    also: async (tx) => {
      for (const w of planned) {
        const created = await tx.workOrder.create({
          data: {
            orderId: id,
            orderLineId: w.orderLineId,
            number: w.number,
            label: w.label,
            state: w.state,
            blockedReason: w.blockedReason,
            estCostCents: w.estCostCents,
            stages: { create: stages.map((stage, i) => ({ stage, sort: i })) },
          },
          select: { id: true, number: true, orderLineId: true, state: true },
        });
        createdWos.push(created);
      }
      return { workOrders: planned.length, depositMet };
    },
  });
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });

  // FP6: reserve each WO's BOM material against the ledger (idempotent, per the line's selections)
  for (const w of createdWos) await reserveWorkOrder(w.id, w.orderLineId, actor!.id).catch(() => {});

  // EPO1.3 (C3) — per-WO trail: each work order's creation is its own audit row
  for (const w of createdWos) {
    void audit({ actorId: actor!.id, entityType: "workorder", entityId: w.id, action: "created", after: { orderId: id, number: w.number, state: w.state } });
  }
  await publishEventDurable("workorder.created", { orderId: id, count: planned.length, blocked: !depositMet });

  return NextResponse.json({ ok: true, workOrders: planned.length, blocked: !depositMet, stages: stages.length });
});
