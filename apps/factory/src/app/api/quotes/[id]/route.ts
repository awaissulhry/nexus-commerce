/**
 * FP3 — one quote: full read (lines w/ template, versions, party+list,
 * conversation), patch (deposit/dates/state/lostReason — with lifecycle
 * guards), delete (draft only). Sent quotes are frozen: editing money-bearing
 * fields on a sent quote is refused (a new version is created on re-send).
 * EPQ.1 — the PATCH enforces the forward-only state machine
 * (src/lib/quotes/transitions.ts): illegal edges 422 and are audited from→to;
 * deposit/dates are DRAFT-only; lostReason only lands on a lost outcome.
 * EPQ.2 — manual Mark accepted / Mark rejected ring every other active Owner
 * (the actor already knows — S6's silent half closed).
 * EPQ.3 — the GET flags a duplicate open quote (same party, same template set,
 * DRAFT/SENT) for the editor's warning banner. Bounded query, pure comparison.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { FEATURES, PAGES } from "@/lib/auth/permissions";
import { quoteTotals } from "@/lib/quotes/compose-line";
import { canTransition, lostReasonAllowed, type QuoteState } from "@/lib/quotes/transitions";
import { findDuplicateOpenQuote } from "@/lib/quotes/duplicate";
import { notifyOwners } from "@/lib/quotes/notify-owners";
import { naturaForMode, type TaxMode } from "@/lib/quotes/tax";

export const permission = { GET: PAGES.quotes, PATCH: FEATURES.quotesCreate, DELETE: FEATURES.quotesCreate };

export const GET = guarded(PAGES.quotes, async (_req, { params, resolved }) => {
  const { id } = await params;
  const quote = await prisma.quote.findUnique({
    where: { id },
    include: {
      // EPQ.5 — taxMode/vatNumber/vies* feed the rail's Tax & legal card
      party: { select: { id: true, name: true, kind: true, paymentTerms: true, priceListId: true, priceList: { select: { name: true } }, taxMode: true, vatNumber: true, viesRequestId: true, viesCheckedAt: true } },
      conversation: { select: { id: true, subject: true } },
      lines: { orderBy: { id: "asc" }, include: { template: { select: { id: true, name: true } } } },
      versions: { orderBy: { version: "desc" }, select: { id: true, version: true, pdfRef: true, sentAt: true } },
    },
  });
  if (!quote) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const totals = quoteTotals(quote.lines);

  // EPQ.3 — duplicate-open-quote banner: another DRAFT/SENT quote for the same
  // party with the same template set is probably the same negotiation twice.
  // Bounded candidate list; pure set comparison (src/lib/quotes/duplicate.ts).
  let duplicate: { id: string; number: string } | null = null;
  const templateIds = quote.lines.map((l) => l.templateId);
  if ((quote.state === "DRAFT" || quote.state === "SENT") && templateIds.some((t) => t != null)) {
    const candidates = await prisma.quote.findMany({
      where: { partyId: quote.partyId, id: { not: id }, state: { in: ["DRAFT", "SENT"] } },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: { id: true, number: true, lines: { select: { templateId: true } } },
    });
    duplicate = findDuplicateOpenQuote(
      templateIds,
      candidates.map((c) => ({ id: c.id, number: c.number, templateIds: c.lines.map((l) => l.templateId) })),
    );
  }
  return jsonStripped({ quote, totals, duplicate }, resolved);
});

const Patch = z.object({
  depositPct: z.number().min(0).max(100).nullable().optional(),
  promiseDateAt: z.string().datetime().nullable().optional(),
  validUntilAt: z.string().datetime().nullable().optional(),
  state: z.enum(["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED"]).optional(),
  lostReason: z.string().max(500).nullable().optional(),
  // EPQ.5 — compliance fields (DRAFT-only, like deposit/dates)
  taxMode: z.enum(["IT_B2C", "IT_B2B", "EU_B2B", "EXTRA_EU"]).optional(),
  depositKind: z.enum(["ACCONTO", "CAPARRA_CONFIRMATORIA"]).optional(),
  validityWording: z.enum(["REVOCABLE", "IRREVOCABLE"]).optional(),
});

export const PATCH = guarded(FEATURES.quotesCreate, async (req: NextRequest, { params, actor, resolved }) => {
  const { id } = await params;
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const existing = await prisma.quote.findUnique({ where: { id }, select: { state: true, number: true } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const from = existing.state as QuoteState;

  // EPQ.1 — forward-only state machine: the transitions map is the authority
  let to: QuoteState | null = null;
  if (parsed.data.state && parsed.data.state !== from) {
    to = parsed.data.state as QuoteState;
    const chk = canTransition(from, to);
    if (!chk.ok) {
      void audit({ actorId: actor!.id, entityType: "quote", entityId: id, action: "transition.refused", before: { from }, after: { to, reason: chk.reason ?? null } });
      return NextResponse.json({ error: chk.reason, useSend: chk.useSend ?? false }, { status: 422 });
    }
  }
  const effective = to ?? from;

  // EPQ.1 — field guards: deposit/dates only exist on a draft (lines are
  // frozen elsewhere; these were the raw-API leak); lostReason only on a loss.
  // EPQ.5 — tax mode / deposit kind / validity wording join the same guard.
  const touchesDraftOnly =
    parsed.data.depositPct !== undefined || parsed.data.validUntilAt !== undefined || parsed.data.promiseDateAt !== undefined ||
    parsed.data.taxMode !== undefined || parsed.data.depositKind !== undefined || parsed.data.validityWording !== undefined;
  if (touchesDraftOnly && from !== "DRAFT") {
    return NextResponse.json({ error: `Deposit and dates are locked on a ${from.toLowerCase()} quote — Revise it to a draft first` }, { status: 422 });
  }
  if (parsed.data.lostReason !== undefined && !lostReasonAllowed(effective)) {
    return NextResponse.json({ error: "A lost reason only applies to a rejected or expired quote" }, { status: 422 });
  }

  const data: Record<string, unknown> = {};
  if (parsed.data.depositPct !== undefined) data.depositPct = parsed.data.depositPct;
  if (parsed.data.promiseDateAt !== undefined) data.promiseDateAt = parsed.data.promiseDateAt ? new Date(parsed.data.promiseDateAt) : null;
  if (parsed.data.validUntilAt !== undefined) data.validUntilAt = parsed.data.validUntilAt ? new Date(parsed.data.validUntilAt) : null;
  if (parsed.data.lostReason !== undefined) data.lostReason = parsed.data.lostReason;
  // EPQ.5 — the natura code (downstream EPF invoicing) tracks the tax mode
  if (parsed.data.taxMode !== undefined) {
    data.taxMode = parsed.data.taxMode;
    data.naturaCode = naturaForMode(parsed.data.taxMode as TaxMode);
  }
  if (parsed.data.depositKind !== undefined) data.depositKind = parsed.data.depositKind;
  if (parsed.data.validityWording !== undefined) data.validityWording = parsed.data.validityWording;
  if (to) data.state = to;

  const quote = await prisma.quote.update({ where: { id }, data });
  if (to) {
    void audit({ actorId: actor!.id, entityType: "quote", entityId: id, action: "state-changed", before: { from }, after: { to, ...(parsed.data.lostReason !== undefined ? { lostReason: parsed.data.lostReason } : {}) } });
    // EPQ.2 — a manual decision rings every OTHER active Owner (S6)
    if (to === "ACCEPTED" || to === "REJECTED") {
      await notifyOwners({
        title: to === "ACCEPTED" ? `Quote ${existing.number} marked accepted` : `Quote ${existing.number} marked rejected`,
        body: to === "REJECTED" && parsed.data.lostReason ? parsed.data.lostReason : undefined,
        entityId: id,
        href: `/quotes?q=${id}`,
        excludeUserId: actor!.id,
      });
    }
  } else {
    void audit({ actorId: actor!.id, entityType: "quote", entityId: id, action: "updated", before: { state: from }, after: parsed.data });
  }
  await publishEventDurable("pricing.updated", { quoteId: id });
  return jsonStripped({ quote }, resolved);
});

export const DELETE = guarded(FEATURES.quotesCreate, async (_req, { params, actor }) => {
  const { id } = await params;
  const quote = await prisma.quote.findUnique({ where: { id }, select: { state: true, number: true } });
  if (!quote) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (quote.state !== "DRAFT") return NextResponse.json({ error: "Only draft quotes can be deleted — mark a sent quote rejected instead" }, { status: 400 });
  await prisma.quote.delete({ where: { id } });
  void audit({ actorId: actor!.id, entityType: "quote", entityId: id, action: "deleted", after: { number: quote.number } });
  return NextResponse.json({ ok: true });
});
