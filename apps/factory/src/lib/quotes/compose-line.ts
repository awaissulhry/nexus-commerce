/**
 * FP3 — compose a quote line through the FP2.1 engine (the only price
 * authority). Loads the party's price list so the line is party-scoped, runs
 * compose(), and returns the per-unit money to persist. The browser never
 * computes money — it PATCHes selections and receives composed values.
 * EPQ.3 — qty rides in (tier + below-MOQ discipline) and the measurement
 * surcharge rule is loaded from AppSetting; all default OFF ⇒ zero-delta.
 */
import { compose, type ComposeResult } from "@/lib/pricing";
import { loadEngineTemplate, loadPriceListInput } from "@/lib/products/load-engine";
import { loadMeasurementSurcharge } from "./measurement-surcharge";

export type ComposedLine = {
  listPriceCents: number;
  costCents: number;
  netPriceCents: number;
  marginCents: number;
  marginPct: number;
  marginNegative: boolean;
  hasBlockingViolation: boolean;
  result: ComposeResult; // full result for the UI rail (violations, lines, materials)
};

export async function composeQuoteLine(input: {
  templateId: string;
  selections: string[];
  adjustmentCents: number;
  priceListId: string | null | undefined;
  qty: number; // EPQ.3 — drives quantity tiers + MOQ; every caller passes the line's qty
}): Promise<ComposedLine | null> {
  const template = await loadEngineTemplate(input.templateId);
  if (!template) return null;
  const [priceList, sizeSurcharge] = await Promise.all([
    loadPriceListInput(input.priceListId),
    loadMeasurementSurcharge(),
  ]);
  const result = compose({
    template,
    selectedOptionIds: input.selections,
    priceList,
    adjustmentCents: input.adjustmentCents,
    qty: input.qty,
    sizeSurcharge,
  });
  return {
    listPriceCents: result.listPriceCents,
    costCents: result.costCents,
    netPriceCents: result.netPriceCents,
    marginCents: result.marginCents,
    marginPct: result.marginPct,
    marginNegative: result.marginNegative,
    hasBlockingViolation: result.hasBlockingViolation,
    result,
  };
}

/** Quote-level rollups (per-unit money × qty summed across lines). */
export function quoteTotals(lines: { netPriceCents: number; costCents: number; qty: number }[]) {
  const net = lines.reduce((s, l) => s + l.netPriceCents * l.qty, 0);
  const cost = lines.reduce((s, l) => s + l.costCents * l.qty, 0);
  const margin = net - cost;
  return { netCents: net, costCents: cost, marginCents: margin, marginPct: net === 0 ? 0 : (margin / net) * 100 };
}
