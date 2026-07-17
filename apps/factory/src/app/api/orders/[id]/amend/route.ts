/**
 * EPO.5 — amendments after CONFIRMED: nothing confirmed is silently editable
 * (ERPNext docstatus verdict). POST applies line edits in ONE transaction:
 * freeze the before-lines into an OrderRevision (rev n), apply the edits,
 * record the field diff + net delta, and — when the net total changed (D-4) —
 * void the customer's acceptance (`reapprovalNeededAt`) until the Owner
 * records their re-approval (PATCH). Every step audited + a durable event.
 * The sending of the re-approval request through the Gmail thread is EPO.6's
 * notification machinery; until then the Owner confirms out-of-band and marks
 * it here (the skip is never silent — the banner + timeline carry it).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { applyAmendment } from "@/lib/orders/amend";

export const permission = FEATURES.ordersEdit;

/** states where an amendment still makes sense (post-ship changes are returns) */
const AMENDABLE = new Set(["CONFIRMED", "IN_PRODUCTION", "READY"]);

const Body = z.object({
  reason: z.string().trim().min(1, "A reason is required").max(500),
  edits: z
    .array(
      z.object({
        lineId: z.string().min(1),
        qty: z.number().int().positive().optional(),
        netPriceCents: z.number().int().min(0).optional(),
        description: z.string().trim().min(1).max(300).optional(),
        sizeRun: z.record(z.string(), z.number().int().min(0)).nullable().optional(),
      }),
    )
    .min(1, "At least one line edit"),
});

export const POST = guarded(FEATURES.ordersEdit, async (req, { params, actor }) => {
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid amendment" }, { status: 400 });

  const order = await prisma.order.findUnique({
    where: { id },
    select: { id: true, number: true, state: true, lines: { select: { id: true, description: true, qty: true, netPriceCents: true, sizeRun: true } }, revisions: { select: { rev: true }, orderBy: { rev: "desc" }, take: 1 } },
  });
  if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!AMENDABLE.has(order.state)) return NextResponse.json({ error: `A ${order.state.toLowerCase()} order can't be amended — record a return instead` }, { status: 422 });

  const known = new Set(order.lines.map((l) => l.id));
  if (parsed.data.edits.some((e) => !known.has(e.lineId))) return NextResponse.json({ error: "Unknown line in amendment" }, { status: 400 });

  const result = applyAmendment(order.lines, parsed.data.edits);
  if (result.changes.length === 0) return NextResponse.json({ error: "Nothing changed" }, { status: 400 });
  const rev = (order.revisions[0]?.rev ?? 0) + 1;
  const voidsAcceptance = result.netDeltaCents !== 0;
  // honesty: existing work orders are NOT re-exploded by an amendment — a
  // mid-production qty/size change is the Owner's to reconcile on the floor
  const workOrdersUntouched = order.state !== "CONFIRMED" && result.changes.some((c) => c.field === "qty" || c.field === "sizeRun");

  await prisma.$transaction(async (tx) => {
    await tx.orderRevision.create({
      data: {
        orderId: id,
        rev,
        snapshot: order.lines as unknown as Prisma.InputJsonValue,
        diff: result.changes as unknown as Prisma.InputJsonValue,
        netDeltaCents: result.netDeltaCents,
        reason: parsed.data.reason,
        actorId: actor!.id,
      },
    });
    for (const next of result.nextLines) {
      const prev = order.lines.find((l) => l.id === next.id)!;
      if (prev.qty === next.qty && prev.netPriceCents === next.netPriceCents && prev.description === next.description && prev.sizeRun === next.sizeRun) continue;
      await tx.orderLine.update({
        where: { id: next.id },
        data: { qty: next.qty, netPriceCents: next.netPriceCents, description: next.description, sizeRun: next.sizeRun === null ? Prisma.JsonNull : (next.sizeRun as Prisma.InputJsonValue | undefined) },
      });
    }
    if (voidsAcceptance) await tx.order.update({ where: { id }, data: { reapprovalNeededAt: new Date() } });
  });

  void audit({ actorId: actor!.id, entityType: "order", entityId: id, action: "amended", after: { rev, reason: parsed.data.reason, netDeltaCents: result.netDeltaCents, changes: result.changes.length, voidsAcceptance, workOrdersUntouched } });
  await publishEventDurable("order.updated", { orderId: id, via: "line-edited", rev });

  return NextResponse.json({ ok: true, rev, netDeltaCents: result.netDeltaCents, reapprovalNeeded: voidsAcceptance, workOrdersUntouched });
});

/** Mark the customer's re-approval recorded (Owner action, audited). */
export const PATCH = guarded(FEATURES.ordersEdit, async (req, { params, actor }) => {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || body.reapproved !== true) return NextResponse.json({ error: "reapproved: true required" }, { status: 400 });
  const res = await prisma.order.updateMany({ where: { id, reapprovalNeededAt: { not: null } }, data: { reapprovalNeededAt: null } });
  if (res.count === 0) return NextResponse.json({ error: "Nothing awaiting re-approval" }, { status: 400 });
  void audit({ actorId: actor!.id, entityType: "order", entityId: id, action: "reapproved", after: {} });
  await publishEventDurable("order.updated", { orderId: id, via: "field-edited" });
  return NextResponse.json({ ok: true });
});
