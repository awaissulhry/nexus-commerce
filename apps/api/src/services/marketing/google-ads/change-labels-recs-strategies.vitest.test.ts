/**
 * Google Ads changes, G5 (2026-10-15) — the pure builders and the live mappers of labels, Google's recommendations and
 * portfolio bid strategies: request + live state → the operations Google gets, what a person reads (from → to, SPENDS
 * MONEY), what it stands on and what undo needs. Ids and names are made up.
 */
import { describe, expect, it } from 'vitest'
import { labelChangeDraft, labelRecordAfterRun, labelRemoveDraft, type LabelLiveState } from './change-labels.js'
import { applyDraft, autoApplyDraft, dismissDraft, type ApplyLiveState } from './change-recommendations.js'
import { strategyChangeDraft, strategyRecordAfterRun, strategyRemoveDraft, type StrategyLiveState } from './change-strategies.js'
import { liveLabelLinkOf } from './live-labels.js'
import { liveRecommendationOf, liveRecommendationsQuery, type LiveRecommendation } from './live-recommendations.js'
import { liveStrategyCampaignsQuery, liveStrategyOf, type LiveStrategy } from './live-strategies.js'
import type { GoogleChangeDraft } from './change-draft.js'
import type { LiveBudget, LiveCampaign } from './live.js'

const CUSTOMER = 'customers/1234567890'
const draft = (out: GoogleChangeDraft | { refusal: string }): GoogleChangeDraft => {
  if ('refusal' in out) throw new Error(`refused: ${out.refusal}`)
  return out
}
const refusal = (out: GoogleChangeDraft | { refusal: string }): string => ('refusal' in out ? out.refusal : 'NOT REFUSED')

const campaign = (id: string, name: string, status = 'ENABLED', budget: LiveCampaign['budget'] = null): LiveCampaign => ({
  campaignId: id, name, status, servingStatus: null, primaryStatus: null, type: 'SEARCH', subType: null, bidding: 'MANUAL_CPC', start: null, end: null, shopping: null, budget,
})

