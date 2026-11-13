import { describe, expect, it } from 'vitest'
import { changeNoteOf, compareQuoteVersions, differsOf, differsWords, type QuoteLineFacts, type QuoteVersionFacts } from './rules'

const line = (over: Partial<QuoteLineFacts> = {}): QuoteLineFacts => ({
  id: 'l1',
  seq: 10,
  kind: 'SIZE_GRID',
  feeKind: null,
  section: null,
  styleId: 's1',
  style: 'SEED-JKT-01 Seed leather jacket',
  colourwayId: 'blk',
  colourway: 'BLK Black',
  revision: 'Rev 1',
  description: 'SEED-JKT-01 Seed leather jacket - Black',
  note: null,
  quantity: 8,
  sizes: { '50': 2, '52': 4, '54': 2 },
  deliveries: null,
  options: null,
  unitPrice: '420',
  listUnitPrice: '420',
  discountPct: null,
  sizePrices: {},
  net: '3360.00',
  adjustmentReason: null,
  marginPct: '30.5',
  ...over,
})

const version = (over: Partial<QuoteVersionFacts> = {}): QuoteVersionFacts => ({
  revision: 1,
  status: 'SENT',
  validUntil: '2026-12-31',
  firmOffer: false,
  promiseDate: null,
  paymentTerms: '30 days',
  depositPct: null,
  depositKind: null,
  acceptanceMode: 'SIGN',
  incoterm: 'EXW',
  incotermPlace: 'Seedville',
  shipComplete: false,
  language: 'it',
  currency: 'EUR',
  termsVersion: null,
  net: '3360.00',
  vat: '739.20',
  gross: '4099.20',
  deposit: null,
  marginPct: '30.5',
  lines: [line()],
  ...over,
})

describe('two versions of a quote compared (SAL-158)', () => {
  const before = version()
  const after = version({
    revision: 2,
    status: 'DRAFT',
    incoterm: 'DAP',
    incotermPlace: 'Milano',
    net: '3555.00',
    lines: [
      line({ id: 'l2', sizes: { '50': 2, '52': 6, '54': 1 }, unitPrice: '395', discountPct: '5.9524', net: '3555.00', adjustmentReason: 'TARGET_PRICE', marginPct: '26.1' }),
      line({ id: 'l3', seq: 20, kind: 'FEE', feeKind: 'DEVELOPMENT', colourwayId: 'blk', sizes: {}, quantity: 1, unitPrice: '500', listUnitPrice: null, net: '500.00' }),
    ],
  })
  const sections = compareQuoteVersions(before, after, () => ['50', '52', '54'])

  it('matches lines by what they sell and says each added, removed or changed, size by size', () => {
    const [terms, lines, prices, margin] = sections
    expect(terms!.summary).toMatchObject({ changed: 1 })
    expect(lines!.lines.map((entry) => [entry.id, entry.before ? 'was' : 'new'])).toEqual([
      ['l2', 'was'],
      ['l3', 'new'],
    ])
    expect(lines!.summary).toEqual({ added: 1, removed: 0, changed: 1, unchanged: 0 })
    expect(lines!.sizes).toEqual(['50', '52', '54'])
    expect(lines!.totals).toEqual([
      { id: 'lines', label: 'Lines', before: '1', after: '2' },
      { id: 'pieces', label: 'Pieces', before: '8', after: '9' },
    ])
    expect(prices!.lines[0]!.after!.fields).toMatchObject({ unitPrice: '395', discountPct: '5.9524', adjustmentReason: 'TARGET_PRICE' })
    expect(margin!.totals[0]).toEqual({ id: 'marginPct', label: 'Margin %', before: '30.5', after: '30.5' })
  })

  it('says what differs and writes a change note from the sections a reader may see', () => {
    const visible = sections.slice(0, 2)
    expect(differsWords(differsOf(visible))).toBe('Terms & delivery: 1 changed · Lines: 1 added, 1 changed')
    const note = changeNoteOf(visible)
    expect(note).toContain('Terms & delivery: incoterm EXW Seedville → DAP Milano')
    expect(note).toContain('10 · SEED-JKT-01 Seed leather jacket · BLK Black: 52 4 → 6, 54 2 → 1')
    expect(note).toContain('20 · DEVELOPMENT · SEED-JKT-01 Seed leather jacket added')
    expect(note).not.toContain('395')
    expect(changeNoteOf(sections)).toContain('unit price 420 → 395')
    expect(differsWords(differsOf(compareQuoteVersions(before, before)))).toBe('the same quote')
  })
})
