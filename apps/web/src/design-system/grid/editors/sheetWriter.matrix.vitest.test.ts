/**
 * MX.G — `matrixWrite`, the Matrix routing branch of the ONE write path.
 *
 * Each rule below is the reason a write is, or is not, sent — asserted with the sentence it gives,
 * because a dropped write must be explainable and a sent one must carry the CAS token.
 */
import { describe, expect, it } from 'vitest'

import { MATRIX_CELL_KINDS, type MatrixCells } from '../matrix/contract'
import { MATRIX_FULFILMENT_INLINE, MATRIX_NO_LISTING, MATRIX_NOT_A_COLUMN, MATRIX_SALE_DATES_NOT_PASTED, MATRIX_UNCHANGED, matrixValueRefusal, matrixWrite } from './sheetWriter'

function cellsOf(over: Partial<MatrixCells> = {}): MatrixCells {
  return {
    listingId: 'L1', version: 7,
    listing: { state: 'listed', externalId: null, detail: null, published: true },
    fulfilment: { method: 'FBM', source: 'set', guard: 'FBM', reported: null },
    sync: { kind: 'FOLLOW', via: null, mode: 'FOLLOW', intended: 403, held: 403, buffer: 0, poolAvailable: 403, routedLocations: ['IT-MAIN'], fbaAtAmazon: null, oversold: false },
    queue: { state: 'sent', at: null, reason: null, syncType: null, via: null },
    price: { value: 105, currency: 'EUR', source: 'master', formula: null, clamped: null },
    sale: { value: null, start: null, end: null },
    writable: { fulfilment: true, syncMode: true, syncQty: true, syncBuffer: true, price: true, salePrice: true },
    writeBlockedReason: {},
    ...over,
  }
}
const col = (kind: string) => ({ kind, coordinateKey: 'AMAZON:IT', rowId: 'r1' })

