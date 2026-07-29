import { describe, it, expect } from 'vitest'
import { gzipSync } from 'node:zlib'
import {
  buildEconomicsQuery,
  decodeJsonl,
  money,
  parseEconomicsRows,
  marketplaceCode,
  isQuotaError,
  ECONOMICS_SCHEMA,
} from './data-kiosk.service.js'

/**
 * Verbatim row captured from Data Kiosk on 2026-07-29 (IT marketplace).
 * The three fees are three BARE amounts with no identifying field — that is
 * Amazon's actual payload, not a simplification.
 */
const LIVE_ROW = {
  startDate: '2026-07-19',
  endDate: '2026-07-19',
  marketplaceId: 'APJ6JRA9NG5V4',
  parentAsin: 'B0F7J163XJ',
  childAsin: 'B0BMSC91YK',
  msku: 'GALE-JACKET-BLACK-MEN-M',
  sales: {
    unitsOrdered: 1,
    netProductSales: { amount: 81.15, currencyCode: 'EUR' },
    averageSellingPrice: { amount: 81.15, currencyCode: 'EUR' },
  },
  fees: [
    { charge: { aggregatedDetail: { amount: { amount: 0.32, currencyCode: 'EUR' }, quantity: 1 } } },
    { charge: { aggregatedDetail: { amount: { amount: 10.53, currencyCode: 'EUR' }, quantity: 1 } } },
    { charge: { aggregatedDetail: { amount: { amount: 9.48, currencyCode: 'EUR' }, quantity: 1 } } },
  ],
  ads: [{ charge: { amount: { amount: 7.75, currencyCode: 'EUR' }, quantity: 13 } }],
  netProceeds: {
    total: { amount: 48.59, currencyCode: 'EUR' },
    perUnit: { amount: 48.59, currencyCode: 'EUR' },
  },
  cost: { costOfGoodsSold: null, miscellaneousCost: null },
}

/** A zero-sales row — the common case: 1100 of 1127 rows had fees: []. */
const ZERO_ROW = {
  ...LIVE_ROW,
  childAsin: 'B0BSXLDDSL',
  msku: '85-A8DQ-UNYF',
  sales: {
    unitsOrdered: 0,
    netProductSales: { amount: 0, currencyCode: 'EUR' },
    averageSellingPrice: { amount: 0, currencyCode: 'EUR' },
  },
  fees: [],
  ads: [],
  netProceeds: { total: { amount: 0, currencyCode: 'EUR' }, perUnit: { amount: 0, currencyCode: 'EUR' } },
}

