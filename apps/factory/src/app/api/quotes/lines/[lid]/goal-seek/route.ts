/**
 * EPQ.3 — goal-seek for the editor rail (kills seam S7): given a target QUOTE
 * net (cents) or margin (%), solve THIS line's per-unit adjustment through the
 * engine's goalSeekByNet/goalSeekByMargin (src/lib/quotes/goal-seek.ts — reuse,
 * no forked math). READ-ONLY: it returns the solved adjustmentCents and the
 * projected quote totals; the client persists via the normal line PATCH (which
 * recomposes, persists, and audits) — discipline: the adjustment still needs a
 * reason, so the UI focuses the reason field after applying. DRAFT only.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { composeQuoteLine } from "@/lib/quotes/compose-line";
import { solveLineAdjustment } from "@/lib/quotes/goal-seek";
import { readSelections } from "@/lib/quotes/selections";

export const permission = FEATURES.quotesCreate;

const Body = z.object({
  by: z.enum(["net", "margin"]),
  value: z.number().finite(), // net: target quote net in CENTS · margin: target %
});

export const POST = guarded(FEATURES.quotesCreate, async (req, { params, resolved }) => {
  const { lid } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  const line = await prisma.quoteLine.findUnique({
    where: { id: lid },
    include: {
      quote: {
        select: {
          id: true,
          state: true,
          party: { select: { priceListId: true } },
          lines: { select: { id: true, netPriceCents: true, costCents: true, qty: true } },
        },
      },
    },
  });
  if (!line) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (line.quote.state !== "DRAFT") return NextResponse.json({ error: "Revise the quote to a draft before goal-seeking" }, { status: 400 });
  if (!line.templateId) return NextResponse.json({ error: "Pick a product for this line first" }, { status: 400 });

  // this line WITHOUT its adjustment (list/cost are what the engine composes;
  // tiers/MOQ/size surcharges are already folded into listPriceCents)
  const composed = await composeQuoteLine({
    templateId: line.templateId,
    selections: readSelections(line.selections).optionIds,
    adjustmentCents: 0,
    priceListId: line.quote.party.priceListId,
    qty: line.qty,
  });
  if (!composed) return NextResponse.json({ error: "Could not compose the line" }, { status: 400 });

  const others = line.quote.lines
    .filter((l) => l.id !== lid)
    .reduce(
      (acc, l) => ({ netCents: acc.netCents + l.netPriceCents * l.qty, costCents: acc.costCents + l.costCents * l.qty }),
      { netCents: 0, costCents: 0 },
    );

  const solution = solveLineAdjustment(
    parsed.data.by,
    parsed.data.value,
    { listPriceCents: composed.listPriceCents, costCents: composed.costCents, qty: line.qty },
    others,
  );
  return jsonStripped(solution, resolved);
});
