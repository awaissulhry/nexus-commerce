/** FP6 — reorder a Work Order's priority; the board recomputes material coverage (higher priority takes scarce stock first). */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";

export const permission = FEATURES.workordersAdvance;

const Body = z.object({ priority: z.number().int() });

export const PATCH = guarded(FEATURES.workordersAdvance, async (req, { params, actor }) => {
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "priority required" }, { status: 400 });
  const wo = await prisma.workOrder.findUnique({ where: { id }, select: { id: true } });
  if (!wo) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await prisma.workOrder.update({ where: { id }, data: { priority: parsed.data.priority } });
  void audit({ actorId: actor!.id, entityType: "workorder", entityId: id, action: "priority", after: { priority: parsed.data.priority } });
  await publishEventDurable("workorder.updated", { workOrderId: id, priority: parsed.data.priority });
  return NextResponse.json({ ok: true });
});
