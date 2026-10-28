/**
 * A real, valid PDF built in the browser for the catalog: `pages` A4 pages, each with a heading and a line of text in
 * the standard Helvetica (no embedded font). Byte offsets in the cross-reference table are computed, so any PDF reader
 * opens it. Used where the catalog shows the browser's own PDF view and the download.
 */
export function samplePdf(title: string, pages = 2): Uint8Array {
  const objects: string[] = []
  const pageIds = Array.from({ length: pages }, (_, i) => 4 + i * 2)
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages} >>`
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  const safe = (text: string) => text.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, '?')
  pageIds.forEach((id, i) => {
    const stream = [
      'BT /F1 22 Tf 64 760 Td',
      `(${safe(title)}) Tj`,
      'ET',
      'BT /F1 12 Tf 64 728 Td',
      `(Sample document for the design-system catalog - page ${i + 1} of ${pages}) Tj`,
      'ET',
      ...Array.from({ length: 18 }, (_, row) => `0.85 g 64 ${680 - row * 28} 467 10 re f`),
    ].join('\n')
    objects[id] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`
    objects[id + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  })
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = body.length
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }
  const xref = body.length
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let id = 1; id < objects.length; id++) body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(body)
}
