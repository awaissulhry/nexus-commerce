/**
 * FP3.4 — similar-quote recall (JobBOSS² verdict): past quotes for this party
 * or this garment template, won/lost with price, to anchor the new quote.
 * EPQ.3 — rows carry wasProduced (the quote became an order) so the rail can
 * chip "repeat".
 * EPQ.4 — the quote-vs-actual loop: produced rows whose order has SHIPPED
 * carry the order's ACTUAL cost beside the estimate ("won at €X · actual cost
 * €Y vs est €Z") from the FP6 ledger via the EPF lib (read-only). Bounded:
 * ≤5 rows feed the actuals lookup.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { quoteTotals } from "@/lib/quotes/compose-line";
import { orderActuals } from "@/lib/quotes/actuals";

export const permission = PAGES.quotes;

export const GET = guarded(PAGES.quotes, async (req: NextRequest, { resolved }) => {
  const partyId = req.nextUrl.searchParams.get("partyId");
  const templateId = req.nextUrl.searchParams.get("templateId");
  const excludeId = req.nextUrl.searchParams.get("excludeId") ?? "";
  if (!partyId && !templateId) return NextResponse.json({ quotes: [] });

  const quotes = await prisma.quote.findMany({
    where: {
      id: { not: excludeId },
      state: { in: ["ACCEPTED", "REJECTED"] },
      OR: [
        ...(partyId ? [{ partyId }] : []),
        ...(templateId ? [{ lines: { some: { templateId } } }] : []),
      ],
    },
    orderBy: { updatedAt: "desc" },
    take: 5,
    include: { party: { select: { name: true } }, lines: { select: { netPriceCents: true, costCents: true, qty: true } } },
  });

  // EPQ.4 — actuals for the produced rows (only orders that shipped resolve)
  const producedIds = quotes.map((q) => q.convertedOrderId).filter((id): id is string => id != null);
  const actuals = await orderActuals(producedIds);

  const rows = quotes.map((q) => {
    const t = quoteTotals(q.lines);
    const actual = q.convertedOrderId ? actuals.get(q.convertedOrderId) ?? null : null;
    return {
      id: q.id,
      number: q.number,
      partyName: q.party.name,
      state: q.state,
      netCents: t.netCents,
      marginPct: t.marginPct,
      wasProduced: q.convertedOrderId != null,
      // EPQ.4 — "won at €X · actual cost €Y vs est €Z" (null until shipped)
      actual: actual
        ? { orderNumber: actual.orderNumber, actualCostCents: actual.actualCostCents, estCostCents: actual.estCostCents }
        : null,
    };
  });
  return jsonStripped({ quotes: rows }, resolved);
});
