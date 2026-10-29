import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import type { AttentionCandidate } from '@nexus/factory-domain/insights/attention'
import { deadlineSeverity } from '@nexus/factory-domain/insights/states'
import { invoiceSdiWords, invoiceToIssueWords, type SdiAttentionState } from '@nexus/factory-domain/insights/words'
import { INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import { deadlineState } from '@nexus/factory-domain/invoicing/sdi/deadline'
import { shippedNotInvoiced } from '../../invoicing/from-shipment/queue'
import { readCopies } from '../../invoicing/sdi/copy'
import { filesPending } from '../../invoicing/store'
import { asDay, capped, partyNames, SOURCE_LIMIT, type Source } from './common'

/**
 * Money (B-W1-28 invoices, B-W1-50 SDI, B-W1-51 shipped goods): issued invoices that SDI rejected (with the 5-working-day
 * resend deadline of the invoicing module), that did not reach SDI, that SDI could not deliver while no courtesy copy
 * went out, or whose XML or PDF is not stored yet; and shipped goods not invoiced, per customer, company and month, with
 * the deadline the invoicing module's own queue (GET /invoicing/shipped-not-invoiced) gives them.
 */

/** INVOICE_SDI: invoices that need a person before SDI holds them for the customer. */
export const invoiceSdi: Source = async ({ caller, viewer }) => {
  const scope = scopeWhere(viewer.actor, INVOICES_VIEW, { company: 'companyId', party: 'buyerPartyId' }) as Prisma.InvoiceWhereInput
  return caller.withClient(async (db) => {
    const found = await db.invoice.findMany({
      where: { AND: [scope, { status: { not: 'DRAFT' } }, { OR: [{ status: { in: ['REJECTED', 'ERROR', 'NOT_DELIVERABLE'] } }, { xmlFileId: null }, { pdfFileId: null }] }] },
      orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }],
      take: SOURCE_LIMIT + 1,
      select: { id: true, number: true, companyId: true, buyerPartyId: true, status: true, issuedAt: true, updatedAt: true, createdAt: true, currency: true, netTotal: true, xmlFileId: true, pdfFileId: true },
    })
    const { rows, complete } = capped(found, SOURCE_LIMIT)
    const names = await partyNames(db, rows.map((row) => row.buyerPartyId))
    const candidates: AttentionCandidate[] = []
    for (const row of rows) {
      let state: SdiAttentionState
      let deadline: string | null = null
      let since = row.issuedAt ?? row.createdAt
      if (row.status === 'REJECTED') {
        state = 'REJECTED'
        const latest = await db.sdiSubmission.findFirst({ where: { invoiceId: row.id }, orderBy: { attempt: 'desc' }, select: { id: true, outcomeAt: true } })
        const ns = latest ? await db.sdiNotification.findFirst({ where: { submissionId: latest.id, type: 'NS' }, orderBy: { receivedAt: 'asc' }, select: { receivedAt: true } }) : null
        const rejectedAt = ns?.receivedAt ?? latest?.outcomeAt ?? null
        if (rejectedAt) {
          deadline = deadlineState(rejectedAt, viewer.today).deadline
          since = rejectedAt
        }
      } else if (row.status === 'ERROR') {
        state = 'ERROR'
        since = row.updatedAt
      } else if (row.status === 'NOT_DELIVERABLE') {
        // The courtesy copy goes out by itself (worker handler invoicing.sdiCourtesyCopy): a person only when none did.
        if ((await readCopies(db, row.id)).queued.length > 0) continue
        state = 'NOT_DELIVERABLE'
        since = row.updatedAt
      } else if (filesPending(row)) {
        state = 'FILES_PENDING'
      } else {
        continue
      }
      const number = row.number ?? 'without a number'
      candidates.push({
        kind: 'INVOICE_SDI',
        state,
        severity: state === 'REJECTED' || state === 'ERROR' ? 'HIGH' : 'MEDIUM',
        record: { type: 'Invoice', id: row.id, label: number },
        scope: { companyId: row.companyId, siteId: null, partyId: row.buyerPartyId },
        ...invoiceSdiWords({ number, customer: names.get(row.buyerPartyId) ?? 'the customer', state, deadline }),
        due: deadline,
        since,
        amounts: { currency: row.currency, netAmount: row.netTotal },
      })
    }
    return { kind: 'INVOICE_SDI', candidates, complete }
  })
}

/** INVOICE_TO_ISSUE: per customer, company and month, the DDTs whose goods no issued invoice bills yet. */
export const invoiceToIssue: Source = async ({ caller }) => {
  const queue = await shippedNotInvoiced(caller, {})
  const candidates: AttentionCandidate[] = []
  for (const customer of queue.customers) {
    for (const month of customer.months) {
      const ddts = customer.ddts.filter((ddt) => month.ddtIds.includes(ddt.ddtId))
      if (ddts.length === 0 || month.deadline === null) continue
      const oldest = ddts.map((ddt) => ddt.date).sort()[0]!
      candidates.push({
        kind: 'INVOICE_TO_ISSUE',
        state: month.deadline.state,
        severity: deadlineSeverity(month.deadline.state),
        record: { type: 'Party', id: customer.partyId, label: customer.legalName },
        scope: { companyId: customer.companyId, siteId: null, partyId: customer.partyId },
        ...invoiceToIssueWords({ customer: customer.legalName, month: month.month, ddts: ddts.map((ddt) => ddt.number), deadlineWords: month.deadline.words }),
        due: month.deadline.dueBy,
        since: asDay(oldest),
        subKey: `${customer.companyId}:${month.month}`,
      })
    }
  }
  // The queue reads the 500 oldest DDTs at most.
  return { kind: 'INVOICE_TO_ISSUE', candidates, complete: queue.customers.reduce((sum, customer) => sum + customer.ddts.length, 0) < 500 }
}
