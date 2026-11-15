import { samplePdf } from '../../../../_shared/document-send/sample-pdf'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import type { CustomsDocument } from '../api'
import { PaperWindowView, type PaperWindowModel } from '../view/PaperWindowView'

/**
 * SCR-654 — the Commercial invoice PDF window (B-W2b-412; design warehouse.shipments tab sh-tab-ci "a customs document for the
 * broker"; a CN 22 / CN 23 opens here too). Made-up data only (shipment SH-26-0120 to "Officina Esempio AG", Zürich).
 */

const uid = (n: number) => `0190f0e2-7419-7000-8000-${String(n).padStart(12, '0')}`
const PDF = samplePdf(['Fattura commerciale (uso doganale) / Commercial invoice', 'SH-26-0120 · Officina Esempio AG, Zürich CH', 'HS 42031000 · Origin IT · EORI IT00000000001'])

const paper = (over: Partial<CustomsDocument> = {}): CustomsDocument => ({ documentId: uid(1), kind: 'COMMERCIAL_INVOICE', version: 2, number: 'SH-26-0120', language: 'en', fileId: uid(2), createdAt: '2026-11-12T10:00:00.000Z', current: true, ...over })

const model = (over: Partial<PaperWindowModel> = {}): PaperWindowModel => ({ prefix: '/w/DEMO', read: { status: 'ready', value: { shipmentId: uid(3), shipmentNumber: 'SH-26-0120', document: paper() } }, pdf: { status: 'ready', value: PDF }, ...over })

export const designScreen = defineDesignScreen<PaperWindowModel>({
  screen: 'SCR-654',
  title: 'Commercial invoice PDF window: the paper, its version and its PDF (a CN 22 / CN 23 too)',
  view: PaperWindowView,
  cases: [
    { id: 'invoice', label: 'The newest commercial invoice', model: model() },
    { id: 'older', label: 'An older version: said, the newest is on the Export tab', model: model({ read: { status: 'ready', value: { shipmentId: uid(3), shipmentNumber: 'SH-26-0120', document: paper({ version: 1, current: false, language: 'it' }) } } }) },
    { id: 'cn23', label: 'A CN 23 (one page per parcel)', model: model({ read: { status: 'ready', value: { shipmentId: uid(3), shipmentNumber: 'SH-26-0120', document: paper({ kind: 'CN23', version: 1 }) } } }) },
    { id: 'pdf-loading', label: 'The PDF being read', model: model({ pdf: { status: 'loading' } }) },
    { id: 'pdf-failed', label: 'The PDF could not be read: Try again', model: model({ pdf: { status: 'error' } }) },
    { id: 'no-price', label: 'Without the price grain: the paper shows values', model: model({ read: { status: 'error', problem: 'noPrice' }, pdf: null }) },
    { id: 'not-found', label: 'No such paper', model: model({ read: { status: 'error', problem: 'notFound' }, pdf: null }) },
    { id: 'loading', label: 'Reading the paper', model: model({ read: { status: 'loading' }, pdf: null }) },
  ],
})
