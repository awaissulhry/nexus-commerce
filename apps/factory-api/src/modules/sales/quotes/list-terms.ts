import type { Prisma } from '@nexus/factory-db'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { byUrgency, QUOTE_GROUP_STATUSES, QUOTE_TERM_GROUPS, QUOTE_URGENT_MAX, quoteUrgencyKey, type QuoteGroupTerm, type QuoteUrgencyFacts } from '@nexus/factory-domain/sales/before-order/groups'
import type { QuoteStatus } from '@nexus/factory-domain/sales/quotes/quotes'
import type { Reader } from './store'

/**
 * B-CQ-010 … 012 (customer page › Quotes & incoming, settle L12; 13-backend §3): the quotes list's terms beside GET /sales/quotes
 * (./quotes.ts listQuotes), kept here so the list grows by a few lines only.
 *
 *   group=<QUOTE_GROUP_TERMS>  the before-order group(s) of the term (factory-domain sales/before-order/groups.ts), ANDed with
 *                              `status` when both are sent: so `count(where + group)` is the counts' number by construction. ORDER_WAITS
 *                              and WON split the ACCEPTED quotes by "an order exists on one of its versions" (even one cancelled later)
 *   sort=urgent                "Most urgent first" (groups.ts quoteUrgencyKey): ONE small read of every quote of the where (at most
 *                              QUOTE_URGENT_MAX, else refused in words), its current version, the newest approval round of a DRAFT or
 *                              PENDING_APPROVAL one and which ACCEPTED ones have an order — 4 queries — then the page's rows are built
 *                              by the list's own code for those ids, in that order. The cursor stays the last row's id: the next page
 *                              starts after that id where it stands NOW; if that quote left the list meanwhile, the page starts at the
 *                              top again (the web keeps each row once, by id; a changed row already raises "N updates · Show"). The
 *                              order never moves rows by itself: the list is read again only on Show
 *   customerHolds              a quote whose current version is not the one the customer holds: an older version still SENT (a revise
 *                              from SENT keeps it SENT until the new one is sent, quotes/send.ts reviseQuote) — its revision
 */

const ACCEPTED_WITH_ORDER: Prisma.QuoteWhereInput = { status: 'ACCEPTED', versions: { some: { salesOrders: { some: {} } } } }
const ACCEPTED_WITHOUT_ORDER: Prisma.QuoteWhereInput = { status: 'ACCEPTED', versions: { none: { salesOrders: { some: {} } } } }

/** B-CQ-010: the where of a `group` term ({} without one), from the domain's status sets. */
export function quoteGroupWhere(term: QuoteGroupTerm | undefined): Prisma.QuoteWhereInput {
  if (term === undefined) return {}
  const groups = QUOTE_TERM_GROUPS[term]
  const plain = groups.filter((group) => group !== 'ORDER_WAITS' && group !== 'WON').flatMap((group) => QUOTE_GROUP_STATUSES[group])
  const parts: Prisma.QuoteWhereInput[] = [
    ...(plain.length > 0 ? [{ status: { in: [...plain] } }] : []),
    ...(groups.includes('ORDER_WAITS') ? [ACCEPTED_WITHOUT_ORDER] : []),
    ...(groups.includes('WON') ? [ACCEPTED_WITH_ORDER] : []),
  ]
  return parts.length === 1 ? parts[0]! : { OR: parts }
}

/** The refusal of `sort=urgent` over too many quotes (a customer's tab never reaches it; the web offers "Newest first"). */
const TOO_MANY = `More than ${QUOTE_URGENT_MAX.toLocaleString('en-US')} quotes: narrow the list (a customer, a state) to sort them by urgency.`

/** B-CQ-011: the ids of one page of `where` in "Most urgent first" order, and the cursor of the next page (null: the last). */
export async function urgentQuotePage(db: Reader, where: Prisma.QuoteWhereInput, cursor: string | undefined, limit: number, now: Date): Promise<{ readonly ids: string[]; readonly next: string | null }> {
  const quotes = await db.quote.findMany({ where, select: { id: true, status: true, currentRevision: true, updatedAt: true }, orderBy: { id: 'asc' }, take: QUOTE_URGENT_MAX + 1 })
  if (quotes.length > QUOTE_URGENT_MAX) throw new ValidationError(TOO_MANY, [{ path: 'querystring/sort', message: TOO_MANY }])
  if (quotes.length === 0) return { ids: [], next: null }
  const ids = quotes.map((quote) => quote.id)
  const revisionOf = new Map(quotes.map((quote) => [quote.id, quote.currentRevision]))
  const versions = (await db.quoteVersion.findMany({ where: { quoteId: { in: ids } }, select: { id: true, quoteId: true, revision: true, validUntil: true, sentAt: true, closedAt: true } })).filter((version) => revisionOf.get(version.quoteId) === version.revision)
  const versionOf = new Map(versions.map((version) => [version.quoteId, version]))
  const asked = quotes.filter((quote) => quote.status === 'DRAFT' || quote.status === 'PENDING_APPROVAL').flatMap((quote) => (versionOf.has(quote.id) ? [versionOf.get(quote.id)!.id] : []))
  const rounds = asked.length > 0 ? await db.quoteApproval.findMany({ where: { versionId: { in: asked } }, select: { versionId: true, status: true, createdAt: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }) : []
  const newest = new Map<string, (typeof rounds)[number]>()
  for (const round of rounds) if (!newest.has(round.versionId)) newest.set(round.versionId, round)
  const accepted = quotes.filter((quote) => quote.status === 'ACCEPTED').map((quote) => quote.id)
  const ordered = new Set(accepted.length > 0 ? (await db.salesOrder.findMany({ where: { quoteVersion: { quoteId: { in: accepted } } }, select: { quoteVersion: { select: { quoteId: true } } } })).flatMap((order) => (order.quoteVersion ? [order.quoteVersion.quoteId] : [])) : [])
  const facts: QuoteUrgencyFacts[] = quotes.map((quote) => {
    const version = versionOf.get(quote.id)
    const round = version ? newest.get(version.id) : undefined
    return {
      id: quote.id,
      status: quote.status as QuoteStatus,
      orderMade: ordered.has(quote.id),
      approval: round ? { status: round.status as 'PENDING' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN', createdAt: toUtcIso(round.createdAt) } : null,
      validUntil: version?.validUntil ? version.validUntil.toISOString().slice(0, 10) : null,
      sentAt: version?.sentAt ? toUtcIso(version.sentAt) : null,
      closedAt: version?.closedAt ? toUtcIso(version.closedAt) : null,
      updatedAt: toUtcIso(quote.updatedAt),
    }
  })
  const today = businessDate(now)
  const order = facts.sort(byUrgency((row: QuoteUrgencyFacts) => quoteUrgencyKey(row, today))).map((row) => row.id)
  const at = cursor === undefined ? -1 : order.indexOf(cursor)
  const start = at >= 0 ? at + 1 : 0
  const page = order.slice(start, start + limit)
  return { ids: page, next: start + limit < order.length && page.length > 0 ? page[page.length - 1]! : null }
}

/** B-CQ-012: for each quote, the revision of an older version the customer still holds (SENT, not its current one). */
export function customerHoldsOf(versions: readonly { readonly quoteId: string; readonly revision: number; readonly status: string }[], currentRevision: ReadonlyMap<string, number>): Map<string, number> {
  const holds = new Map<string, number>()
  for (const version of versions) {
    if (version.status !== 'SENT' || currentRevision.get(version.quoteId) === version.revision) continue
    holds.set(version.quoteId, Math.max(holds.get(version.quoteId) ?? 0, version.revision))
  }
  return holds
}
