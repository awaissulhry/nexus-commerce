/**
 * ADM-A5 — new-to-brand must never be reported for an ad product that does not publish it.
 *
 * Regression for a defect caught ON PROD minutes after the ADM-A3 deploy, on the very page that
 * deploy fixed: the Ad Manager printed `0` for NTB-Orders on Sponsored Products campaigns. The
 * cause was not a missing request but a `DEFAULT 0` — the legacy NTB columns hold a zero on all
 * 6,019 SP rows that nobody ever measured, and a `_count > 0` presence check treats a defaulted
 * zero as a reading.
 */
import { describe, it, expect } from 'vitest'
import { ntbIsPublishedFor } from './metrics-math.js'

describe('ADM-A5 ntbIsPublishedFor', () => {
  it('REFUSES Sponsored Products — Amazon publishes no newToBrand column on spCampaigns or spTargeting', () => {
    expect(ntbIsPublishedFor('SPONSORED_PRODUCTS')).toBe(false)
  })

  it('allows the two ad products that do publish it', () => {
    expect(ntbIsPublishedFor('SPONSORED_BRANDS')).toBe(true)
    expect(ntbIsPublishedFor('SPONSORED_DISPLAY')).toBe(true)
  })

  it('treats an unknown or missing ad product as NOT published', () => {
    // 200 of this account's 219 campaigns are SP, so an unknown product must not be assumed to
    // publish a metric — the safe direction is "say nothing", not "print a zero".
    expect(ntbIsPublishedFor(null)).toBe(false)
    expect(ntbIsPublishedFor(undefined)).toBe(false)
    expect(ntbIsPublishedFor('SPONSORED_TELEVISION')).toBe(false)
    expect(ntbIsPublishedFor('')).toBe(false)
  })

  // The gate exists precisely because a defaulted zero is indistinguishable from a measured one.
  it('the defaulted-zero scenario: a present SP row must still yield no NTB figure', () => {
    const row = { adProduct: 'SPONSORED_PRODUCTS', ntbOrders14d: 0, countedRows: 31 }
    const reported = row.countedRows > 0            // what a presence check alone would conclude
    expect(reported).toBe(true)                     // ...and it is WRONG on its own
    const figure = ntbIsPublishedFor(row.adProduct) && reported ? row.ntbOrders14d : null
    expect(figure).toBeNull()
  })
})
