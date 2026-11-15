import { samplePdf } from '../../../../_shared/document-send/sample-pdf'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import type { Manifest } from '../api'
import { DAY, sheetRow } from '../fixtures'
import { ManifestWindowView, type ManifestWindowModel } from '../view/ManifestWindowView'

/**
 * SCR-652 — the End-of-day manifest PDF window (B-W2b-412; design warehouse.shipments tab sh-tab-manifest "the driver signs the
 * paper"): the sheet, who closed it (a person or the system), its shipments and the PDF. Made-up data only.
 */

const uid = (n: number) => `0190f0e2-7416-7000-8000-${String(n).padStart(12, '0')}`
const PDF = samplePdf(['Distinta di fine giornata / End-of-day manifest', 'Demo Express · A1 Stabilimento Demo', 'SH-26-0101 · SH-26-0102 · 4 colli · 23,6 kg', 'Firma autista / Driver signature: ____________'])

const sheet = (over: Partial<Manifest> = {}): Manifest => ({
  id: uid(1),
  site: { code: 'A1', name: 'Stabilimento Demo' },
  carrierCode: 'demo-express',
  carrierName: 'Demo Express',
  day: DAY,
  state: 'CLOSED',
  closedAt: `${DAY}T16:42:00.000Z`,
  closedBy: 'PERSON',
  fileId: uid(2),
  shipments: [sheetRow(1), sheetRow(2)],
  totals: { shipments: 2, parcels: 4, weightKg: '23.600' },
  ...over,
})

const model = (over: Partial<ManifestWindowModel> = {}): ManifestWindowModel => ({ prefix: '/w/DEMO', read: { status: 'ready', value: sheet() }, pdf: { status: 'ready', value: PDF, name: 'manifest-A1-demo-express.pdf' }, readFiles: true, ...over })

export const designScreen = defineDesignScreen<ManifestWindowModel>({
  screen: 'SCR-652',
  title: 'End-of-day manifest PDF window: the sheet and its PDF for the driver to sign',
  view: ManifestWindowView,
  cases: [
    { id: 'closed', label: 'Closed by a person: the sheet and its PDF', model: model() },
    { id: 'by-system', label: 'Closed by the system after the site\'s day ended', model: model({ read: { status: 'ready', value: sheet({ closedBy: 'SYSTEM' }) } }) },
    { id: 'open', label: 'A sheet still open: its PDF is made when the day closes', model: model({ read: { status: 'ready', value: sheet({ state: 'OPEN', closedAt: null, closedBy: null, fileId: null }) }, pdf: null }) },
    { id: 'no-files', label: 'Without files.read: the sheet without its PDF', model: model({ readFiles: false, pdf: null }) },
    { id: 'pdf-failed', label: 'The PDF could not be read: Try again', model: model({ pdf: { status: 'error' } }) },
    { id: 'loading', label: 'Reading the sheet', model: model({ read: { status: 'loading' }, pdf: null }) },
    { id: 'not-found', label: 'No such sheet', model: model({ read: { status: 'error', problem: 'notFound' }, pdf: null }) },
    { id: 'error', label: 'The sheet could not be read: Try again', model: model({ read: { status: 'error', problem: 'failed' }, pdf: null }) },
  ],
})
