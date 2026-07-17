/**
 * EPO.5 — returns for a delivered order: per-line REPAIR / REMAKE / CREDIT
 * (MRPeasy per-line-outcome verdict; repairs are a brand asset for handmade
 * leather). REPAIR and REMAKE spawn a rework WorkOrder (`ORD-n/R1…`) back
 * through the NORMAL stage pipeline — cutting to QC, cert gate included —
 * priced at zero est-cost (the est lived on the original WO; actuals land via
 * the ledger as usual). CREDIT records no money here: the Owner records a
 * REFUND payment (EPF.1's mechanism, negative + mandatory note) — the return
 * response says so. RET numbers ride the house counter. All in ONE txn,
 * per-WO audits, durable events.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { nextNumberTx } from "@/lib/counters";
import { DEFAULT_STAGES } from "@/lib/orders/production";

export const permission = FEATURES.ordersEdit;

/** returns only make sense once the goods have left */
const RETURNABLE = new Set(["SHIPPED", "DELIVERED", "CLOSED"]);

const Body = z.object({
  notes: z.string().trim().max(500).optional(),
  lines: z
    .array(
      z.object({
        orderLineId: z.string().min(1),
        qty: z.number().int().positive(),
        outcome: z.enum(["REPAIR", "REMAKE", "CREDIT"]),
        note: z.string().trim().max(300).optional(),
      }),
    )
    .min(1, "At least one return line"),
});

export const POST = guarded(FEATURES.ordersEdit, async (req, { params, actor }) => {
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid return" }, { status: 400 });

  const order = await prisma.order.findUnique({
    where: { id },
    select: { id: true, number: true, state: true, lines: { select: { id: true, description: true, qty: true } }, workOrders: { select: { number: true } } },
  });
  if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!RETURNABLE.has(order.state)) return NextResponse.json({ error: `Returns apply to shipped/delivered orders — this one is ${order.state.toLowerCase()}` }, { status: 422 });

  const lineById = new Map(order.lines.map((l) => [l.id, l]));
  for (const rl of parsed.data.lines) {
    const l = lineById.get(rl.orderLineId);
    if (!l) return NextResponse.json({ error: "Unknown line in return" }, { status: 400 });
    if (rl.qty > l.qty) return NextResponse.json({ error: `Return qty ${rl.qty} exceeds the line's ${l.qty} (${l.description})` }, { status: 400 });
  }

  const stageRow = await prisma.appSetting.findUnique({ where: { key: "production.stages" } });
  const stages = (((stageRow?.value as { stages?: string[] } | null)?.stages ?? DEFAULT_STAGES) as string[]).filter((s) => typeof s === "string" && s.trim().length > 0);
  const reworkSeq = order.workOrders.filter((w) => /\/R\d+$/.test(w.number)).length;

  const created: { returnNumber: string; reworkWos: { id: string; number: string; lineDesc: string }[] } = { returnNumber: "", reworkWos: [] };
  await prisma.$transaction(async (tx) => {
    const number = await nextNumberTx(tx, "return");
    created.returnNumber = number;
    const ret = await tx.orderReturn.create({ data: { orderId: id, number, notes: parsed.data.notes ?? null }, select: { id: true } });
    let seq = reworkSeq;
    for (const rl of parsed.data.lines) {
      const line = lineById.get(rl.orderLineId)!;
      let reworkWorkOrderId: string | null = null;
      if (rl.outcome === "REPAIR" || rl.outcome === "REMAKE") {
        seq += 1;
        const wo = await tx.workOrder.create({
          data: {
            orderId: id,
            orderLineId: rl.orderLineId,
            number: `${order.number}/R${seq}`,
            label: `${rl.outcome === "REPAIR" ? "Repair" : "Remake"} ×${rl.qty} — ${line.description}`,
            state: "READY",
            estCostCents: 0, // est lived on the original WO; rework actuals land via the ledger
            stages: { create: stages.map((stage, i) => ({ stage, sort: i })) },
          },
          select: { id: true, number: true },
        });
        reworkWorkOrderId = wo.id;
        created.reworkWos.push({ id: wo.id, number: wo.number, lineDesc: line.description });
      }
      await tx.orderReturnLine.create({
        data: { returnId: ret.id, orderLineId: rl.orderLineId, qty: rl.qty, outcome: rl.outcome, note: rl.note ?? null, reworkWorkOrderId },
      });
    }
  });

  void audit({ actorId: actor!.id, entityType: "order", entityId: id, action: "return-recorded", after: { number: created.returnNumber, lines: parsed.data.lines.length, reworkWos: created.reworkWos.length } });
  for (const wo of created.reworkWos) {
    void audit({ actorId: actor!.id, entityType: "workorder", entityId: wo.id, action: "created", after: { orderId: id, number: wo.number, rework: true } });
  }
  await publishEventDurable("order.updated", { orderId: id, via: "field-edited" });
  if (created.reworkWos.length > 0) await publishEventDurable("workorder.created", { orderId: id, count: created.reworkWos.length, rework: true });

  const creditLines = parsed.data.lines.filter((l) => l.outcome === "CREDIT").length;
  return NextResponse.json({ ok: true, number: created.returnNumber, reworkWos: created.reworkWos.map((w) => w.number), creditLines, creditHint: creditLines > 0 ? "Record the credit as a REFUND payment (negative amount + note) so the balance stays true." : undefined });
});
