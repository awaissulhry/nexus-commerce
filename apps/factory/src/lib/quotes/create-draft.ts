/**
 * FP3 — a new quote, created as a DRAFT for a customer (optionally from a mail thread). P12 (MCP full control): moved
 * verbatim from POST /api/quotes so Claude's `factory-draft-quote` creates a quote exactly as the page does. A draft is
 * never sent from here: sending stays the Owner's click (quotes.send).
 */
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { nextNumber } from "@/lib/counters";
import { naturaForMode, resolveTaxMode } from "@/lib/quotes/tax";

export async function createDraftQuote(input: { partyId: string; conversationId?: string | null; actorId: string }) {
  const party = await prisma.party.findUnique({ where: { id: input.partyId }, select: { id: true, kind: true, taxMode: true, depositDefaultPct: true } });
  if (!party) return { ok: false as const, status: 404, error: "Party not found" };

  // estimated lead time (honest v1 — real capable-to-promise from floor load lands in FP6)
  const leadRow = await prisma.appSetting.findUnique({ where: { key: "production.leadTimeDays" } });
  const leadDays = ((leadRow?.value as { days?: number })?.days) ?? 21;

  const number = await nextNumber("quote");
  // EPQ.5 — the quote snapshots its tax mode from the party at create (the
  // party's stored mode, else its kind default); DRAFT-editable in the rail.
  const taxMode = resolveTaxMode(party.taxMode, party.kind);
  const quote = await prisma.quote.create({
    data: {
      number,
      partyId: party.id,
      conversationId: input.conversationId ?? null,
      depositPct: party.depositDefaultPct ?? null,
      taxMode,
      naturaCode: naturaForMode(taxMode),
      validUntilAt: new Date(Date.now() + 30 * 86400000), // 30-day default validity
      promiseDateAt: new Date(Date.now() + leadDays * 86400000),
    },
  });
  void audit({ actorId: input.actorId, entityType: "quote", entityId: quote.id, action: "created", after: { number } });
  // EPI1.1 (G11) — creation used to be silent: other viewers' linked-quote
  // rails stayed stale until an unrelated event happened by.
  void publishEventDurable("pricing.updated", {
    quoteId: quote.id,
    ...(quote.conversationId ? { conversationId: quote.conversationId } : {}),
  });
  return { ok: true as const, quote };
}

/** FP3 — a line on a DRAFT quote (priced later in the quote rail). Moved verbatim from POST /api/quotes/:id/lines. */
export async function addDraftQuoteLine(input: { quoteId: string; templateId?: string | null; description?: string; actorId: string }) {
  const quote = await prisma.quote.findUnique({ where: { id: input.quoteId }, select: { state: true } });
  if (!quote) return { ok: false as const, status: 404, error: "Not found" };
  if (quote.state !== "DRAFT") return { ok: false as const, status: 400, error: "Revise the quote to a draft before editing lines" };
  const line = await prisma.quoteLine.create({
    data: { quoteId: input.quoteId, templateId: input.templateId ?? null, description: input.description, selections: [] },
  });
  void audit({ actorId: input.actorId, entityType: "quote", entityId: input.quoteId, action: "line.added", after: { lineId: line.id } });
  return { ok: true as const, line };
}
