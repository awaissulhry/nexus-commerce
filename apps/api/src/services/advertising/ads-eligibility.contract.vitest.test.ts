/**
 * APS.3 — locks the eligibility response contract to what Amazon ACTUALLY sent.
 *
 * This cost several deploy cycles to establish, because ads credentials cannot
 * be decrypted off-prod, so it is worth pinning. The payload below is copied
 * verbatim from the live IT profile (profile 4117374346144545, 2026-07-30):
 * the identifiers are nested under `productDetails`, NOT flat on the record.
 *
 * Reading the wrong level made every ASIN look unanswered while Amazon was
 * replying correctly — a failure that produced no error, only a silent wall of
 * "Not checked". A test is the only thing that stops that returning.
 */
import { describe, it, expect } from 'vitest'
import { eligibilityAsin, eligibilitySku, type AdsProductEligibility } from './ads-api-client.js'

/** Verbatim from the live API. Do not "tidy" this shape. */
const LIVE_ROW = {
  eligibilityStatusList: [],
  overallStatus: 'ELIGIBLE',
  productDetails: {
    asin: 'B0CFB7GTV7',
    globalStoreSetting: null,
    sku: 'AIR-MESH-JACKET-MEN-L-BLACK',
  },
} as unknown as AdsProductEligibility

describe('eligibility identifiers — the observed nesting', () => {
  it('reads the asin from productDetails, where Amazon puts it', () => {
    expect(eligibilityAsin(LIVE_ROW)).toBe('B0CFB7GTV7')
  })

  it('reads the sku from productDetails', () => {
    expect(eligibilitySku(LIVE_ROW)).toBe('AIR-MESH-JACKET-MEN-L-BLACK')
  })

  it('uppercases the asin so lookups key consistently', () => {
    const row = { ...LIVE_ROW, productDetails: { asin: 'b0cfb7gtv7' } } as AdsProductEligibility
    expect(eligibilityAsin(row)).toBe('B0CFB7GTV7')
  })

  it('still reads a flat asin, so a future shape change does not break it', () => {
    const flat = { asin: 'B0TESTFLAT', overallStatus: 'ELIGIBLE' } as AdsProductEligibility
    expect(eligibilityAsin(flat)).toBe('B0TESTFLAT')
  })

  it('prefers productDetails over a flat field when both are present', () => {
    const both = {
      asin: 'B0FLAT00000',
      productDetails: { asin: 'B0NESTED000' },
      overallStatus: 'ELIGIBLE',
    } as AdsProductEligibility
    expect(eligibilityAsin(both)).toBe('B0NESTED000')
  })

  it('returns null rather than a plausible-looking empty string', () => {
    const empty = { overallStatus: 'ELIGIBLE' } as AdsProductEligibility
    expect(eligibilityAsin(empty)).toBeNull()
    expect(eligibilitySku(empty)).toBeNull()
  })
})

describe('worst-status-wins across multiple offers for one ASIN', () => {
  // Amazon can return one row per seller SKU offering the same ASIN. The
  // service keeps the WORST, because an ASIN with one blocked offer is not
  // safely advertisable just because another offer is fine.
  const RANK: Record<string, number> = { ELIGIBLE: 0, ELIGIBLE_WITH_WARNING: 1, INELIGIBLE: 2 }
  const worst = (rows: AdsProductEligibility[]) =>
    rows.reduce((acc, r) =>
      (RANK[String(r.overallStatus)] ?? 0) > (RANK[String(acc.overallStatus)] ?? 0) ? r : acc)

  it('an ineligible offer beats an eligible one', () => {
    const rows = [
      { overallStatus: 'ELIGIBLE', productDetails: { asin: 'B0X', sku: 'A' } },
      { overallStatus: 'INELIGIBLE', productDetails: { asin: 'B0X', sku: 'B' } },
    ] as unknown as AdsProductEligibility[]
    expect(worst(rows).overallStatus).toBe('INELIGIBLE')
    expect(eligibilitySku(worst(rows))).toBe('B')
  })

  it('a warning beats plain eligible', () => {
    const rows = [
      { overallStatus: 'ELIGIBLE', productDetails: { asin: 'B0X', sku: 'A' } },
      { overallStatus: 'ELIGIBLE_WITH_WARNING', productDetails: { asin: 'B0X', sku: 'B' } },
    ] as unknown as AdsProductEligibility[]
    expect(worst(rows).overallStatus).toBe('ELIGIBLE_WITH_WARNING')
  })

  it('order does not matter', () => {
    const rows = [
      { overallStatus: 'INELIGIBLE', productDetails: { asin: 'B0X', sku: 'B' } },
      { overallStatus: 'ELIGIBLE', productDetails: { asin: 'B0X', sku: 'A' } },
    ] as unknown as AdsProductEligibility[]
    expect(worst(rows).overallStatus).toBe('INELIGIBLE')
  })
})
