import type { FactoryClient } from '@nexus/factory-db'
import { KIND_RULES as APPROVAL_KINDS, type ApprovalKind, type ApprovalLocale } from '@nexus/factory-domain/approvals-out/kinds'
// B-PR-31: a counter-offer's task (its approval is about the customer's request) names the request's order.
import { COUNTER_OFFER_RECORD } from '@nexus/factory-domain/approvals-out/kinds'
import { customerRefOf } from '@nexus/factory-domain/sales/customer-numbers'
import type { CommandTx } from '../../../core/command'
import type { TaskRow } from './store'

/**
 * th3b follow-up 5 (threads plan §0.5, "counts do not leak"): what a partner reads of a task's record. A task keeps the office's
 * label (`recordLabel`, written when it is asked: "SO-2026-0042", "Revised order · SO-2026-0042 · revision 2"), which the office
 * reads as it is; a customer reads its own reference instead — its order, quote or request by ITS running number ("#12"), a
 * shipment by its order's, a proof by its order's and the line ("#12 · line 30"), a revised order by its order's and the revision,
 * a concession without the office's NCR number ("concession 2") — never the office's shared series. Every other record keeps its
 * label: invoices and DDTs their legal numbers, a supplier's purchase order or job its own number, a style its code.
 *
 * Read in a scope that reaches the records (the fan-out's, or the portal's tenant scope for the party's own tasks), and always
 * only of the task's own party: a row of another party is never read, whatever the task names. A record no longer found reads
 * "—" (an approval: the kind's name alone), never the office's label.
 */

type Client = FactoryClient | CommandTx
type Labelled = Pick<TaskRow, 'id' | 'partyId' | 'recordType' | 'recordId' | 'recordLabel'>

/** The record type of an approval asked through approvals-out (its task's record). */
const APPROVAL_RECORD = 'ApprovalRequest'
/** The customer's records whose office label a partner never reads as it is. */
const CUSTOMER_RECORDS = new Set(['SalesOrder', 'Quote', 'Inquiry', 'Shipment', 'SalesOrderLine', 'SalesOrderAmendment', 'NcrConcession'])
const NO_NUMBER = '—'
const WORDS = {
  line: { it: 'riga', en: 'line' },
  revision: { it: 'revisione', en: 'revision' },
  concession: { it: 'concessione', en: 'concession' },
} as const

const ref = (kind: 'ORDER' | 'QUOTE' | 'REQUEST', seq: number | null | undefined): string => customerRefOf(kind, seq) ?? NO_NUMBER
const idsOf = (pairs: readonly { type: string; id: string }[], type: string): string[] => [...new Set(pairs.filter((pair) => pair.type === type).map((pair) => pair.id))]

