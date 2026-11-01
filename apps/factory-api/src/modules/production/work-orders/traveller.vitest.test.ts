import { describe, expect, it } from 'vitest'
import { travellerPaper, type TravellerFacts } from '@nexus/factory-domain/production/work-orders/traveller'
import { inlineDisposition, renderTravellers } from './traveller'

/**
 * The traveller's painter (B-W2b-51; MES-014): pdfkit's standard fonts, the QR code drawn from its modules, a new page per
 * traveller with its own page count, the same bytes for the same paper. Every code, number and name is made up.
 */

const facts = (number: string, operations: number): TravellerFacts => ({
  number,
  batchNumber: 'BA-00001',
  status: 'RELEASED',
  kind: 'SIZE_GRID',
  rush: true,
  priority: 0,
  dueDate: '2026-11-20',
  site: { code: 'A1', name: 'Made-up plant' },
  style: { code: 'JKT-DEMO', name: 'Giacca prova' },
  revision: 1,
  orders: ['SO-DEMO-1'],
  splitFrom: null,
  note: null,
  holdReason: null,
  releasedAt: new Date('2026-11-02T09:30:00.000Z'),
  sizes: ['50', '52'],
  cells: [{ colourway: 'BLK', size: '52', quantity: 3 }],
  frozen: true,
  operations: Array.from({ length: operations }, (_, index) => ({ seq: (index + 1) * 10, code: `OP-${index + 1}`, name: `Operazione ${index + 1}`, workCentre: 'SEW', standardMinutes: '2.5', scanRequired: index % 2 === 0 })),
  materials: [{ code: 'LEA', name: 'Pelle', colour: 'BLK', planned: '12.5', uom: 'FT2' }],
  printedAt: new Date('2026-11-03T08:15:00.000Z'),
  timeZone: 'Europe/Rome',
})

const pages = (pdf: Buffer): number => pdf.toString('latin1').match(/\/Type \/Page\b/g)?.length ?? 0

describe('the traveller PDF (MES-014)', () => {
  it('paints one traveller on A4 with its QR code, the same bytes each time', async () => {
    const paper = travellerPaper(facts('WO-00042', 4), 'it')
    const pdf = await renderTravellers([paper])
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(pages(pdf)).toBe(1)
    expect((await renderTravellers([paper])).equals(pdf)).toBe(true)
  })

  it('starts each traveller on a new page and runs a long one over more pages', async () => {
    const pdf = await renderTravellers([travellerPaper(facts('WO-00001', 3), 'it'), travellerPaper(facts('WO-00002', 60), 'en')])
    expect(pages(pdf)).toBeGreaterThanOrEqual(3)
  })

  it('opens inline with an ASCII and a UTF-8 file name', () => {
    expect(inlineDisposition('Foglio di lavorazione WO-00042.pdf')).toBe(`inline; filename="Foglio di lavorazione WO-00042.pdf"; filename*=UTF-8''Foglio%20di%20lavorazione%20WO-00042.pdf`)
    expect(inlineDisposition('Città "x".pdf')).toBe(`inline; filename="Citt_ _x_.pdf"; filename*=UTF-8''Citt%C3%A0%20%22x%22.pdf`)
  })
})
