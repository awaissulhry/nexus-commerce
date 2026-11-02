import { createElement } from 'react'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { TravellerPdfView, type TravellerModel } from './view/TravellerPdfView'

/** SCR-070-traveller — the traveller's new tab, made-up data only: one, several, being made, failed, none named, no right. */

function demoPdf(title: string): Uint8Array {
  const text = `BT /F1 20 Tf 72 770 Td (${title}) Tj 0 -28 Td /F1 11 Tf (Made-up design data) Tj ET`
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${text.length} >>\nstream\n${text}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(body)
}

function TravellerDesign({ model }: { model: TravellerModel }) {
  return createElement(TravellerPdfView, { model })
}

export const designScreen = defineDesignScreen<TravellerModel>({
  screen: 'SCR-070-traveller',
  title: 'Traveller PDF with QR (a new tab of the work order)',
  view: TravellerDesign,
  cases: [
    { id: 'one', label: 'One traveller, Print', model: { allowed: true, count: 1, pdf: demoPdf('Traveller WO-00012'), problem: null } },
    { id: 'several', label: 'Three travellers in one PDF', model: { allowed: true, count: 3, pdf: demoPdf('Travellers'), problem: null } },
    { id: 'loading', label: 'Being made', model: { allowed: true, count: 1, pdf: null, problem: null } },
    { id: 'error', label: 'The PDF could not be made', model: { allowed: true, count: 1, pdf: null, problem: 'error.offline' } },
    { id: 'none', label: 'No work order named', model: { allowed: true, count: 0, pdf: null, problem: null } },
    { id: 'no-permission', label: 'No workorders.view', model: { allowed: false, count: 1, pdf: null, problem: null } },
  ],
})
