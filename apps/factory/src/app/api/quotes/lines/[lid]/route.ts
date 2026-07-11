/**
 * FP3 — edit a quote line (DRAFT only): recompose through the FP2.1 engine
 * with the party's price list and PERSIST the composed money — the browser
 * sends selections, the server owns the numbers. Returns the full compose
 * result (violations/materials/lines) for the rail, grain-stripped.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { composeQuoteLine } from "@/lib/quotes/compose-line";

export const permission = { PATCH: FEATURES.quotesCreate, DELETE: FEATURES.quotesCreate };

const Patch = z.object({
  templateId: z.string().nullable().optional(),
  selections: z.array(z.string()).optional(),
  adjustmentCents: z.number().int().optional(),
  adjustmentReason: z.string().max(300).nullable().optional(),
  qty: z.number().int().min(1).optional(),
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
  const selections = parsed.data.selections ?? ((line.selections as string[] | null) ?? []);
  const adjustmentCents = parsed.data.adjustmentCents ?? line.adjustmentCents;

  const data: Record<string, unknown> = {
    ...(parsed.data.templateId !== undefined ? { templateId: parsed.data.templateId } : {}),
    ...(parsed.data.selections !== undefined ? { selections: parsed.data.selections } : {}),
    ...(parsed.data.adjustmentCents !== undefined ? { adjustmentCents: parsed.data.adjustmentCents } : {}),
    ...(parsed.data.adjustmentReason !== undefined ? { adjustmentReason: parsed.data.adjustmentReason } : {}),
    ...(parsed.data.qty !== undefined ? { qty: parsed.data.qty } : {}),
    ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
  };

  let result = null;
  if (templateId) {
    const composed = await composeQuoteLine({ templateId, selections, adjustmentCents, priceListId: line.quote.party.priceListId });
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
    before: { lineId: lid, netPriceCents: line.netPriceCents, costCents: line.costCents, adjustmentCents: line.adjustmentCents, qty: line.qty },
    after: { lineId: lid, netPriceCents: updated.netPriceCents, costCents: updated.costCents, adjustmentCents: updated.adjustmentCents, qty: updated.qty },
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
