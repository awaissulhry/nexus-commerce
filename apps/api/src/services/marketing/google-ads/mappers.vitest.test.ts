/**
 * Google Ads step 1a — REST answers (fixtures shaped as Google sends them: camelCase, int64 as strings, zero fields
 * left out) → table data. Money stays in the account's currency; a missing number is zero; the change history's
 * source is one of five, in words.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CHANGE_SOURCE_TEXT, campaignStatus, campaignTypeText, changeSourceOf, count, customerIdDigits, decimal4, double, fieldMaskPaths,
  idFromResourceName, int64, int64OrNull, mapCampaign, mapCampaignDay, mapChangeEvent, mapCustomer, mapCustomerClient, unitsToMicros,
} from './mappers.js'
import type {
  GoogleAdsCampaignDayRow, GoogleAdsCampaignRow, GoogleAdsChangeEventRow, GoogleAdsCustomerClientRow, GoogleAdsCustomerRow, GoogleAdsSearchPage,
} from './types.js'

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../../../test-support/google-ads/${name}`, import.meta.url), 'utf8')) as T
const ACCOUNT = { customerId: '1234567890', currencyCode: 'EUR' }

describe('numbers', () => {
  it('int64 strings become BigInt exactly; a missing field is 0', () => {
    expect(int64('31450000')).toBe(31_450_000n)
    expect(int64('9007199254740993')).toBe(9_007_199_254_740_993n) // beyond a double's precision
    expect(int64(undefined)).toBe(0n)
    expect(int64('')).toBe(0n)
    expect(int64('not a number')).toBe(0n)
    expect(int64(42)).toBe(42n)
    expect(int64OrNull(undefined)).toBeNull()
    expect(int64OrNull('2500000')).toBe(2_500_000n)
    expect(count('1520')).toBe(1520)
    expect(count(undefined)).toBe(0)
    expect(double(undefined)).toBe(0)
    expect(double(Number.NaN)).toBe(0)
  })

  it('currency units → micros without float drift; fractional conversions as Decimal(14,4) text', () => {
    expect(unitsToMicros(12.34)).toBe(12_340_000n)
    expect(unitsToMicros(0.1 + 0.2)).toBe(300_000n)
    expect(unitsToMicros(1234.56)).toBe(1_234_560_000n)
    expect(unitsToMicros(undefined)).toBe(0n)
    expect(decimal4(2.5)).toBe('2.5000')
    expect(decimal4(1 / 3)).toBe('0.3333')
    expect(decimal4(undefined)).toBe('0.0000')
  })

  it('ids from resource names and customer ids as digits', () => {
    expect(idFromResourceName('customers/1234567890/campaigns/11111111111')).toBe('11111111111')
    expect(idFromResourceName('customers/1234567890/adGroupCriteria/1~2')).toBeNull()
    expect(idFromResourceName(undefined)).toBeNull()
    expect(customerIdDigits('123-456-7890')).toBe('1234567890')
    expect(customerIdDigits('12345abc')).toBeNull()
    expect(customerIdDigits('')).toBeNull()
  })
})

describe('the account', () => {
  it('the customer row; false flags Google left out read as false', () => {
    const page = fixture<GoogleAdsSearchPage<GoogleAdsCustomerRow>>('search-customer.json')
    expect(mapCustomer(page.results?.[0])).toEqual({
      customerId: '1234567890', descriptiveName: 'Test advertiser', currencyCode: 'EUR', timeZone: 'Europe/Rome',
      manager: false, testAccount: false, status: 'ENABLED',
    })
    expect(mapCustomer(undefined)).toBeNull()
    expect(mapCustomer({ customer: { descriptiveName: 'No id' } })).toBeNull()
  })

  it('a manager\'s own row (level 0, left out) and its clients', () => {
    const rows = fixture<GoogleAdsSearchPage<GoogleAdsCustomerClientRow>>('search-customer-clients.json').results ?? []
    const mapped = rows.map(mapCustomerClient)
    expect(mapped.map((c) => [c?.customerId, c?.level, c?.manager, c?.testAccount])).toEqual([
      ['9876543210', 0, true, false],
      ['1234567890', 1, false, false],
      ['1112223334', 1, false, true],
    ])
    expect(mapped[2]).toMatchObject({ descriptiveName: null, currencyCode: 'USD', timeZone: 'America/Los_Angeles' })
    // An id only in the resource name still counts.
    expect(mapCustomerClient({ customerClient: { clientCustomer: 'customers/5550001112', level: '1' } })?.customerId).toBe('5550001112')
  })
})

describe('campaigns', () => {
  const page1 = fixture<GoogleAdsSearchPage<GoogleAdsCampaignRow>>('search-campaigns-page-1.json').results ?? []
  const page2 = fixture<GoogleAdsSearchPage<GoogleAdsCampaignRow>>('search-campaigns-page-2.json').results ?? []

  it('a search campaign with a target CPA and its own daily budget', () => {
    expect(mapCampaign(page1[0], ACCOUNT)).toEqual({
      customerId: '1234567890', campaignId: '11111111111', name: 'Test search campaign', status: 'ENABLED',
      servingStatus: 'SERVING', primaryStatus: 'ELIGIBLE', primaryStatusReasons: [], channelType: 'SEARCH', channelSubType: null,
      biddingStrategyType: 'TARGET_CPA', portfolioBiddingStrategy: null, targetCpaMicros: 2_500_000n, targetRoas: null,
      budgetId: '21111111111', budgetAmountMicros: 15_000_000n, budgetDeliveryMethod: 'STANDARD', budgetPeriod: 'DAILY',
      budgetShared: false, merchantId: null, feedLabel: null,
      startDate: new Date('2026-01-15T00:00:00Z'), endDate: new Date('2037-12-30T00:00:00Z'), currencyCode: 'EUR',
    })
  })

  it('Performance Max with a target ROAS, a shared budget, a feed; no end date', () => {
    expect(mapCampaign(page1[1], ACCOUNT)).toMatchObject({
      campaignId: '22222222222', status: 'PAUSED', primaryStatus: 'PAUSED', primaryStatusReasons: ['CAMPAIGN_PAUSED'],
      channelType: 'PERFORMANCE_MAX', biddingStrategyType: 'MAXIMIZE_CONVERSION_VALUE', targetRoas: '4.5000', targetCpaMicros: null,
      budgetAmountMicros: 40_000_000n, budgetShared: true, merchantId: '5555555555', feedLabel: 'IT',
      startDate: new Date('2026-03-01T00:00:00Z'), endDate: null,
    })
    expect(mapCampaign(page2[0], ACCOUNT)).toMatchObject({ campaignId: '33333333333', channelType: 'SHOPPING', budgetId: '23333333333', primaryStatusReasons: ['BUDGET_CONSTRAINED'] })
  })

  it('statuses and types in words; an unknown status is never ENABLED', () => {
    expect(campaignStatus('PAUSED')).toBe('PAUSED')
    expect(campaignStatus('SOMETHING_NEW')).toBe('UNKNOWN')
    expect(campaignStatus(undefined)).toBe('UNKNOWN')
    expect(mapCampaign({ campaign: { id: '7', name: 'Test' } }, ACCOUNT)).toMatchObject({ status: 'UNKNOWN', channelType: 'UNKNOWN', budgetId: null, budgetAmountMicros: null })
    expect(mapCampaign({ campaignBudget: { id: '1' } }, ACCOUNT)).toBeNull()
    expect(campaignTypeText('PERFORMANCE_MAX')).toBe('Performance Max')
    expect(campaignTypeText('MULTI_CHANNEL')).toBe('App')
    expect(campaignTypeText('NEW_TYPE')).toBe('Other')
  })
})

describe('daily campaign numbers', () => {
  const rows = fixture<GoogleAdsSearchPage<GoogleAdsCampaignDayRow>>('search-campaign-days.json').results ?? []

  it('a full day: cost micros as sent, conversion value from currency units, fractional conversions', () => {
    expect(mapCampaignDay(rows[0], ACCOUNT)).toEqual({
      customerId: '1234567890', date: new Date('2026-10-11T00:00:00Z'), entityType: 'CAMPAIGN', entityId: '11111111111',
      campaignId: '11111111111', adGroupId: null, label: 'Test search campaign', impressions: 1520, clicks: 48,
      costMicros: 31_450_000n, conversions: '2.5000', conversionsValueMicros: 12_340_000n, allConversions: '3.2500',
      allConversionsValueMicros: 20_500_000n, currencyCode: 'EUR',
    })
  })

  it('every number Google left out is zero', () => {
    expect(mapCampaignDay(rows[1], ACCOUNT)).toMatchObject({
      date: new Date('2026-10-12T00:00:00Z'), impressions: 310, clicks: 0, costMicros: 0n, conversions: '0.0000', conversionsValueMicros: 0n,
    })
    expect(mapCampaignDay({ campaign: { id: '1' }, segments: { date: '2026-10-12' } }, ACCOUNT)).toMatchObject({ impressions: 0, clicks: 0, costMicros: 0n })
  })

  it('a campaign removed before the first read keeps its name on the row; a row without id or day is no row', () => {
    expect(mapCampaignDay(rows[2], ACCOUNT)).toMatchObject({ entityId: '44444444444', label: 'Test campaign removed before the first read', costMicros: 430_000n })
    expect(mapCampaignDay({ segments: { date: '2026-10-12' } }, ACCOUNT)).toBeNull()
    expect(mapCampaignDay({ campaign: { id: '1' } }, ACCOUNT)).toBeNull()
  })
})

describe('the change history', () => {
  const rows = fixture<GoogleAdsSearchPage<GoogleAdsChangeEventRow>>('search-change-events.json').results ?? []
  const CONTEXT = { customerId: '1234567890', timeZone: 'Europe/Rome' }

  it('a budget raised by Google\'s auto-apply: the account\'s wall clock becomes an instant, fields in snake_case', () => {
    expect(mapChangeEvent(rows[0], CONTEXT)).toEqual({
      customerId: '1234567890',
      resourceName: 'customers/1234567890/changeEvents/1760266800000000~0~0',
      changedAt: new Date('2026-10-12T11:00:00.123Z'),
      resourceType: 'CAMPAIGN_BUDGET',
      changeResourceName: 'customers/1234567890/campaignBudgets/21111111111',
      operation: 'UPDATE',
      clientType: 'GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION',
      userEmail: 'test.person@example.com',
      changedFields: ['amount_micros'],
      campaignId: '11111111111',
      adGroupId: null,
      oldResource: { campaignBudget: { amountMicros: '10000000' } },
      newResource: { campaignBudget: { amountMicros: '15000000' } },
    })
  })

  it('several fields; no resource sent → the Json columns are left out, not null', () => {
    expect(mapChangeEvent(rows[1], CONTEXT)?.changedFields).toEqual(['status', 'name'])
    const created = mapChangeEvent(rows[2], CONTEXT)
    expect(created).toMatchObject({ operation: 'CREATE', changedFields: [], adGroupId: '31111111111', userEmail: null })
    expect(created).not.toHaveProperty('oldResource')
    expect(created).not.toHaveProperty('newResource')
    expect(mapChangeEvent({ changeEvent: { changeDateTime: '2026-10-12 13:00:00' } }, CONTEXT)).toBeNull()
    expect(fieldMaskPaths({ paths: ['campaignBudget.amountMicros'] })).toEqual(['campaign_budget.amount_micros'])
  })

  it('where a change was made, in the five sources of the campaign modal', () => {
    const source = (clientType: unknown) => changeSourceOf(clientType).source
    for (const automatic of ['GOOGLE_ADS_AUTOMATED_RULE', 'GOOGLE_ADS_RECOMMENDATIONS', 'GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION', 'GOOGLE_ADS_SCRIPTS', 'INTERNAL_TOOL']) {
      expect(source(automatic), automatic).toBe('google_automatic')
    }
    expect(source('GOOGLE_ADS_WEB_CLIENT')).toBe('google_ads_web')
    expect(source('GOOGLE_ADS_BULK_UPLOAD')).toBe('google_ads_web')
    expect(source('GOOGLE_ADS_EDITOR')).toBe('google_ads_editor')
    expect(source('GOOGLE_ADS_API')).toBe('api')
    for (const other of ['OTHER', 'UNKNOWN', 'UNSPECIFIED', 'SEARCH_ADS_360_SYNC', 'GOOGLE_ADS_MOBILE_APP', 'A_NEW_CLIENT', undefined]) {
      expect(source(other), String(other)).toBe('other')
    }
    expect(changeSourceOf('GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION')).toEqual({
      source: 'google_automatic', sourceText: 'Google, automatically', sentence: 'Google applied one of its recommendations automatically (auto-apply is on).',
    })
    expect(CHANGE_SOURCE_TEXT).toEqual({
      google_automatic: 'Google, automatically', google_ads_web: 'Google Ads website', google_ads_editor: 'Google Ads Editor', api: 'Google Ads API', other: 'Other',
    })
    // The words never carry the person's e-mail.
    for (const row of rows) expect(JSON.stringify(changeSourceOf(row.changeEvent?.clientType))).not.toContain('@')
  })
})
