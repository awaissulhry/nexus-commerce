/**
 * Google Ads programme 2, G1 review (2026-10-15) — the product groups of a campaign with every Shopping dimension (a
 * condition node is not "everything else"), portfolio bid strategies (micros → cents, a target impression share in
 * percent) and Google's auto-apply settings.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ rows: vi.fn() }))
vi.mock('./write-client.js', () => ({ liveRows: h.rows }))

import { AUTO_APPLY_QUERY, BID_STRATEGIES_QUERY, bidStrategyOf, campaignProductGroupsQuery, liveAutoApply, liveCampaignProductGroups } from './live-views.js'

const target = { connectionId: 'g-1', customerId: '1234567890', loginCustomerId: null }
beforeEach(() => { h.rows.mockReset() })

describe('product groups of a campaign, every dimension', () => {
  it('selects every Shopping dimension and every field it filters on; the campaign is a Google id', () => {
    const q = campaignProductGroupsQuery('21')
    for (const f of ['product_condition.condition', 'product_category.category_id', 'product_channel.channel', 'product_channel_exclusivity.channel_exclusivity', 'product_item_id.value']) {
      expect(q).toContain(`ad_group_criterion.listing_group.case_value.${f}`)
    }
    const select = q.slice(7, q.indexOf(' FROM ')).split(', ')
    expect(select).toEqual(expect.arrayContaining(['campaign.id', 'ad_group.status', 'ad_group.id']))
    expect(q).toContain("WHERE campaign.id = 21 AND ad_group_criterion.type = 'LISTING_GROUP'")
    expect(() => campaignProductGroupsQuery('21 OR 1=1')).toThrow(/Nothing was sent/)
  })

  it('a condition node has its value; only a node without one is "everything else"', async () => {
    h.rows.mockResolvedValue([
      { adGroup: { id: '51', name: 'AG' }, adGroupCriterion: { criterionId: '601', listingGroup: { type: 'SUBDIVISION' } } },
      { adGroup: { id: '51' }, adGroupCriterion: { criterionId: '602', cpcBidMicros: '300000', listingGroup: { type: 'UNIT', parentAdGroupCriterion: 'customers/1/adGroupCriteria/51~601', caseValue: { productCondition: { condition: 'NEW' } } } } },
      { adGroup: { id: '51' }, adGroupCriterion: { criterionId: '603', negative: true, listingGroup: { type: 'UNIT', parentAdGroupCriterion: 'customers/1/adGroupCriteria/51~601', caseValue: { productCondition: {} } } } },
    ])
    const items = await liveCampaignProductGroups(target, '21')
    expect(items.map((i) => [i.criterionId, i.dimension, i.value, i.everythingElse, i.excluded, i.bidCents])).toEqual([
      ['601', null, null, false, false, null],
      ['602', 'productCondition', 'NEW', false, false, 30],
      ['603', 'productCondition', null, true, true, null],
    ])
    expect(items[0]).toMatchObject({ adGroupId: '51', adGroupName: 'AG', parentId: null })
  })
})

describe('bid strategies and auto-apply', () => {
  it('the queries filter only on selected fields of their own resource', () => {
    expect(BID_STRATEGIES_QUERY).toMatch(/FROM bidding_strategy WHERE bidding_strategy\.status != 'REMOVED'$/)
    expect(AUTO_APPLY_QUERY).toMatch(/FROM recommendation_subscription$/)
  })

  it('a strategy: its targets and ceilings in cents, the share it aims for in percent', () => {
    expect(bidStrategyOf({ biddingStrategy: { id: '81', name: 'Portfolio A', type: 'TARGET_ROAS', status: 'ENABLED', nonRemovedCampaignCount: '2', targetRoas: { targetRoas: 4, cpcBidCeilingMicros: '1500000' } } }))
      .toEqual({ strategyId: '81', name: 'Portfolio A', type: 'TARGET_ROAS', status: 'ENABLED', campaigns: 2, currency: null, targetCpaCents: null, targetRoas: 4, maxCpcCeilingCents: 150, cpcFloorCents: null, impressionShare: null })
    expect(bidStrategyOf({ biddingStrategy: { type: 'TARGET_IMPRESSION_SHARE', targetImpressionShare: { location: 'TOP_OF_PAGE', locationFractionMicros: '650000', cpcBidCeilingMicros: '900000' } } }))
      .toMatchObject({ impressionShare: { location: 'TOP_OF_PAGE', targetPct: 65 }, maxCpcCeilingCents: 90 })
  })

  it('auto-apply: which kinds Google applies by itself', async () => {
    h.rows.mockResolvedValue([{ recommendationSubscription: { type: 'CAMPAIGN_BUDGET', status: 'ENABLED', createDateTime: '2026-10-01 10:00:00' } }])
    expect(await liveAutoApply(target)).toEqual([{ type: 'CAMPAIGN_BUDGET', status: 'ENABLED', createdAt: '2026-10-01 10:00:00', changedAt: null }])
  })
})
