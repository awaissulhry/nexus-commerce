import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_PDF, inPpeShell, NOW, RECEIPT_IDS, RECEIPT_OPEN, RECEIPT_PAPER, RECEIPT_PIN, RECEIPT_VOIDED, receiptAnswer, uid, type PpeRoleDemo } from '../_demo/fixtures'
import { ReceiptTabView, type ReceiptTabModel } from './view/ReceiptTabView'

/** SCR-211-receipt — a PPE receipt (PDF), signed with badge and PIN or on paper (design plant.ppe/tab:receipt). Made-up data. */

interface ReceiptCase {
  role: PpeRoleDemo
  model: ReceiptTabModel
}

const model = (over: Partial<ReceiptTabModel> = {}): ReceiptTabModel => ({
  canView: true,
  canKeep: true,
  canReadFiles: true,
  ids: [RECEIPT_PIN.id],
  index: 0,
  language: 'it',
  record: { value: receiptAnswer(RECEIPT_PIN), problem: null },
  pdf: DEMO_PDF,
  pdfProblem: null,
  keeping: false,
  kept: null,
  keepProblem: null,
  fileProblem: null,
  ...over,
})

function ReceiptDesign({ model: entry }: { model: ReceiptCase }) {
  return inPpeShell('/plant/ppe/receipt', createElement(ReceiptTabView, { model: entry.model }), entry.role)
}

export const designScreen = defineDesignScreen<ReceiptCase>({
  screen: 'SCR-211-receipt',
  title: 'PPE for workers › Receipt (PDF), new tab',
  view: ReceiptDesign,
  cases: [
    { id: 'pin', label: 'Signed with badge and PIN: verified, kept as version 1', model: { role: 'safety', model: model() }, note: 'The SHA-256 and the statement the person signed; the giver at the tablet hidden ("A worker") behind the site\'s gate.' },
    { id: 'pin-not-verified', label: 'Signed with PIN, but the fingerprint does not reproduce', model: { role: 'safety', model: model({ record: { value: receiptAnswer({ ...RECEIPT_PIN, document: null }, false), problem: null } }) } },
    { id: 'pin-kept-now', label: 'Keep the PDF: kept as version 2', model: { role: 'safety', model: model({ kept: { document: { id: uid('9802', 2), version: 2, language: 'it', fileId: uid('9801', 3), createdAt: NOW }, made: true } }) } },
    { id: 'paper', label: 'A paper receipt with its signed scan (Keep the PDF not offered)', model: { role: 'safety', model: model({ ids: [RECEIPT_PAPER.id], record: { value: receiptAnswer(RECEIPT_PAPER), problem: null } }) }, note: 'One line voided with its reason.' },
    { id: 'paper-open', label: 'A paper receipt still without its scan', model: { role: 'safety', model: model({ ids: [RECEIPT_OPEN.id], record: { value: receiptAnswer(RECEIPT_OPEN), problem: null } }) } },
    { id: 'voided', label: 'Every line voided', model: { role: 'safety', model: model({ record: { value: receiptAnswer(RECEIPT_VOIDED), problem: null } }) } },
    { id: 'several', label: 'Print receipts: 2 of 3, one at a time', model: { role: 'safety', model: model({ ids: RECEIPT_IDS, index: 1, record: { value: receiptAnswer(RECEIPT_PAPER), problem: null } }) } },
    { id: 'english', label: 'The PDF in English', model: { role: 'safety', model: model({ language: 'en' }) } },
    { id: 'read-only', label: 'Production manager: Keep the PDF held with the reason', model: { role: 'production', model: model({ canKeep: false, record: { value: receiptAnswer({ ...RECEIPT_PIN, document: null, canIssue: false }), problem: null } }) } },
    { id: 'keep-refused', label: 'Keep refused: said in words', model: { role: 'safety', model: model({ keepProblem: { key: 'problem.conflict', field: null, line: null } }) } },
    { id: 'pdf-loading', label: 'Making the PDF', model: { role: 'safety', model: model({ pdf: null }) } },
    { id: 'pdf-failed', label: 'The PDF failed: Try again', model: { role: 'safety', model: model({ pdf: null, pdfProblem: 'problem.unavailable' }) } },
    { id: 'loading', label: 'Reading the receipt', model: { role: 'safety', model: model({ record: { value: null, problem: null }, pdf: null }) } },
    { id: 'error', label: 'Not found: said in words', model: { role: 'safety', model: model({ record: { value: null, problem: 'problem.notFound' }, pdf: null }) } },
    { id: 'no-permission', label: 'Sales: no safety.view', model: { role: 'sales', model: model({ canView: false }) } },
  ],
})
