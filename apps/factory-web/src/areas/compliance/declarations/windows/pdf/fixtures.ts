import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { DRAFT_PDF, PREFIX, RECORD_DE, RECORD_DRAFT, RECORD_SIGNED } from '../../_demo/fixtures'
import type { PdfWindowModel } from '../../view-model'
import { PdfWindowView } from '../view/WindowsView'

/**
 * SCR-052-pdf — the Declaration PDF window (B-W2b-268; design tab:dc-pdf; a window page, a new tab). Made-up data only; the PDF is
 * a small made-up one.
 */

const ready = <T,>(value: T) => ({ status: 'ready' as const, value })

export const designScreen = defineDesignScreen<PdfWindowModel>({
  screen: 'SCR-052-pdf',
  title: 'Declaration PDF (a new tab)',
  view: PdfWindowView,
  cases: [
    { id: 'draft', label: 'A generated draft: DRAFT on every page, the gate said, one language at a time', model: { prefix: PREFIX, read: ready(RECORD_DRAFT), shownId: RECORD_DRAFT.row.id, pdf: ready<Uint8Array | string>(DRAFT_PDF) } },
    { id: 'translation', label: 'The German translation of the family', model: { prefix: PREFIX, read: ready(RECORD_DE), shownId: RECORD_DE.row.id, pdf: ready<Uint8Array | string>(DRAFT_PDF) } },
    { id: 'signed', label: 'A signed DoC: its uploaded file', model: { prefix: PREFIX, read: ready(RECORD_SIGNED), shownId: RECORD_SIGNED.row.id, pdf: ready<Uint8Array | string>(DRAFT_PDF) } },
    { id: 'signed-no-file', label: 'A signed DoC without a confirmed PDF', model: { prefix: PREFIX, read: ready(RECORD_SIGNED), shownId: RECORD_SIGNED.row.id, pdf: { status: 'error', problem: 'preview.noFile' } } },
    { id: 'pdf-loading', label: 'Reading the PDF', model: { prefix: PREFIX, read: ready(RECORD_DRAFT), shownId: RECORD_DRAFT.row.id, pdf: { status: 'loading' } } },
    { id: 'loading', label: 'Loading', model: { prefix: PREFIX, read: { status: 'loading' }, shownId: null, pdf: null } },
    { id: 'error', label: 'Not found', model: { prefix: PREFIX, read: { status: 'error', problem: 'problem.notFound' }, shownId: null, pdf: null } },
    { id: 'forbidden', label: 'No permission', model: { prefix: PREFIX, read: { status: 'error', problem: 'problem.forbidden' }, shownId: null, pdf: null } },
  ],
})
