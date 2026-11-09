import type { ApprovalLocale } from '@nexus/factory-domain/approvals-out/kinds'
import { amendmentDiff, type OrderSnapshot } from '@nexus/factory-domain/sales/amendments/amendments'
import { ORDERS_MANAGE, ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import type { FactoryClient } from '@nexus/factory-db'
import type { CommandTx } from '../../../core/command'
import { words, type RecordAdapter } from '../../../platform/approvals-out/adapter'
import { diffView } from './amend'

/**
 * The customer's re-acceptance of a revised order (B-W2b-184; SAL-222; W2a's SalesOrderAmendment, B-W2a-30: an amendment
 * that moved the net total sets `reacceptanceNeeded` and the order's `reapprovalNeededAt`). The office asks it with an
 * approval request of kind REVISED_ORDER on the amendment (platform/approvals-out); the customer reads the order line by
 * line, old → new, with its own prices (the price grain: the link's, the portal person's) and accepts it as it stands or
 * refuses it with its words (a change is a new amendment). Asked only on the order's LATEST amendment that still waits.
 *
 * The answer, settled in the tenant's system scope (the partner role reads neither the amendment nor writes the order):
 * accepted → the order's wait is cleared (`reapprovalNeededAt` null, its version + 1, audited on the order) when this is
 * still its latest amendment; refused → the wait stays and the office decides (a new amendment, or the order as it was).
 */

const RECORD = 'SalesOrderAmendment'
type Client = FactoryClient | CommandTx

const AMENDMENT = {
  id: true,
  orderId: true,
  revision: true,
  reason: true,
  reacceptanceNeeded: true,
  before: true,
  after: true,
  order: { select: { id: true, number: true, companyId: true, partyId: true, status: true, currency: true, reapprovalNeededAt: true } },
} as const

async function latestRevision(client: Client, orderId: string): Promise<number> {
  const latest = await client.salesOrderAmendment.findFirst({ where: { orderId }, orderBy: { revision: 'desc' }, select: { revision: true } })
  return latest?.revision ?? 0
}

export const REACCEPTANCE_ADAPTER: RecordAdapter = Object.freeze<RecordAdapter>({
  recordType: RECORD,
  kinds: ['REVISED_ORDER'],
  view: ORDERS_VIEW,
  ask: ORDERS_MANAGE,
  async read(client, recordId) {
    const row = await client.salesOrderAmendment.findUnique({ where: { id: recordId }, select: AMENDMENT })
    if (!row) return null
    const { order } = row
    const latest = await latestRevision(client, order.id)
    const held = !row.reacceptanceNeeded
      ? `Revision ${row.revision} did not change the net total: the customer need not accept it again.`
      : row.revision !== latest
        ? `Revision ${row.revision} is not the order's latest (${latest}): ask on the latest.`
        : order.reapprovalNeededAt === null
          ? `${order.number} waits for no re-acceptance any more.`
          : order.status === 'CLOSED' || order.status === 'CANCELLED'
            ? `${order.number} is ${order.status.toLowerCase()}.`
            : null
    return { companyId: order.companyId, siteId: null, partyId: order.partyId, label: { it: `${order.number} · revisione ${row.revision}`, en: `${order.number} · revision ${row.revision}` }, held, thread: { type: 'SalesOrder', id: order.id } }
  },
  async fileRecords(client, recordId) {
    const row = await client.salesOrderAmendment.findUnique({ where: { id: recordId }, select: { orderId: true } })
    return row ? [{ type: 'SalesOrder', id: row.orderId }] : []
  },
  async content(client, request, locale: ApprovalLocale) {
    const row = await client.salesOrderAmendment.findUnique({ where: { id: request.recordId }, select: AMENDMENT })
    if (!row) return { facts: [], revisedOrder: null }
    const diff = amendmentDiff(row.before as unknown as OrderSnapshot, row.after as unknown as OrderSnapshot)
    const styleIds = [...new Set(diff.lines.map((line) => line.styleId))]
    const colourwayIds = [...new Set(diff.lines.map((line) => line.colourwayId))]
    const styles = await client.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true, name: true } })
    const colourways = await client.colourway.findMany({ where: { id: { in: colourwayIds } }, select: { id: true, code: true, name: true } })
    return {
      facts: [
        { label: words(locale, 'Ordine', 'Order'), value: row.order.number },
        { label: words(locale, 'Revisione', 'Revision'), value: String(row.revision) },
        { label: words(locale, 'Perché è cambiato', 'Why it changed'), value: row.reason },
        { label: words(locale, 'Attenzione', 'Please note'), value: words(locale, "La vostra accettazione precedente decade se cambia il valore netto dell'ordine.", 'Your earlier acceptance ends if the net value changes.') },
      ],
      revisedOrder: {
        orderNumber: row.order.number,
        revision: row.revision,
        reason: row.reason,
        currency: row.order.currency,
        diff: diffView(diff),
        styles: Object.fromEntries(styles.map((style) => [style.id, { code: style.code, name: style.name }])),
        colourways: Object.fromEntries(colourways.map((colourway) => [colourway.id, { code: colourway.code, name: colourway.name }])),
      },
    }
  },
  async answerHeld(client, request, locale) {
    const row = await client.salesOrderAmendment.findUnique({ where: { id: request.recordId }, select: { revision: true, order: { select: { id: true, reapprovalNeededAt: true } } } })
    if (!row) return words(locale, 'Questo ordine non è più disponibile.', 'This order is no longer available.')
    if (row.revision !== (await latestRevision(client, row.order.id))) return words(locale, "L'ordine è stato cambiato di nuovo: vi mandiamo la versione più recente da approvare.", 'The order was changed again: we will send you the newest version to approve.')
    if (row.order.reapprovalNeededAt === null) return words(locale, "Questo ordine non attende più la vostra conferma.", 'This order no longer waits for your confirmation.')
    return null
  },
  async settle(tools, request) {
    if (request.status === 'REFUSED') {
      const row = await tools.tx.salesOrderAmendment.findUnique({ where: { id: request.recordId }, select: { orderId: true, revision: true, order: { select: { companyId: true } } } })
      if (row) tools.audit({ action: 'sales.reacceptanceRefused', recordType: 'SalesOrder', recordId: row.orderId, companyId: row.order.companyId, after: { revision: row.revision, approvalRequestId: request.id } })
      return { cleared: false }
    }
    const row = await tools.tx.salesOrderAmendment.findUnique({ where: { id: request.recordId }, select: { orderId: true, revision: true, order: { select: { companyId: true, reapprovalNeededAt: true } } } })
    if (!row || row.revision !== (await latestRevision(tools.tx, row.orderId))) return { cleared: false }
    const { count } = await tools.tx.salesOrder.updateMany({ where: { id: row.orderId, reapprovalNeededAt: { not: null } }, data: { reapprovalNeededAt: null, version: { increment: 1 }, updatedAt: tools.now } })
    tools.audit({
      action: 'sales.reaccepted',
      recordType: 'SalesOrder',
      recordId: row.orderId,
      companyId: row.order.companyId,
      before: { reapprovalNeededAt: row.order.reapprovalNeededAt?.toISOString() ?? null },
      after: { reapprovalNeededAt: null, revision: row.revision, approvalRequestId: request.id, byPartner: true },
    })
    return { cleared: count === 1 }
  },
})
