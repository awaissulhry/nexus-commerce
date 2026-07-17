/**
 * EPQ.3 — read-only compose of a stored line for the editor rail. The rail
 * previously previewed through /api/products/preview, which knows nothing of
 * qty — so the new quantity-tier / MOQ / size-surcharge waterfall rows would
 * be invisible until the first edit. This route composes the line EXACTLY as
 * the PATCH/send paths do (same composeQuoteLine, same discipline inputs) and
 * writes nothing. Works on sent quotes too (the rail is read-only there).
 * EPQ.4 — kind:"cost" waterfall rows (their labels embed rates) are dropped
 * for callers without the costs grain; name-based stripping handles the rest.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { composeQuoteLine } from "@/lib/quotes/compose-line";
import { canSeeCosts, dropCostRows } from "@/lib/quotes/cost-model";
import { readSelections } from "@/lib/quotes/selections";

export const permission = PAGES.quotes;

export const GET = guarded(PAGES.quotes, async (_req, { params, resolved }) => {
  const { lid } = await params;
  const line = await prisma.quoteLine.findUnique({
    where: { id: lid },
    include: { quote: { select: { party: { select: { priceListId: true } } } } },
  });
  if (!line) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!line.templateId) return NextResponse.json({ result: null });

  const composed = await composeQuoteLine({
    templateId: line.templateId,
    selections: readSelections(line.selections).optionIds,
    adjustmentCents: line.adjustmentCents,
    priceListId: line.quote.party.priceListId,
    qty: line.qty,
  });
  // EPQ.4 — cost rows are Owner-only (labels carry rates)
  const result = dropCostRows(composed?.result ?? null, canSeeCosts(resolved));
  return jsonStripped({ result }, resolved);
});
