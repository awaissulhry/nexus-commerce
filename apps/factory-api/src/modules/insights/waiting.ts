import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { matchesScope } from '@nexus/factory-domain/insights/attention'
import { WAITING_KINDS, WAITING_RULES, waitingFor, waitingKindsFor, type WaitingCandidate } from '@nexus/factory-domain/insights/waiting'
import { approvalRequestWords, poConfirmationWords, quoteAnswerWords } from '@nexus/factory-domain/insights/words'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { QUOTES_VIEW } from '@nexus/factory-domain/sales/quotes/permissions'
import type { CommandCaller } from '../../core/command'
import { dayOrNull, partyNames, SOURCE_LIMIT } from './sources/common'
import { amountsView } from './today'
import { scopeFilterOf, viewerOf } from './viewer'

/**
 * GET /home/waiting-on-others (B-W1-52; design home.today `waiting-on`): what the person asked for or sent and still
 * waits on: their quote approval requests not decided, the purchase orders they sent and the supplier has not confirmed,
 * the quote versions they sent and the customer has not answered. Only records they still see (factory-domain
 * insights/waiting waitsFor); amounts follow their grains. Nudge is W2a. Read only.
 */

export async function waitingOnOthers(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly siteId?: string | undefined }) {
  const viewer = viewerOf(caller)
  const filter = await scopeFilterOf(caller, query)
  const kinds = waitingKindsFor(viewer.actor)
  const me = viewer.personId
  const candidates = await caller.withClient(async (db) => {
    const found: WaitingCandidate[] = []
    if (kinds.includes('APPROVAL_REQUEST') || kinds.includes('QUOTE_ANSWER')) {
      const quoteScope = scopeWhere(viewer.actor, QUOTES_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.QuoteWhereInput
      const approvals = await db.quoteApproval.findMany({ where: { status: 'PENDING', createdById: me }, take: SOURCE_LIMIT, select: { versionId: true, reasons: true, createdAt: true, createdById: true } })
      const sent = await db.quoteVersion.findMany({ where: { status: 'SENT', sentById: me }, take: SOURCE_LIMIT, select: { id: true } })
      const versions = await db.quoteVersion.findMany({
        where: { id: { in: [...approvals.map((row) => row.versionId), ...sent.map((row) => row.id)] }, quote: quoteScope },
        select: { id: true, quoteId: true, revision: true, status: true, currency: true, netAmount: true, marginPct: true, marginAmount: true, validUntil: true, sentAt: true, sentById: true },
      })
      const quotes = versions.length > 0 ? await db.quote.findMany({ where: { id: { in: [...new Set(versions.map((row) => row.quoteId))] } }, select: { id: true, number: true, companyId: true, partyId: true } }) : []
      const names = await partyNames(db, quotes.map((row) => row.partyId))
      for (const approval of approvals) {
        const version = versions.find((row) => row.id === approval.versionId)
        const quote = version ? quotes.find((row) => row.id === version.quoteId) : undefined
        if (!version || !quote) continue
        const margin = approval.reasons.includes('MARGIN_FLOOR')
        found.push({
          kind: 'APPROVAL_REQUEST',
          record: { type: 'Quote', id: quote.id, label: quote.number },
          scope: { companyId: quote.companyId, siteId: null, partyId: quote.partyId },
          requestedBy: approval.createdById,
          sentence: approvalRequestWords({ number: quote.number, customer: names.get(quote.partyId) ?? 'the customer', reasons: approval.reasons }),
          waitingFor: 'An approver of quotes',
          since: approval.createdAt,
          due: dayOrNull(version.validUntil),
          amounts: {
            currency: version.currency,
            netAmount: version.netAmount,
            marginPct: version.marginPct === null ? null : version.marginPct.toString(),
            marginAmount: version.marginAmount,
            inSentence: margin ? 'marginPct' : 'netAmount',
          },
        })
      }
      for (const version of versions.filter((row) => row.status === 'SENT')) {
        const quote = quotes.find((row) => row.id === version.quoteId)
        if (!quote) continue
        const customer = names.get(quote.partyId) ?? 'the customer'
        found.push({
          kind: 'QUOTE_ANSWER',
          record: { type: 'Quote', id: quote.id, label: quote.number },
          scope: { companyId: quote.companyId, siteId: null, partyId: quote.partyId },
          requestedBy: version.sentById,
          sentence: quoteAnswerWords({ number: quote.number, revision: version.revision, customer }),
          waitingFor: customer,
          since: version.sentAt ?? viewer.now,
          due: dayOrNull(version.validUntil),
          amounts: { currency: version.currency, netAmount: version.netAmount, inSentence: 'netAmount' },
        })
      }
    }
    if (kinds.includes('PO_CONFIRMATION')) {
      const scope = scopeWhere(viewer.actor, PURCHASING_VIEW, { company: 'companyId', site: 'siteId', party: 'partyId' }) as Prisma.PurchaseOrderWhereInput
      const orders = await db.purchaseOrder.findMany({
        where: { AND: [scope, { status: 'SENT', sentById: me }] },
        orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
        take: SOURCE_LIMIT,
        select: { id: true, number: true, companyId: true, siteId: true, partyId: true, currency: true, netAmount: true, requestedDate: true, sentAt: true, sentById: true, createdAt: true },
      })
      const names = await partyNames(db, orders.map((row) => row.partyId))
      for (const order of orders) {
        const supplier = names.get(order.partyId) ?? 'the supplier'
        found.push({
          kind: 'PO_CONFIRMATION',
          record: { type: 'PurchaseOrder', id: order.id, label: order.number },
          scope: { companyId: order.companyId, siteId: order.siteId, partyId: order.partyId },
          requestedBy: order.sentById,
          sentence: poConfirmationWords({ number: order.number, supplier }),
          waitingFor: supplier,
          since: order.sentAt ?? order.createdAt,
          due: dayOrNull(order.requestedDate),
          amounts: { currency: order.currency, purchaseAmount: order.netAmount, inSentence: 'purchaseAmount' },
        })
      }
    }
    return found
  })
  const items = waitingFor(viewer, candidates).filter((item) => matchesScope(item, filter))
  return {
    asOf: toUtcIso(viewer.now),
    counts: { total: items.length, byKind: WAITING_KINDS.filter((kind) => kinds.includes(kind)).map((kind) => ({ kind, label: WAITING_RULES[kind].label, count: items.filter((item) => item.kind === kind).length })) },
    items: items.map((item) => ({
      key: item.key,
      kind: item.kind,
      record: item.record,
      companyId: item.companyId,
      siteId: item.siteId,
      partyId: item.partyId,
      sentence: item.sentence,
      waitingFor: item.waitingFor,
      since: toUtcIso(item.since),
      ageDays: item.ageDays,
      due: item.due,
      figures: amountsView(item.amounts),
    })),
    live: { events: [...new Set(kinds.flatMap((kind) => WAITING_RULES[kind].live))].sort() },
  }
}
