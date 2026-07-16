/**
 * FP3 — quotes pipeline: list (state filter, search, the three live counters)
 * + create. A quote is born from a matched thread or standalone; it prices
 * through the FP2.1 engine per line. Money via the grain strip.
 * EPQ.2 — the Overdue counter (always ~0 once the worker sweeps EXPIRED)
 * became "Expiring soon" (SENT, validity ending within the pre-expiry window),
 * clickable via ?state=expiring; rows carry the view counters for the compact
 * "viewed" cell; and the payload gains the Needs-follow-up queue (flagged SENT
 * quotes, snoozed rows hidden until their clock lapses).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { FEATURES, PAGES } from "@/lib/auth/permissions";
import { quoteTotals } from "@/lib/quotes/compose-line";
import { nextNumber } from "@/lib/counters";
import { ruleDays, type FollowUpRule } from "@/lib/quotes/followup";
import { loadFollowUpSettings } from "@/lib/quotes/followup-settings";

export const permission = { GET: PAGES.quotes, POST: FEATURES.quotesCreate };

export const GET = guarded(PAGES.quotes, async (req: NextRequest, { resolved }) => {
  const p = req.nextUrl.searchParams;
  const state = (p.get("state") ?? "all").toUpperCase();
  const q = (p.get("q") ?? "").trim();
  const now = new Date();
  const settings = await loadFollowUpSettings();
  const soonCutoff = new Date(now.getTime() + settings.preExpiryDays * 86_400_000);
  // EPQ.2 — "expiring" is a filter over SENT, not a stored state
  const expiringWhere = { state: "SENT" as const, validUntilAt: { gt: now, lte: soonCutoff } };
  const where = {
    ...(state === "EXPIRING" ? expiringWhere : state !== "ALL" ? { state: state as never } : {}),
    ...(q ? { OR: [{ number: { contains: q } }, { party: { name: { contains: q } } }] } : {}),
  };
  const [quotes, drafts, awaiting, expiringSoon, counts, followupRows] = await Promise.all([
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
    prisma.quote.count({ where: expiringWhere }),
    prisma.quote.groupBy({ by: ["state"], _count: { _all: true } }),
    prisma.quote.findMany({
      // EPQ.2 — the Needs-follow-up queue: flagged, not snoozed (future flag)
      where: { state: "SENT", followUpRule: { not: null }, followUpFlaggedAt: { lte: now } },
      orderBy: { followUpFlaggedAt: "asc" },
      take: 50,
      include: {
        party: { select: { id: true, name: true, kind: true } },
        lines: { select: { netPriceCents: true, costCents: true, qty: true } },
      },
    }),
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
      viewCount: qt.viewCount, firstViewedAt: qt.firstViewedAt, lastViewedAt: qt.lastViewedAt, // EPQ.2
    };
  });
  const followups = followupRows.map((qt) => {
    const rule = qt.followUpRule as FollowUpRule;
    return {
      id: qt.id, number: qt.number, party: qt.party, rule,
      days: ruleDays(rule, qt, now),
      flaggedAt: qt.followUpFlaggedAt, sentAt: qt.sentAt,
      lastViewedAt: qt.lastViewedAt, validUntilAt: qt.validUntilAt,
      netCents: quoteTotals(qt.lines).netCents,
    };
  });
  return jsonStripped(
    {
      quotes: rows,
      counters: { drafts, awaiting, expiringSoon },
      counts: Object.fromEntries(counts.map((c) => [c.state, c._count._all])),
      followups,
      followupConfig: { unviewedDays: settings.unviewedDays, viewedDays: settings.viewedDays, preExpiryDays: settings.preExpiryDays },
    },
    resolved,
  );
});

const Create = z.object({ partyId: z.string().min(1), conversationId: z.string().nullable().optional() });

export const POST = guarded(FEATURES.quotesCreate, async (req, { actor, resolved }) => {
  const parsed = Create.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "partyId required" }, { status: 400 });
  const party = await prisma.party.findUnique({ where: { id: parsed.data.partyId }, select: { id: true, depositDefaultPct: true } });
  if (!party) return NextResponse.json({ error: "Party not found" }, { status: 404 });

  // estimated lead time (honest v1 — real capable-to-promise from floor load lands in FP6)
  const leadRow = await prisma.appSetting.findUnique({ where: { key: "production.leadTimeDays" } });
  const leadDays = ((leadRow?.value as { days?: number })?.days) ?? 21;

  const number = await nextNumber("quote");
  const quote = await prisma.quote.create({
    data: {
      number,
      partyId: party.id,
      conversationId: parsed.data.conversationId ?? null,
      depositPct: party.depositDefaultPct ?? null,
      validUntilAt: new Date(Date.now() + 30 * 86400000), // 30-day default validity
      promiseDateAt: new Date(Date.now() + leadDays * 86400000),
    },
  });
  void audit({ actorId: actor!.id, entityType: "quote", entityId: quote.id, action: "created", after: { number } });
  // EPI1.1 (G11) — creation used to be silent: other viewers' linked-quote
  // rails stayed stale until an unrelated event happened by.
  void publishEventDurable("pricing.updated", {
    quoteId: quote.id,
    ...(quote.conversationId ? { conversationId: quote.conversationId } : {}),
  });
  return jsonStripped({ quote }, resolved, { status: 201 });
});
