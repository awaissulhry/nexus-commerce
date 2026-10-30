import { describe, expect, it } from 'vitest'
import { answerOfState, changeProblem, changeWords, counterProblem, priceDiff, revisionDiff, revisionMailOpening, revisionPricesOf, type RevisionLine, type RevisionState } from './revisions'

/** Made-up states of one order (hand-checked diffs). */
const line = (over: Partial<RevisionLine> = {}): RevisionLine => ({
  id: 'l10',
  seq: 10,
  itemId: 'leather',
  itemColourId: 'black',
  description: null,
  supplierArticleCode: 'ART-1',
  supplierColourCode: null,
  quantity: '105.0000',
  uom: 'FT2',
  needDate: '2026-11-20',
  grade: 'A',
  thicknessMinMm: '1.1',
  thicknessMaxMm: '1.3',
  oneDyeBatch: true,
  areaTolerancePct: '1',
  note: null,
  confirmedQuantity: null,
  confirmedDate: null,
  proposal: null,
  cancelled: false,
  closedShort: false,
  ...over,
})
const state = (lines: readonly RevisionLine[], over: Partial<RevisionState> = {}): RevisionState => ({ requestedDate: null, incoterms: 'EXW Seedville', paymentTerms: '30 days', note: null, status: 'SENT', confirmation: null, lines, ...over })
const labels = { lineLabel: (id: string) => ({ l10: 'ART-1 Seed cowhide', l20: 'PRT-2 Protector', l30: 'LIN-3 Lining' })[id] ?? id, colourName: (id: string) => ({ black: 'Black', red: 'Red' })[id] ?? null }

describe('when a revision may start', () => {
  it('a sent, declined or confirmed order changes; a proposal waits for the buyer; goods received end changes', () => {
    expect(['SENT', 'DECLINED', 'CONFIRMED'].map((status) => changeProblem(status as 'SENT'))).toEqual([null, null, null])
    expect(changeProblem('CHANGES_PROPOSED')).toMatch(/counter-propose/)
    expect(changeProblem('PARTLY_RECEIVED')).toMatch(/^Goods were received against this order: it is not changed any more/)
    expect(changeProblem('DRAFT')).toBe('The order is a draft: change it and send it.')
    expect(changeProblem('CANCELLED')).toBe('The order is cancelled already.')
    expect(counterProblem('CHANGES_PROPOSED')).toBeNull()
    expect(counterProblem('SENT')).toMatch(/change it instead/)
  })
})

describe('the diff of two revisions', () => {
  it('revision 1 has nothing to compare with', () => {
    expect(revisionDiff(null, state([line()]))).toEqual({ header: [], lines: [], count: 0 })
  })

  it('names the header fields, a changed line (fields from → to), an added, a removed and a cancelled line, in line order', () => {
    const before = state([line(), line({ id: 'l20', seq: 20, itemId: 'protector', itemColourId: null, quantity: '24.0000', uom: 'PCS', grade: null, thicknessMinMm: null, thicknessMaxMm: null, oneDyeBatch: false, areaTolerancePct: null }), line({ id: 'l30', seq: 30, itemId: 'lining' })], { confirmation: { at: '2026-11-02T10:00:00.000Z', via: 'LINK', byName: 'M. Rossi', supplierRef: 'OC-1' }, status: 'CONFIRMED' })
    const after = state(
      [
        line({ quantity: '140.0000', needDate: '2026-11-27', itemColourId: 'red' }),
        line({ id: 'l20', seq: 20, itemId: 'protector', itemColourId: null, quantity: '24.0000', uom: 'PCS', grade: null, thicknessMinMm: null, thicknessMaxMm: null, oneDyeBatch: false, areaTolerancePct: null, cancelled: true }),
        line({ id: 'l40', seq: 40, itemId: 'trim' }),
      ],
      { incoterms: 'DAP Plant A1', requestedDate: '2026-11-30' },
    )
    const diff = revisionDiff(before, after)
    expect(diff.header).toEqual([
      { field: 'requestedDate', before: null, after: '2026-11-30' },
      { field: 'incoterms', before: 'EXW Seedville', after: 'DAP Plant A1' },
    ])
    expect(diff.lines.map((entry) => [entry.seq, entry.kind])).toEqual([
      [10, 'CHANGED'],
      [20, 'CANCELLED'],
      [30, 'REMOVED'],
      [40, 'ADDED'],
    ])
    expect(diff.lines[0]!.changes).toEqual([
      { field: 'quantity', before: '105.0000 FT2', after: '140.0000 FT2' },
      { field: 'needDate', before: '2026-11-20', after: '2026-11-27' },
      { field: 'itemColourId', before: 'black', after: 'red' },
    ])
    expect(diff.count).toBe(6)
    // The supplier's confirmation of the old revision is no change of the order: only what was asked counts.
    expect(revisionDiff(before, state(before.lines)).count).toBe(0)
  })

  it('a field an older stored shape did not keep is no change; a line cancelled in both is none either', () => {
    const old = { id: 'l10', seq: 10, itemId: 'leather', itemColourId: null, description: null, quantity: '12.0000', uom: 'PCS', needDate: '2026-12-10', confirmedQuantity: null, confirmedDate: null, cancelled: false } as RevisionLine
    expect(revisionDiff(state([old]), state([line({ itemColourId: null, quantity: '16.0000', uom: 'PCS', needDate: '2026-12-10' })])).lines).toEqual([
      { lineId: 'l10', seq: 10, itemId: 'leather', kind: 'CHANGED', changes: [{ field: 'quantity', before: '12.0000 PCS', after: '16.0000 PCS' }] },
    ])
    expect(revisionDiff(state([line({ cancelled: true })]), state([line({ cancelled: true, quantity: '1.0000' })])).count).toBe(0)
  })

  it('the prices that changed: the total and each line (open lines only)', () => {
    const before = revisionPricesOf('EUR', [
      { id: 'l10', seq: 10, unitPrice: '4.200000', netAmount: 44_100, cancelled: false },
      { id: 'l20', seq: 20, unitPrice: '6.500000', netAmount: 15_600, cancelled: false },
    ])
    expect(before).toEqual({ currency: 'EUR', netAmount: 59_700, lines: [{ id: 'l10', seq: 10, unitPrice: '4.200000', netAmount: 44_100 }, { id: 'l20', seq: 20, unitPrice: '6.500000', netAmount: 15_600 }] })
    const after = revisionPricesOf('EUR', [
      { id: 'l10', seq: 10, unitPrice: '4.200000', netAmount: 58_800, cancelled: false },
      { id: 'l20', seq: 20, unitPrice: '6.500000', netAmount: 15_600, cancelled: true },
    ])
    expect(after.netAmount).toBe(58_800)
    expect(priceDiff(before, after)).toEqual({
      netAmount: { before: 59_700, after: 58_800 },
      lines: [
        { lineId: 'l10', seq: 10, unitPrice: null, netAmount: { before: 44_100, after: 58_800 } },
        { lineId: 'l20', seq: 20, unitPrice: { before: '6.500000', after: null }, netAmount: { before: 15_600, after: null } },
      ],
    })
    expect(priceDiff(null, after)).toEqual({ netAmount: null, lines: [] })
  })
})

