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
      quantityBreaks: { orderBy: { minQty: "asc" } }, // EPQ.3 — tier rules ride the template
      consumption: true, // EPQ.4 — leather m² per size (no rows = cost model dormant)
    },
  });
  if (!t) return null;
  return {
    id: t.id,
    name: t.name,
    baseCostCents: t.baseCostCents,
    basePriceCents: t.basePriceCents,
    // EPQ.3 — pricing discipline inputs (absent/empty ⇒ zero-delta in compose)
    quantityBreaks: t.quantityBreaks.map((b) => ({ minQty: b.minQty, priceDeltaMode: b.priceDeltaMode, priceDelta: b.priceDelta })),
    moqQty: t.moqQty,
    moqSurchargeMode: t.moqSurchargeMode,
    moqSurcharge: t.moqSurcharge,
    // EPQ.4 — structured cost inputs (absent ⇒ cost parity in compose)
    laborHours: t.laborHours,
    consumption: t.consumption.map((c) => ({ sizeKey: c.sizeKey, leatherSqm: c.leatherSqm, wastagePct: c.wastagePct })),
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