/** The partner's label of each task (by task id) of ONE party; a task not listed keeps its own label. */
export async function partnerLabelsOf(client: Client, partyId: string, tasks: readonly Labelled[]): Promise<Map<string, string>> {
  const own = tasks.filter((task) => task.partyId === partyId)
  const approvalIds = [...new Set(own.filter((task) => task.recordType === APPROVAL_RECORD).map((task) => task.recordId))]
  const approvals = approvalIds.length === 0 ? [] : await client.approvalRequest.findMany({ where: { id: { in: approvalIds }, partyId }, select: { id: true, kind: true, recordType: true, recordId: true } })
  const pairs = [...own.map((task) => ({ type: task.recordType, id: task.recordId })), ...approvals.map((row) => ({ type: row.recordType, id: row.recordId }))].filter((pair) => CUSTOMER_RECORDS.has(pair.type))
  if (pairs.length === 0 && approvals.length === 0) return new Map()
  const found = async <Row extends { id: string }>(type: string, read: (ids: string[]) => Promise<Row[]>): Promise<Map<string, Row>> => {
    const ids = idsOf(pairs, type)
    return new Map((ids.length === 0 ? [] : await read(ids)).map((row) => [row.id, row]))
  }
  const orders = await found('SalesOrder', (ids) => client.salesOrder.findMany({ where: { id: { in: ids }, partyId }, select: { id: true, customerSeq: true } }))
  const quotes = await found('Quote', (ids) => client.quote.findMany({ where: { id: { in: ids }, partyId }, select: { id: true, customerSeq: true } }))
  const requests = await found('Inquiry', (ids) => client.inquiry.findMany({ where: { id: { in: ids }, partyId }, select: { id: true, customerSeq: true } }))
  const shipments = await found('Shipment', (ids) => client.shipment.findMany({ where: { id: { in: ids }, partyId }, select: { id: true, salesOrder: { select: { customerSeq: true } } } }))
  const lines = await found('SalesOrderLine', (ids) => client.salesOrderLine.findMany({ where: { id: { in: ids }, partyId }, select: { id: true, seq: true, order: { select: { customerSeq: true } } } }))
  const amendments = await found('SalesOrderAmendment', (ids) => client.salesOrderAmendment.findMany({ where: { id: { in: ids }, partyId }, select: { id: true, revision: true, order: { select: { customerSeq: true } } } }))
  const concessions = await found('NcrConcession', (ids) => client.ncrConcession.findMany({ where: { id: { in: ids }, partyId }, select: { id: true, seq: true } }))
  // ---- B-PR-31 (threads plan §0.5; production plan B-PR-26's counter-offer, "waiting on you"): a counter-offer's approval is about
  // the customer's request (OrderChangeRequest), whose order the customer reads by its own number: "Counter-offer · #12", never the
  // label it was asked with ("Counter-offer · SO-2026-0042"). Its own party's requests only.
  const counterIds = [...new Set(approvals.filter((row) => row.recordType === COUNTER_OFFER_RECORD).map((row) => row.recordId))]
  const counterOrders = new Map(
    (counterIds.length === 0 ? [] : await client.orderChangeRequest.findMany({ where: { id: { in: counterIds }, partyId }, select: { id: true, order: { select: { customerSeq: true } } } })).map((row) => [row.id, row.order.customerSeq] as const),
  )
  // ---- end B-PR-31

  /** A customer record's label in a language; null: not one whose label changes (or it is no longer found). */
  const labelOf = (type: string, id: string, locale: ApprovalLocale): string | null => {
    switch (type) {
      case 'SalesOrder':
        return orders.has(id) ? ref('ORDER', orders.get(id)!.customerSeq) : null
      case 'Quote':
        return quotes.has(id) ? ref('QUOTE', quotes.get(id)!.customerSeq) : null
      case 'Inquiry':
        return requests.has(id) ? ref('REQUEST', requests.get(id)!.customerSeq) : null
      case 'Shipment':
        return shipments.has(id) ? ref('ORDER', shipments.get(id)!.salesOrder.customerSeq) : null
      case 'SalesOrderLine': {
        const line = lines.get(id)
        return line ? `${ref('ORDER', line.order.customerSeq)} · ${WORDS.line[locale]} ${line.seq}` : null
      }
      case 'SalesOrderAmendment': {
        const amendment = amendments.get(id)
        return amendment ? `${ref('ORDER', amendment.order.customerSeq)} · ${WORDS.revision[locale]} ${amendment.revision}` : null
      }
      case 'NcrConcession': {
        const concession = concessions.get(id)
        return concession ? `${WORDS.concession[locale]} ${concession.seq}` : null
      }
      default:
        return null
    }
  }

  const approvalOf = new Map(approvals.map((row) => [row.id, row]))
  const labels = new Map<string, string>()
  for (const task of own) {
    if (task.recordType === APPROVAL_RECORD) {
      // approvals-out wrote "<kind's name> · <the record>" in the language it asked in: the same language, the partner's record.
      const approval = approvalOf.get(task.recordId)
      // B-PR-31: a counter-offer reads its request's order (or the kind's name alone), never the office's label.
      const counter = approval?.recordType === COUNTER_OFFER_RECORD
      if (!approval || (!counter && !CUSTOMER_RECORDS.has(approval.recordType))) continue
      const name = APPROVAL_KINDS[approval.kind as ApprovalKind].name
      const locale: ApprovalLocale = task.recordLabel.startsWith(`${name.it} · `) && !task.recordLabel.startsWith(`${name.en} · `) ? 'it' : 'en'
      const record = counter ? (counterOrders.has(approval.recordId) ? ref('ORDER', counterOrders.get(approval.recordId)) : null) : labelOf(approval.recordType, approval.recordId, locale)
      labels.set(task.id, record ? `${name[locale]} · ${record}` : name[locale])
    } else if (CUSTOMER_RECORDS.has(task.recordType)) {
      labels.set(task.id, labelOf(task.recordType, task.recordId, 'en') ?? NO_NUMBER)
    }
  }
  return labels
}
