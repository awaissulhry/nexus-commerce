import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, LIST_ROWS, type Role } from '../../_demo/fixtures'
import type { CreditReason } from '../../_shared/api'
import { designScreen as recordScreen } from '../record/fixtures'
import { InvoiceRecordView } from '../record/view/InvoiceRecordView'
import { financeCanOf } from '../test-mode/demo/fixtures'
import type { DebitNotes, VatLimit } from './api'
import { emptyDebitLine, type DebitLineDraft } from './model'
import { DebitNoteDialog, type DebitNoteModel } from './view/DebitNoteDialog'
import { VatTimeLimitNote, type VatTimeLimitModel } from './view/VatTimeLimitNote'

/**
 * SCR-442 — New ▾ › Debit note and the credit note's VAT time limit (design finance.invoices page.h "New ▾ (credit note ·
 * debit note W2b · deposit invoice)" and pop:credit-note "VAT time-limit warning on decreases"; B-W2b-417 on B-W2b-401's
 * API; FIN-071, FIN-073), made-up data only: the debit note — the invoice picked from the issued ones (or handed over by
 * the record), its debit notes so far, what waits for the accountant, the lines added (a charge, a service), the lines'
 * problems, a refusal —, the credit note's picker, and inside the credit note the verdict for the reason picked: within
 * the year, beyond it, no limit, ask, waiting for the accountant, loading, failed. Roles: Finance, Sales (held with why).
 */

const ISSUED_ROWS = LIST_ROWS.filter((row) => row.status !== 'DRAFT' && row.status !== 'REJECTED' && (row.docType === 'TD01' || row.docType === 'TD24'))
const FIRST = ISSUED_ROWS[0] ?? LIST_ROWS[0]!

const INFO: DebitNotes = { invoiceId: FIRST.id, debitable: { ok: true, code: null }, debitNotes: [{ id: '0190f0e2-8181-7000-8000-000000000050', status: 'DRAFT', number: null, issueDate: null, currency: 'EUR', grossTotal: 18300 }], waits: 'off' }

const FREIGHT: DebitLineDraft = { kind: 'CHARGE', chargeKind: 'FREIGHT', description: 'Trasporto aggiuntivo urgente', quantity: '1', unitPrice: '150,00' }

type DebitCase = { role: Role; kind: 'dialog'; dialog: DebitNoteModel } | { role: Role; kind: 'vat'; reason: CreditReason; vat: VatTimeLimitModel }

const dialog = (role: Role, over: Partial<DebitNoteModel> = {}): DebitCase => ({
  role,
  kind: 'dialog',
  dialog: { can: financeCanOf(role), kind: 'debit', fixed: null, rows: { value: ISSUED_ROWS, problem: null }, invoiceId: null, info: null, lines: [emptyDebitLine()], causale: '', busy: false, problem: null, ...over },
})

const verdict = (state: VatLimit['verdict']['state'], limitDate: string | null, operationDate = '2025-10-27'): VatLimit => ({ invoiceId: FIRST.id, reason: 'PRICE_REDUCTION', operationDate, judgedOn: '2026-11-14', verdict: { state, limitDate } })
const vat = (reason: CreditReason, over: Partial<VatTimeLimitModel>): DebitCase => ({ role: 'finance', kind: 'vat', reason, vat: { asked: true, value: null, problem: null, ...over } })

function DebitDesign({ model }: { model: DebitCase }) {
  if (model.kind === 'dialog') return inShell('/finance/invoices', createElement(DebitNoteDialog, { model: model.dialog }), model.role)
  const found = recordScreen.cases.find((item) => item.id === 'credit-dialog')!.model.record
  const record = { ...found, draft: { ...found.draft, reason: model.reason } }
  return inShell('/finance/invoices/credit', createElement(InvoiceRecordView, { model: record, depth: { creditWarning: () => createElement(VatTimeLimitNote, { model: model.vat }) } }), model.role)
}