// ── labels ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe('labels', () => {
  const live = (): LabelLiveState => ({
    labels: [{ labelId: '61', name: 'Brand', color: '#ff0000', description: null }, { labelId: '62', name: 'Test', color: null, description: 'old' }],
    links: [{ labelId: '61', kind: 'campaign', id: '21', name: 'Search A' }, { labelId: '61', kind: 'keyword', id: '51~601', name: 'shoes' }],
    campaigns: [campaign('21', 'Search A'), campaign('22', 'Search B', 'PAUSED')],
    items: [
      { kind: 'keyword', id: '51~602', name: 'boots (EXACT)', status: 'ENABLED', campaignId: '21', campaignName: 'Search A', campaignStatus: 'ENABLED', adGroupStatus: 'ENABLED', negative: false },
      { kind: 'keyword', id: '51~603', name: 'free (PHRASE, negative)', status: 'ENABLED', campaignId: '21', campaignName: 'Search A', campaignStatus: 'ENABLED', adGroupStatus: 'ENABLED', negative: true },
      { kind: 'ad', id: '51~701', name: 'ad 701 (RESPONSIVE_SEARCH_AD)', status: 'ENABLED', campaignId: '21', campaignName: 'Search A', campaignStatus: 'ENABLED', adGroupStatus: 'ENABLED' },
    ],
  })

  it('makes a label and puts it on items in ONE request (temporary id); nothing spends; it says rules may act on labels', () => {
    const out = draft(labelChangeDraft(CUSTOMER, {
      create: [{ name: 'Promo', color: '#00ff00' }],
      attach: [{ newLabel: 'Promo', kind: 'campaign', id: '22' }, { labelId: '61', kind: 'ad', id: '51~701' }, { labelId: '61', kind: 'campaign', id: '21' }],
    }, live()))
    expect(out.operations).toEqual([
      { labelOperation: { create: { resourceName: `${CUSTOMER}/labels/-1`, name: 'Promo', textLabel: { backgroundColor: '#00ff00' } } } },
      { campaignLabelOperation: { create: { campaign: `${CUSTOMER}/campaigns/22`, label: `${CUSTOMER}/labels/-1` } } },
      { adGroupAdLabelOperation: { create: { adGroupAd: `${CUSTOMER}/adGroupAds/51~701`, label: `${CUSTOMER}/labels/61` } } },
    ])
    expect(out.skipped).toEqual(['campaign "Search A" already carries "Brand".'])
    expect(out.spendsMoney).toEqual([])
    expect(out.warnings[0]).toMatch(/rule or script inside Google Ads/)
    expect(out.after).toEqual({ created: [{ labelId: 'new:0', name: 'Promo' }], edited: [], attached: [{ labelId: 'new:0', kind: 'campaign', id: '22' }, { labelId: '61', kind: 'ad', id: '51~701' }], detached: [] })
    // After the run, the new label's id comes from Google's first result.
    expect(labelRecordAfterRun(out.after as never, [{ labelResult: { resourceName: `${CUSTOMER}/labels/77` } }, {}, {}]).attached[0]).toEqual({ labelId: '77', kind: 'campaign', id: '22' })
  })

  it('edits only what changes; "" clears a description (in the mask, not in the body)', () => {
    const out = draft(labelChangeDraft(CUSTOMER, { edit: [{ labelId: '62', name: 'Tested', description: '' }, { labelId: '61', color: '#FF0000' }] }, live()))
    expect(out.operations).toEqual([{ labelOperation: { update: { resourceName: `${CUSTOMER}/labels/62`, name: 'Tested' }, updateMask: 'name,text_label.description' } }])
    expect(out.skipped).toEqual(['Label "Brand" already reads so.'])
    expect(out.before).toMatchObject({ edited: [{ labelId: '62', name: 'Test', description: 'old', color: null }] })
    expect(out.after).toMatchObject({ edited: [{ labelId: '62', name: 'Tested', description: null, color: null }] })
  })

  it('takes a label off by its link\'s resource name; a link that is not there is skipped', () => {
    const out = draft(labelChangeDraft(CUSTOMER, { detach: [{ labelId: '61', kind: 'keyword', id: '51~601' }, { labelId: '62', kind: 'campaign', id: '21' }] }, live()))
    expect(out.operations).toEqual([{ adGroupCriterionLabelOperation: { remove: `${CUSTOMER}/adGroupCriterionLabels/51~601~61` } }])
    expect(out.skipped).toEqual(['campaign 21 does not carry "Test".'])
  })

  it('refuses what Google would refuse, in words', () => {
    expect(refusal(labelChangeDraft(CUSTOMER, { create: [{ name: 'brand' }] }, live()))).toMatch(/already exists/)
    expect(refusal(labelChangeDraft(CUSTOMER, { attach: [{ labelId: '61', kind: 'keyword', id: '51~603' }] }, live()))).toMatch(/negative keyword: Google cannot put a label/)
    expect(refusal(labelChangeDraft(CUSTOMER, { attach: [{ labelId: '99', kind: 'campaign', id: '21' }] }, live()))).toMatch(/Label 99 is not in this account.*"Brand" \(61\)/)
    expect(refusal(labelChangeDraft(CUSTOMER, { attach: [{ labelId: '61', kind: 'keyword', id: '601' }] }, live()))).toMatch(/not a keyword id/)
    expect(refusal(labelChangeDraft(CUSTOMER, { attach: [{ labelId: '61', kind: 'ad-group', id: '59' }] }, live()))).toMatch(/ad group 59 is not in this account/)
    expect(refusal(labelChangeDraft(CUSTOMER, { create: [{ name: 'X', color: 'red' }] }, live()))).toMatch(/#rrggbb/)
  })

  it('a removal names what carries each label and cannot be undone', () => {
    const out = draft(labelRemoveDraft(CUSTOMER, ['61'], live()))
    expect(out.operations).toEqual([{ labelOperation: { remove: `${CUSTOMER}/labels/61` } }])
    expect(out.changes).toEqual({ 'label "Brand"': { from: 'on 1 campaign, 1 keyword', to: 'REMOVED' } })
    expect(out.warnings[0]).toMatch(/cannot be undone/)
    expect(out.spendsMoney).toEqual([])
  })

  it('maps a link row to the ids the tools take', () => {
    expect(liveLabelLinkOf('ad', { label: { id: '61' }, adGroup: { id: '51' }, adGroupAd: { ad: { id: '701' } } })).toEqual({ labelId: '61', kind: 'ad', id: '51~701', name: 'ad 701' })
    expect(liveLabelLinkOf('keyword', { label: { id: '61' }, adGroup: { id: '51' }, adGroupCriterion: { criterionId: '601', keyword: { text: 'shoes' } } })).toEqual({ labelId: '61', kind: 'keyword', id: '51~601', name: 'shoes' })
  })
})

// ── recommendations ─────────────────────────────────────────────────────────────────────────────────────────────

