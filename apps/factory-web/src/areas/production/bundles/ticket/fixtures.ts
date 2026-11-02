import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { TicketPdfView, type TicketPdfModel } from './view/TicketPdfView'

/** SCR-259-ticket — the ticket PDF tab, made-up data only: the PDF, being made, a failed read, no print.labels. */

/** A one-page PDF that says it is made-up (built here so the design index needs no API). */
function demoPdf(title: string): Uint8Array {
  const text = `BT /F1 20 Tf 72 770 Td (${title}) Tj 0 -28 Td /F1 11 Tf (Made-up design data) Tj ET`
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 283 142] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${text.length} >>\nstream\n${text}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
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

function TicketDesign({ model }: { model: TicketPdfModel }) {
  return createElement(TicketPdfView, { model })
}

export const designScreen = defineDesignScreen<TicketPdfModel>({
  screen: 'SCR-259-ticket',
  title: 'Ticket PDF (a new tab of Bundles)',
  view: TicketDesign,
  cases: [
    { id: 'pdf', label: 'The ticket as a PDF, Print', model: { allowed: true, code: 'BN-000001', pdf: demoPdf('Ticket BN-000001'), problem: null } },
    { id: 'loading', label: 'Being made', model: { allowed: true, code: 'BN-000001', pdf: null, problem: null } },
    { id: 'error', label: 'The PDF could not be made', model: { allowed: true, code: null, pdf: null, problem: 'production:error.offline' } },
    { id: 'no-permission', label: 'No print.labels', model: { allowed: false, code: null, pdf: null, problem: null } },
  ],
})
