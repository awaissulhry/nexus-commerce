import type { FastifyRequest } from 'fastify'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { evidenceNeeds } from '@nexus/factory-domain/links/evidence'
import { answerProblem, DECLINE_REASONS, LINE_ANSWERS, type AskedLine } from '@nexus/factory-domain/purchasing/confirm/answer'
import { supplierLanguageOf } from '@nexus/factory-domain/purchasing/orders'
import { changeWords, revisionDiff, type RevisionState } from '@nexus/factory-domain/purchasing/revisions/revisions'
import type { CommandTx } from '../../../core/command'
import { systemCallerOf } from '../../../platform/files/files'
import { linkSessionOf, linkUnavailable, type LinkSession } from '../../../platform/links/authenticator'
import { labelsFor } from '../revisions/read'
import { dayOf, quantityText } from '../store'
import { SUPPLIER_LINE_COLUMNS, SUPPLIER_ORDER_COLUMNS, supplierView } from '../supplier-view'
import { siteAddressOf } from '../views'

/**
 * What the supplier's PO_CONFIRM link reads (B-W1-31; design links.po "Confirm a PO", SCR-100; PLAN §4.7 08-buy "no prices
 * on the link"). The order and its lines are read in the link's OWN scope (factory_partner_runtime: its party's wall, and
 * column grants that hold no price, amount, internal note or office user), through purchasing's `supplierView`: the same
 * read as the office's "What the supplier sees". What the partner role may not read comes from the tenant's system scope
 * for THIS order only, and only these columns: the material's code, name and base unit and the colour's name for the ids
 * the order's lines name (the PDF prints them too), the buying company's name, the delivery site's address and the name of
 * the person who sent the order. Never a price, a cost or the PDF (the mail's attachment, not shared with link sessions).
 */

/** The PDF is not on the link (it prints the prices): the page says where it is. */
export const PDF_WORDS = 'The PDF of this order is in the e-mail we sent you.'

/** The link session of a purchase order's confirm link; any other link is the one 404 of every dead link. */
export function confirmLinkOf(request: FastifyRequest): LinkSession {
  const link = linkSessionOf(request)
  if (link.purpose !== 'PO_CONFIRM' || link.record.type !== 'PurchaseOrder') throw linkUnavailable()
  return link
}

/** The order as the link's command reads it (its transaction, the link's scope): what an answer is checked against. */
export async function answerFacts(tx: CommandTx, orderId: string) {
  const order = await tx.purchaseOrder.findUnique({ where: { id: orderId }, select: { ...SUPPLIER_ORDER_COLUMNS, companyId: true, siteId: true } })
  if (!order) throw linkUnavailable()
  const lines = await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId: order.id }, orderBy: { seq: 'asc' }, select: SUPPLIER_LINE_COLUMNS })
  // B-W2a-52: a cancelled line is not answered (planAnswer takes every line once: the open ones).
  const asked: AskedLine[] = lines.filter((line) => line.cancelledAt === null && line.closedShortAt === null).map((line) => ({ id: line.id, seq: line.seq, quantity: quantityText(line.quantity), uom: line.uom, needDate: dayOf(line.needDate)! }))
  return { order, lines, asked }
}

/** The name of the person who sent the order (the page's "who at the company asked"), read in the system scope. */
export async function buyerNameOf(request: FastifyRequest, link: LinkSession): Promise<string | null> {
  return systemCallerOf(request)(link.tenantId).withClient(async (client) => {
    const order = await client.purchaseOrder.findUnique({ where: { id: link.record.id }, select: { sentById: true } })
    if (!order?.sentById) return null
    return (await client.user.findUnique({ where: { id: order.sentById }, select: { displayName: true } }))?.displayName ?? null
  })
}

/** The page (GET /link/purchase-order, and the end state of an answer): the order, price-free, its state, what it may ask. */
export async function linkView(request: FastifyRequest) {
  const link = confirmLinkOf(request)
  const system = systemCallerOf(request)(link.tenantId)
  const read = await request.withClient((own) =>
    system.withClient(async (tenant) => {
      // The link's own scope finds the order or nothing (another party's order is behind the wall).
      const seen = await own.purchaseOrder.findUnique({ where: { id: link.record.id }, select: { id: true, companyId: true, siteId: true } })
      if (!seen) throw linkUnavailable()
      const view = await supplierView(own, seen.id, tenant)
      const company = await tenant.company.findUnique({ where: { id: seen.companyId }, select: { legalName: true, tradeName: true } })
      const site = await tenant.site.findUnique({ where: { id: seen.siteId }, select: { name: true, address: true } })
      // B-W2a-52: a later revision says what changed (its row, read in the link's own scope: no price, no who).
      const row = view.order.revision > 1 ? await own.purchaseOrderRevision.findFirst({ where: { purchaseOrderId: seen.id, revision: view.order.revision }, select: { revision: true, sentAt: true, before: true, after: true, changeNote: true } }) : null
      let revision = null
      if (row) {
        const party = await tenant.party.findUnique({ where: { id: link.partyId }, select: { language: true } })
        const before = row.before as unknown as RevisionState | null
        const after = row.after as unknown as RevisionState
        const diff = revisionDiff(before, after)
        revision = { revision: row.revision, sentAt: toUtcIso(row.sentAt), changeNote: row.changeNote, changes: changeWords(diff, supplierLanguageOf(null, party?.language ?? 'it'), await labelsFor(tenant, [before, after])) }
      }
      return { view, company, site, revision }
    }),
  )
  const { view } = read
  const problem = answerProblem(view.order.status)
  const answers = problem === null ? (['confirm', 'decline'] as const).map((action) => ({ action, ...evidenceNeeds(link.purpose, action, { email: link.email }) })) : []
  return {
    order: view.order,
    lines: view.lines,
    from: { legalName: read.company?.legalName ?? '', tradeName: read.company?.tradeName ?? null, buyerName: await buyerNameOf(request, link) },
    deliverTo: read.site ? siteAddressOf(read.site) : null,
    canAnswer: problem === null,
    message: problem,
    answers,
    lineAnswers: [...LINE_ANSWERS],
    declineReasons: [...DECLINE_REASONS],
    document: PDF_WORDS,
    expiresAt: toUtcIso(link.expiresAt),
    revision: read.revision,
  }
}
