import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { CONFIRMATION_NONE, CONFIRMATION_OUTDATED, CONFIRMATION_SENT, CONFIRMATION_WAITING, demoPdf } from '../depth/demo/fixtures'
import { ConfirmationPdfView, type ConfirmationPdfModel } from './view/ConfirmationPdfView'

/**
 * SCR-430 — the order confirmation PDF in a new tab (design sales.orders tab:orders.confirmation; B-W2b-323 on B-W2b-303's
 * ORDER_CONFIRMATION document) with made-up data only: the newest version with Print, the order changed since (Make version 3),
 * none made yet (Make confirmation), the order waiting for a yes (held), reading, a failed read, the PDF that would not open, no
 * right, a reader who may not make one.
 */

const base = (over: Partial<ConfirmationPdfModel> = {}): ConfirmationPdfModel => ({
  allowed: true,
  files: true,
  can: { manage: true },
  number: 'SO-2026-0088',
  confirmation: { status: 'ready', value: CONFIRMATION_SENT },
  pdf: demoPdf('Conferma SO-2026-0088 v2'),
  pdfProblem: null,
  busy: false,
  problem: null,
  ...over,
})

function PdfDesign({ model }: { model: ConfirmationPdfModel }) {
  return createElement(ConfirmationPdfView, { model })
}

export const designScreen = defineDesignScreen<ConfirmationPdfModel>({
  screen: 'SCR-430',
  title: 'Order confirmation PDF (a new tab of the order)',
  view: PdfDesign,
  cases: [
    { id: 'sent', label: 'Sales · Version 2, printing the order as it is: Print', model: base() },
    { id: 'outdated', label: 'Sales · The order changed since version 2: Make version 3', model: base({ confirmation: { status: 'ready', value: CONFIRMATION_OUTDATED } }) },
    { id: 'none', label: 'Sales · Not made yet: Make confirmation', model: base({ confirmation: { status: 'ready', value: CONFIRMATION_NONE }, pdf: null }) },
    { id: 'waiting', label: 'Sales · The order waits for a yes: Make held with its reason', model: base({ confirmation: { status: 'ready', value: CONFIRMATION_WAITING }, pdf: null }) },
    { id: 'read-only', label: 'Production manager · Reads the newest; no Make', model: base({ can: { manage: false }, confirmation: { status: 'ready', value: CONFIRMATION_OUTDATED } }) },
    { id: 'refused', label: 'Sales · Make refused (said above the PDF)', model: base({ confirmation: { status: 'ready', value: CONFIRMATION_OUTDATED }, problem: { key: 'problem.write.state' } }) },
    { id: 'loading', label: 'Reading', model: base({ confirmation: { status: 'loading' }, pdf: null }) },
    { id: 'error', label: 'The read failed (in words, Try again)', model: base({ confirmation: { status: 'error', problem: 'problem.read.unavailable' }, pdf: null }) },
    { id: 'pdf-failed', label: 'The PDF could not be opened (Try again)', model: base({ pdf: null, pdfProblem: 'problem.read.unavailable' }) },
    { id: 'no-files', label: 'No files right: the PDF is not read', model: base({ files: false, pdf: null }) },
    { id: 'no-permission', label: 'No orders.view', model: base({ allowed: false, confirmation: { status: 'loading' }, pdf: null }) },
  ],
})
