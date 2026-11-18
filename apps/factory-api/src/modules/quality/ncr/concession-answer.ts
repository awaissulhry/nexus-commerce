import type { ApprovalLocale } from '@nexus/factory-domain/approvals-out/kinds'
import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { QUALITY_NCR_MANAGE, QUALITY_NCR_VIEW } from '@nexus/factory-domain/quality/ncr/permissions'
import { customerRefOf } from '@nexus/factory-domain/sales/customer-numbers' // fix-pr-10
import type { CommandTools } from '../../../core/command'
import { words, type RecordAdapter, type RequestRef } from '../../../platform/approvals-out/adapter'
import { emitChanged } from './ncr'

/**
 * The customer's concession by link or portal (B-W2b-184 with B-W2b-113; QHS-085; follow-up AP1:01; design links.approve
 * "Concession"): the office asks a concession on the NCR (113's route), then asks the customer to approve it
 * (platform/approvals-out, kind CONCESSION, record NcrConcession): the request names the concession, the concession names
 * the request (onAsked). The customer's answer is ONE command in its own session (the APPROVAL link or the portal person,
 * factory_partner_runtime): the request first, then the concession ACCEPTED (approved, with or without changes: their words
 * in `answer`) or REFUSED, `answeredBy` = the name they typed, `recordedById` null — the customer, not an office person (the
 * partner role cannot even read that column; …_links_depth_w2b_guards factory_ncr_concession_guard lets a partner session
 * change only those columns, only as the request was answered). The partner grant is on NcrConcession only, never on
 * NcrCostLine. The office path stays: 113's POST …/concessions/:id/answer records a written answer by hand (then a request
 * still open answers nothing: answerHeld).
 */

const RECORD = 'NcrConcession'

const CONCESSION = {
  id: true,
  ncrId: true,
  seq: true,
  partyId: true,
  ask: true,
  proposal: true,
  status: true,
  approvalRequestId: true,
  ncr: { select: { id: true, number: true, companyId: true, siteId: true, stage: true, title: true, workOrderId: true /* fix-pr-10 */ } },
} as const

export const CONCESSION_ADAPTER: RecordAdapter = Object.freeze<RecordAdapter>({
  recordType: RECORD,
  kinds: ['CONCESSION'],
  view: QUALITY_NCR_VIEW,
  ask: QUALITY_NCR_MANAGE,
  async read(client, recordId) {
    const row = await client.ncrConcession.findUnique({ where: { id: recordId }, select: CONCESSION })
    if (!row) return null
    const held =
      row.status !== 'ASKED'
        ? `Concession ${row.seq} of ${row.ncr.number} is answered already.`
        : row.approvalRequestId !== null
          ? `Concession ${row.seq} of ${row.ncr.number} is asked of the customer already: withdraw that request first.`
          : row.ncr.stage === 'CLOSED' || row.ncr.stage === 'CANCELLED'
            ? `${row.ncr.number} is ${row.ncr.stage.toLowerCase()}: no concession is asked any more.`
            : null
    return { companyId: row.ncr.companyId, siteId: row.ncr.siteId, partyId: row.partyId, label: { it: `${row.ncr.number} · concessione ${row.seq}`, en: `${row.ncr.number} · concession ${row.seq}` }, held, thread: { type: 'Nonconformance', id: row.ncrId } }
  },
  async fileRecords(client, recordId) {
    const row = await client.ncrConcession.findUnique({ where: { id: recordId }, select: { id: true, ncrId: true } })
    return row ? [{ type: RECORD, id: row.id }, { type: 'Nonconformance', id: row.ncrId }] : []
  },
  async content(client, request, locale: ApprovalLocale) {
    const row = await client.ncrConcession.findUnique({ where: { id: request.recordId }, select: CONCESSION })
    if (!row) return { facts: [], revisedOrder: null }
    // ---- fix-pr-10 (B-TH-303: the portal never shows the office's series): what the customer reads names no NCR number of ours — a
    // plain "Quality concession" with the NCR's title, and the customer's OWN order number ("#12") of what its work order makes for
    // this customer (only this concession's party's cells; none known: no line). content() is read only by the partner's page.
    const orders = row.ncr.workOrderId
      ? await client.workOrderSize.findMany({ where: { workOrderId: row.ncr.workOrderId, partyId: row.partyId, salesOrderLineId: { not: null } }, select: { salesOrderLine: { select: { order: { select: { id: true, customerSeq: true } } } } } })
      : []
    const seqs = new Map(orders.flatMap((cell) => (cell.salesOrderLine ? [[cell.salesOrderLine.order.id, cell.salesOrderLine.order.customerSeq] as const] : [])))
    const own = [...new Set([...seqs.values()].map((seq) => customerRefOf('ORDER', seq) ?? '—'))].sort()
    return {
      facts: [
        { label: words(locale, 'Concessione di qualità', 'Quality concession'), value: row.ncr.title },
        ...(own.length > 0 ? [{ label: words(locale, 'Il vostro ordine', 'Your order'), value: own.join(', ') }] : []),
        // ---- end fix-pr-10
        { label: words(locale, 'La deviazione', 'The deviation'), value: row.ask },
        { label: words(locale, 'Cosa proponiamo', 'What we propose'), value: row.proposal },
      ],
      revisedOrder: null,
    }
  },
  async answerHeld(client, request: RequestRef, locale: ApprovalLocale) {
    const row = await client.ncrConcession.findUnique({ where: { id: request.recordId }, select: { status: true, approvalRequestId: true } })
    if (row?.status === 'ASKED' && row.approvalRequestId === request.id) return null
    return words(locale, 'Questa concessione ha già una risposta registrata da noi: non serve più rispondere qui.', 'This concession was answered already (we recorded it): no answer is needed here any more.')
  },
  // The office (ask's command): the concession names its request, once, while ASKED (the guard holds it too).
  async onAsked(tools, request) {
    const { count } = await tools.tx.ncrConcession.updateMany({
      where: { id: request.recordId, status: 'ASKED', approvalRequestId: null },
      data: { approvalRequestId: request.id, version: { increment: 1 }, updatedAt: tools.now },
    })
    if (count !== 1) throw new InvalidStateError('This concession is answered or asked already.')
  },
  // The customer's own session: the concession answered as the request was (the request is written first).
  async onAnswered(tools: CommandTools, request) {
    const { count } = await tools.tx.ncrConcession.updateMany({
      where: { id: request.recordId, status: 'ASKED', approvalRequestId: request.id },
      data: { status: request.status === 'REFUSED' ? 'REFUSED' : 'ACCEPTED', answer: request.answer, answeredAt: request.answeredAt, answeredBy: request.typedName, version: { increment: 1 }, updatedAt: tools.now },
    })
    if (count !== 1) throw new InvalidStateError('This concession was answered already.')
  },
  // The office's screens (the system): the NCR changed (its concessions), with its audit row.
  async settle(tools, request) {
    const row = await tools.tx.ncrConcession.findUnique({ where: { id: request.recordId }, select: { id: true, seq: true, status: true, ncr: { select: { id: true, number: true, companyId: true, siteId: true } } } })
    if (!row) return null
    tools.audit({ action: 'quality.ncrConcessionByPartner', recordType: 'Nonconformance', recordId: row.ncr.id, companyId: row.ncr.companyId, siteId: row.ncr.siteId, after: { concessionId: row.id, seq: row.seq, status: row.status, approvalRequestId: request.id } })
    emitChanged(tools, row.ncr, ['concessions'])
    return { concessionId: row.id, status: row.status }
  },
})