const rec = (over: Partial<LiveRecommendation>): LiveRecommendation => ({
  recommendationId: 'r-1', resourceName: `${CUSTOMER}/recommendations/r-1`, type: 'CAMPAIGN_BUDGET', dismissed: false, campaignId: '21', adGroupId: null,
  budgetId: '11', impact: null, budget: null, excessBudgetId: null, keyword: null, targetCpaCents: null, targetRoas: null, adjustment: null,
  requiredBudgetCents: null, broadMatchKeywords: null, ...over,
})
const BUDGET: LiveBudget = { budgetId: '11', name: 'Budget A', amountCents: 1000, shared: false, deliveryMethod: 'STANDARD', period: 'DAILY', usedBy: 1, campaigns: [{ campaignId: '21', name: 'Search A', status: 'ENABLED' }] }

describe('apply recommendations', () => {
  const live = (recommendations: LiveRecommendation[], over: Partial<ApplyLiveState> = {}): ApplyLiveState => ({
    recommendations, detailsRead: true, campaigns: [campaign('21', 'Search A', 'ENABLED', { budgetId: '11', name: 'Budget A', amountCents: 1000, shared: false })], budgets: [BUDGET], ...over,
  })

  it('a budget raise is SPENDS MONEY; the record keeps the old and new daily amounts (undo sets the old one again)', () => {
    const out = draft(applyDraft(CUSTOMER, 'EUR', { items: [{ recommendationId: 'r-1' }] }, live([rec({ budget: { currentCents: 1000, recommendedCents: 1800 }, impact: { base: { costCents: 7000, clicks: 10, impressions: 100, conversions: 1 }, potential: { costCents: 9000, clicks: 14, impressions: 140, conversions: 1.5 } } })])))
    expect(out.operations).toEqual([{ resourceName: `${CUSTOMER}/recommendations/r-1` }])
    expect(out.spendsMoney).toEqual([
      'Raises the daily budget "Budget A" from EUR 10.00 to EUR 18.00 (1 enabled campaign on it).',
      'Google estimates the weekly cost of campaign "Search A" goes from EUR 70.00 to EUR 90.00 (Google\'s estimate).',
    ])
    expect(out.before).toEqual({ applied: [{ recommendationId: 'r-1', type: 'CAMPAIGN_BUDGET', campaignId: '21', budgetId: '11', budgetCents: 1000 }] })
    expect(out.after).toEqual({ applied: [{ recommendationId: 'r-1', type: 'CAMPAIGN_BUDGET', campaignId: '21', budgetId: '11', budgetCents: 1800 }] })
    expect(out.warnings).toContain('Google cannot un-apply a recommendation; undo here sets the old daily amount again.')
    // Google's estimates move: they are not part of what the run stands on.
    expect(JSON.stringify(out.stands)).not.toMatch(/costCents/)
  })

  it('your own amount goes in campaign_budget; a lower amount spends nothing more', () => {
    const out = draft(applyDraft(CUSTOMER, 'EUR', { items: [{ recommendationId: 'r-1', budgetCents: 900 }] }, live([rec({ budget: { currentCents: 1000, recommendedCents: 1800 } })])))
    expect(out.operations).toEqual([{ resourceName: `${CUSTOMER}/recommendations/r-1`, campaignBudget: { newBudgetAmountMicros: '9000000' } }])
    expect(out.spendsMoney).toEqual([])
    expect(out.changes).toEqual({ 'budget "Budget A" (campaign "Search A")': { from: 'EUR 10.00 a day', to: 'daily budget EUR 9.00 (your amount)' } })
  })

  it('a keyword with your match type and bid: the ad group is the recommendation\'s; Google adds it enabled — SPENDS MONEY', () => {
    const out = draft(applyDraft(CUSTOMER, 'EUR', { items: [{ recommendationId: 'r-2', matchType: 'EXACT', bidCents: 45 }] }, live([rec({ recommendationId: 'r-2', resourceName: `${CUSTOMER}/recommendations/r-2`, type: 'KEYWORD', budgetId: null, adGroupId: '51', keyword: { text: 'trail boots', matchType: 'BROAD', bidCents: 60 } })])))
    expect(out.operations).toEqual([{ resourceName: `${CUSTOMER}/recommendations/r-2`, keyword: { adGroup: `${CUSTOMER}/adGroups/51`, matchType: 'EXACT', cpcBidMicros: '450000' } }])
    expect(out.spendsMoney[0]).toBe('Keyword on campaign "Search A": adds the keyword Google suggests (Google adds it ENABLED) ("trail boots" EXACT, max CPC EUR 0.45).')
    expect(out.warnings.at(-1)).toMatch(/Nexus cannot put this one back/)
  })

  it('refuses: two types in one request, a type that makes campaigns, an override the type does not take, a recommendation Google withdrew', () => {
    const two = [rec({}), rec({ recommendationId: 'r-2', resourceName: `${CUSTOMER}/recommendations/r-2`, type: 'KEYWORD', budgetId: null })]
    expect(refusal(applyDraft(CUSTOMER, 'EUR', { items: [{ recommendationId: 'r-1' }, { recommendationId: 'r-2' }] }, live(two)))).toMatch(/one type of recommendation per request/)
    expect(refusal(applyDraft(CUSTOMER, 'EUR', { items: [{ recommendationId: 'r-1' }] }, live([rec({ type: 'PERFORMANCE_MAX_OPT_IN' })])))).toMatch(/Nexus does not apply.*paused/)
    expect(refusal(applyDraft(CUSTOMER, 'EUR', { items: [{ recommendationId: 'r-1' }] }, live([rec({ type: 'SHOPPING_ADD_GTIN' })])))).toMatch(/does not say what applying it changes/)
    expect(refusal(applyDraft(CUSTOMER, 'EUR', { items: [{ recommendationId: 'r-1', targetRoas: 3 }] }, live([rec({})])))).toMatch(/takes budgetCents \(not targetRoas\)/)
    expect(refusal(applyDraft(CUSTOMER, 'EUR', { items: [{ recommendationId: 'r-9' }] }, live([rec({})])))).toMatch(/applied, replaced or withdrew it/)
  })

  it('bidding handed to Google is SPENDS MONEY, with a note when the campaign is paused', () => {
    const out = draft(applyDraft(CUSTOMER, 'EUR', { items: [{ recommendationId: 'r-1', targetCpaCents: 1200 }] }, live([rec({ type: 'TARGET_CPA_OPT_IN', budgetId: null, targetCpaCents: 1500 })], { campaigns: [campaign('21', 'Search A', 'PAUSED')] })))
    expect(out.operations).toEqual([{ resourceName: `${CUSTOMER}/recommendations/r-1`, targetCpaOptIn: { targetCpaMicros: '12000000' } }])
    expect(out.spendsMoney[0]).toMatch(/^Target CPA opt in on campaign "Search A": switches the campaign to Target CPA bidding.*target CPA EUR 12.00\) \(the campaign is paused: nothing spends until it is enabled\)\.$/)
  })

  it('moving unused budget is SPENDS MONEY; your amount goes in move_unused_budget', () => {
    const out = draft(applyDraft(CUSTOMER, 'EUR', { items: [{ recommendationId: 'r-1', budgetCents: 300 }] }, live([rec({ type: 'MOVE_UNUSED_BUDGET', excessBudgetId: '12', budget: { currentCents: 1000, recommendedCents: 1500 } })])))
    expect(out.operations).toEqual([{ resourceName: `${CUSTOMER}/recommendations/r-1`, moveUnusedBudget: { budgetMicrosToMove: '3000000' } }])
    expect(out.spendsMoney).toEqual(['Move unused budget on campaign "Search A": moves unused daily budget from another budget to this campaign\'s budget (taken from budget 12, EUR 3.00 a day moved).'])
  })

  it('dismiss: one type per request, an already dismissed one is skipped, nothing spends', () => {
    const out = draft(dismissDraft({ recommendationIds: ['r-1', 'r-2'] }, { recommendations: [rec({}), rec({ recommendationId: 'r-2', dismissed: true })], campaigns: [campaign('21', 'Search A')] }))
    expect(out.operations).toEqual([{ resourceName: `${CUSTOMER}/recommendations/r-1` }])
    expect(out.skipped).toEqual(['Recommendation r-2 (campaign budget) is already dismissed.'])
    expect(out.spendsMoney).toEqual([])
  })

  it('auto-apply: a new setting is created, an old one updated; ON for a type that spends is SPENDS MONEY', () => {
    const out = draft(autoApplyDraft(CUSTOMER, { types: [{ type: 'KEYWORD', status: 'ENABLED' }, { type: 'SET_TARGET_CPA', status: 'PAUSED' }, { type: 'OPTIMIZE_AD_ROTATION', status: 'PAUSED' }] }, { subscriptions: [{ type: 'SET_TARGET_CPA', status: 'ENABLED' }] }))
    expect(out.operations).toEqual([
      { recommendationSubscriptionOperation: { create: { type: 'KEYWORD', status: 'ENABLED' } } },
      { recommendationSubscriptionOperation: { update: { resourceName: `${CUSTOMER}/recommendationSubscriptions/SET_TARGET_CPA`, status: 'PAUSED' }, updateMask: 'status' } },
    ])
    expect(out.skipped).toEqual(['Auto-apply of optimize ad rotation is already off.'])
    expect(out.spendsMoney).toEqual(['Lets Google apply its keyword recommendations BY ITSELF from now, with no person approving each: it adds the keyword Google suggests (Google adds it ENABLED).'])
    expect(out.before).toEqual({ types: [{ type: 'KEYWORD', status: null }, { type: 'SET_TARGET_CPA', status: 'ENABLED' }] })
    expect(refusal(autoApplyDraft(CUSTOMER, { types: [{ type: 'CAMPAIGN_BUDGET', status: 'ENABLED' }] }, { subscriptions: [] }))).toMatch(/does not auto-apply campaign budget/)
  })

  it('maps a recommendation with its details; the query names them by resource name', () => {
    const r = liveRecommendationOf({ recommendation: {
      resourceName: `${CUSTOMER}/recommendations/r-3`, type: 'MOVE_UNUSED_BUDGET', campaign: `${CUSTOMER}/campaigns/21`, campaignBudget: `${CUSTOMER}/campaignBudgets/11`,
      moveUnusedBudgetRecommendation: { excessCampaignBudget: `${CUSTOMER}/campaignBudgets/12`, budgetRecommendation: { currentBudgetAmountMicros: '10000000', recommendedBudgetAmountMicros: '12000000' } },
      impact: { baseMetrics: { costMicros: '5000000' }, potentialMetrics: { costMicros: '6000000', clicks: 3 } },
    } })
    expect(r).toMatchObject({ recommendationId: 'r-3', campaignId: '21', budgetId: '11', excessBudgetId: '12', budget: { currentCents: 1000, recommendedCents: 1200 }, impact: { base: { costCents: 500 }, potential: { costCents: 600, clicks: 3 } } })
    expect(liveRecommendationsQuery([`${CUSTOMER}/recommendations/r-3`], false)).toBe(
      'SELECT recommendation.resource_name, recommendation.type, recommendation.dismissed, recommendation.campaign, recommendation.ad_group, '
      + `recommendation.campaign_budget FROM recommendation WHERE recommendation.resource_name IN ('${CUSTOMER}/recommendations/r-3')`,
    )
  })
})

