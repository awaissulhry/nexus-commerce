import type { FactoryClient } from '@nexus/factory-db'
import type { ApprovalLocale } from '@nexus/factory-domain/approvals-out/kinds'
import { shortDayOf } from '@nexus/factory-domain/approvals-out/rules'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { HoldFact } from '@nexus/factory-domain/production/work-orders/blockers'
import { ORDERS_MANAGE, ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import type { CommandTx } from '../../core/command'
import { words, type RecordAdapter } from './adapter'

/**
 * The design proof of a made-to-measure unit (B-W2b-184; SAL-294 "design proof sign-off"; design links.approve "Design
 * proof: the final design before cutting", sales.mtm › Proofs): asked on the MADE_TO_MEASURE order line (its proof image
 * or PDF sent with it), answered by the customer by link or portal. Until the line's latest proof is approved, the release
 * check of every work order made from that line is held with the words of where the proof stands
 * (modules/production/work-orders/release/blockers.ts reads `proofHoldFacts`): waiting, refused (send a new proof) or
 * expired unanswered (ask again). A line with no proof asked is not held (a proof is the office's choice per unit); a
 * withdrawn latest proof holds nothing (the office decided it is not needed).
 */

const RECORD = 'SalesOrderLine'
type Client = FactoryClient | CommandTx

const LINE = {
  id: true,
  seq: true,
  kind: true,
  orderId: true,
  partyId: true,
  companyId: true,
  styleId: true,
  colourwayId: true,
  measurementProfileId: true,
  description: true,
  order: { select: { number: true, status: true } },
} as const

export const PROOF_ADAPTER: RecordAdapter = Object.freeze<RecordAdapter>({
  recordType: RECORD,
  kinds: ['PROOF'],
  view: ORDERS_VIEW,
  ask: ORDERS_MANAGE,
  async read(client, recordId) {
    const line = await client.salesOrderLine.findUnique({ where: { id: recordId }, select: LINE })
    if (!line) return null
    const label = { it: `${line.order.number} · riga ${line.seq}`, en: `${line.order.number} · line ${line.seq}` }
    const held =
      line.kind !== 'MADE_TO_MEASURE'
        ? `Line ${line.seq} of ${line.order.number} is not made to measure: a design proof is asked on a made-to-measure line.`
        : line.order.status === 'CLOSED' || line.order.status === 'CANCELLED'
          ? `${line.order.number} is ${line.order.status.toLowerCase()}.`
          : null
    return { companyId: line.companyId, siteId: null, partyId: line.partyId, label, held, thread: { type: 'SalesOrder', id: line.orderId } }
  },
  async fileRecords(client, recordId) {
    const line = await client.salesOrderLine.findUnique({ where: { id: recordId }, select: { orderId: true, styleId: true, measurementProfileId: true } })
    if (!line) return []
    return [{ type: 'SalesOrder', id: line.orderId }, { type: 'Style', id: line.styleId }, ...(line.measurementProfileId ? [{ type: 'MeasurementProfile', id: line.measurementProfileId }] : [])]
  },
  async content(client, request, locale: ApprovalLocale) {
    const line = await client.salesOrderLine.findUnique({ where: { id: request.recordId }, select: LINE })
    if (!line) return { facts: [], revisedOrder: null }
    const style = await client.style.findUnique({ where: { id: line.styleId }, select: { code: true, name: true } })
    const colourway = await client.colourway.findUnique({ where: { id: line.colourwayId }, select: { code: true, name: true } })
    return {
      facts: [
        { label: words(locale, 'Ordine', 'Order'), value: `${line.order.number} · ${words(locale, 'riga', 'line')} ${line.seq}` },
        { label: words(locale, 'Modello', 'Style'), value: `${style?.code ?? ''} ${style?.name ?? ''}${colourway ? ` · ${colourway.code} ${colourway.name}` : ''}`.trim() },
        ...(line.description ? [{ label: words(locale, 'Descrizione', 'Description'), value: line.description }] : []),
        { label: words(locale, 'Cosa controllare', 'What to check'), value: words(locale, 'Nomi e numeri scritti giusti, colori, posizione dei loghi.', 'Names and numbers spelled right, colours, logo placement.') },
      ],
      revisedOrder: null,
    }
  },
})

/**
 * The release check's proof holds of a work order (B-W2b-184, SAL-294): for each made-to-measure line its cells make, the
 * line's LATEST design proof request, when it is not approved and not withdrawn. Read in the caller's scope (the record's
 * or the release command's): a request it cannot see holds nothing it could not show.
 */
export async function proofHoldFacts(db: Client, workOrderId: string): Promise<HoldFact[]> {
  const cells = await db.workOrderSize.findMany({ where: { workOrderId, measurementProfileId: { not: null } }, select: { salesOrderLineId: true } })
  const lineIds = [...new Set(cells.map((cell) => cell.salesOrderLineId))]
  if (lineIds.length === 0) return []
  const requests = await db.approvalRequest.findMany({
    where: { kind: 'PROOF', recordType: RECORD, recordId: { in: lineIds } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { recordId: true, status: true, dueAt: true, createdAt: true, answeredAt: true },
  })
  const lines = await db.salesOrderLine.findMany({ where: { id: { in: lineIds } }, select: { id: true, seq: true, order: { select: { number: true } } } })
  const facts: HoldFact[] = []
  for (const line of lines) {
    const latest = requests.find((request) => request.recordId === line.id)
    if (!latest || latest.status === 'APPROVED' || latest.status === 'APPROVED_WITH_CHANGES' || latest.status === 'WITHDRAWN') continue
    const which = `the design proof of ${line.order.number} line ${line.seq}`
    const reason =
      latest.status === 'OPEN'
        ? `${which} waits for the customer's approval (answer by ${shortDayOf(latest.dueAt, 'en')})`
        : latest.status === 'REFUSED'
          ? `${which} was refused by the customer: send a new proof`
          : `${which} expired without an answer: ask the customer again`
    facts.push({ holdId: null, reason, placedAt: toUtcIso(latest.answeredAt ?? latest.createdAt), liftedBy: "The customer's approval of the proof lifts it." })
  }
  return facts
}
