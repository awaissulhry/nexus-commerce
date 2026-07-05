/**
 * FP2.4 — load DB rows into the pure-engine shapes (src/lib/pricing.ts). Keeps
 * the engine free of Prisma so it stays exhaustively unit-testable; this is the
 * only bridge. Base BOM = perOption=false lines (per-option draws ride on the
 * option itself).
 */
import { prisma } from "@/lib/db";
import type { EngineTemplate, PriceListInput } from "@/lib/pricing";

export async function loadEngineTemplate(templateId: string): Promise<EngineTemplate | null> {
  const t = await prisma.productTemplate.findUnique({
    where: { id: templateId },
    include: {
      optionGroups: { orderBy: { sort: "asc" }, include: { options: { orderBy: { sort: "asc" } } } },
      constraints: true,
      bomLines: true,
    },
  });
  if (!t) return null;
  return {
    id: t.id,
    name: t.name,
    baseCostCents: t.baseCostCents,
    basePriceCents: t.basePriceCents,
    groups: t.optionGroups.map((g) => ({
      id: g.id,
      name: g.name,
      minSelect: g.minSelect,
      maxSelect: g.maxSelect,
      options: g.options.map((o) => ({
        id: o.id,
        groupId: g.id,
        name: o.name,
        costDeltaMode: o.costDeltaMode,
        costDelta: o.costDelta,
        priceDeltaMode: o.priceDeltaMode,
        priceDelta: o.priceDelta,
        materialDraws: (o.materialDraws as { materialId: string; qty: number; unit: string }[] | null) ?? null,
      })),
    })),
    constraints: t.constraints.map((c) => ({
      id: c.id,
      type: c.type,
      severity: c.severity,
      ifOptionId: c.ifOptionId,
      thenOptionId: c.thenOptionId,
      message: c.message,
    })),
    bomLines: t.bomLines.filter((l) => !l.perOption).map((l) => ({ materialId: l.materialId, qty: l.qty, unit: l.unit })),
  };
}

export async function loadPriceListInput(priceListId: string | null | undefined): Promise<PriceListInput> {
  if (!priceListId) return null;
  const list = await prisma.priceList.findUnique({ where: { id: priceListId }, include: { entries: true } });
  if (!list) return null;
  return {
    id: list.id,
    name: list.name,
    entries: list.entries.map((e) => ({
      templateId: e.templateId,
      optionId: e.optionId,
      basePriceCents: e.basePriceCents,
      priceDeltaMode: e.priceDeltaMode,
      priceDelta: e.priceDelta,
    })),
  };
}
