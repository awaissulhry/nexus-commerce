import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { Invoice, Sdi } from '../../_shared/api'
import { STEP_UP_CLOSED } from '../../_shared/hooks'
import { at, canOf, CHECKS_FAIL, CHECKS_READY, EXPORT_LINES, inShell, invoice, panelsModel, PREFIX, RELATED, RELATED_PAID, sdi, TD02, TD04, TODAY, withoutPrices, type Role } from '../../_demo/fixtures'
import type { InvoiceRecordModel } from './record-model'
import { InvoiceRecordView } from './view/InvoiceRecordView'

/**
 * SCR-081 — the invoice record (design finance.invoices "Record: Invoice") with made-up data only: a draft TD01 from a
 * DDT with the deposit deducted and its checks (failing with Fix links; passing with the number it will get), Check and
 * issue (P1 confirm) with the step-up, Send to SDI, at SDI, delivered and archived, not delivered (the copy e-mailed),
 * rejected with SDI's reason and the deadline, Fix and resend (same number and date), sent again and delivered, a send
 * that failed, the credit note (TD04) dialog and its draft, the TD02 deposit invoice, an export line's "Why no VAT?",
 * payments placed, documents and the PDF, the states (loading, error, not found, no permission, held with its reason,
 * changed meanwhile) and the roles: Owner, Finance, Sales (read-only).
 */

interface RecordCase {
  role: Role
  record: InvoiceRecordModel
}

const base = (role: Role, value: Invoice, over: Partial<InvoiceRecordModel> = {}, sdiPart: Sdi | null = null): RecordCase => {
  const can = canOf(role)
  const shown = can.price ? value : withoutPrices(value)
  return {
    role,
    record: {
      prefix: PREFIX,
      can,
      today: TODAY,
      tab: 'lines',
      invoice: { status: 'ready', value: shown },
      checks: value.status === 'DRAFT' ? { value: CHECKS_READY, problem: null } : null,
      related: { value: can.price ? RELATED : withoutPrices(RELATED), problem: null },
      sdi: value.status === 'DRAFT' ? null : { value: sdiPart ?? sdi('notSent'), problem: null },
      pdf: { status: 'idle', src: null },
      live: 'live',
      dockOpen: false,
      changed: null,
      notice: null,
      busy: false,
      dialog: null,
      dialogProblem: null,
      resendProblems: null,
      stepUp: STEP_UP_CLOSED,
      panelsPreview: panelsModel(),
      ...over,
    },
  }
}

const draft = invoice('DRAFT')
const issued = invoice('ISSUED')
const atSdi = invoice('SENT')
const delivered = invoice('DELIVERED')
const paid = invoice('DELIVERED', { paidAmount: 532896, openAmount: 0 })
const credited = invoice('DELIVERED', { paidAmount: 0, creditedAmount: 6100, openAmount: 526796 })
const overdue = invoice('DELIVERED', { issueDate: '2026-09-15', paymentTerms: { condition: 'TP02', installments: [{ method: 'MP05', amount: 532896, dueDate: '2026-10-15' }] } })
const notDelivered = invoice('NOT_DELIVERABLE')
const rejected = invoice('REJECTED')
const failed = invoice('ERROR')
const filesPending = invoice('ISSUED', { xmlFileId: null, pdfFileId: null, filesPending: true })
const exportDraft = invoice('DRAFT', { lines: EXPORT_LINES, netTotal: 360000, vatTotal: 0, grossTotal: 360000, vatSummary: [{ rate: '0.00', nature: 'N3.1', legalRef: EXPORT_LINES[0]!.vatLegalRef, taxable: 360000, vat: 0, rounding: 0 }], billTo: { name: 'Squadra Fittizia S.r.l.', kind: 'FOREIGN' } })

function InvoiceDesign({ model }: { model: RecordCase }) {
  const id = model.record.invoice.status === 'ready' ? model.record.invoice.value.id : 'x'
  return inShell(`/finance/invoices/${id}`, createElement(InvoiceRecordView, { model: model.record }), model.role)
}