export const designScreen = defineDesignScreen<DebitCase>({
  screen: 'SCR-442',
  title: 'New ▾ › Debit note (TD05) and the credit note’s time limit on lowering the VAT',
  view: DebitDesign,
  cases: [
    { id: 'pick', label: 'Finance · New ▾ › Debit note: pick the issued invoice it adds to', model: dialog('finance') },
    { id: 'lines', label: 'Finance · Its debit notes so far; waits for the accountant; a freight charge added (Create draft)', model: dialog('finance', { invoiceId: FIRST.id, info: { value: INFO, problem: null }, lines: [FREIGHT], causale: 'Spedizione espressa richiesta dal cliente' }) },
    { id: 'lines-problems', label: 'Finance · A line without words and a price of 0: held with why', model: dialog('finance', { invoiceId: FIRST.id, info: { value: { ...INFO, waits: null, debitNotes: [] }, problem: null }, lines: [FREIGHT, { ...emptyDebitLine(), unitPrice: '0' }] }) },
    { id: 'from-record', label: 'Finance · From the invoice’s ⋯: the invoice handed over', model: dialog('finance', { fixed: { id: FIRST.id, number: FIRST.number, partyName: FIRST.partyName }, invoiceId: FIRST.id, info: { value: { ...INFO, waits: null, debitNotes: [] }, problem: null }, lines: [{ ...FREIGHT, kind: 'SERVICE', description: 'Adeguamento prezzo concordato' }] }) },
    { id: 'not-debitable', label: 'Finance · A rejected invoice: no debit note (said; Create held)', model: dialog('finance', { invoiceId: FIRST.id, info: { value: { ...INFO, debitable: { ok: false, code: 'REJECTED' }, debitNotes: [] }, problem: null }, lines: [FREIGHT] }) },
    { id: 'refused', label: 'Finance · Refused by the API (said in the dialog, the lines kept)', model: dialog('finance', { invoiceId: FIRST.id, info: { value: INFO, problem: null }, lines: [FREIGHT], problem: { key: 'finance-invoices-depth:refusal.DEBIT_NOTE', reload: false } }) },
    { id: 'pick-loading', label: 'Loading the issued invoices', model: dialog('finance', { rows: { value: null, problem: null } }) },
    { id: 'pick-error', label: 'The issued invoices could not be read (Try again)', model: dialog('finance', { rows: { value: null, problem: 'problem.read.unavailable' } }) },
    { id: 'pick-empty', label: 'No issued invoice can take one yet', model: dialog('finance', { rows: { value: [], problem: null } }) },
    { id: 'credit-pick', label: 'Finance · New ▾ › Credit note: pick the invoice, its credit note dialog next', model: dialog('finance', { kind: 'credit', invoiceId: FIRST.id }) },
    { id: 'sales', label: 'Sales · Create held with why', model: dialog('sales', { invoiceId: FIRST.id, info: { value: INFO, problem: null }, lines: [FREIGHT] }) },
    { id: 'vat-within', label: 'Finance · Credit note, price reduction: within the year (the limit day said)', model: vat('PRICE_REDUCTION', { value: verdict('WITHIN', '2027-01-27', '2026-01-27') }) },
    { id: 'vat-beyond', label: 'Finance · Credit note, billing mistake beyond the year: the VAT stays due (ask the accountant)', model: vat('BILLING_ERROR', { value: verdict('BEYOND', '2026-10-27') }) },
    { id: 'vat-no-limit', label: 'Finance · Credit note for a return: no time limit', model: vat('RETURN', { value: verdict('NO_LIMIT', null) }) },
    { id: 'vat-ask', label: 'Finance · Credit note for another reason: ask the accountant', model: vat('OTHER', { value: verdict('ASK', null) }) },
    { id: 'vat-waits', label: 'Finance · The check waits for the accountant (switch off)', model: vat('PRICE_REDUCTION', { value: verdict('WAITS', null) }) },
    { id: 'vat-loading', label: 'The time limit is being checked', model: vat('PRICE_REDUCTION', {}) },
    { id: 'vat-error', label: 'The time limit could not be checked (said, never "no limit")', model: vat('PRICE_REDUCTION', { problem: 'problem.read.unavailable' }) },
  ],
})