describe('in the supplier’s words', () => {
  const diff = revisionDiff(state([line(), line({ id: 'l20', seq: 20 })]), state([line({ quantity: '140.0000', needDate: '2026-11-27' }), line({ id: 'l20', seq: 20, cancelled: true })], { incoterms: 'DAP Plant A1' }))

  it('one sentence per change, Italian and English', () => {
    expect(changeWords(diff, 'en', labels)).toEqual([
      'Order: delivery terms EXW Seedville → DAP Plant A1',
      'Line 10 (ART-1 Seed cowhide): quantity 105 ft² → 140 ft²; delivery date 20 Nov 2026 → 27 Nov 2026',
      'Line 20 (PRT-2 Protector): cancelled',
    ])
    expect(changeWords(diff, 'it', labels)).toEqual([
      'Ordine: resa EXW Seedville → DAP Plant A1',
      'Riga 10 (ART-1 Seed cowhide): quantità 105 ft² → 140 ft²; data di consegna 20/11/2026 → 27/11/2026',
      'Riga 20 (PRT-2 Protector): annullata',
    ])
  })

  it('the mail of revision 2: the standard opening (or the office’s), what changed and why', () => {
    const words = changeWords(diff, 'en', labels)
    expect(revisionMailOpening({ language: 'en', number: 'PO-2026-0007', revision: 2, recipientName: 'Mario Rossi', changes: words, changeNote: 'Our customer moved the order a week.', message: null })).toBe(
      [
        'Dear Mario Rossi,',
        '',
        'please find attached revision PO-2026-0007 rev. 2 of our purchase order, which replaces PO-2026-0007. Please confirm it again.',
        '',
        'What changed:',
        '- Order: delivery terms EXW Seedville → DAP Plant A1',
        '- Line 10 (ART-1 Seed cowhide): quantity 105 ft² → 140 ft²; delivery date 20 Nov 2026 → 27 Nov 2026',
        '- Line 20 (PRT-2 Protector): cancelled',
        '',
        'Why: Our customer moved the order a week.',
      ].join('\n'),
    )
    expect(revisionMailOpening({ language: 'it', number: 'PO-7', revision: 3, recipientName: null, changes: [], changeNote: null, message: '  Ecco la nuova versione.  ' })).toBe('Ecco la nuova versione.\n\nLe quantità e le date non cambiano.')
  })

  it('the answer a revision got, in a word', () => {
    expect([answerOfState('SENT', false), answerOfState('CONFIRMED', true), answerOfState('DECLINED', false), answerOfState('CHANGES_PROPOSED', false), answerOfState('PARTLY_RECEIVED', true), answerOfState('PARTLY_RECEIVED', false), answerOfState('CANCELLED', false)]).toEqual([
      'WAITING',
      'CONFIRMED',
      'DECLINED',
      'CHANGES_PROPOSED',
      'CONFIRMED',
      'RECEIVED',
      'CANCELLED',
    ])
  })
})
