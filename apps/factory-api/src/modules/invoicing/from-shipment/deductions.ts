import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { INVOICES_MANAGE } from '@nexus/factory-domain/invoicing/permissions'
import { markMoney } from '@nexus/factory-domain/money/marked'
import type { CommandCaller } from '../../../core/command'
import { onDraft, refreshDraft, storedPrepared } from '../drafts'
import { storedSourceOf } from '../terms'
import { invoiceDetail, officeInvoice, readInvoice, type InvoiceDetail } from '../store'

/**
 * Removing a deposit deduction from a draft (B-W1-51; FIN-078; A2 SCR-081 "Deposits & payments"): the deductions of a
 * draft made from DDTs are added automatically and may only be removed (the deposit is then deducted on the next invoice
 * of the order; making the draft again from its DDTs adds what is left). ONE command on the draft (its version guards
 * it): the line goes, the totals follow (drafts.ts refreshDraft).
 */
export async function removeDeduction(caller: CommandCaller, invoiceId: string, lineId: string, query: { version?: number | undefined }, idempotencyKey?: string): Promise<{ invoice: InvoiceDetail }> {
  const invoice = await officeInvoice(caller, invoiceId, INVOICES_MANAGE)
  return onDraft(caller, invoice, { name: 'invoices.removeDeduction', idempotencyKey, input: { invoiceId, lineId, ...query }, version: query.version }, async (tools, current) => {
    const line = isUuid(lineId) ? await tools.tx.invoiceLine.findFirst({ where: { id: lineId, invoiceId: current.id }, select: { id: true, kind: true, depositInvoiceId: true, netAmount: true } }) : null
    if (!line || line.kind !== 'DEPOSIT_DEDUCTION') throw new NotFoundError('Deposit deduction not found on this invoice.')
    const kept = (await tools.tx.invoiceLine.findMany({ where: { invoiceId: current.id }, orderBy: { seq: 'asc' }, select: { id: true } })).map((row) => row.id)
    const lines = (await storedPrepared(tools.tx, current.id)).filter((_, index) => kept[index] !== line.id)
    const totals = await refreshDraft(tools, current, lines, current.priceBasis, storedSourceOf(current.paymentTerms))
    tools.audit({
      action: 'invoices.removeDeduction',
      recordType: 'Invoice',
      recordId: current.id,
      companyId: current.companyId,
      before: { depositInvoiceId: line.depositInvoiceId, deductedNet: markMoney('price', -line.netAmount), grossTotal: markMoney('price', current.grossTotal) },
      after: { depositInvoiceId: null, grossTotal: markMoney('price', totals.grossTotal) },
    })
    tools.emit({ type: 'invoice.draft_saved', subject: current.id, companyId: current.companyId, payload: { invoiceId: current.id, docType: current.docType, created: false } })
    return { invoice: await invoiceDetail(tools.tx, (await readInvoice(tools.tx, current.id))!) }
  })
}
