/**
 * Google Ads changes (2026-10-15) — the live reads' queries (ids checked before anything is sent; change history needs a
 * day and a LIMIT) and how Google's rows read (Shopping priority 0/1/2, a product group's parent, value and "everything
 * else", micros → cents, the location option, audiences that only observe).
 */
import { describe, expect, it } from 'vitest'
import {
  centsOfMicros, liveAdOf, liveAssetOf, liveAssetsQuery, liveCampaignOf, liveChangeHistoryQuery, liveCriterionOf, liveListKeywordsQuery, liveProductGroupOf,
  liveProductGroupsQuery, microsOfCents, priorityName,
} from './live.js'

describe('live queries', () => {
  it('ids are digits or nothing is sent', () => {
    expect(liveProductGroupsQuery('1001')).toContain('WHERE campaign.id = 1001 AND ad_group_criterion.type = \'LISTING_GROUP\'')
    expect(() => liveProductGroupsQuery('1 OR 1=1')).toThrow(/Nothing was sent/)
    expect(() => liveListKeywordsQuery('abc')).toThrow(/Nothing was sent/)
  })

  it('assets: campaign.status is selected, because Google refuses the filter on it otherwise', () => {
    expect(liveAssetsQuery('1001')).toMatch(/^SELECT campaign\.id, campaign\.status, /)
    expect(liveAssetsQuery()).toContain("campaign.status != 'REMOVED'")
  })

  it('change history: one day, newest first, a LIMIT', () => {
    expect(liveChangeHistoryQuery('2026-10-15')).toContain("change_event.change_date_time >= '2026-10-15 00:00:00' AND change_event.change_date_time <= '2026-10-15 23:59:59' ORDER BY change_event.change_date_time DESC LIMIT 1000")
    expect(() => liveChangeHistoryQuery('15/10/2026')).toThrow(/Nothing was sent/)
  })
})

describe('live rows', () => {
  it('money: micros ↔ cents', () => {
    expect(centsOfMicros('10000000')).toBe(1000)
    expect(centsOfMicros(undefined)).toBeNull()
    expect(microsOfCents(25)).toBe('250000')
  })

  it('a Shopping campaign: priority from 0/1/2 (left out = Low), its budget', () => {
    expect(priorityName(2)).toBe('HIGH')
    const c = liveCampaignOf({
      campaign: { id: '21', name: 'Shop A', status: 'PAUSED', advertisingChannelType: 'SHOPPING', shoppingSetting: { merchantId: '5', feedLabel: 'IT' } },
      campaignBudget: { id: '11', name: 'Shared', amountMicros: '10000000', explicitlyShared: true },
    })
    expect(c).toMatchObject({ campaignId: '21', type: 'SHOPPING', shopping: { merchantId: '5', feedLabel: 'IT', priority: 'LOW' }, budget: { budgetId: '11', amountCents: 1000, shared: true } })
  })

  it('a product group: its parent, its value, "everything else" (no value) and excluded', () => {
    const item = liveProductGroupOf({
      adGroup: { id: '51' },
      adGroupCriterion: { criterionId: '602', status: 'ENABLED', cpcBidMicros: '250000', listingGroup: { type: 'UNIT', parentAdGroupCriterion: 'customers/1/adGroupCriteria/51~601', caseValue: { productItemId: { value: 'shopify_it_1_2' } } } },
    })
    expect(item).toMatchObject({ adGroupId: '51', criterionId: '602', parentId: '601', kind: 'UNIT', dimension: 'productItemId', value: 'shopify_it_1_2', everythingElse: false, excluded: false, bidCents: 25 })
    const rest = liveProductGroupOf({ adGroup: { id: '51' }, adGroupCriterion: { criterionId: '603', negative: true, listingGroup: { type: 'UNIT', parentAdGroupCriterion: 'customers/1/adGroupCriteria/51~601', caseValue: { productItemId: {} } } } })
    expect(rest).toMatchObject({ everythingElse: true, excluded: true, value: null })
    const root = liveProductGroupOf({ adGroup: { id: '51' }, adGroupCriterion: { criterionId: '601', listingGroup: { type: 'SUBDIVISION' } } })
    expect(root).toMatchObject({ parentId: null, dimension: null, everythingElse: false })
  })

  it('criteria: a schedule in hours, a location, an audience', () => {
    expect(liveCriterionOf({ campaignCriterion: { criterionId: '1', type: 'AD_SCHEDULE', adSchedule: { dayOfWeek: 'MONDAY', startHour: 8, endHour: 24, startMinute: 'ZERO', endMinute: 'ZERO' } } }).schedule)
      .toEqual({ day: 'MONDAY', from: '08:00', to: '24:00' })
    expect(liveCriterionOf({ campaignCriterion: { criterionId: '2', type: 'LOCATION', displayName: 'Italy', location: { geoTargetConstant: 'geoTargetConstants/2380' } } }))
      .toMatchObject({ name: 'Italy', location: 'geoTargetConstants/2380', negative: false })
  })

  it('an RSA and a sitelink with their review', () => {
    const ad = liveAdOf({ adGroup: { id: '51' }, adGroupAd: { status: 'PAUSED', adStrength: 'GOOD', ad: { id: '7', type: 'RESPONSIVE_SEARCH_AD', finalUrls: ['https://x.example/a'], responsiveSearchAd: { headlines: [{ text: 'H1', pinnedField: 'HEADLINE_1' }], descriptions: [{ text: 'D1' }], path1: 'jackets' } }, policySummary: { approvalStatus: 'APPROVED', reviewStatus: 'REVIEWED' } } })
    expect(ad).toMatchObject({ adId: '7', headlines: [{ text: 'H1', pinned: 'HEADLINE_1' }], descriptions: [{ text: 'D1', pinned: null }], path1: 'jackets', approval: 'APPROVED' })
    const asset = liveAssetOf({ campaign: { id: '21' }, campaignAsset: { fieldType: 'SITELINK', status: 'ENABLED' }, asset: { id: '9', type: 'SITELINK', sitelinkAsset: { linkText: 'Size guide', description1: 'a' }, finalUrls: ['https://x.example/t'], policySummary: { reviewStatus: 'UNDER_REVIEW' } } })
    expect(asset).toMatchObject({ assetId: '9', fieldType: 'SITELINK', text: 'Size guide', description1: 'a', review: 'UNDER_REVIEW' })
  })
})
