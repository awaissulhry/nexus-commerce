import { ConflictError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { creditable, creditNoteDraft, creditProblems, refundDueAfter, type CreditAsk, type CreditReason } from '@nexus/factory-domain/invoicing/credit-note/credit-note'
import { computeInvoiceTotals, treatmentOf } from '@nexus/factory-domain/invoicing/invoices'
import { INVOICES_MANAGE } from '@nexus/factory-domain/invoicing/permissions'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { PriceBasis } from '@nexus/factory-domain/tax/vat-summary'
import { command, type CommandCaller } from '../../../core/command'
import { insertDraft } from '../drafts'
import { creditedInvoiceOf } from '../from-shipment/store'
import { invoiceDetail, officeInvoice, readInvoice } from '../store'

/**
 * The credit note draft of an issued invoice (B-W1-51; FIN-069; DPR 633/1972 art. 26; A2 SCR-081 "Credit note for
 * 2026/0142"): invoices.manage, ONE command. The rules are factory-domain invoicing/credit-note: what may be credited,
 * FULL / LINES / AMOUNT, positive amounts at the credited lines' own VAT, the reason on the causale, never above what is
 * still creditable (issued credit notes counted; other DRAFT credit notes are not, the issue checks again under the
 * credited invoice's lock). The draft names the invoice it credits (creditOfId) and its order; it is issued and sent like
 * any invoice (issue.ts: invoices.issue + step-up; the CREDIT_NOTE series when the company keeps one). The answer says
 * what is still creditable and the refund that will be due once it is issued (refunds are W2b).
 */

export interface CreditNoteInput {
  readonly reason: CreditReason
  readonly reasonText?: string | null | undefined
  readonly full?: boolean | undefined
  readonly lines?: readonly { readonly lineId: string; readonly quantity?: string | undefined; readonly unitPrice?: string | undefined }[] | undefined
  readonly amount?: number | undefined
  readonly amountBasis?: PriceBasis | undefined
  readonly vatRatePct?: string | undefined
  readonly vatNature?: string | null | undefined
  readonly vatLegalRef?: string | null | undefined
  readonly description?: string | null | undefined
  readonly internalNote?: string | null | undefined
}

function askOf(body: CreditNoteInput, basis: PriceBasis): CreditAsk {
  const modes = [body.full === true, body.lines !== undefined, body.amount !== undefined].filter(Boolean).length
  if (modes !== 1) throw new ValidationError('Credit the whole invoice (full), some of its lines (lines), or an amount (amount): one of the three.', [{ path: 'body', message: 'One of full, lines or amount.' }])
  if (body.full === true) return { mode: 'FULL' }
  if (body.lines !== undefined) return { mode: 'LINES', lines: body.lines }
  let vat
  if (body.vatRatePct !== undefined || body.vatNature !== undefined) {
    vat = treatmentOf({ vatRatePct: body.vatRatePct ?? '0', vatNature: body.vatNature?.trim() || null, vatLegalRef: body.vatLegalRef?.trim() || null })
    if (vat === null) throw new ValidationError('A VAT rate of 22, 10, 5 or 4, or 0 with its Natura and law.', [{ path: 'body/vatRatePct', message: 'Not a VAT treatment.' }])
  }
  return { mode: 'AMOUNT', amount: body.amount!, basis: body.amountBasis ?? basis, ...(vat ? { vat } : {}), ...(body.description ? { description: body.description } : {}) }
}

/** invoices.manage: a TD04 draft crediting an issued invoice. */
export async function createCreditNote(caller: CommandCaller, invoiceId: string, body: CreditNoteInput, idempotencyKey?: string) {
  const invoice = await officeInvoice(caller, invoiceId, INVOICES_MANAGE)
  const { result } = await command(caller, { name: 'invoices.createCreditNote', idempotencyKey, input: { invoiceId, ...body } }, async (tools) => {
    const credited = (await creditedInvoiceOf(tools.tx, invoice.id, null))!
    const { draft, problems } = creditNoteDraft(credited, askOf(body, credited.priceBasis), body.reason, body.reasonText)
    if (!draft) {
      if (problems.some((problem) => problem.path === 'invoice')) throw new ConflictError(problems[0]!.message)
      throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'This credit note cannot be made.', problems)
    }
    const totals = computeInvoiceTotals(draft.lines.map((line) => line.core), draft.priceBasis, credited.currency)
    const over = creditProblems({ causale: draft.causale, netTotal: totals.netTotal, grossTotal: totals.grossTotal }, credited)
    if (over.length > 0) throw new ConflictError(over[0]!.message)
    const id = newId()
    await insertDraft(
      tools,
      {
        id,
        companyId: credited.companyId,
        buyerPartyId: credited.buyerPartyId,
        docType: 'TD04',
        priceBasis: draft.priceBasis,
        currency: credited.currency,
        salesOrderId: credited.salesOrderId,
        depositRequestId: null,
        creditOfId: credited.id,
        causale: draft.causale,
        documentRefs: null,
        payment: null,
        internalNote: body.internalNote?.trim() || null,
      },
      draft.lines.map((line) => ({ core: line.core, salesOrderLineId: line.salesOrderLineId, size: line.size, ddtId: null })),
    )
    tools.audit({ action: 'invoices.creditNote', recordType: 'Invoice', recordId: id, companyId: credited.companyId, after: { creditOfId: credited.id, reason: body.reason, mode: body.full ? 'FULL' : body.lines ? 'LINES' : 'AMOUNT' } })
    const left = creditable(credited)
    return {
      invoice: await invoiceDetail(tools.tx, (await readInvoice(tools.tx, id))!),
      creditableAmount: asMoney('price', left.gross),
      refundDueAmount: asMoney('price', refundDueAfter(credited, totals.grossTotal)),
    }
  })
  return result
}
