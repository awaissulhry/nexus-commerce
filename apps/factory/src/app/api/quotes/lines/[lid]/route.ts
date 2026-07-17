/**
 * FP3 — edit a quote line (DRAFT only): recompose through the FP2.1 engine
 * with the party's price list and PERSIST the composed money — the browser
 * sends selections, the server owns the numbers. Returns the full compose
 * result (violations/materials/lines) for the rail, grain-stripped.
 * EPQ.3 — size-run lines (B2B): `sizeRun` {size: qty} rides into
 * selections (writeSelections shape) and DERIVES qty = Σ sizes; discount
 * reason codes persist beside the free-text reason; qty feeds the engine's
 * quantity-tier/MOQ discipline.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { composeQuoteLine } from "@/lib/quotes/compose-line";
import { ADJUSTMENT_REASON_CODES } from "@/lib/quotes/reason-codes";
import { cleanSizeRun, readSelections, sizeRunTotal, writeSelections } from "@/lib/quotes/selections";

export const permission = { PATCH: FEATURES.quotesCreate, DELETE: FEATURES.quotesCreate };

const Patch = z.object({
  templateId: z.string().nullable().optional(),
  selections: z.array(z.string()).optional(),
  adjustmentCents: z.number().int().optional(),
  adjustmentReason: z.string().max(300).nullable().optional(),
  adjustmentReasonCode: z.enum(ADJUSTMENT_REASON_CODES).nullable().optional(), // EPQ.3
  qty: z.number().int().min(1).optional(),
  sizeRun: z.record(z.string(), z.number().int().min(0)).nullable().optional(), // EPQ.3 — {size: qty}; null clears
  description: z.string().max(300).nullable().optional(),
});

export const PATCH = guarded(FEATURES.quotesCreate, async (req, { params, actor, resolved }) => {
  const { lid } = await params;
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  const line = await prisma.quoteLine.findUnique({
    where: { id: lid },
    include: { quote: { select: { state: true, id: true, party: { select: { priceListId: true } } } } },
  });
  if (!line) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (line.quote.state !== "DRAFT") return NextResponse.json({ error: "Revise the quote to a draft before editing lines" }, { status: 400 });

  const templateId = parsed.data.templateId !== undefined ? parsed.data.templateId : line.templateId;
  const stored = readSelections(line.selections);
  const optionIds = parsed.data.selections ?? stored.optionIds;
  // EPQ.3 — a size-run OWNS qty (qty = Σ sizes); explicit qty applies only without one
  const sizeRun = parsed.data.sizeRun !== undefined ? cleanSizeRun(parsed.data.sizeRun) : stored.sizeRun;
  const qty = sizeRun ? sizeRunTotal(sizeRun) : Math.max(1, parsed.data.qty ?? line.qty);
  const adjustmentCents = parsed.data.adjustmentCents ?? line.adjustmentCents;

  const data: Record<string, unknown> = {
    ...(parsed.data.templateId !== undefined ? { templateId: parsed.data.templateId } : {}),
    ...(parsed.data.selections !== undefined || parsed.data.sizeRun !== undefined
      ? { selections: writeSelections(optionIds, sizeRun) as object }
      : {}),
    ...(parsed.data.adjustmentCents !== undefined ? { adjustmentCents: parsed.data.adjustmentCents } : {}),
    ...(parsed.data.adjustmentReason !== undefined ? { adjustmentReason: parsed.data.adjustmentReason } : {}),
    ...(parsed.data.adjustmentReasonCode !== undefined ? { adjustmentReasonCode: parsed.data.adjustmentReasonCode } : {}),
    ...(qty !== line.qty ? { qty } : {}),
    ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
  };

  let result = null;
  if (templateId) {
    const composed = await composeQuoteLine({ templateId, selections: optionIds, adjustmentCents, priceListId: line.quote.party.priceListId, qty });
    if (composed) {
      Object.assign(data, {
        listPriceCents: composed.listPriceCents,
        costCents: composed.costCents,
        netPriceCents: composed.netPriceCents,
        marginCents: composed.marginCents,
        marginPct: composed.marginPct,
      });
      result = composed.result;
    }
  } else {
    Object.assign(data, { listPriceCents: 0, costCents: 0, netPriceCents: 0, marginCents: 0, marginPct: 0 });
  }

  const updated = await prisma.quoteLine.update({ where: { id: lid }, data });
  // EPQ.1 — before/after money in the audit (S5: `{lineId}` alone said nothing)
  void audit({
    actorId: actor!.id,
    entityType: "quote",
    entityId: line.quote.id,
    action: "line.updated",
    before: { lineId: lid, netPriceCents: line.netPriceCents, costCents: line.costCents, adjustmentCents: line.adjustmentCents, qty: line.qty, adjustmentReasonCode: line.adjustmentReasonCode },
    after: { lineId: lid, netPriceCents: updated.netPriceCents, costCents: updated.costCents, adjustmentCents: updated.adjustmentCents, qty: updated.qty, adjustmentReasonCode: updated.adjustmentReasonCode },
  });
  return jsonStripped({ line: updated, result }, resolved);
});

export const DELETE = guarded(FEATURES.quotesCreate, async (_req, { params, actor }) => {
  const { lid } = await params;
  const line = await prisma.quoteLine.findUnique({ where: { id: lid }, include: { quote: { select: { state: true, id: true } } } });
  if (!line) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (line.quote.state !== "DRAFT") return NextResponse.json({ error: "Revise the quote to a draft before editing lines" }, { status: 400 });
  await prisma.quoteLine.delete({ where: { id: lid } });
  void audit({ actorId: actor!.id, entityType: "quote", entityId: line.quote.id, action: "line.removed", after: { lineId: lid } });
  return NextResponse.json({ ok: true });
});