export const designScreen = defineDesignScreen<RecordCase>({
  screen: 'SCR-081',
  title: 'Invoice record: lines & VAT with the checks, issue, SDI status, fix and resend, credit note, deposits & payments',
  view: InvoiceDesign,
  cases: [
    { id: 'draft-ready', label: 'Finance · Draft TD01 from DDT 144/2026: deposit deducted, checks pass, Check and issue', model: base('finance', draft), note: 'The bridge: goods 6,240.00 − deposit 1,872.00 = 4,368.00 + VAT 960.96 = 5,328.96.' },
    { id: 'draft-checks-fail', label: 'Finance · Draft: two checks fail, each with where to fix it; Check and issue held', model: base('finance', draft, { checks: { value: CHECKS_FAIL, problem: null } }) },
    { id: 'draft-checks-loading', label: 'Finance · Draft: the checks are read', model: base('finance', draft, { checks: { value: null, problem: null } }) },
    { id: 'issue-dialog', label: 'Finance · Check and issue (P1): the number it will get, today, what happens', model: base('finance', draft, { dialog: { kind: 'issue' } }) },
    { id: 'issue-step-up', label: 'Finance · Issuing asks a fresh authenticator code first', model: base('finance', draft, { dialog: { kind: 'issue' }, busy: true, stepUp: { open: true, busy: false, sentence: 'stepUp.sentence.issue', problem: null } }) },
    { id: 'step-up-wrong', label: 'Finance · The code was wrong', model: base('finance', draft, { dialog: { kind: 'issue' }, busy: true, stepUp: { open: true, busy: false, sentence: 'stepUp.sentence.issue', problem: 'stepUp.problem.wrong' } }) },
    { id: 'lines-dialog', label: 'Finance · Edit a draft’s lines (the deduction stays)', model: base('finance', draft, { dialog: { kind: 'lines' } }) },
    { id: 'details-dialog', label: 'Finance · A draft’s text and due date', model: base('finance', draft, { dialog: { kind: 'details' } }) },
    { id: 'delete-dialog', label: 'Finance · Delete a draft', model: base('finance', draft, { dialog: { kind: 'delete' } }) },
    { id: 'vat-why', label: 'Finance · An export line: N3.1 with "Why no VAT?"', model: base('finance', exportDraft, { related: { value: { ...RELATED, depositRequests: [], depositInvoices: [] }, problem: null } }) },
    { id: 'issued-not-sent', label: 'Finance · Issued FT-2026-00031, not sent: Send to SDI', model: base('finance', issued, { notice: { tone: 'warning', words: { key: 'notice.issuedNotSent', params: { number: 'FT-2026-00031' } } } }, sdi('notSent')) },
    { id: 'send-dialog', label: 'Finance · Send to SDI', model: base('finance', issued, { dialog: { kind: 'send' } }, sdi('notSent')) },
    { id: 'files-pending', label: 'Finance · Issued; its XML and PDF are still being made: Make the files', model: base('finance', filesPending, { tab: 'documents' }, sdi('notSent')) },
    { id: 'at-sdi', label: 'Finance · At SDI: waiting for its answer (SDI tab)', model: base('finance', atSdi, { tab: 'sdi', notice: { tone: 'success', words: { key: 'notice.issuedSent', params: { number: 'FT-2026-00031' } } } }, sdi('atSdi')) },
    { id: 'sending', label: 'Finance · Being sent (SDI tab)', model: base('finance', issued, { tab: 'sdi' }, sdi('sending')) },
    { id: 'delivered', label: 'Finance · Delivered and archived; Record payment (SDI tab)', model: base('finance', delivered, { tab: 'sdi' }, sdi('delivered')) },
    { id: 'not-delivered', label: 'Finance · Not delivered: in the customer’s tax drawer, the copy e-mailed (SDI tab)', model: base('finance', notDelivered, { tab: 'sdi' }, sdi('notDelivered')) },
    { id: 'rejected', label: 'Finance · Rejected (00305): it counts as never issued; fix and send by 5 Nov (SDI tab)', model: base('finance', rejected, { tab: 'sdi' }, sdi('rejected')) },
    { id: 'rejected-lines', label: 'Finance · Rejected: the Lines tab says so, Fix and resend', model: base('finance', rejected, {}, sdi('rejected')) },
    { id: 'fix-dialog', label: 'Finance · Fix and resend: the reason, where to fix, the lines, same number and date', model: base('finance', rejected, { tab: 'sdi', dialog: { kind: 'fix' } }, sdi('rejected')) },
    { id: 'fix-not-ready', label: 'Finance · Fix and resend: saved, but the customer’s VAT number still fails', model: base('finance', rejected, { tab: 'sdi', dialog: { kind: 'fix' }, dialogProblem: { key: 'fix.notReady' }, resendProblems: [{ code: 'BUYER', path: 'party/vatNumber' }] }, sdi('rejected')) },
    { id: 'resent', label: 'Finance · Sent again with the same number and date: delivered (SDI tab)', model: base('finance', delivered, { tab: 'sdi', notice: { tone: 'success', words: { key: 'notice.resent' } } }, sdi('resent')) },
    { id: 'failed', label: 'Finance · The intermediary did not answer: Send again (SDI tab)', model: base('finance', failed, { tab: 'sdi' }, sdi('error')) },
    { id: 'credit-dialog', label: 'Finance · Credit note for FT-2026-00031: full, lines or an amount; a reason', model: base('finance', delivered, { dialog: { kind: 'credit' }, draft: { mode: 'amount', reason: 'PRICE_REDUCTION', amount: '61,00' } }, sdi('delivered')) },
    { id: 'credit-draft', label: 'Finance · The credit note’s draft (TD04), then Check and issue', model: base('finance', TD04, { related: { value: { ...RELATED, creditOf: { id: delivered.id, docType: 'TD01', number: 'FT-2026-00031', issueDate: TODAY, status: 'DELIVERED' }, depositRequests: [], depositInvoices: [], ddts: [] }, problem: null } }) },
    { id: 'credited', label: 'Finance · A credit note issued on it: the balance less 61.00', model: base('finance', credited, { tab: 'money', related: { value: RELATED_PAID, problem: null } }, sdi('delivered')) },
    { id: 'money', label: 'Finance · Deposits & payments: the deposit and its TD02, nothing paid yet', model: base('finance', delivered, { tab: 'money' }, sdi('delivered')) },
    { id: 'money-paid', label: 'Finance · Deposits & payments: the balance paid; the order can close', model: base('finance', paid, { tab: 'money', related: { value: RELATED_PAID, problem: null } }, sdi('delivered')) },
    { id: 'overdue', label: 'Finance · Overdue 14 days: Record payment', model: base('finance', overdue, { tab: 'money' }, sdi('delivered')) },
    { id: 'td02', label: 'Finance · The deposit invoice (TD02): paid by its deposit', model: base('finance', TD02, { related: { value: { ...RELATED, ddts: [], depositInvoices: [] }, problem: null } }, sdi('delivered')) },
    { id: 'documents', label: 'Finance · Documents: the legal XML, the courtesy PDF, the DDT', model: base('finance', delivered, { tab: 'documents' }, sdi('delivered')) },
    { id: 'activity', label: 'Finance · Activity: thread, files, history', model: base('finance', delivered, { tab: 'activity' }, sdi('delivered')) },
    { id: 'dock', label: 'Finance · The thread beside a tab (⌘J, 1280 px and wider)', model: base('finance', delivered, { dockOpen: true }, sdi('delivered')) },
    { id: 'owner', label: 'Owner · Delivered, lines & VAT', model: base('owner', delivered, {}, sdi('delivered')) },
    { id: 'sales-read-only', label: 'Sales · Read-only: prices shown, every action held with the reason', model: base('sales', draft) },
    { id: 'sales-rejected', label: 'Sales · A rejected invoice: Fix and resend held (finance issues invoices)', model: base('sales', rejected, { tab: 'sdi' }, sdi('rejected')) },
    { id: 'changed', label: 'Finance · Someone changed the invoice while a dialog was open', model: base('finance', draft, { changed: { at: at(29, 10, 42) } }) },
    { id: 'related-error', label: 'Finance · Deposits & payments could not be read (Try again)', model: base('finance', delivered, { tab: 'money', related: { value: null, problem: 'problem.read.unavailable' } }, sdi('delivered')) },
    { id: 'loading', label: 'Loading', model: { ...base('finance', draft), record: { ...base('finance', draft).record, invoice: { status: 'loading' }, live: 'connecting' } } },
    { id: 'error', label: 'The read failed (in words, Try again)', model: { ...base('finance', draft), record: { ...base('finance', draft).record, invoice: { status: 'error', problem: 'problem.read.unavailable' } } } },
    { id: 'not-found', label: 'Not found (another company, or a wrong address)', model: { ...base('finance', draft), record: { ...base('finance', draft).record, invoice: { status: 'not_found' } } } },
    { id: 'no-permission', label: 'No permission (invoices.view over its company and customer)', model: { ...base('sales', draft), record: { ...base('sales', draft).record, invoice: { status: 'forbidden' } } } },
  ],
})
