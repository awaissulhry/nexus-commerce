/**
 * Meta ads step 2 — the pure parts of the read: money converted once (Meta's offset units and insights decimals →
 * micros → the currency's minor units), Meta's rows mapped (time zones written +0200, purchase action types), and the
 * windows of the read in the account's time zone. Made-up values only.
 */
import { describe, expect, it } from 'vitest'
import { currencyExponent, decimalToMicros, metaOffset, metaUnitsToMicros, microsToMinor, minorOf } from './money.js'
import { mapAccount, mapAd, mapAdSet, mapCampaign, mapInsightDay, purchasesOf } from './mappers.js'
import { metaBackfillWindow, metaDailyWindow, metaReadWindow } from './dates.js'

describe('money', () => {
  it('Meta\'s offset units: 100 for most currencies, 1 for JPY, HUF, TWD and the others Meta names', () => {
    expect(metaOffset('EUR')).toBe(100)
    expect(metaOffset('jpy')).toBe(1)
    expect(metaOffset('HUF')).toBe(1)
    expect(metaUnitsToMicros('2500', 'EUR')).toBe(25_000_000n)
    expect(metaUnitsToMicros(2500, 'JPY')).toBe(2_500_000_000n)
    expect(metaUnitsToMicros('12.5', 'EUR')).toBeNull()
    expect(metaUnitsToMicros(null, 'EUR')).toBeNull()
  })
  it('insights decimals exactly, rounded past 6 decimals', () => {
    expect(decimalToMicros('12.34')).toBe(12_340_000n)
    expect(decimalToMicros('0.0000005')).toBe(1n)
    expect(decimalToMicros('7')).toBe(7_000_000n)
    expect(decimalToMicros('x')).toBeNull()
  })
  it('micros to the currency\'s ISO minor units, whatever Meta\'s offset (1,000 HUF is 1,000 forints either way)', () => {
    expect(microsToMinor(12_345_000n, currencyExponent('EUR'))).toBe(1235)
    expect(microsToMinor(2_500_000_000n, currencyExponent('JPY'))).toBe(2500)
    expect(minorOf(metaUnitsToMicros('1000', 'HUF'), 'HUF')).toBe(1000 * 10 ** currencyExponent('HUF'))
    expect(minorOf(null, 'EUR')).toBeNull()
  })
})

describe('mappers', () => {
  it('an ad account needs its currency and time zone; money from the money read; the payment method\'s kind only', () => {
    const account = mapAccount(
      { account_id: '1234567890', name: 'Shop A', currency: 'EUR', timezone_name: 'Europe/Rome', account_status: 1, business: { id: '9876543210', name: 'Shop A portfolio' } },
      { amount_spent: '123456', spend_cap: '0', balance: '1500', funding_source_details: { ID: '1', TYPE: 1, DISPLAY_STRING: 'Visa *0000' } },
      { capabilities: ['X'] },
    )!
    expect(account).toMatchObject({ adAccountId: '1234567890', currencyCode: 'EUR', accountStatus: 1, businessId: '9876543210', amountSpentMicros: 1_234_560_000n, spendCapMicros: 0n })
    expect(JSON.stringify(account.settings)).not.toContain('Visa')
    expect(account.settings).toMatchObject({ capabilities: ['X'], fundingSourceType: 1 })
    expect(mapAccount({ account_id: '1', name: 'x' }, null, {})).toBeNull()
  })
  it('a campaign, an ad set and an ad, with Meta\'s +0200 times', () => {
    const ctx = { adAccountId: '1234567890', currencyCode: 'EUR' }
    expect(mapCampaign({ id: '120000000000001', name: 'Shop A sales', status: 'PAUSED', effective_status: 'PAUSED', objective: 'OUTCOME_SALES', daily_budget: '2000', start_time: '2026-10-01T09:00:00+0200' }, ctx))
      .toMatchObject({ campaignId: '120000000000001', dailyBudgetMicros: 20_000_000n, lifetimeBudgetMicros: null, startTime: new Date('2026-10-01T07:00:00Z') })
    expect(mapAdSet({ id: '120000000000002', campaign_id: '120000000000001', name: 'Italy', status: 'ACTIVE', bid_amount: 150, targeting: { geo_locations: { countries: ['IT'] } } }, ctx))
      .toMatchObject({ adSetId: '120000000000002', bidAmountMicros: 1_500_000n, targeting: { geo_locations: { countries: ['IT'] } } })
    expect(mapAd({ id: '120000000000003', campaign_id: '120000000000001', adset_id: '120000000000002', name: 'Ad 1', status: 'ACTIVE', creative: { id: '120000000000004', title: 'T', body: 'B' } }, { adAccountId: '1234567890' }))
      .toMatchObject({ adId: '120000000000003', creativeId: '120000000000004', creative: { title: 'T', body: 'B' } })
    expect(mapCampaign({ id: 'not-an-id' }, ctx)).toBeNull()
  })
  it('purchases: the aggregate type first, its value from action_values', () => {
    expect(purchasesOf([{ action_type: 'link_click', value: '10' }, { action_type: 'purchase', value: '2' }, { action_type: 'omni_purchase', value: '3' }], [{ action_type: 'omni_purchase', value: '89.70' }]))
      .toEqual({ type: 'omni_purchase', count: '3.0000', valueMicros: 89_700_000n })
    expect(purchasesOf(undefined, undefined)).toEqual({ type: null, count: '0.0000', valueMicros: 0n })
  })
  it('an insights row is one entity on one day; a period row is not a day', () => {
    const row = { date_start: '2026-10-10', date_stop: '2026-10-10', campaign_id: '120000000000001', adset_id: '120000000000002', ad_id: '120000000000003', ad_name: 'Ad 1', impressions: '1000', clicks: '20', inline_link_clicks: '15', reach: '800', spend: '12.34', actions: [{ action_type: 'purchase', value: '1' }], action_values: [{ action_type: 'purchase', value: '49.90' }] }
    expect(mapInsightDay(row, { adAccountId: '1234567890', currencyCode: 'EUR', level: 'AD' })).toMatchObject({
      entityType: 'AD', entityId: '120000000000003', adSetId: '120000000000002', impressions: 1000, clicks: 20, linkClicks: 15, reach: 800,
      spendMicros: 12_340_000n, purchases: '1.0000', purchaseValueMicros: 49_900_000n, extra: { purchaseActionType: 'purchase' },
    })
    expect(mapInsightDay({ ...row, date_stop: '2026-10-11' }, { adAccountId: '1', currencyCode: 'EUR', level: 'AD' })).toBeNull()
  })
})

describe('the windows, in the account\'s time zone', () => {
  const now = new Date('2026-10-20T06:50:00Z')
  it('daily: 28 days ending yesterday; backfill: 180', () => {
    expect(metaDailyWindow('Europe/Rome', now)).toEqual({ from: '2026-09-22', to: '2026-10-19' })
    expect(metaBackfillWindow('Europe/Rome', now)).toEqual({ from: '2026-04-23', to: '2026-10-19' })
    expect(metaDailyWindow('Pacific/Honolulu', now).to).toBe('2026-10-18')
  })
  it('missed runs reach back to the day after the last day read, never past 180 days', () => {
    expect(metaReadWindow('Europe/Rome', now, '2026-10-01')).toEqual({ from: '2026-09-22', to: '2026-10-19' })
    expect(metaReadWindow('Europe/Rome', now, '2026-08-31')).toEqual({ from: '2026-09-01', to: '2026-10-19' })
    expect(metaReadWindow('Europe/Rome', now, '2025-01-01').from).toBe('2026-04-23')
  })
})
