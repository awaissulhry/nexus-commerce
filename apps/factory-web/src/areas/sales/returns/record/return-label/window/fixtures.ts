import { defineDesignScreen } from '../../../../../../lib/design/design-screen'
import type { ReturnLabelRow } from '../api'
import { LabelPdfWindowView, type LabelPdfWindowModel } from '../view/LabelPdfWindowView'

/**
 * SCR-112-label-pdf — the Return label PDF window (B-W2b-398; design sales.returns tab:returns.label "Return label PDF —
 * printed or sent to the customer"; a window of SCR-112, named like SCR-052-pdf). Made-up data only.
 */

const uid = (n: number) => `0190f0e2-7113-7000-8000-${String(n).padStart(12, '0')}`

/** A one-page made-up PDF that says it is a design sample. */
function samplePdf(): Uint8Array {
  const stream = 'BT /F1 14 Tf 20 380 Td (DESIGN SAMPLE - RETURN LABEL RMA-26-0007) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 298 420] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(pdf)
}

const label: ReturnLabelRow = {
  id: uid(21),
  status: 'BOOKED',
  mode: 'LABEL',
  carrierCode: 'brt',
  bookingReference: 'FK1A2B3C4D5E6F',
  file: { id: uid(31), name: 'return-label-RMA-26-0007-FK1A2B3C4D5E6F.pdf' },
  link: null,
  usedAt: null,
  createdAt: '2026-11-12T09:10:00.000Z',
  changedAt: '2026-11-12T09:10:00.000Z',
}
const ready = (over: Partial<ReturnLabelRow> = {}) => ({ status: 'ready' as const, value: { returnId: uid(1), number: 'RMA-26-0007', label: { ...label, ...over } } })
const PDF = samplePdf()

export const designScreen = defineDesignScreen<LabelPdfWindowModel>({
  screen: 'SCR-112-label-pdf',
  title: 'Return label PDF (a window: print or download)',
  view: LabelPdfWindowView,
  cases: [
    { id: 'pdf', label: 'A booked label: its PDF in the viewer', model: { prefix: '/w/DEMO', read: ready(), pdf: { status: 'ready', value: PDF } } },
    { id: 'offered', label: 'Offered by link: no PDF until the customer books', model: { prefix: '/w/DEMO', read: ready({ status: 'OFFERED', mode: 'LINK', bookingReference: null, file: null }), pdf: null } },
    { id: 'cancelled', label: 'A withdrawn label: shown, with a warning not to send it', model: { prefix: '/w/DEMO', read: ready({ status: 'CANCELLED' }), pdf: { status: 'ready', value: PDF } } },
    { id: 'pdf-loading', label: 'Reading the PDF', model: { prefix: '/w/DEMO', read: ready(), pdf: { status: 'loading' } } },
    { id: 'pdf-failed', label: 'The PDF could not be read: Try again', model: { prefix: '/w/DEMO', read: ready(), pdf: { status: 'error', problem: 'pdf' } } },
    { id: 'not-found', label: 'No such label (an incomplete address)', model: { prefix: '/w/DEMO', read: { status: 'error', problem: 'notFound' }, pdf: null } },
    { id: 'forbidden', label: 'No right to see this return', model: { prefix: '/w/DEMO', read: { status: 'error', problem: 'forbidden' }, pdf: null } },
    { id: 'error', label: 'Could not be read: Try again', model: { prefix: '/w/DEMO', read: { status: 'error', problem: 'failed' }, pdf: null } },
    { id: 'loading', label: 'Loading', model: { prefix: '/w/DEMO', read: { status: 'loading' }, pdf: null } },
  ],
})
