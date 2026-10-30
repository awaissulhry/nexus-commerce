import { ConflictError } from '@nexus/factory-domain/core/errors'
import { INVOICES_MANAGE, INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { command, type CommandCaller } from '../../../core/command'
import type { PaymentInput } from '../drafts'
import { assertMay, officeContextOf } from '../store'
import { draftFromDdtsInCommand, draftPlanOf, type FromDdtsAnswer } from './draft'
import { shippedNotInvoiced, type QueueQuery } from './queue'
import { readDdts } from './store'

/**
 * One invoice for many shipments (B-W2a-54; FIN-059 "One deferred invoice across many DDTs"; DPR 633/1972 art. 21 c.4
 * lett. a; design finance.invoices tile "Deferred invoices due by the 15th", toinvoice "Create deferred invoice for 4 DDTs
 * of Customer Gamma"):
 *
 *   GET  /invoicing/deferred             the deferred invoices due: per customer, company and month, the DDTs still to
 *                                        invoice whose invoice is a TD24 (the customer is invoiced monthly, or the DDTs
 *                                        are several or past their 12 days), with their value, the freight still to
 *                                        bill, the drafts holding some of them and the deadline (the 15th of the next
 *                                        month) counted down; the counts the tile shows (OPEN, DUE_SOON, LATE).
 *   POST /invoicing/invoices/deferred    {companyId, partyId, month}: ONE TD24 draft of every DDT of that month the
 *                                        customer still has to be invoiced for, made as a draft from DDTs is
 *                                        (draft.ts: under their locks, the goods, their freight, the deposits, the terms).
 * Reads only the 500 oldest open DDTs of the reader (the queue's limit); the post reads the month's DDTs of one customer.
 */

export async function deferredDue(caller: CommandCaller, query: QueueQuery) {
  const queue = await shippedNotInvoiced(caller, query)
  const groups = queue.customers.flatMap((customer) =>
    customer.months
      .filter((month) => month.suggested === 'TD24' || (month.suggested === null && customer.preset === 'TD24'))
      .map((month) => {
        const ddts = customer.ddts.filter((ddt) => month.ddtIds.includes(ddt.ddtId))
        return {
          companyId: customer.companyId,
          partyId: customer.partyId,
          code: customer.code,
          legalName: customer.legalName,
          invoiceTiming: customer.invoiceTiming,
          month: month.month,
          ddts: ddts.map((ddt) => ({ ddtId: ddt.ddtId, number: ddt.number, date: ddt.date, shipmentNumber: ddt.shipmentNumber })),
          valueAmount: asMoney('price', ddts.reduce((sum, ddt) => sum + (ddt.valueAmount as number), 0)),
          freightAmount: asMoney('price', ddts.reduce((sum, ddt) => sum + (ddt.freight.billed ? 0 : ((ddt.freight.amount as number | null) ?? 0)), 0)),
          drafts: [...new Set(ddts.flatMap((ddt) => ddt.drafts))],
          deadline: month.deadline,
          words: month.words,
        }
      }),
  )
  groups.sort((a, b) => (a.deadline?.dueBy ?? '').localeCompare(b.deadline?.dueBy ?? '') || a.legalName.localeCompare(b.legalName) || a.month.localeCompare(b.month))
  const count = (state: string) => groups.filter((group) => group.deadline?.state === state).length
  return { asOf: queue.asOf, counts: { groups: groups.length, open: count('OPEN'), dueSoon: count('DUE_SOON'), late: count('LATE') }, groups }
}

export interface DeferredInput {
  readonly companyId: string
  readonly partyId: string
  /** YYYY-MM: the month of the DDTs. */
  readonly month: string
  readonly freight?: boolean | undefined
  readonly causale?: string | null | undefined
  readonly payment?: PaymentInput | null | undefined
  readonly internalNote?: string | null | undefined
}

const monthRange = (month: string): { gte: Date; lt: Date } => {
  const start = new Date(`${month}-01T00:00:00.000Z`)
  const end = new Date(start)
  end.setUTCMonth(end.getUTCMonth() + 1)
  return { gte: start, lt: end }
}

/** invoices.manage: the TD24 draft of every DDT of `month` the customer still has to be invoiced for. */
export async function createDeferred(caller: CommandCaller, body: DeferredInput, idempotencyKey?: string): Promise<FromDdtsAnswer> {
  const context = officeContextOf(caller)
  assertMay(context, INVOICES_VIEW, INVOICES_MANAGE, { companyId: body.companyId, partyId: body.partyId }, 'Customer')
  const where = { companyId: body.companyId, partyId: body.partyId, documentDate: monthRange(body.month), cancellations: { none: {} }, shipment: { status: { in: ['SHIPPED' as const, 'DELIVERED' as const] } } }
  const ddts = await caller.withClient((client) => readDdts(client, where, 500))
  if (ddts.length === 0) throw new ConflictError(`No DDT of ${body.month} of this customer waits for an invoice (shipped, not cancelled).`)
  const scope = { companyId: body.companyId, partyId: body.partyId }
  const plan = await draftPlanOf(caller, scope)
  const ids = ddts.map((ddt) => ddt.id)
  const { result } = await command(caller, { name: 'invoices.createDeferred', idempotencyKey, input: body }, (tools) =>
    draftFromDdtsInCommand(tools, scope, ids, { ddtIds: ids, docType: 'TD24', freight: body.freight, causale: body.causale, payment: body.payment, internalNote: body.internalNote }, plan, 'invoices.deferred'),
  )
  return result
}