describe('matrixWrite — what a Matrix cell edit sends, and why it sometimes sends nothing', () => {
  it('routes on kind ∈ MATRIX_CELL_KINDS and refuses every other column (the sheet’s own kinds included)', () => {
    for (const k of ['text', 'number', 'select', 'variationTheme', 'basePrice', '']) {
      expect(matrixWrite(col(k), cellsOf(), 1, 2)).toEqual({ send: false, reason: MATRIX_NOT_A_COLUMN })
    }
    /* Positive control on the same predicate: every Matrix kind gets PAST the routing test. */
    let past = 0
    for (const k of MATRIX_CELL_KINDS) { const d = matrixWrite(col(k), cellsOf(), 1, 2); if (!(d.send === false && d.reason === MATRIX_NOT_A_COLUMN)) past++ }
    expect(past).toBe(10)
  })

  it('sends a syncQty write with the listing’s version as the CAS token — a typed number on a Follow cell pins (the store does it)', () => {
    const d = matrixWrite(col('syncQty'), cellsOf(), 403, 10)
    expect(d).toEqual({ send: true, cell: { rowId: 'r1', coordinateKey: 'AMAZON:IT', cell: 'syncQty', value: 10, expectedVersion: 7 } })
    /* Nothing about the CLASS travels: the decision carries a value and a token, not a mode. */
    expect(JSON.stringify(d)).not.toMatch(/PINNED|FOLLOW|mode|kind/)
  })

  it('sends Mode, Buffer, Price and Sale; coerces a pasted numeric string; a sale travels as the compound', () => {
    expect(matrixWrite(col('syncMode'), cellsOf(), 'FOLLOW', 'PINNED')).toMatchObject({ send: true, cell: { cell: 'syncMode', value: 'PINNED' } })
    expect(matrixWrite(col('syncBuffer'), cellsOf(), 0, '3')).toMatchObject({ send: true, cell: { cell: 'syncBuffer', value: 3 } })
    expect(matrixWrite(col('price'), cellsOf(), 105, 99.75)).toMatchObject({ send: true, cell: { cell: 'price', value: 99.75 } })
    const sale = { value: 89, start: '2026-09-12', end: '2026-09-30' }
    expect(matrixWrite(col('salePrice'), cellsOf(), { value: null, start: null, end: null }, sale)).toMatchObject({ send: true, cell: { cell: 'salePrice', value: sale } })
    /* A dates-only change is a change — the reason the value is the compound. */
    expect(matrixWrite(col('salePrice'), cellsOf(), sale, { ...sale, end: '2026-10-01' })).toMatchObject({ send: true })
  })

  it('an unchanged edit sends NOTHING (structural for the sale compound, numeric-string aware for numbers)', () => {
    expect(matrixWrite(col('syncQty'), cellsOf(), 403, 403)).toEqual({ send: false, reason: MATRIX_UNCHANGED })
    expect(matrixWrite(col('syncQty'), cellsOf(), 403, '403')).toEqual({ send: false, reason: MATRIX_UNCHANGED })
    expect(matrixWrite(col('syncMode'), cellsOf(), 'FOLLOW', 'FOLLOW')).toEqual({ send: false, reason: MATRIX_UNCHANGED })
    const sale = { value: 89, start: '2026-09-12', end: null }
    expect(matrixWrite(col('salePrice'), cellsOf(), sale, { ...sale })).toEqual({ send: false, reason: MATRIX_UNCHANGED })
  })

  it('facts are never writes; fulfilment never travels inline; no cell means no listing', () => {
    expect(matrixWrite(col('listing'), cellsOf(), 'listed', 'draft')).toEqual({ send: false, reason: 'Listing is a fact, not a write' })
    expect(matrixWrite(col('syncState'), cellsOf(), 'sent', 'queued')).toEqual({ send: false, reason: 'Sync is a fact, not a write' })
    expect(matrixWrite(col('fulfilment'), cellsOf(), 'FBM', 'FBA')).toEqual({ send: false, reason: MATRIX_FULFILMENT_INLINE })
    expect(matrixWrite(col('syncQty'), null, 403, 10)).toEqual({ send: false, reason: MATRIX_NO_LISTING })
    expect(matrixWrite(col('syncQty'), undefined, 403, 10)).toEqual({ send: false, reason: MATRIX_NO_LISTING })
  })

  it('a held cell answers the wire’s own sentence; an absent `writable` is held, never open', () => {
    const fba = cellsOf({ writable: { syncQty: false }, writeBlockedReason: { syncQty: 'Amazon-managed' } })
    expect(matrixWrite(col('syncQty'), fba, null, 10)).toEqual({ send: false, reason: 'Amazon-managed' })
    const unsaid = cellsOf({ writable: {}, writeBlockedReason: {} })
    expect(matrixWrite(col('syncQty'), unsaid, 403, 10)).toEqual({ send: false, reason: 'This cell cannot be changed here' })
  })

  it('a value the kind cannot hold is refused with the rule, before the unchanged test', () => {
    expect(matrixWrite(col('syncQty'), cellsOf(), 403, -1)).toEqual({ send: false, reason: 'A quantity is a whole number, zero or more' })
    expect(matrixWrite(col('syncQty'), cellsOf(), 403, 4.5)).toEqual({ send: false, reason: 'A quantity is a whole number, zero or more' })
    expect(matrixWrite(col('syncBuffer'), cellsOf(), 0, 'abc')).toEqual({ send: false, reason: 'A buffer is a whole number, zero or more' })
    expect(matrixWrite(col('price'), cellsOf(), 105, -5)).toEqual({ send: false, reason: 'A price is zero or more' })
    expect(matrixWrite(col('syncMode'), cellsOf(), 'FOLLOW', 'Paused')).toEqual({ send: false, reason: 'Mode is Follow or Pinned' })
    expect(matrixWrite(col('salePrice'), cellsOf(), null, 89)).toEqual({ send: false, reason: 'A sale is a price, zero or more, with an optional window' })
  })

  it('a pasted price as the Matrix copies it ("€99.00") is a price write', () => {
    expect(matrixWrite(col('price'), cellsOf(), 105, '€99.00')).toEqual({ send: true, cell: { rowId: 'r1', coordinateKey: 'AMAZON:IT', cell: 'price', value: 99, expectedVersion: 7 } })
  })

  it('matrixValueRefusal: null when the cell can hold the value, else the sentence a refused paste says', () => {
    expect(matrixValueRefusal('price', '€105.00')).toBeNull()
    expect(matrixValueRefusal('syncQty', '29')).toBeNull()
    expect(matrixValueRefusal('salePrice', '—')).toBeNull()
    expect(matrixValueRefusal('price', 'abc')).toBe('A price is zero or more')
    expect(matrixValueRefusal('syncQty', null)).toBe('A quantity is a whole number, zero or more')
    expect(matrixValueRefusal('price', '1,050')).toBe('"1,050" can be read two ways: write 1050 or 1.05')
    expect(matrixValueRefusal('syncQty', '2.000')).toBe('"2.000" can be read two ways: write 2000 or 2')
    expect(matrixValueRefusal('salePrice', '€89.00 · 12 Sep → —')).toBe(MATRIX_SALE_DATES_NOT_PASTED)
    expect(matrixValueRefusal('syncMode', 'Paused')).toBe('Mode is Follow or Pinned')
    expect(matrixValueRefusal('notAKind', 'x')).toBeNull()
  })
})

