/**
 * EPQ.4 — CTP-lite promise suggestion for one quote, read-only. Terms:
 * base production.leadTimeDays (what quote creation already seeds) + backlog
 * (active WO count ÷ pricing.defaults.capacityPerWeek, weeks→days ceil) +
 * leather procurement (pricing.defaults.procurementLeadDays when the quote's
 * consumption-modeled lines outrun free leather stock — the FS1 SQL-side
 * ledger fold, bounded to SQM materials). Config keys absent ⇒ the suggestion
 * IS the base lead, exactly today's behavior. This route never writes — the
 * editor shows "suggested: {date} (3w base + …)" with an Apply button and the
 * Owner stays in control.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { pickConsumption } from "@/lib/pricing";
import { loadEngineTemplate } from "@/lib/products/load-engine";
import { materialStock } from "@/lib/materials/stock";
import { loadPromiseConfig } from "@/lib/quotes/cost-model";
import { formulaText, promiseTerms, requiredLeatherSqm } from "@/lib/quotes/promise";
import { readSelections } from "@/lib/quotes/selections";

export const permission = PAGES.quotes;

/** Free leather right now: Σ available (inStock − committed) across SQM materials. */
async function availableLeatherSqm(): Promise<number> {
  const leatherMats = await prisma.material.findMany({ where: { unit: "SQM", archivedAt: null }, select: { id: true } }); // bounded: materials catalog is config-sized
  if (leatherMats.length === 0) return 0;
  const ids = leatherMats.map((m) => m.id);
  // FS1 shape — fold the append-only ledger in SQL, never row-by-row
  const sums = await prisma.movementLedger.groupBy({ by: ["materialId", "type"], where: { materialId: { in: ids } }, _sum: { qty: true } });
  const byMat: Record<string, { type: string; qty: number }[]> = {};
  for (const s of sums) (byMat[s.materialId] ??= []).push({ type: s.type, qty: s._sum.qty ?? 0 });
  return ids.reduce((total, id) => total + materialStock(byMat[id] ?? [], 0).available, 0);
}

export const GET = guarded(PAGES.quotes, async (_req, { params }) => {
  const { id } = await params;
  const quote = await prisma.quote.findUnique({
    where: { id },
    select: {
      id: true,
      promiseDateAt: true,
      lines: { select: { templateId: true, selections: true, qty: true } },
    },
  });
  if (!quote) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [leadRow, config, activeWoCount] = await Promise.all([
    prisma.appSetting.findUnique({ where: { key: "production.leadTimeDays" } }),
    loadPromiseConfig(),
    prisma.workOrder.count({ where: { state: { in: ["BLOCKED", "READY", "IN_PROGRESS"] } } }),
  ]);
  const baseDays = ((leadRow?.value as { days?: number } | null)?.days) ?? 21;

  // Leather coverage — only consulted when it could add a term. A quote line
  // is "consumption-modeled" when its template+selection resolves a row.
  let leatherShort = false;
  let hasConsumption = false;
  if (config.procurementLeadDays != null) {
    const modeled: { leatherSqm: number; wastagePct: number; qty: number }[] = [];
    for (const line of quote.lines) {
      if (!line.templateId) continue;
      const template = await loadEngineTemplate(line.templateId); // quote lines are few; template load is catalog-sized
      if (!template) continue;
      const row = pickConsumption(template, readSelections(line.selections).optionIds);
      if (row) modeled.push({ leatherSqm: row.leatherSqm, wastagePct: row.wastagePct, qty: line.qty });
    }
    hasConsumption = modeled.length > 0;
    if (hasConsumption) {
      const required = requiredLeatherSqm(modeled);
      leatherShort = required > (await availableLeatherSqm());
    }
  }

  const { totalDays, terms } = promiseTerms({
    baseDays,
    activeWoCount,
    capacityPerWeek: config.capacityPerWeek,
    leatherShort: hasConsumption && leatherShort,
    procurementLeadDays: config.procurementLeadDays,
  });
  const suggestedAt = new Date(Date.now() + totalDays * 86_400_000);
  return NextResponse.json({
    suggestion: {
      dateISO: suggestedAt.toISOString(),
      totalDays,
      terms,
      formula: formulaText(terms),
    },
  });
});
