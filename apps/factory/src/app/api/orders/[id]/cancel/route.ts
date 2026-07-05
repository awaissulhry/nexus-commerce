/**
 * FP4 — cancel an order (behind orders.cancel, its own grain). A reason is
 * required; open work orders are cancelled too (compensating). Reopen is the
 * named backward edge on PATCH (CANCELLED→CONFIRMED). Every move audited +
 * event-published; history is append-only.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { canTransition, type OrderState } from "@/lib/orders/transitions";

export const permission = FEATURES.ordersCancel;

const Body = z.object({ reason: z.string().trim().min(1, "A reason is required").max(500) });

export const POST = guarded(FEATURES.ordersCancel, async (req, { params, actor }) => {
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "A reason is required" }, { status: 400 });

  const order = await prisma.order.findUnique({ where: { id }, select: { id: true, state: true } });
  if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const from = order.state as OrderState;
  const chk = canTransition(from, "CANCELLED");
  if (!chk.ok) return NextResponse.json({ error: chk.reason ?? "Cannot cancel from this state" }, { status: 400 });

  await prisma.$transaction([
    prisma.order.update({ where: { id }, data: { state: "CANCELLED", cancelReason: parsed.data.reason } }),
    // compensating: open work orders are cancelled with the order
    prisma.workOrder.updateMany({ where: { orderId: id, state: { notIn: ["DONE", "CANCELLED"] } }, data: { state: "CANCELLED", blockedReason: null } }),
  ]);

  void audit({ actorId: actor!.id, entityType: "order", entityId: id, action: "state-changed", before: { from }, after: { to: "CANCELLED", reason: parsed.data.reason } });
  await publishEventDurable("order.updated", { orderId: id, from, to: "CANCELLED" });

  return NextResponse.json({ ok: true, state: "CANCELLED" });
});
