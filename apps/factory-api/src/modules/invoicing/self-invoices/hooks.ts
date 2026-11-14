import { ConflictError } from '@nexus/factory-domain/core/errors'
import type { IssueProblem } from '@nexus/factory-domain/invoicing/checks'
import { debitProblem } from '@nexus/factory-domain/invoicing/debit-notes/debit-notes'
import { isSelfInvoiceDocType, waitsWords } from '@nexus/factory-domain/invoicing/self-invoices/self-invoices'
import type { CommandTools, CommandTx } from '../../../core/command'
import { issueRefusal } from '../tax-codes/store'
import type { InvoiceRow, Reader } from '../store'
import { lockSettings, readSettings } from '../test-mode/store'

/**
 * B-W2b-401's hooks in the invoice core (each called on one marked line): the checks before a debit note (TD05) or a
 * self-invoice (TD16-TD19) is issued, the switch read again under its lock inside the issue, the self-invoice marked ISSUED
 * with its invoice, the invoice either names in DatiFattureCollegate, and a self-invoice's draft kept from a plain delete.
 * GATE-ACCOUNTANT: both wait for the company's switch `selfInvoicesOn` (the database refuses a TD16-TD19 issued while it is
 * off; a TD05 is the API's to hold).
 */

const SWITCH_PATH = 'eInvoicing/selfInvoicesOn'

/** The debit note's or the self-invoice's own problems before its issue (facts.ts reviewIssue: the pre-check and the issue). */
export async function depthIssueProblems(db: Reader, invoice: Pick<InvoiceRow, 'id' | 'docType' | 'status' | 'companyId' | 'buyerPartyId'>): Promise<IssueProblem[]> {
  if (invoice.status !== 'DRAFT') return []
  const isDebit = invoice.docType === 'TD05'
  if (!isDebit && !isSelfInvoiceDocType(invoice.docType)) return []
  const problems: IssueProblem[] = []
  const on = (await readSettings(db, invoice.companyId)).selfInvoicesOn
  if (isDebit) {
    const waits = waitsWords(on, 'DEBIT_NOTES')
    if (waits) problems.push({ code: 'DEBIT_NOTE_OFF', path: SWITCH_PATH, message: waits })
    const row = await db.invoice.findUnique({ where: { id: invoice.id }, select: { debitOf: { select: { docType: true, status: true, number: true, companyId: true, buyerPartyId: true } } } })
    const debited = row?.debitOf ?? null
    const problem = debited ? debitProblem(debited) : { code: 'NOT_DEBITABLE', message: 'A debit note names the invoice it adds to.' }
    if (problem) problems.push({ code: 'DEBIT_NOTE_TARGET', path: 'debitOf', message: problem.message })
    return problems
  }
  const waits = waitsWords(on, 'SELF_INVOICES')
  if (waits) problems.push({ code: 'SELF_INVOICE_OFF', path: SWITCH_PATH, message: waits })
  if (invoice.docType === 'TD16') problems.push({ code: 'SELF_INVOICE_KIND', path: 'docType', message: 'An internal reverse charge (TD16) stays with the accountant: it is not issued here.' })
  else if (!(await db.selfInvoice.findFirst({ where: { invoiceId: invoice.id, status: 'PENDING' }, select: { id: true } }))) {
    problems.push({ code: 'SELF_INVOICE_MISSING', path: 'selfInvoice', message: 'A self-invoice is issued from its supplier invoice (Finance › Payables › Self-invoices), which names this draft.' })
  }
  return problems
}

/**
 * Inside the issue command, before the number: the switch again, the company's row held FOR SHARE until the commit (a switch
 * turned off meanwhile waits for this issue, or this issue sees it off: 409 in words, no number).
 */
export async function depthAtIssue(tools: Pick<CommandTools, 'tx'>, invoice: Pick<InvoiceRow, 'docType' | 'companyId'>): Promise<void> {
  const isDebit = invoice.docType === 'TD05'
  if (!isDebit && !isSelfInvoiceDocType(invoice.docType)) return
  const waits = waitsWords((await lockSettings(tools.tx, invoice.companyId)).selfInvoicesOn, isDebit ? 'DEBIT_NOTES' : 'SELF_INVOICES')
  if (waits) throw issueRefusal([{ code: isDebit ? 'DEBIT_NOTE_OFF' : 'SELF_INVOICE_OFF', path: SWITCH_PATH, message: waits }])
}

/** Inside the issue command, after the invoice is ISSUED: the self-invoice that names it is ISSUED with it. */
export async function selfInvoiceAtIssue(tools: Pick<CommandTools, 'tx' | 'audit' | 'emit'>, invoice: Pick<InvoiceRow, 'id' | 'docType' | 'companyId'>): Promise<void> {
  if (!isSelfInvoiceDocType(invoice.docType)) return
  const self = await tools.tx.selfInvoice.findFirst({ where: { invoiceId: invoice.id, status: 'PENDING' }, select: { id: true, supplierInvoiceId: true, kind: true } })
  if (!self) return
  await tools.tx.selfInvoice.update({ where: { id: self.id }, data: { status: 'ISSUED', version: { increment: 1 } }, select: { id: true } })
  tools.audit({ action: 'invoices.selfInvoiceIssued', recordType: 'SelfInvoice', recordId: self.id, companyId: invoice.companyId, before: { status: 'PENDING' }, after: { status: 'ISSUED', invoiceId: invoice.id } })
  tools.emit({ type: 'self_invoice.changed', subject: self.id, companyId: invoice.companyId, payload: { selfInvoiceId: self.id, companyId: invoice.companyId, supplierInvoiceId: self.supplierInvoiceId, kind: self.kind, action: 'ISSUED', invoiceId: invoice.id } })
}

/**
 * The invoice a debit note adds to, or the supplier's invoice a self-invoice integrates (DatiFattureCollegate), for the
 * pre-check's file and the issued file; null for any other type.
 */
export async function depthRelatedOf(db: Reader, invoice: Pick<InvoiceRow, 'id' | 'docType'>): Promise<{ number: string; issueDate: string } | null> {
  if (invoice.docType === 'TD05') {
    const row = await db.invoice.findUnique({ where: { id: invoice.id }, select: { debitOf: { select: { number: true, issueDate: true } } } })
    const debited = row?.debitOf
    return debited && debited.number && debited.issueDate ? { number: debited.number, issueDate: debited.issueDate.toISOString().slice(0, 10) } : null
  }
  if (!isSelfInvoiceDocType(invoice.docType)) return null
  const self = await db.selfInvoice.findFirst({ where: { invoiceId: invoice.id }, select: { supplierInvoice: { select: { number: true, issueDate: true } } } })
  return self ? { number: self.supplierInvoice.number.slice(0, 20), issueDate: self.supplierInvoice.issueDate.toISOString().slice(0, 10) } : null
}

/** A draft a pending self-invoice names is let go only by cancelling the self-invoice (409 in words, never the database's 500). */
export async function refuseSelfInvoiceDraft(tx: CommandTx, invoiceId: string): Promise<void> {
  const self = await tx.selfInvoice.findFirst({ where: { invoiceId }, select: { kind: true, supplierInvoice: { select: { number: true } } } })
  if (self) throw new ConflictError(`This draft is the ${self.kind} self-invoice of supplier invoice ${self.supplierInvoice.number}: cancel the self-invoice instead (Finance › Payables › Self-invoices).`)
}