describe('matrixWrite — the B2B price and Tiers cells write the WHOLE business setting (Amazon Business)', () => {
  const biz = (over: Record<string, unknown> = {}) => ({
    rule: 'PERCENT_OFF' as const, percent: 5, exact: null, price: 99.75, normalPrice: 105, minPrice: null, maxPrice: null, currency: 'EUR',
    tiers: { type: 'percent' as const, levels: [{ minQty: 2, value: 3, unitPrice: 96.76 }] }, warnings: [], held: null, send: null, live: null, reported: null, ...over,
  })
  const b2b = (over: Record<string, unknown> = {}) => cellsOf({ business: biz(over) as never, writable: { businessPrice: true, businessTiers: true } })
  const col = (kind: string) => ({ kind, coordinateKey: 'AMAZON:IT', rowId: 'r1' })
  const tiers = { type: 'percent', levels: [{ minQty: 2, value: 3 }] }

  it('a typed percent keeps the discounts; a typed price is an exact price; empty removes the business offer', () => {
    expect(matrixWrite(col('businessPrice'), b2b(), '€99.75 · −5%', '6%')).toEqual({ send: true, cell: { rowId: 'r1', coordinateKey: 'AMAZON:IT', cell: 'businessPrice', value: { rule: 'PERCENT_OFF', percent: 6, price: null, tiers }, expectedVersion: 7 } })
    expect(matrixWrite(col('businessPrice'), b2b(), '€99.75 · −5%', '€89')).toMatchObject({ send: true, cell: { value: { rule: 'FIXED', percent: null, price: 89, tiers } } })
    expect(matrixWrite(col('businessPrice'), b2b(), '€99.75 · −5%', '')).toMatchObject({ send: true, cell: { value: null } })
  })
  it('the Tiers column writes under its own kind with the price part as the cell keeps it', () => {
    expect(matrixWrite(col('businessTiers'), b2b(), '2+ −3%', '2+ 3% · 5+ 5%')).toMatchObject({
      send: true, cell: { cell: 'businessTiers', value: { rule: 'PERCENT_OFF', percent: 5, price: null, tiers: { type: 'percent', levels: [{ minQty: 2, value: 3 }, { minQty: 5, value: 5 }] } } },
    })
  })
  it('the same rule read back is unchanged; junk and a held cell say why; discounts with no business price are refused', () => {
    expect(matrixWrite(col('businessPrice'), b2b(), '€99.75 · −5%', '5%')).toEqual({ send: false, reason: MATRIX_UNCHANGED })
    expect(matrixWrite(col('businessPrice'), b2b(), '€99.75 · −5%', 'abc')).toEqual({ send: false, reason: 'A B2B price is a percent below the price (5%) or a price (32.95); empty removes it' })
    const held = cellsOf({ business: biz() as never, writable: {}, writeBlockedReason: { businessPrice: 'Set on the variants' } })
    expect(matrixWrite(col('businessPrice'), held, '—', '5%')).toEqual({ send: false, reason: 'Set on the variants' })
    expect(matrixWrite(col('businessTiers'), b2b({ rule: null, percent: null, price: null, tiers: null }), '—', '2+ 3%')).toEqual({ send: false, reason: 'Set a B2B price first — quantity discounts go with a business price' })
  })
})