describe('buildEconomicsQuery', () => {
  it('uses the verified root field `economics`, not economicsByAsin', () => {
    const q = buildEconomicsQuery({ startDate: '2026-07-01', endDate: '2026-07-07', marketplaceIds: ['APJ6JRA9NG5V4'] })
    expect(q).toContain(ECONOMICS_SCHEMA)
    expect(q).toMatch(/economics\(startDate/)
    expect(q).not.toContain('economicsByAsin')
  })

  it('never emits a __-prefixed field (reserved → "Introspection is not supported")', () => {
    const q = buildEconomicsQuery({ startDate: '2026-07-01', endDate: '2026-07-07', marketplaceIds: ['X'] })
    expect(q).not.toMatch(/\b__/)
  })

  it('does NOT pass feeTypes — economics rejects it as UnknownArgument', () => {
    const q = buildEconomicsQuery({ startDate: '2026-07-01', endDate: '2026-07-07', marketplaceIds: ['X'] })
    expect(q).not.toContain('feeTypes')
  })

  it('quotes each marketplace id', () => {
    const q = buildEconomicsQuery({ startDate: '2026-07-01', endDate: '2026-07-07', marketplaceIds: ['A', 'B'] })
    expect(q).toContain('marketplaceIds: ["A", "B"]')
  })
})

describe('money', () => {
  it('reads a nested Amount', () => {
    expect(money({ amount: 81.15, currencyCode: 'EUR' })).toBeCloseTo(81.15)
  })

  it('keeps a real zero', () => {
    expect(money({ amount: 0, currencyCode: 'EUR' })).toBe(0)
  })

  it('returns null for absent — a missing COGS must not read as free', () => {
    expect(money(null)).toBeNull()
    expect(money(undefined)).toBeNull()
    expect(money({} as never)).toBeNull()
    expect(money({ amount: null } as never)).toBeNull()
    expect(money({ amount: '' } as never)).toBeNull()
  })
})

describe('marketplaceCode', () => {
  it('maps the EU ids Xavia trades in', () => {
    expect(marketplaceCode('APJ6JRA9NG5V4')).toBe('IT')
    expect(marketplaceCode('A1PA6795UKMFR9')).toBe('DE')
    expect(marketplaceCode('A13V1IB3VIYZZH')).toBe('FR')
    expect(marketplaceCode('A1RKKUPIHCS9HS')).toBe('ES')
  })

  it('passes an unknown id through rather than losing it', () => {
    expect(marketplaceCode('SOMETHING_NEW')).toBe('SOMETHING_NEW')
  })
})

describe('decodeJsonl', () => {
  it('decodes one object per line', () => {
    const nd = `${JSON.stringify(LIVE_ROW)}\n${JSON.stringify(ZERO_ROW)}`
    expect(decodeJsonl(Buffer.from(nd))).toEqual([LIVE_ROW, ZERO_ROW])
  })

  it('decodes gzipped JSONL', () => {
    expect(decodeJsonl(gzipSync(Buffer.from(JSON.stringify(LIVE_ROW))))).toEqual([LIVE_ROW])
  })

  it('skips a malformed line instead of losing the document', () => {
    const nd = `${JSON.stringify(LIVE_ROW)}\n{broken\n${JSON.stringify(ZERO_ROW)}`
    expect(decodeJsonl(Buffer.from(nd))).toEqual([LIVE_ROW, ZERO_ROW])
  })

  it('returns empty for an empty body and does not treat 1 byte as gzip', () => {
    expect(decodeJsonl(Buffer.from(''))).toEqual([])
    expect(decodeJsonl(Buffer.from([0x1f]))).toEqual([])
  })
})

describe('parseEconomicsRows', () => {
  it('parses the live row', () => {
    const [r] = parseEconomicsRows([LIVE_ROW])
    expect(r.marketplaceId).toBe('APJ6JRA9NG5V4')
    expect(r.marketplace).toBe('IT')
    expect(r.date.toISOString()).toBe('2026-07-19T00:00:00.000Z')
    expect(r.parentAsin).toBe('B0F7J163XJ')
    expect(r.childAsin).toBe('B0BMSC91YK')
    expect(r.msku).toBe('GALE-JACKET-BLACK-MEN-M')
    expect(r.unitsOrdered).toBe(1)
    expect(r.netProductSales).toBeCloseTo(81.15)
    expect(r.netProceedsTotal).toBeCloseTo(48.59)
    expect(r.currencyCode).toBe('EUR')
  })

  it('sums the unlabelled fee array and records how many there were', () => {
    // 0.32 + 10.53 + 9.48. Only the TOTAL is attributable — the entries carry
    // no identifier, so the count is kept for later reconciliation.
    const [r] = parseEconomicsRows([LIVE_ROW])
    expect(r.feesTotal).toBeCloseTo(20.33)
    expect(r.feesCount).toBe(3)
  })

  it('sums ads from their different nesting (charge.amount, not charge.aggregatedDetail.amount)', () => {
    const [r] = parseEconomicsRows([LIVE_ROW])
    expect(r.adsTotal).toBeCloseTo(7.75)
    expect(r.adsCount).toBe(1)
  })

  it('leaves fee/ad totals NULL when the arrays are empty, not 0', () => {
    // "no fee rows reported" is not the same claim as "fees were zero".
    const [r] = parseEconomicsRows([ZERO_ROW])
    expect(r.feesTotal).toBeNull()
    expect(r.feesCount).toBe(0)
    expect(r.adsTotal).toBeNull()
    expect(r.adsCount).toBe(0)
  })

  it('keeps null COGS null — absent, not free', () => {
    const [r] = parseEconomicsRows([LIVE_ROW])
    expect(r.costOfGoodsSold).toBeNull()
    expect(r.miscellaneousCost).toBeNull()
  })

  it('keeps netProceeds.perUnit null when Amazon omits it (~9% of rows)', () => {
    const row = { ...LIVE_ROW, netProceeds: { total: { amount: 5, currencyCode: 'EUR' }, perUnit: null } }
    const [r] = parseEconomicsRows([row])
    expect(r.netProceedsTotal).toBe(5)
    expect(r.netProceedsPerUnit).toBeNull()
  })

  it('preserves the raw row so unlabelled fees are not lost', () => {
    const [r] = parseEconomicsRows([LIVE_ROW])
    expect(r.raw).toEqual(LIVE_ROW)
  })

  it('keeps rows that differ only by msku — the grain requires it', () => {
    // Measured: (date, childAsin) collides on 896 of 1127 real rows because one
    // ASIN carries several MSKUs. Dropping msku would overwrite ~20% of rows.
    const a = { ...LIVE_ROW, msku: 'SKU-A' }
    const b = { ...LIVE_ROW, msku: 'SKU-B' }
    const rows = parseEconomicsRows([a, b])
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r) => r.childAsin)).size).toBe(1)
    expect(new Set(rows.map((r) => r.msku)).size).toBe(2)
  })

  it.each([
    ['no startDate', { ...LIVE_ROW, startDate: undefined }],
    ['no marketplaceId', { ...LIVE_ROW, marketplaceId: undefined }],
    ['no childAsin', { ...LIVE_ROW, childAsin: undefined }],
    ['no msku', { ...LIVE_ROW, msku: undefined }],
  ])('drops a row with %s — it cannot be keyed safely', (_label, row) => {
    expect(parseEconomicsRows([row])).toHaveLength(0)
  })

  it('returns empty for junk instead of throwing', () => {
    expect(parseEconomicsRows([null, 42, 'x', undefined])).toEqual([])
    expect(parseEconomicsRows([])).toEqual([])
  })
})

describe('isQuotaError', () => {
  it('recognises Data Kiosk quota exhaustion, which arrives with an empty detail', () => {
    // This must never be mistaken for a schema error — that misread produced
    // nine false "field exists" results during discovery.
    expect(isQuotaError({ message: 'You exceeded your quota for the requested resource.' })).toBe(true)
    expect(isQuotaError({ code: 'QuotaExceeded', message: '' })).toBe(true)
  })

  it('does not flag a genuine validation error as quota', () => {
    expect(isQuotaError({ code: 'InvalidInput', message: 'The provided query is invalid.' })).toBe(false)
  })
})
