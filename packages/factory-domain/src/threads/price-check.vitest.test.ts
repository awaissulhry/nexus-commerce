import { describe, expect, it } from 'vitest'
import { amountProblems, floorPriceRefusal, MESSAGE_AMOUNT_MAX, priceInWords } from './price-check'
import { NAMES_A_PRICE, PRICE_REFUSALS, PRICES_IN_WORDS_WORDS, PURCHASE_SIDE_RECORDS, pricesInWordsRefusal } from './price-check' // B-CP-020

/** B-TH-049 (gap N7): the amount field's rules and the price check of a note for the floor. Every word is made up. */
describe('B-TH-049 price check of a note for the floor', () => {
  it('finds a price written with a sign, a currency or a money word, in Italian or English', () => {
    for (const [text, found] of [
      ['Il cliente paga € 12,50 al pezzo', '€ 12,50'],
      ['Price agreed: 12.50€ each', '12.50€'],
      ['30 EUR per jacket', '30 EUR'],
      ['costa 18 euro', '18 euro'],
      ['prezzo: 42', 'prezzo: 42'],
      ['the cost of 7 per metre', 'cost of 7'],
      ['sconto 10% sul lotto', 'sconto 10'],
      ['USD 1,250.00 for the lot', 'USD 1,250.00'],
      ['$5 more than last season', '$5'],
    ] as const) expect(priceInWords(text), text).toBe(found)
  })

  it('leaves a note of pieces, sizes, dates and counts alone', () => {
    for (const text of ['Taglia 48: 30 pezzi entro venerdì', 'Totale 120 capi, 4 colli', 'Amount: 30 pieces in size 52', 'Europa 2026: cuciture rinforzate', 'Costura doppia sul fianco, 3 mm', 'Ordine 12/11, consegna 20/11']) expect(priceInWords(text), text).toBeNull()
  })

  it('names what looked like a price in the refusal, in both languages', () => {
    const refusal = floorPriceRefusal('Attenzione: il lotto vale € 1.200')
    expect(refusal?.code).toBe('FLOOR_PRICE')
    expect(refusal?.words.it).toContain('“€ 1.200”')
    expect(refusal?.words.en).toContain('the floor never sees money')
    expect(floorPriceRefusal('Cucire il collo prima delle maniche')).toBeNull()
  })
})

describe('B-TH-049 the amount field', () => {
  it('a whole number of cents from 0, in an ISO 4217 currency, never on a note for the floor', () => {
    expect(amountProblems({ value: 12_50, currency: 'EUR' }, { forFloor: false })).toEqual([])
    expect(amountProblems({ value: 0, currency: 'CHF' }, { forFloor: false })).toEqual([])
    expect(amountProblems({ value: -1, currency: 'EUR' }, { forFloor: false }).map((problem) => problem.path)).toEqual(['body/amount/value'])
    expect(amountProblems({ value: 1.5, currency: 'EUR' }, { forFloor: false }).map((problem) => problem.path)).toEqual(['body/amount/value'])
    expect(amountProblems({ value: MESSAGE_AMOUNT_MAX + 1, currency: 'EUR' }, { forFloor: false }).map((problem) => problem.path)).toEqual(['body/amount/value'])
    expect(amountProblems({ value: 100, currency: 'eur' }, { forFloor: false }).map((problem) => problem.path)).toEqual(['body/amount/currency'])
    expect(amountProblems({ value: 100, currency: 'EUR' }, { forFloor: true }).map((problem) => problem.path)).toEqual(['body/amount'])
  })
})

// ── B-CP-020 (customer page plan O5, L3; review F5): prices typed in words by our own people — warn, never block ──
describe('B-CP-020 an office note or reply whose words look like a price', () => {
  const note = (text: string, over: Partial<{ recordType: string; pricesInWordsOk: boolean }> = {}) => pricesInWordsRefusal(text, { kind: 'note', recordType: 'SalesOrder', pricesInWordsOk: false, ...over })

  it('finds € 12,50, 12.50 EUR and "prezzo 40", in Italian and English', () => {
    for (const [text, found] of [
      ['Il cliente paga € 12,50 a giacca', '€ 12,50'],
      ['We quoted 12.50 EUR a jacket', '12.50 EUR'],
      ['prezzo 40 per la giacca', 'prezzo 40'],
      ['the price is 38 now', 'price is 38'],
    ] as const) {
      expect(priceInWords(text), text).toBe(found)
      expect(note(text)?.code, text).toBe(NAMES_A_PRICE)
    }
  })

  it('leaves a size, a date, pieces and counts alone', () => {
    for (const text of ['Taglia XL 52 per il pilota', 'XL 52 e L 50: 30 pezzi', 'Consegna il 12/11/2026', 'Ordine del 2026-11-19, 4 colli', 'Europa 2026: cuciture rinforzate da 3 mm']) {
      expect(priceInWords(text), text).toBeNull()
      expect(note(text), text).toBeNull()
    }
  })

  it('the warning names no amount (the money wall), in both languages, a note’s and a reply’s own words', () => {
    const refusal = note('Il cliente paga € 12,50 a giacca')!
    expect(refusal.words).toEqual(PRICES_IN_WORDS_WORDS.note)
    const reply = pricesInWordsRefusal('Your price stays 99.00 EUR', { kind: 'reply', recordType: 'SalesOrder', pricesInWordsOk: false })!
    expect(reply.words).toEqual(PRICES_IN_WORDS_WORDS.reply)
    for (const words of [...Object.values(PRICES_IN_WORDS_WORDS.note), ...Object.values(PRICES_IN_WORDS_WORDS.reply)]) {
      expect(words).not.toMatch(/\d|€|EUR/)
      expect(words.length).toBeGreaterThan(20)
    }
    expect(PRICE_REFUSALS).toEqual(['FLOOR_PRICE', 'NAMES_A_PRICE'])
  })

  it('goes when the writer sends it anyway, and a purchase’s thread is never warned (Owner O8)', () => {
    expect(note('Il cliente paga € 12,50 a giacca', { pricesInWordsOk: true })).toBeNull()
    for (const recordType of ['PurchaseOrder', 'SubcontractOrder', 'SupplierClaim', 'SupplierInvoice', 'GoodsReceipt']) {
      expect(PURCHASE_SIDE_RECORDS.has(recordType)).toBe(true)
      expect(note('The mill asks € 3,20 a metre', { recordType }), recordType).toBeNull()
    }
    for (const recordType of ['SalesOrder', 'Quote', 'WorkOrder', 'Party', 'PortalOrderRequest']) expect(note('prezzo 40', { recordType }), recordType).not.toBeNull()
  })

  it('the floor’s own hold still names what it found (its writer typed it; the note never leaves the office)', () => {
    expect(floorPriceRefusal('prezzo 40')?.words.en).toContain('“prezzo 40”')
  })
})
// ── end B-CP-020 ──
