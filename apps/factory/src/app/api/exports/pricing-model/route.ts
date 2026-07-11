/**
 * FP2.5 — the full pricing model as one CSV (the Owner's spreadsheet-audit
 * interface): a row per template base and per option, with any price-list
 * overrides. Cost columns are stripped for callers without the grain — the
 * exporter calls the filter EXPLICITLY (exports bypass response serialization).
 */
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { FEATURES, FIELDS } from "@/lib/auth/permissions";
import { toCsv } from "@/lib/csv";

export const permission = FEATURES.exportsRun;

const money = (c: number) => (c / 100).toFixed(2);
const delta = (v: number, mode: string) => (mode === "ABSOLUTE" ? money(v) : `${v / 100}%`);

export const GET = guarded(FEATURES.exportsRun, async (_req, { resolved }) => {
  const canCost = !!resolved && (resolved.isOwner || resolved.permissions.has(FIELDS.costsView));
  const [templates, lists] = await Promise.all([
    prisma.productTemplate.findMany({ // bounded: export: pricing model is config-sized
      where: { archivedAt: null },
      orderBy: { name: "asc" },
      include: { optionGroups: { orderBy: { sort: "asc" }, include: { options: { orderBy: { sort: "asc" } } } } },
    }),
    prisma.priceList.findMany({ where: { kind: "PARTY_TIER" }, include: { entries: true } }), // bounded: export: pricing model is config-sized
  ]);

  // overrides keyed for quick lookup: `${listName}` columns
  const listNames = lists.map((l) => l.name);
  const overrideFor = (listId: string, templateId: string | null, optionId: string | null): string => {
    const list = lists.find((l) => l.id === listId)!;
    if (optionId) {
      const e = list.entries.find((x) => x.optionId === optionId);
      return e?.priceDelta != null ? delta(e.priceDelta, e.priceDeltaMode ?? "ABSOLUTE") : "";
    }
    const e = list.entries.find((x) => x.templateId === templateId && x.optionId == null);
    return e?.basePriceCents != null ? money(e.basePriceCents) : "";
  };

  const headers = ["template", "row_type", "group", "option", "price", "price_mode", ...(canCost ? ["cost", "cost_mode"] : []), ...listNames.map((n) => `list:${n}`)];
  const rows: unknown[][] = [];
  for (const t of templates) {
    rows.push([t.name, "BASE", "", "", money(t.basePriceCents), "ABSOLUTE", ...(canCost ? [money(t.baseCostCents), "ABSOLUTE"] : []), ...lists.map((l) => overrideFor(l.id, t.id, null))]);
    for (const g of t.optionGroups) {
      for (const o of g.options) {
        rows.push([t.name, "OPTION", g.name, o.name, delta(o.priceDelta, o.priceDeltaMode), o.priceDeltaMode, ...(canCost ? [delta(o.costDelta, o.costDeltaMode), o.costDeltaMode] : []), ...lists.map((l) => overrideFor(l.id, t.id, o.id))]);
      }
    }
  }

  return new Response(toCsv(headers, rows), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="pricing-model.csv"' },
  });
});
