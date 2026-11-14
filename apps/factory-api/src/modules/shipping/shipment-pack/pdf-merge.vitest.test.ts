import { deflateSync } from 'node:zlib'
import PDFDocument from 'pdfkit'
import { describe, expect, it } from 'vitest'
import { mergePdfs, PdfMergeError, pdfPages } from './pdf-merge'

/** A pdfkit PDF of `pages` A4 pages, each saying its text (compressed streams, a classic cross-reference). */
async function pdfkitFile(pages: number, text: string): Promise<Buffer> {
  const pdf = new PDFDocument({ size: 'A4', compress: true, info: { CreationDate: new Date('2026-11-14T00:00:00Z') } })
  const chunks: Buffer[] = []
  pdf.on('data', (chunk: Buffer) => chunks.push(chunk))
  const done = new Promise<void>((resolve) => pdf.on('end', () => resolve()))
  for (let page = 0; page < pages; page++) {
    if (page > 0) pdf.addPage()
    pdf.font('Helvetica').fontSize(14).text(`${text} ${page + 1}`)
  }
  pdf.end()
  await done
  return Buffer.concat(chunks)
}

/** A hand-made PDF 1.5: a cross-reference STREAM with a PNG "Up" predictor, its objects inside an object stream, its MediaBox inherited. */
function xrefStreamFile(): Buffer {
  const content = 'BT /F1 12 Tf 20 20 Td (label) Tj ET'
  // Objects 1 (catalog), 2 (pages, with the inherited MediaBox), 3 (the page) and 5 (the font) live in object stream 6.
  const inside: [number, string][] = [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 283 425] /Resources << /Font << /F1 5 0 R >> >> >>'],
    [3, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>'],
    [5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
  ]
  let header = ''
  let bodies = ''
  for (const [number, text] of inside) {
    header += `${number} ${bodies.length} `
    bodies += `${text}\n`
  }
  const objStm = deflateSync(Buffer.from(header + bodies, 'latin1'))
  let file = '%PDF-1.5\n'
  const at: Record<number, number> = {}
  at[4] = file.length
  file += `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`
  at[6] = file.length
  file += `6 0 obj\n<< /Type /ObjStm /N 4 /First ${header.length} /Filter /FlateDecode /Length ${objStm.length} >>\nstream\n${objStm.toString('latin1')}\nendstream\nendobj\n`
  // The cross-reference stream (object 7): W [1 4 1], rows for objects 0-7, each row with a PNG Up predictor byte.
  at[7] = file.length
  const rows: number[][] = [
    [0, 0, 0, 0, 0, 0],
    [2, 0, 0, 0, 6, 0],
    [2, 0, 0, 0, 6, 1],
    [2, 0, 0, 0, 6, 2],
    [1, ...be32(at[4]!), 0],
    [2, 0, 0, 0, 6, 3],
    [1, ...be32(at[6]!), 0],
    [1, ...be32(at[7]!), 0],
  ]
  const predicted: number[] = []
  rows.forEach((row, index) => {
    const previous = index > 0 ? rows[index - 1]! : row.map(() => 0)
    predicted.push(2, ...row.map((value, k) => (value - previous[k]! + 256) & 0xff))
  })
  const xref = deflateSync(Buffer.from(predicted))
  file += `7 0 obj\n<< /Type /XRef /Size 8 /W [1 4 1] /Root 1 0 R /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 6 >> /Length ${xref.length} >>\nstream\n${xref.toString('latin1')}\nendstream\nendobj\n`
  file += `startxref\n${at[7]}\n%%EOF\n`
  return Buffer.from(file, 'latin1')
}

const be32 = (value: number) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]

describe('merging PDFs page by page (one PDF per shipment, LOG-031)', () => {
  it('merges pdfkit files and a cross-reference-stream file into one PDF of every page, in order', async () => {
    const ddt = await pdfkitFile(2, 'DDT page')
    const list = await pdfkitFile(1, 'Packing list page')
    const label = xrefStreamFile()
    const merged = mergePdfs([label, ddt, list], { title: 'SH-00001 pack' })
    expect(merged.pagesPerFile).toEqual([1, 2, 1])
    expect(merged.pages).toBe(4)
    const text = merged.pdf.toString('latin1')
    expect(text.startsWith('%PDF-1.7')).toBe(true)
    expect(text).toContain('/Title (SH-00001 pack)')
    // The label's inherited media box and fonts are written on its page.
    expect(text).toMatch(/\/Type \/Page [^]*?\/MediaBox \[0 0 283 425\]/)
    // The merged file reads back (its own classic cross-reference), page for page.
    expect(pdfPages(merged.pdf)).toBe(4)
    expect(mergePdfs([merged.pdf, label], { title: 'again' }).pages).toBe(5)
  })

  it('gives the same bytes for the same files', async () => {
    const ddt = await pdfkitFile(1, 'DDT')
    expect(mergePdfs([ddt, xrefStreamFile()], { title: 't' }).pdf.equals(mergePdfs([ddt, xrefStreamFile()], { title: 't' }).pdf)).toBe(true)
  })

  it('reads a file whose cross-reference points nowhere by its objects', async () => {
    const broken = Buffer.from((await pdfkitFile(1, 'x')).toString('latin1').replace(/startxref\s+\d+/, 'startxref\n999999'), 'latin1')
    expect(pdfPages(broken)).toBe(1)
  })

  it('refuses what is not a PDF, an encrypted file and too many pages, in words', async () => {
    expect(() => mergePdfs([Buffer.from('hello')], { title: 't' })).toThrow(PdfMergeError)
    const encrypted = Buffer.from((await pdfkitFile(1, 'x')).toString('latin1').replace('/Root', '/Encrypt 99 0 R /Root'), 'latin1')
    expect(() => mergePdfs([encrypted], { title: 't' })).toThrow('One of the files is encrypted: it cannot be merged.')
    const three = await pdfkitFile(3, 'x')
    expect(() => mergePdfs([three], { title: 't', maxPages: 2 })).toThrow('The pack would have more than 2 pages.')
    expect(() => mergePdfs([], { title: 't' })).toThrow('There is nothing to merge.')
  })
})
