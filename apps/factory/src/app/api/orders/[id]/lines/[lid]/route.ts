/**
 * FP4.4 — edit an order line's size-run (B2B matrix) BEFORE production starts.
 * Docstatus discipline (ERPNext verdict): lines lock once the order leaves
 * CONFIRMED — later changes would be audited revisions, not silent edits. The
 * line qty is kept in sync with the size-run total.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { parseSizeRun } from "@/lib/orders/production";

export const permission = FEATURES.ordersEdit;

const Body = z.object({
  sizeRun: z.record(z.string(), z.number()).nullable().optional(),
  qty: z.number().int().positive().optional(),
});

export const PATCH = guarded(FEATURES.ordersEdit, async (req, { params, actor }) => {
  const { id, lid } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const order = await prisma.order.findUnique({ where: { id }, select: { state: true } });
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  if (order.state !== "CONFIRMED") return NextResponse.json({ error: "Lines lock once production starts" }, { status: 400 });

  const line = await prisma.orderLine.findFirst({ where: { id: lid, orderId: id }, select: { id: true } });
  if (!line) return NextResponse.json({ error: "Line not found" }, { status: 404 });

  const data: Prisma.OrderLineUpdateInput = {};
  if (parsed.data.sizeRun !== undefined) {
    const clean = parsed.data.sizeRun ? Object.fromEntries(parseSizeRun(parsed.data.sizeRun).map((r) => [r.size, r.qty])) : null;
    const has = !!clean && Object.keys(clean).length > 0;
    data.sizeRun = has ? (clean as Prisma.InputJsonValue) : Prisma.JsonNull;
    const total = has ? Object.values(clean!).reduce((s, n) => s + n, 0) : 0;
    if (total > 0) data.qty = total; // keep qty in sync with the matrix
  }
  if (parsed.data.qty !== undefined && data.qty === undefined) data.qty = parsed.data.qty;
  if (Object.keys(data).length === 0) return NextResponse.json({ error: "Nothing to change" }, { status: 400 });

  await prisma.orderLine.update({ where: { id: lid }, data });
  void audit({ actorId: actor!.id, entityType: "order", entityId: id, action: "line-edited", after: { lineId: lid, ...data } });
  // EPO1.3 (C3) — a real quantity mutation was silent to SSE; live boards now see it
  await publishEventDurable("order.updated", { orderId: id, via: "line-edited", lineId: lid });
  return NextResponse.json({ ok: true });
});
