import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { CreditReason } from '@nexus/factory-domain/invoicing/credit-note/credit-note'
import { DEBIT_NOTE_RULE, debitNoteCausale, debitProblem, vatDecreaseVerdict } from '@nexus/factory-domain/invoicing/debit-notes/debit-notes'
import { INVOICES_MANAGE } from '@nexus/factory-domain/invoicing/permissions'
import { waitsWords } from '@nexus/factory-domain/invoicing/self-invoices/self-invoices'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { command, type CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { checkSources, insertDraft, prepareLines, type LineInput, type PaymentInput } from '../drafts'
import { partyFacts } from '../facts'
import { invoiceDetail, officeInvoice, readInvoice, type InvoiceDetail } from '../store'
import { orderTermsSource } from '../terms'
import { readSettings } from '../test-mode/store'
import { refusedDepth } from '../test-mode/refusals'

/**
 * The debit note TD05 and the time limit on VAT decreases (B-W2b-401; FIN-071, FIN-073; design finance.invoices "New ▾ debit
 * note", the credit note pop-up's "VAT time-limit warning on decreases"):
 *
 *   POST …/invoices/:id/debit-note   invoices.manage: a TD05 draft adding charges to an issued TD01/TD24 of the same company and
 *                                    customer (Invoice.debitOfId), in its currency and price basis, its lines' VAT decided by the
 *                                    rules for the customer unless given, the payment terms the office gives or the order's /
 *                                    the customer's. It is issued (INVOICE series) and sent through the invoice routes, only
 *                                    while the company's switch is on (GATE-ACCOUNTANT; hooks.ts).
 *   GET  …/invoices/:id/debit-notes  invoices.view: may it take a debit note, and the ones it has.
 *   GET  …/invoices/:id/vat-time-limit?reason=  invoices.view: before a credit note of this invoice, whether a decrease for
 *                                    that reason may still lower VAT (one year from the operation for an agreed decrease or a
 *                                    billing mistake): a warning, never a refusal; while the switch is off it waits in words.
 */

export interface DebitNoteInput {
  readonly lines: readonly LineInput[]
  /** What the charges are, after "Nota di debito: " in the Causale. */
  readonly causale?: string | null | undefined
  readonly payment?: PaymentInput | null | undefined
}

/** invoices.manage: a debit note draft of an issued invoice (201). 409 refusal/DEBIT_NOTE in words when it cannot take one. */
export async function createDebitNote(caller: CommandCaller, invoiceId: string, body: DebitNoteInput, idempotencyKey: string | undefined): Promise<{ invoice: InvoiceDetail }> {
  const invoice = await officeInvoice(caller, invoiceId, INVOICES_MANAGE)
  const problem = debitProblem(invoice)
  if (problem) throw refusedDepth('DEBIT_NOTE', problem.message)
  const profile = await caller.withClient(async (client) => (await partyFacts(client, invoice.buyerPartyId, businessDate(serverClock.now()), serverClock.now()))?.profile ?? null)
  const lines = prepareLines(body.lines, profile)
  const { result } = await command(caller, { name: 'invoices.createDebitNote', idempotencyKey, input: { invoiceId, ...body } }, async (tools) => {
    const current = (await readInvoice(tools.tx, invoice.id))!
    const again = debitProblem(current)
    if (again) throw refusedDepth('DEBIT_NOTE', again.message)
    await checkSources(tools.tx, { companyId: current.companyId, buyerPartyId: current.buyerPartyId, salesOrderId: current.salesOrderId }, lines)
    const id = newId()
    await insertDraft(
      tools,
      {
        id,
        companyId: current.companyId,
        buyerPartyId: current.buyerPartyId,
        docType: 'TD05',
        priceBasis: current.priceBasis,
        currency: current.currency,
        salesOrderId: current.salesOrderId,
        depositRequestId: null,
        debitOfId: current.id,
        causale: debitNoteCausale({ number: current.number!, issueDate: current.issueDate!.toISOString().slice(0, 10) }, body.causale),
        documentRefs: null,
        payment: body.payment ?? null,
        termsSource: body.payment ? null : await orderTermsSource(tools.tx, { salesOrderId: current.salesOrderId, partyId: current.buyerPartyId }),
        internalNote: null,
      },
      lines,
    )
    return { invoice: await invoiceDetail(tools.tx, (await readInvoice(tools.tx, id))!) }
  })
  return result
}

/** invoices.view: whether the invoice may take a debit note (and what waits), and its debit notes. */
export async function debitNotesOf(caller: CommandCaller, invoiceId: string) {
  const invoice = await officeInvoice(caller, invoiceId)
  const problem = debitProblem(invoice)
  return caller.withClient(async (client) => {
    const on = (await readSettings(client, invoice.companyId)).selfInvoicesOn
    const notes = await client.invoice.findMany({ where: { debitOfId: invoice.id, docType: 'TD05' }, select: { id: true, status: true, number: true, issueDate: true, currency: true, grossTotal: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    return {
      invoiceId: invoice.id,
      debitable: { ok: problem === null, code: problem?.code ?? null, words: problem?.message ?? null },
      debitNotes: notes.map((note) => ({ id: note.id, status: note.status, number: note.number, issueDate: note.issueDate ? note.issueDate.toISOString().slice(0, 10) : null, currency: note.currency, grossTotal: asMoney('price', note.grossTotal) })),
      waits: waitsWords(on, 'DEBIT_NOTES'),
      rule: DEBIT_NOTE_RULE,
    }
  })
}

const VAT_LIMIT_RULE = Object.freeze({
  status: 'UNVERIFIED' as const,
  words: 'Art. 26 c.3 DPR 633/1972: a decrease agreed later between the parties, or the correction of a billing mistake, lowers VAT only within one year of the operation (its earliest DDT, else the invoice date); a return, a defect or a deposit paid back has no such limit. The accountant confirms.',
})

/** invoices.view: the VAT time limit of a credit note of this invoice for `reason`, judged today. */
export async function vatTimeLimit(caller: CommandCaller, invoiceId: string, query: { reason: CreditReason }) {
  const invoice = await officeInvoice(caller, invoiceId)
  if (invoice.status === 'DRAFT' || invoice.issueDate === null) throw new InvalidStateError('The invoice is a draft: a draft is changed, not credited.')
  const today = businessDate(serverClock.now())
  return caller.withClient(async (client) => {
    const on = (await readSettings(client, invoice.companyId)).selfInvoicesOn
    const ddtIds = (await client.invoiceLine.findMany({ where: { invoiceId: invoice.id, ddtId: { not: null } }, select: { ddtId: true } })).flatMap((line) => (line.ddtId ? [line.ddtId] : []))
    const earliest = ddtIds.length > 0 ? await client.ddt.findFirst({ where: { id: { in: ddtIds } }, select: { documentDate: true }, orderBy: { documentDate: 'asc' } }) : null
    const operationDate = (earliest?.documentDate ?? invoice.issueDate!).toISOString().slice(0, 10)
    const verdict = vatDecreaseVerdict({ switchOn: on, reason: query.reason, operationDate, creditDate: today, waits: waitsWords(on, 'VAT_DECREASE_LIMIT') ?? '' })
    return { invoiceId: invoice.id, reason: query.reason, operationDate, judgedOn: today, verdict, rule: VAT_LIMIT_RULE }
  })
}
