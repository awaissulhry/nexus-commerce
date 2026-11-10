import { crc32, deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type { TechPackPaper } from '@nexus/factory-domain/product/techpack/paper'
import { pdfFlatText, pdfPageCount } from '../../../platform/documents/testing/pdf-text'
import { renderTechPack } from './pdf'

/** The tech pack painter (B-W2b-230; PRD-131, PRD-138) on a made-up paper: no database, no file store. */

/** A small grey PNG (8-bit RGB), made here. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4)
    head.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([head, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x99)])))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}
const PNG = png(40, 30)
const PICTURE = '01900000-0000-7000-8000-0000000000e1'
const MISSING = '01900000-0000-7000-8000-0000000000e2'

const paper: TechPackPaper = {
  language: 'en',
  title: 'Tech pack',
  styleLine: 'SEED-JKT-01 · Made-up jacket',
  versionLine: 'Revision 2 · draft · version 3',
  audienceLine: 'Copy for the workshop',
  qr: 'https://factory.example/tech-pack/01ABCDEFGH',
  code: 'TP 01ABC-DEFGH',
  banner: 'Revision 2 is a draft: it can change before it is released.',
  sections: [
    { section: 'COVER', title: 'Cover', blocks: [{ kind: 'facts', facts: [{ label: 'Style', value: 'SEED-JKT-01' }] }, { kind: 'notes', title: 'Description', notes: ['word '.repeat(2400)] }] },
    {
      section: 'SKETCHES',
      title: 'Sketches',
      blocks: [
        {
          kind: 'pictures',
          pictures: [
            { fileId: PICTURE, caption: 'Front flat', callouts: [{ n: 1, x: '0.5', y: '0.5', text: 'Double stitch, 4 mm' }] },
            { fileId: MISSING, caption: 'Back flat', callouts: [] },
          ],
          missing: 'Picture not in the PDF: open the current tech pack.',
        },
      ],
    },
    {
      section: 'BOM',
      title: 'Bill of materials',
      blocks: [
        {
          kind: 'table',
          table: {
            title: 'Shell',
            columns: [
              { label: 'No.', width: 100, align: 'left' },
              { label: 'Material', width: 900, align: 'left' },
            ],
            rows: Array.from({ length: 80 }, (_, index) => [String((index + 1) * 10), `SEED-MAT-${index}`]),
            empty: 'Nothing to show.',
          },
        },
      ],
    },
  ],
  footer: { printed: 'Printed on 10 Nov 2026, 10:00', page: 'Page {page} of {pages}', continued: 'continued', scan: 'Scan the QR to check that this is the current version.' },
  meta: { title: 'Tech pack SEED-JKT-01 r2 v3', subject: 'SEED-JKT-01', createdAt: '2026-11-10T09:00:00.000Z' },
}

describe('the tech pack PDF painter', () => {
  it('prints the header with the QR code on every page, pictures with their callouts or why not, long notes and tables across pages', async () => {
    const pdf = await renderTechPack(paper, new Map([[PICTURE, PNG]]))
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    const pages = pdfPageCount(pdf)
    expect(pages).toBeGreaterThan(2)
    const text = pdfFlatText(pdf)
    // The code under the QR: once per page, also on a page pdfkit added by itself for the long note.
    expect(text.split('TP 01ABC-DEFGH').length - 1).toBe(pages)
    expect(text).toContain('1. Double stitch, 4 mm')
    expect(text).toContain('Picture not in the PDF: open the current tech pack.')
    expect(text).toContain('SEED-MAT-79')
    expect(text).toContain(`Page ${pages} of ${pages}`)
    // The picture is an image object in the file.
    expect(pdf.toString('latin1')).toMatch(/\/Subtype\s*\/Image/)
  })
})
