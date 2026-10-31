import { describe, expect, it } from 'vitest'
import { claimLetter, letterFingerprintText, type ClaimLetterInput } from './letter'
import { claimReasonColumns, claimReasonOf, photoProblems } from './rules'

/**
 * Supplier claims, W2b follow-ups (B-W2b-14; SCM-135; B-W2a-44's gaps), the pure parts: the reason code as data, the
 * photos' rule and the claim letter's words (no price, ever).
 */

describe('a claim reason code as data (Z1:04)', () => {
  it('writes the code in its column and the words in reason (the code when there are none)', () => {
    expect(claimReasonColumns('QUALITY', ' holes near the belly ')).toEqual({ reasonCode: 'QUALITY', reason: 'holes near the belly' })
    expect(claimReasonColumns('WRONG_ITEM', '')).toEqual({ reasonCode: 'WRONG_ITEM', reason: 'WRONG_ITEM' })
  })

  it('reads the column first, else the W2a prefix of a claim made before W2b', () => {
    expect(claimReasonOf({ reasonCode: 'QUALITY', reason: 'holes near the belly' })).toEqual({ code: 'QUALITY', note: 'holes near the belly' })
    expect(claimReasonOf({ reasonCode: 'WRONG_ITEM', reason: 'WRONG_ITEM' })).toEqual({ code: 'WRONG_ITEM', note: null })
    // A column value: the words are never parsed for a code.
    expect(claimReasonOf({ reasonCode: 'QUALITY', reason: 'OTHER: words' })).toEqual({ code: 'QUALITY', note: 'OTHER: words' })
    expect(claimReasonOf({ reasonCode: null, reason: 'QUALITY: holes' })).toEqual({ code: 'QUALITY', note: 'holes' })
    expect(claimReasonOf({ reasonCode: null, reason: 'Hide SEED-HIDE-0002 has a hole' })).toEqual({ code: null, note: 'Hide SEED-HIDE-0002 has a hole' })
  })
})

describe('claim photos (Z1:08)', () => {
  it('added until settled, at most 20; removed only while a draft', () => {
    expect(photoProblems({ number: 'CLM-1', status: 'DRAFT' }, 'add', 3)).toEqual([])
    expect(photoProblems({ number: 'CLM-1', status: 'REJECTED' }, 'add', 3)).toEqual([])
    expect(photoProblems({ number: 'CLM-1', status: 'SENT' }, 'add', 20)).toEqual(['Claim CLM-1 holds 20 photos already.'])
    expect(photoProblems({ number: 'CLM-1', status: 'CLOSED' }, 'add')).toEqual(['Claim CLM-1 is closed; it takes no more photos.'])
    expect(photoProblems({ number: 'CLM-1', status: 'DRAFT' }, 'remove')).toEqual([])
    expect(photoProblems({ number: 'CLM-1', status: 'SENT' }, 'remove')).toEqual(['Claim CLM-1 is sent, waiting for the supplier; its photos are removed only while it is a draft.'])
  })
})

const LETTER: ClaimLetterInput = {
  language: 'it',
  date: '2026-10-31',
  company: { name: 'Fabbrica Esempio S.r.l.', lines: ['Via Roma 1, 20100 Milano'], legal: 'P. IVA IT00000003038' },
  supplier: { name: 'Conceria Esempio S.p.A.', address: 'Via Lago 2, 56029 Santa Croce', vatNumber: 'IT00000000000' },
  number: 'CLM-2026-0004',
  kind: 'CLAIM',
  foundAt: 'CUTTING',
  remedy: 'CREDIT',
  reason: { label: 'Difetto di qualità', note: 'Buchi vicino alla pancia' },
  receiptNumber: 'GR-2026-0007',
  supplierDdtNumber: '781',
  supplierDdtDate: '2026-10-20',
  orderNumber: 'PO-2026-0012',
  returnDdts: [],
  lines: [
    { seq: 20, code: 'LEA-BLK', name: 'Pelle nera', colour: 'Nero', lot: 'LOT-9 / B-77', hide: 'H-12 / T-4', quantity: '4.5000', uom: 'FT2', reason: null, note: null, discrepancySeq: 10 },
    { seq: 10, code: 'LEA-BLK', name: 'Pelle nera', colour: null, lot: 'LOT-9', hide: null, quantity: '12.0000', uom: 'FT2', reason: 'Macchie', note: 'Bordo', discrepancySeq: null },
  ],
  photos: 3,
  sample: false,
}

describe('the claim letter (Z1:08)', () => {
  it('names the claim, the delivery, where it was found, the lines in order and the remedy, in Italian', () => {
    const letter = claimLetter(LETTER)
    expect(letter.title).toBe('Reclamo al fornitore')
    expect(letter.sample).toBeNull()
    expect(letter.facts).toEqual([
      { label: 'Reclamo n.', value: 'CLM-2026-0004' },
      { label: 'Data', value: expect.any(String) },
      { label: 'Nostro ricevimento', value: 'GR-2026-0007' },
      { label: 'Vostro DDT', value: expect.stringContaining('781') },
      { label: 'Nostro ordine', value: 'PO-2026-0012' },
      { label: 'Rilevato', value: 'al taglio' },
    ])
    expect(letter.rows.map((row) => row.seq)).toEqual(['10', '20'])
    expect(letter.rows[1]).toMatchObject({ material: 'LEA-BLK Pelle nera · Nero · lotto LOT-9 / B-77 · pelle H-12 / T-4', kind: 'Difetto di qualità: Buchi vicino alla pancia', note: 'difformità 10 del ricevimento' })
    expect(letter.rows[0]).toMatchObject({ kind: 'Macchie', note: 'Bordo' })
    expect(letter.intro).toBe('Vi segnaliamo un problema con la merce indicata qui sotto. Motivo: Difetto di qualità: Buchi vicino alla pancia.')
    expect(letter.closing).toContain('nota di credito')
    expect(letter.closing).toContain('3 foto')
    expect(letter.closing).toContain('CLM-2026-0004')
    expect(letter.fileName).toBe('Reclamo-CLM-2026-0004.pdf')
  })

  it('a return in English names its return DDT; a preview says so; no price anywhere', () => {
    const letter = claimLetter({ ...LETTER, language: 'en', kind: 'RETURN', remedy: 'REPLACEMENT', returnDdts: ['146/2026'], photos: 0, sample: true })
    expect(letter.title).toBe('Goods returned and claim')
    expect(letter.sample).toBe('PREVIEW - not sent')
    expect(letter.facts).toContainEqual({ label: 'Our return DDT', value: '146/2026' })
    expect(letter.closing).toBe('We ask you to replace the goods. Please reply quoting claim CLM-2026-0004: your answer stays with the claim.')
    const printed = (value: unknown): string[] => (typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(printed) : value && typeof value === 'object' ? Object.values(value).flatMap(printed) : [])
    expect(printed({ ...letter, page: letter.page(1, 1) }).join(' ')).not.toMatch(/€|\bEUR\b|price|prezzo|\bcost|valore|\bvalue/i)
  })

  it('the same contents give the same fingerprint text, whatever the day or the banner', () => {
    expect(letterFingerprintText(LETTER)).toBe(letterFingerprintText({ ...LETTER, date: '2026-11-03', sample: true }))
    expect(letterFingerprintText(LETTER)).not.toBe(letterFingerprintText({ ...LETTER, photos: 4 }))
  })
})