// ── portfolio bid strategies ────────────────────────────────────────────────────────────────────────────────────

describe('portfolio bid strategies', () => {
  const strategy = (over: Partial<LiveStrategy>): LiveStrategy => ({
    strategyId: '81', name: 'Strategy A', type: 'TARGET_CPA', scheme: 'TARGET_CPA', campaignCount: 1, currency: 'EUR',
    targetCpaCents: 900, targetRoas: null, maxCpcCents: 80, minCpcCents: null, location: null, impressionSharePercent: null, ...over,
  })
  const live = (over: Partial<StrategyLiveState> = {}): StrategyLiveState => ({
    strategies: [strategy({}), strategy({ strategyId: '82', name: 'Strategy B', type: 'TARGET_SPEND', scheme: 'MAXIMIZE_CLICKS', campaignCount: 0, targetCpaCents: null, maxCpcCents: null })],
    campaigns: [{ strategyId: '81', campaignId: '21', name: 'Search A', status: 'ENABLED' }],
    ...over,
  })

  it('makes a strategy with its scheme (nothing uses it: no money), and refuses a scheme without what it needs', () => {
    const out = draft(strategyChangeDraft(CUSTOMER, 'EUR', { create: { name: 'Top', scheme: 'TARGET_IMPRESSION_SHARE', location: 'ABSOLUTE_TOP_OF_PAGE', impressionSharePercent: 70, maxCpcCents: 150 } }, live()))
    expect(out.operations).toEqual([{ biddingStrategyOperation: { create: { resourceName: `${CUSTOMER}/biddingStrategies/-1`, name: 'Top', targetImpressionShare: { cpcBidCeilingMicros: '1500000', location: 'ABSOLUTE_TOP_OF_PAGE', locationFractionMicros: '700000' } } } }])
    expect(out.spendsMoney).toEqual([])
    expect(out.warnings[0]).toMatch(/spends nothing until a campaign is put on it/)
    expect(strategyRecordAfterRun(out.after as never, [{ biddingStrategyResult: { resourceName: `${CUSTOMER}/biddingStrategies/88` } }]).created).toEqual({ strategyId: '88', name: 'Top', scheme: 'TARGET_IMPRESSION_SHARE' })
    expect(refusal(strategyChangeDraft(CUSTOMER, 'EUR', { create: { name: 'X', scheme: 'TARGET_CPA' } }, live()))).toMatch(/Target CPA needs a target CPA/)
    expect(refusal(strategyChangeDraft(CUSTOMER, 'EUR', { create: { name: 'strategy a', scheme: 'MAXIMIZE_CLICKS' } }, live()))).toMatch(/already exists/)
  })

  it('a higher target CPA and a max CPC taken off, on a strategy an enabled campaign uses, are SPENDS MONEY; null clears through the mask', () => {
    const out = draft(strategyChangeDraft(CUSTOMER, 'EUR', { change: [{ strategyId: '81', targetCpaCents: 1200, maxCpcCents: null, name: 'Strategy A2' }] }, live()))
    expect(out.operations).toEqual([{ biddingStrategyOperation: {
      update: { resourceName: `${CUSTOMER}/biddingStrategies/81`, name: 'Strategy A2', targetCpa: { targetCpaMicros: '12000000' } },
      updateMask: 'name,target_cpa.target_cpa_micros,target_cpa.cpc_bid_ceiling_micros',
    } }])
    expect(out.spendsMoney).toEqual([
      'Raises the target CPA of "Strategy A" from EUR 9.00 to EUR 12.00 (1 enabled campaign uses it).',
      'Takes the max CPC of "Strategy A" off: Google bids with no such limit (1 enabled campaign uses it).',
    ])
    expect(out.before).toEqual({ strategies: [{ strategyId: '81', name: 'Strategy A', targetCpaCents: 900, maxCpcCents: 80 }] })
    expect(out.after).toEqual({ strategies: [{ strategyId: '81', name: 'Strategy A2', targetCpaCents: 1200, maxCpcCents: null }] })
  })

  it('a lower target CPA spends nothing more; a setting the scheme does not take is refused', () => {
    expect(draft(strategyChangeDraft(CUSTOMER, 'EUR', { change: [{ strategyId: '81', targetCpaCents: 700 }] }, live())).spendsMoney).toEqual([])
    expect(refusal(strategyChangeDraft(CUSTOMER, 'EUR', { change: [{ strategyId: '82', targetRoas: 3 }] }, live()))).toMatch(/Maximize clicks takes max CPC \(not target ROAS\)/)
    expect(refusal(strategyChangeDraft(CUSTOMER, 'EUR', { change: [{ strategyId: '81', targetCpaCents: null }] }, live()))).toMatch(/needs a target CPA/)
  })

  it('a strategy in use is never removed (its campaigns are named); an unused one is, for good', () => {
    expect(refusal(strategyRemoveDraft(CUSTOMER, 'EUR', ['81'], live()))).toMatch(/used by 1 campaign \("Search A"\)/)
    const out = draft(strategyRemoveDraft(CUSTOMER, 'EUR', ['82'], live()))
    expect(out.operations).toEqual([{ biddingStrategyOperation: { remove: `${CUSTOMER}/biddingStrategies/82` } }])
    expect(out.warnings[0]).toMatch(/cannot be undone/)
  })

  it('maps a strategy row; the campaigns query names the strategies by resource name', () => {
    expect(liveStrategyOf({ biddingStrategy: { id: '83', name: 'Top', type: 'TARGET_IMPRESSION_SHARE', nonRemovedCampaignCount: '2', targetImpressionShare: { location: 'TOP_OF_PAGE', locationFractionMicros: '650000', cpcBidCeilingMicros: '1200000' } } }))
      .toMatchObject({ strategyId: '83', scheme: 'TARGET_IMPRESSION_SHARE', campaignCount: 2, location: 'TOP_OF_PAGE', impressionSharePercent: 65, maxCpcCents: 120 })
    expect(liveStrategyCampaignsQuery(CUSTOMER, ['81'])).toBe(
      `SELECT campaign.id, campaign.name, campaign.status, campaign.bidding_strategy FROM campaign WHERE campaign.bidding_strategy IN ('${CUSTOMER}/biddingStrategies/81') AND campaign.status != 'REMOVED'`,
    )
  })
})
