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

// ---- F-PR-16 (the browser walk): the customer's own references, read ONCE for the tasks below and for the partner's approval page
// (platform/approvals-out/page.ts — the portal's and the APPROVAL link's reads), so both follow the same rule.
/** What a party reads instead of the office's label of its own records (B-TH-303's rule). */
export interface PartnerRefs {
  /** A customer record's label in a language; null: not one whose label changes (or it is no longer found). */
  readonly labelOf: (type: string, id: string, locale: ApprovalLocale) => string | null
  /** A counter-offer's request (OrderChangeRequest): its order by the customer's own number; null: not found. */
  readonly counterOrderOf: (requestId: string) => string | null
  /** Words that quote the office's number of one of these records' orders or quotes, with the customer's own number instead. */
  readonly own: (text: string) => string
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The references of ONE party's records (`pairs`: customer records, see CUSTOMER_RECORDS; `counterIds`: counter-offers' change
 * requests): only rows of that party are read, whatever a pair names.
 */
export async function partnerRefsOf(client: Client, partyId: string, records: readonly { type: string; id: string }[], counterIds: readonly string[] = []): Promise<PartnerRefs> {
  const pairs = records.filter((pair) => CUSTOMER_RECORDS.has(pair.type))
  const found = async <Row extends { id: string }>(type: string, read: (ids: string[]) => Promise<Row[]>): Promise<Map<string, Row>> => {
    const ids = idsOf(pairs, type)
    return new Map((ids.length === 0 ? [] : await read(ids)).map((row) => [row.id, row]))
  }
  const orders = await found('SalesOrder', (ids) => client.salesOrder.findMany({ where: { id: { in: ids }, partyId }, select: { id: true, number: true, customerSeq: true } }))
  const quotes = await found('Quote', (ids) => client.quote.findMany({ where: { id: { in: ids }, partyId }, select: { id: true, number: true, customerSeq: true } }))
  const requests = await found('Inquiry', (ids) => client.inquiry.findMany({ where: { id: { in: ids }, partyId }, select: { id: true, customerSeq: true } }))
  const shipments = await found('Shipment', (ids) => client.shipment.findMany({ where: { id: { in: ids }, partyId }, select: { id: true, salesOrder: { select: { number: true, customerSeq: true } } } }))
  const lines = await found('SalesOrderLine', (ids) => client.salesOrderLine.findMany({ where: { id: { in: ids }, partyId }, select: { id: true, seq: true, order: { select: { number: true, customerSeq: true } } } }))
  const amendments = await found('SalesOrderAmendment', (ids) => client.salesOrderAmendment.findMany({ where: { id: { in: ids }, partyId }, select: { id: true, revision: true, order: { select: { number: true, customerSeq: true } } } }))
  const concessions = await found('NcrConcession', (ids) => client.ncrConcession.findMany({ where: { id: { in: ids }, partyId }, select: { id: true, seq: true } }))
  // ---- B-PR-31 (threads plan §0.5; production plan B-PR-26's counter-offer, "waiting on you"): a counter-offer's approval is about
  // the customer's request (OrderChangeRequest), whose order the customer reads by its own number: "Counter-offer · #12", never the
  // label it was asked with ("Counter-offer · SO-2026-0042"). Its own party's requests only.
  const counters = new Map(
    (counterIds.length === 0 ? [] : await client.orderChangeRequest.findMany({ where: { id: { in: [...new Set(counterIds)] }, partyId }, select: { id: true, order: { select: { number: true, customerSeq: true } } } })).map((row) => [row.id, row.order] as const),
  )
  // ---- end B-PR-31

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

  // Each office order or quote number these records name → the customer's own ("SO-2026-0042" → "#12"), longest first.
  const numbers = new Map<string, string>()
  const add = (number: string, mine: string) => (number ? numbers.set(number, mine) : numbers)
  for (const order of [...orders.values(), ...[...shipments.values()].map((row) => row.salesOrder), ...[...lines.values()].map((row) => row.order), ...[...amendments.values()].map((row) => row.order), ...counters.values()]) add(order.number, ref('ORDER', order.customerSeq))
  for (const quote of quotes.values()) add(quote.number, ref('QUOTE', quote.customerSeq))
  const pattern = numbers.size === 0 ? null : new RegExp(`(?<![A-Za-z0-9-])(?:${[...numbers.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join('|')})(?![A-Za-z0-9-])`, 'g')
  const own = (text: string): string => (pattern ? text.replace(pattern, (number) => numbers.get(number) ?? number) : text)

  return {
    labelOf,
    counterOrderOf: (requestId) => (counters.has(requestId) ? ref('ORDER', counters.get(requestId)!.customerSeq) : null),
    own,
  }
}
// ---- end F-PR-16

// ---- fix-pr-10: the words a party reads of the record of one of its approvals — on its approval page (portal and link), in the
// receipt mail of its answer and in its answer on a thread it shares (platform/approvals-out page.ts, settle.ts): its own order and
// quote numbers ("#12 · revision 2"), a concession as its task reads it ("concession 2", never the office's NCR number).
export function partnerRecordWords(refs: PartnerRefs, record: { readonly type: string; readonly id: string }, words: { readonly it: string; readonly en: string }): { it: string; en: string } {
  const theirs = (locale: ApprovalLocale): string => (record.type === 'NcrConcession' ? (refs.labelOf(record.type, record.id, locale) ?? NO_NUMBER) : refs.own(words[locale]))
  return { it: theirs('it'), en: theirs('en') }
}
// ---- end fix-pr-10

/** The partner's label of each task (by task id) of ONE party; a task not listed keeps its own label. */
export async function partnerLabelsOf(client: Client, partyId: string, tasks: readonly Labelled[]): Promise<Map<string, string>> {
  const own = tasks.filter((task) => task.partyId === partyId)
  const approvalIds = [...new Set(own.filter((task) => task.recordType === APPROVAL_RECORD).map((task) => task.recordId))]
  const approvals = approvalIds.length === 0 ? [] : await client.approvalRequest.findMany({ where: { id: { in: approvalIds }, partyId }, select: { id: true, kind: true, recordType: true, recordId: true } })
  const pairs = [...own.map((task) => ({ type: task.recordType, id: task.recordId })), ...approvals.map((row) => ({ type: row.recordType, id: row.recordId }))].filter((pair) => CUSTOMER_RECORDS.has(pair.type))
  if (pairs.length === 0 && approvals.length === 0) return new Map()
  const counterIds = approvals.filter((row) => row.recordType === COUNTER_OFFER_RECORD).map((row) => row.recordId) // B-PR-31
  const { labelOf, counterOrderOf } = await partnerRefsOf(client, partyId, pairs, counterIds) // F-PR-16

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
      const record = counter ? counterOrderOf(approval.recordId) : labelOf(approval.recordType, approval.recordId, locale)
      labels.set(task.id, record ? `${name[locale]} · ${record}` : name[locale])
    } else if (CUSTOMER_RECORDS.has(task.recordType)) {
      labels.set(task.id, labelOf(task.recordType, task.recordId, 'en') ?? NO_NUMBER)
    }
  }
  return labels
}
