/**
 * FP4 → EPO1.2 — cancel an order (behind orders.cancel, its own grain). A
 * reason is required; open work orders are cancelled too (compensating), in
 * the SAME transaction as the state change, via the one transition writer.
 * EPO1.3 (C3): the cascade is no longer silent — every cancelled work order
 * gets its own audit row and a workorder.updated event fires. Reopen is the
 * named backward edge on PATCH (CANCELLED→CONFIRMED).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { transitionOrder } from "@/lib/orders/transition-service";

export const permission = FEATURES.ordersCancel;

const Body = z.object({
  reason: z.string().trim().min(1, "A reason is required").max(500),
  expectedUpdatedAt: z.string().optional(), // D-6 read stamp
});

export const POST = guarded(FEATURES.ordersCancel, async (req, { params, actor }) => {
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "A reason is required" }, { status: 400 });

  let cancelledWos: { id: string; number: string; state: string }[] = [];
  const outcome = await transitionOrder({
    orderId: id,
    to: "CANCELLED",
    via: "cancel",
    actorId: actor!.id,
    reason: parsed.data.reason,
    expectedUpdatedAt: parsed.data.expectedUpdatedAt,
    also: async (tx) => {
      // compensating: open work orders are cancelled with the order
      const open = await tx.workOrder.findMany({
        where: { orderId: id, state: { notIn: ["DONE", "CANCELLED"] } },
        select: { id: true, number: true, state: true }, // bounded: per-order work orders
      });
      if (open.length > 0) {
        await tx.workOrder.updateMany({ where: { id: { in: open.map((w) => w.id) } }, data: { state: "CANCELLED", blockedReason: null } });
      }
      cancelledWos = open;
      return { cancelledWorkOrders: open.length };
    },
  });
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });

  // EPO1.3 (C3) — per-WO trail: each work order's cancellation is its own audit row
  for (const w of cancelledWos) {
    void audit({ actorId: actor!.id, entityType: "workorder", entityId: w.id, action: "state-changed", before: { from: w.state }, after: { to: "CANCELLED", via: "order-cancelled", number: w.number } });
  }
  if (cancelledWos.length > 0) {
    await publishEventDurable("workorder.updated", { orderId: id, cancelled: cancelledWos.length });
  }

  return NextResponse.json({ ok: true, state: "CANCELLED" });
});
