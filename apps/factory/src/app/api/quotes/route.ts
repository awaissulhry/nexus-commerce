/**
 * FP3 — quotes pipeline: list (state filter, search, the three live counters)
 * + create. A quote is born from a matched thread or standalone; it prices
 * through the FP2.1 engine per line. Money via the grain strip.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { FEATURES, PAGES } from "@/lib/auth/permissions";
import { quoteTotals } from "@/lib/quotes/compose-line";
import { nextNumber } from "@/lib/counters";

export const permission = { GET: PAGES.quotes, POST: FEATURES.quotesCreate };

export const GET = guarded(PAGES.quotes, async (req: NextRequest, { resolved }) => {
  const p = req.nextUrl.searchParams;
  const state = (p.get("state") ?? "all").toUpperCase();
  const q = (p.get("q") ?? "").trim();
  const where = {
    ...(state !== "ALL" ? { state: state as never } : {}),
    ...(q ? { OR: [{ number: { contains: q } }, { party: { name: { contains: q } } }] } : {}),
  };
  const now = new Date();
  const [quotes, drafts, awaiting, overdue, counts] = await Promise.all([
    prisma.quote.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: 200,
      include: {
        party: { select: { id: true, name: true, kind: true } },
        lines: { select: { netPriceCents: true, costCents: true, qty: true } },
      },
    }),
    prisma.quote.count({ where: { state: "DRAFT" } }),
    prisma.quote.count({ where: { state: "SENT" } }),
    prisma.quote.count({ where: { state: { in: ["DRAFT", "SENT"] }, validUntilAt: { lt: now } } }),
    prisma.quote.groupBy({ by: ["state"], _count: { _all: true } }),
  ]);

  const rows = quotes.map((qt) => {
    const totals = quoteTotals(qt.lines);
    return {
      id: qt.id, number: qt.number, state: qt.state,
      party: qt.party, depositPct: qt.depositPct,
      validUntilAt: qt.validUntilAt, promiseDateAt: qt.promiseDateAt,
      convertedOrderId: qt.convertedOrderId, updatedAt: qt.updatedAt,
      netCents: totals.netCents, costCents: totals.costCents, marginCents: totals.marginCents, marginPct: totals.marginPct,
      lineCount: qt.lines.length,
    };
  });
  return jsonStripped({ quotes: rows, counters: { drafts, awaiting, overdue }, counts: Object.fromEntries(counts.map((c) => [c.state, c._count._all])) }, resolved);
});

const Create = z.object({ partyId: z.string().min(1), conversationId: z.string().nullable().optional() });

export const POST = guarded(FEATURES.quotesCreate, async (req, { actor, resolved }) => {
  const parsed = Create.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "partyId required" }, { status: 400 });
  const party = await prisma.party.findUnique({ where: { id: parsed.data.partyId }, select: { id: true, depositDefaultPct: true } });
  if (!party) return NextResponse.json({ error: "Party not found" }, { status: 404 });

  const number = await nextNumber("quote");
  const quote = await prisma.quote.create({
    data: {
      number,
      partyId: party.id,
      conversationId: parsed.data.conversationId ?? null,
      depositPct: party.depositDefaultPct ?? null,
      validUntilAt: new Date(Date.now() + 30 * 86400000), // 30-day default validity
    },
  });
  void audit({ actorId: actor!.id, entityType: "quote", entityId: quote.id, action: "created", after: { number } });
  return jsonStripped({ quote }, resolved, { status: 201 });
});
