/**
 * FP2.4 — preview-as-configurator: server-composes price/cost/margin/materials/
 * violations through the FP2.1 engine and grain-strips the response (a caller
 * without cost/margin grains mathematically cannot receive them — this is FP3's
 * dress rehearsal and the standing proof of the field boundary). Optional
 * goal-seek: solve the quote adjustment for a target net or margin.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { compose, goalSeekByMargin, goalSeekByNet } from "@/lib/pricing";
import { loadEngineTemplate, loadPriceListInput } from "@/lib/products/load-engine";

export const permission = PAGES.products;

const Body = z.object({
  templateId: z.string().min(1),
  selectedOptionIds: z.array(z.string()).default([]),
  priceListId: z.string().nullable().optional(),
  adjustmentCents: z.number().int().optional(),
  goalSeek: z.object({ by: z.enum(["net", "margin"]), value: z.number() }).nullable().optional(),
});

export const POST = guarded(PAGES.products, async (req, { resolved }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "templateId required" }, { status: 400 });
  const { templateId, selectedOptionIds, priceListId, adjustmentCents, goalSeek } = parsed.data;

  const template = await loadEngineTemplate(templateId);
  if (!template) return NextResponse.json({ error: "Template not found" }, { status: 404 });
  const priceList = await loadPriceListInput(priceListId);

  // goal-seek solves the adjustment against the un-adjusted base
  let appliedAdjustmentCents = adjustmentCents ?? 0;
  if (goalSeek) {
    const base = compose({ template, selectedOptionIds, priceList, adjustmentCents: 0 });
    const gs = goalSeek.by === "net"
      ? goalSeekByNet({ listPriceCents: base.listPriceCents, costCents: base.costCents }, goalSeek.value)
      : goalSeekByMargin({ listPriceCents: base.listPriceCents, costCents: base.costCents }, goalSeek.value);
    appliedAdjustmentCents = gs.adjustmentCents;
  }

  const result = compose({ template, selectedOptionIds, priceList, adjustmentCents: appliedAdjustmentCents });

  // enrich composed materials with names (display only; no money)
  const matIds = result.materials.map((m) => m.materialId);
  const materials = await prisma.material.findMany({ where: { id: { in: matIds } }, select: { id: true, name: true } });
  const nameById = Object.fromEntries(materials.map((m) => [m.id, m.name]));
  const enriched = {
    ...result,
    appliedAdjustmentCents,
    materials: result.materials.map((m) => ({ ...m, name: nameById[m.materialId] ?? "(unknown material)" })),
  };

  return jsonStripped(enriched, resolved);
});
