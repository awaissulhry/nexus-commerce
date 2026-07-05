/**
 * FP3.4 — similar-quote recall (JobBOSS² verdict): past quotes for this party
 * or this garment template, won/lost with price, to anchor the new quote.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { quoteTotals } from "@/lib/quotes/compose-line";

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

  const rows = quotes.map((q) => {
    const t = quoteTotals(q.lines);
    return { id: q.id, number: q.number, partyName: q.party.name, state: q.state, netCents: t.netCents, marginPct: t.marginPct };
  });
  return jsonStripped({ quotes: rows }, resolved);
});
