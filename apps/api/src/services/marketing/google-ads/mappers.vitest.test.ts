/**
 * Google Ads steps 1a and 1b — REST answers (fixtures shaped as Google sends them: camelCase, int64 as strings, zero
 * fields left out) → table data. Money stays in the account's currency; a missing number is zero; the change history's
 * source is one of five, in words. Step 1b: the daily keys of each grain, settings Google left out read as false (and
 * a setting not read as null), only real ad and product issues kept, a negative list's details when sent.
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
import * as m from './mappers.js'
import type {
  GoogleAdsAdGroupCriterionRow, GoogleAdsAdGroupRow, GoogleAdsAdPolicyRow, GoogleAdsAssetGroupRow, GoogleAdsCampaignCriterionRow,
  GoogleAdsCampaignFlagsRow, GoogleAdsCampaignSharedSetRow, GoogleAdsDailyMetricData, GoogleAdsGrainDayRow, GoogleAdsRecommendationRow,
  GoogleAdsRecommendationSubscriptionRow, GoogleAdsSharedCriterionRow, GoogleAdsShoppingProductRow,
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

// ── step 1b ─────────────────────────────────────────────────────────────────────────────────────────────────────

const rows = <T>(name: string): T[] => fixture<GoogleAdsSearchPage<T>>(name).results ?? []
const CID = { customerId: '1234567890' }
const ROME = 'Europe/Rome'

describe('step 1b: numbers per day below the campaign', () => {
  it('each grain\'s key, label and numbers; missing numbers are 0', () => {
    const [helmets, gloves] = rows<GoogleAdsGrainDayRow>('search-ad-group-days.json').map((row) => m.mapGrainDay('AD_GROUP', row, ACCOUNT))
    expect(helmets).toMatchObject({ entityType: 'AD_GROUP', entityId: '71111111111', campaignId: '11111111111', adGroupId: '71111111111', label: 'Test helmets',
      impressions: 900, clicks: 30, costMicros: 21_000_000n, conversions: '2.0000', conversionsValueMicros: 180_500_000n, currencyCode: 'EUR' })
    expect(helmets?.date).toEqual(new Date('2026-10-12T00:00:00Z'))
    expect(gloves).toMatchObject({ impressions: 120, clicks: 0, costMicros: 0n, conversions: '0.0000', conversionsValueMicros: 0n })
    const [keyword] = rows<GoogleAdsGrainDayRow>('search-keyword-days.json').map((row) => m.mapGrainDay('KEYWORD', row, ACCOUNT))
    expect(keyword).toMatchObject({ entityType: 'KEYWORD', entityId: '71111111111~91111', adGroupId: '71111111111', label: 'test helmet', conversions: '1.5000' })
    const [assetGroup] = rows<GoogleAdsGrainDayRow>('search-asset-group-days.json').map((row) => m.mapGrainDay('ASSET_GROUP', row, ACCOUNT))
    expect(assetGroup).toMatchObject({ entityType: 'ASSET_GROUP', entityId: '61111111111', campaignId: '22222222222', adGroupId: null, label: 'Test asset group' })
    const products = rows<GoogleAdsGrainDayRow>('search-product-days.json').map((row) => m.mapGrainDay('PRODUCT', row, ACCOUNT))
    expect(products.map((p) => [p?.entityId, p?.label])).toEqual([
      ['33333333333~test-sku-1', 'Test helmet, size M'], ['33333333333~test-sku-1', 'Test helmet M'], ['22222222222~test-sku-2', 'Test gloves'],
    ])
    expect(m.productDayKey('333', ' Test-SKU-1 ')).toBe('333~test-sku-1')
  })

  it('search terms: one key per campaign and normalised term (the term is the label); a term without a click is not kept', () => {
    const terms = rows<GoogleAdsGrainDayRow>('search-search-terms.json').map((row) => m.mapGrainDay('SEARCH_TERM', row, ACCOUNT))
    expect(terms.map((t) => t?.label ?? null)).toEqual(['test helmet', 'test helmet', 'test gloves winter', null])
    expect(terms[0]?.entityId).toBe(terms[1]?.entityId)
    expect(terms[0]?.entityId).toMatch(/^11111111111~[0-9a-f]{24}$/)
    expect(terms[0]?.entityId).toBe(m.searchTermKey('11111111111', 'TEST   Helmet'))
    expect(m.searchTermKey('22222222222', 'test helmet')).not.toBe(terms[0]?.entityId)
    expect(m.normalizeSearchTerm('  Ｔest\tHelmet  ')).toBe('test helmet')
    expect(m.normalizeSearchTerm('   ')).toBeNull()
  })

  it('rows on the same key are summed exactly (conversions as Decimal(14,4) text)', () => {
    const [a, b] = rows<GoogleAdsGrainDayRow>('search-search-terms.json').map((row) => m.mapGrainDay('SEARCH_TERM', row, ACCOUNT)) as GoogleAdsDailyMetricData[]
    expect(m.addDailyRows(a, b)).toMatchObject({ impressions: 60, clicks: 8, costMicros: 5_600_000n, conversions: '1.5000', conversionsValueMicros: 99_500_000n,
      allConversions: '0.0000', allConversionsValueMicros: 0n, label: 'test helmet' })
    expect(m.addDecimal4('0.3333', '0.6667')).toBe('1.0000')
    expect(m.addDecimal4('12.5', '-0.25')).toBe('12.2500')
    expect(m.addDailyRows({ ...a, label: null, allConversions: null, allConversionsValueMicros: null }, { ...b, allConversions: null, allConversionsValueMicros: null }))
      .toMatchObject({ label: 'test helmet', allConversions: null, allConversionsValueMicros: null })
  })

  it('a row without its campaign, day or own id is not a row', () => {
    expect(m.mapGrainDay('AD_GROUP', { segments: { date: '2026-10-12' }, adGroup: { id: '1' } }, ACCOUNT)).toBeNull()
    expect(m.mapGrainDay('AD_GROUP', { campaign: { id: '1' }, adGroup: { id: '2' } }, ACCOUNT)).toBeNull()
    expect(m.mapGrainDay('KEYWORD', { campaign: { id: '1' }, adGroup: { id: '2' }, segments: { date: '2026-10-12' } }, ACCOUNT)).toBeNull()
    expect(m.mapGrainDay('PRODUCT', { campaign: { id: '1' }, segments: { date: '2026-10-12' } }, ACCOUNT)).toBeNull()
  })
})

describe('step 1b: safety', () => {
  it('campaign settings: as sent, left out = false, asset automation null when not read and [] when Google listed none', () => {
    const [search, pmax, shopping] = rows<GoogleAdsCampaignFlagsRow>('search-campaign-flags.json').map((row) => m.mapCampaignFlags(row, { timeZone: ROME, assetAutomationRead: true }))
    expect(search).toEqual({
      campaignId: '11111111111', aiMaxEnabled: true, keywordMatchType: 'BROAD', broadMatchMigratedAt: new Date('2026-10-01T10:00:00Z'),
      targetGoogleSearch: true, targetSearchNetwork: true, targetContentNetwork: false, targetPartnerSearchNetwork: false,
      assetAutomation: [
        { assetAutomationType: 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION', assetAutomationStatus: 'OPTED_IN' },
        { assetAutomationType: 'TEXT_ASSET_AUTOMATION', assetAutomationStatus: 'OPTED_OUT' },
      ],
      dsaDomain: 'shop.example.com',
    })
    expect(pmax).toMatchObject({ aiMaxEnabled: false, keywordMatchType: null, broadMatchMigratedAt: null, targetGoogleSearch: false, assetAutomation: [], dsaDomain: null })
    expect(shopping).toMatchObject({ targetGoogleSearch: true })
    expect(m.mapCampaignFlags(rows<GoogleAdsCampaignFlagsRow>('search-campaign-flags.json')[0], { timeZone: ROME, assetAutomationRead: false })?.assetAutomation).toBeNull()
  })

  it('ad approvals: only disapproved and limited ads are issues, topics once each', () => {
    const issues = rows<GoogleAdsAdPolicyRow>('search-ad-policy.json').map((row) => m.mapAdPolicyIssue(row, CID))
    expect(issues[2]).toBeNull()
    expect(issues[0]).toEqual({
      customerId: '1234567890', kind: 'AD', entityKey: '71111111111~81111111111', campaignId: '11111111111', adGroupId: '71111111111', adId: '81111111111',
      adType: 'RESPONSIVE_SEARCH_AD', itemId: null, label: null, status: 'DISAPPROVED', reviewStatus: 'REVIEWED', reasons: ['DESTINATION_NOT_WORKING'],
    })
    expect(issues[1]).toMatchObject({ status: 'APPROVED_LIMITED', reasons: ['TRADEMARKS_IN_AD_TEXT'] })
  })

  it('product status: not eligible and limited products, the item id in lower case, Google\'s issues as sent', () => {
    const issues = rows<GoogleAdsShoppingProductRow>('search-shopping-products.json').map((row) => m.mapShoppingProductIssue(row, CID))
    expect(issues[2]).toBeNull()
    expect(issues[0]).toEqual({
      customerId: '1234567890', kind: 'PRODUCT', entityKey: '5555555555~ONLINE~it~IT~test-sku-1', campaignId: null, adGroupId: null, adId: null, adType: null,
      itemId: 'test-sku-1', label: 'Test helmet, size M', status: 'NOT_ELIGIBLE', reviewStatus: null, reasons: [],
      issues: [{ errorCode: 'missing_gtin', adsSeverity: 'NOT_ELIGIBLE', attributeName: 'gtin', description: 'Missing value [gtin]',
        detail: 'Add a GTIN for this product.', documentation: 'https://support.example.com/gtin', affectedRegions: ['IT'] }],
    })
    expect(issues[1]).toMatchObject({ status: 'ELIGIBLE_LIMITED', itemId: 'test-sku-2', issues: [{ errorCode: 'image_too_small', affectedRegions: ['IT', 'SM'] }] })
  })

  it('auto-apply: the type, its status and Google\'s times (the account\'s wall clock)', () => {
    const subs = rows<GoogleAdsRecommendationSubscriptionRow>('search-auto-apply.json').map((row) => m.mapAutoApply(row, { ...CID, timeZone: ROME }))
    expect(subs).toEqual([
      { customerId: '1234567890', type: 'KEYWORD', status: 'ENABLED', createdAtGoogle: new Date('2026-09-01T08:00:00Z'), modifiedAtGoogle: new Date('2026-09-15T07:30:00Z') },
      { customerId: '1234567890', type: 'CAMPAIGN_BUDGET', status: 'PAUSED', createdAtGoogle: new Date('2026-08-20T06:00:00Z'), modifiedAtGoogle: null },
    ])
  })
})

describe('step 1b: structure', () => {
  it('ad groups: bids as micros, ROAS as text, search term matching', () => {
    const [helmets, gloves] = rows<GoogleAdsAdGroupRow>('search-ad-groups.json').map((row) => m.mapAdGroup(row, CID))
    expect(helmets).toEqual({
      customerId: '1234567890', campaignId: '11111111111', adGroupId: '71111111111', name: 'Test helmets', status: 'ENABLED', type: 'SEARCH_STANDARD',
      primaryStatus: 'ELIGIBLE', primaryStatusReasons: [], cpcBidMicros: 650_000n, targetCpaMicros: null, targetRoas: null, searchTermMatchingDisabled: true,
    })
    expect(gloves).toMatchObject({ status: 'PAUSED', cpcBidMicros: null, targetCpaMicros: 4_000_000n, targetRoas: '3.5000', primaryStatusReasons: ['AD_GROUP_PAUSED'], searchTermMatchingDisabled: false })
  })

  it('keywords and ad-group negatives: negative always set, a negative has no bid or quality', () => {
    const [phrase, exact, negative] = rows<GoogleAdsAdGroupCriterionRow>('search-keywords.json').map((row) => m.mapAdGroupKeyword(row, CID))
    expect(phrase).toEqual({
      customerId: '1234567890', level: 'AD_GROUP', parentKey: 'ag:71111111111', criterionId: '91111', campaignId: '11111111111', adGroupId: '71111111111',
      sharedSetId: null, negative: false, criterionType: 'KEYWORD', text: 'test helmet', matchType: 'PHRASE', status: 'ENABLED', cpcBidMicros: 700_000n,
      effectiveCpcBidMicros: 700_000n, qualityScore: 7, systemServingStatus: 'ELIGIBLE', approvalStatus: 'APPROVED', primaryStatus: 'ELIGIBLE',
    })
    expect(exact).toMatchObject({ negative: false, status: 'PAUSED', cpcBidMicros: null, effectiveCpcBidMicros: 650_000n, qualityScore: null })
    expect(negative).toMatchObject({ negative: true, matchType: 'BROAD', cpcBidMicros: null, effectiveCpcBidMicros: null, qualityScore: null, approvalStatus: null })
  })

  it('campaign negatives and a brand list', () => {
    const [keyword, brand] = rows<GoogleAdsCampaignCriterionRow>('search-campaign-negatives.json').map((row) => m.mapCampaignNegative(row, CID))
    expect(keyword).toMatchObject({ level: 'CAMPAIGN', parentKey: 'c:11111111111', criterionId: '92111', negative: true, criterionType: 'KEYWORD', text: 'test used', matchType: 'PHRASE', status: 'ENABLED' })
    expect(brand).toMatchObject({ level: 'CAMPAIGN', parentKey: 'c:22222222222', criterionId: '92112', negative: true, criterionType: 'BRAND_LIST', text: null, matchType: null })
    expect(m.mapCampaignNegative({ campaign: { id: '1' }, campaignCriterion: { criterionId: '2', type: 'LOCATION', negative: true } }, CID)).toBeNull()
  })

  it('asset groups', () => {
    expect(m.mapAssetGroup(rows<GoogleAdsAssetGroupRow>('search-asset-groups.json')[0], CID)).toEqual({
      customerId: '1234567890', campaignId: '22222222222', assetGroupId: '61111111111', name: 'Test asset group', status: 'ENABLED', primaryStatus: 'ELIGIBLE',
      primaryStatusReasons: ['ASSET_GROUP_UNDER_REVIEW'], adStrength: 'GOOD', finalUrls: ['https://shop.example.com/helmets'],
    })
  })
})

describe('step 1b: negative keyword lists and recommendations', () => {
  it('a list\'s keywords and attachments, with the list when sent; other shared sets are not negative keyword lists', () => {
    const [free] = rows<GoogleAdsSharedCriterionRow>('search-negative-list-keywords.json').map((row) => m.mapListKeyword(row, CID))
    expect(free).toEqual({
      keyword: { customerId: '1234567890', level: 'LIST', parentKey: 'l:66666666666', criterionId: '93111', campaignId: null, adGroupId: null, sharedSetId: '66666666666',
        negative: true, criterionType: 'KEYWORD', text: 'test free', matchType: 'BROAD', status: null, cpcBidMicros: null, effectiveCpcBidMicros: null,
        qualityScore: null, systemServingStatus: null, approvalStatus: null, primaryStatus: null },
      set: { sharedSetId: '66666666666', name: 'Test negative list', type: 'NEGATIVE_KEYWORDS', status: 'ENABLED', memberCount: 2 },
    })
    // Without shared_set.* (the twin query): the keyword, no list details.
    expect(m.mapListKeyword({ sharedCriterion: { sharedSet: 'customers/1234567890/sharedSets/66666666666', criterionId: '93111', type: 'KEYWORD', keyword: { text: 'test free' } } }, CID)?.set).toBeNull()
    const attachments = rows<GoogleAdsCampaignSharedSetRow>('search-negative-list-attachments.json').map((row) => m.mapListAttachment(row))
    expect(attachments.map((a) => a && [a.campaignId, a.sharedSetId])).toEqual([['11111111111', '66666666666'], ['33333333333', '66666666666'], null])
    expect(m.mapListAttachment({ campaignSharedSet: { campaign: 'customers/1/campaigns/2', sharedSet: 'customers/1/sharedSets/3', status: 'REMOVED' } })).toBeNull()
  })

  it('recommendations: dismissed always set, the impact as sent (micros as text), none when not read', () => {
    const [keyword, budget] = rows<GoogleAdsRecommendationRow>('search-recommendations.json').map((row) => m.mapRecommendation(row, { ...CID, impactRead: true }))
    expect(keyword).toEqual({
      customerId: '1234567890', resourceName: 'customers/1234567890/recommendations/test-rec-1', type: 'KEYWORD', campaignId: '11111111111', adGroupId: '71111111111',
      dismissed: false,
      impact: { base: { impressions: 1000, clicks: 40, costMicros: '28000000', conversions: 2, conversionsValue: 180 },
        potential: { impressions: 1300, clicks: 52, costMicros: '36000000', conversions: 2.6, conversionsValue: 234 } },
    })
    expect(budget).toMatchObject({ type: 'CAMPAIGN_BUDGET', dismissed: true, adGroupId: null, impact: { base: { impressions: 500 }, potential: { impressions: 650, costMicros: '9000000' } } })
    const notRead = m.mapRecommendation(rows<GoogleAdsRecommendationRow>('search-recommendations.json')[0], { ...CID, impactRead: false })
    expect(notRead).not.toHaveProperty('impact')
    expect(notRead?.dismissed).toBe(false)
  })
})
