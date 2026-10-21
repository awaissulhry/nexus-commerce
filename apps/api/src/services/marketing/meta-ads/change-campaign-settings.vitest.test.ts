/**
 * Meta step 18 — set-meta-campaign as a pure draft: one request with exactly the fields that change, in Meta's units;
 * every raise, removed cap, accelerated pacing or campaign budget turned on is SPENDS MONEY (and says when the campaign
 * is off); Meta's documented limits refuse in words (more than 70 ad sets, a ROAS goal under a campaign budget, budget
 * sharing, every ad set in adset_budgets, the objective of a campaign with ad sets); undo holds the same tool's arguments
 * for what it replaced, and says what has no way back. Made-up ids.
 */
import { describe, expect, it } from 'vitest'
import { campaignReadsNeeded, campaignSettingsDraft, type CampaignSettingsLive } from './change-campaign-settings.js'
import type { LiveCampaign, LiveChildAdSet } from './live-settings.js'
import type { MetaChangeDraft } from './change-draft.js'
import type { SettingsRecord } from './change-settings-common.js'

const C = '120000000000001'
const A1 = '120000000000002'
const A2 = '120000000000004'
const campaign = (over: Partial<LiveCampaign> = {}): LiveCampaign => ({
  id: C, name: 'Campaign A', status: 'ACTIVE', effectiveStatus: 'ACTIVE', objective: 'OUTCOME_SALES', buyingType: 'AUCTION', smartPromotionType: null,
  dailyBudget: '5000', lifetimeBudget: null, spendCap: null, canUseSpendCap: true, bidStrategy: 'LOWEST_COST_WITHOUT_CAP', pacingType: ['standard'],
  promotedObject: { pixel_id: '120000000000050', custom_event_type: 'PURCHASE' }, specialAdCategories: [], specialAdCategory: 'NONE', specialAdCategoryCountry: null,
  budgetSharing: false, budgetScheduling: false, reelsTrendingAds: false, advantageState: 'ADVANTAGE_PLUS_SALES', ...over,
})
const child = (id: string, over: Partial<LiveChildAdSet> = {}): LiveChildAdSet => ({ id, name: `Ad set ${id.slice(-1)}`, status: 'ACTIVE', dailyBudget: null, lifetimeBudget: null, bidAmount: null, endTime: null, ...over })
const live = (over: Partial<CampaignSettingsLive> = {}): CampaignSettingsLive => ({
  campaign: campaign(), currency: 'EUR', adSets: [child(A1), child(A2)], adSetsMore: false, pixels: new Set(['120000000000050', '120000000000051']), ...over,
})
const ok = (d: MetaChangeDraft | { refusal: string }): MetaChangeDraft => { if ('refusal' in d) throw new Error(d.refusal); return d }
const refusal = (d: MetaChangeDraft | { refusal: string }) => ('refusal' in d ? d.refusal : null)

describe('budget', () => {
  it('a raise: one POST with daily_budget in cents, SPENDS MONEY, read back and judged; undo puts the old amount back', () => {
    const d = ok(campaignSettingsDraft({ campaignId: C, dailyBudgetCents: 7000 }, live()))
    expect(d.requests).toHaveLength(1)
    expect(d.requests[0]).toMatchObject({
      kind: 'campaign', objectId: C, params: { daily_budget: '7000' }, check: 'not-yet', raisesSpend: true, readBackInPost: true, budget: false,
      operation: 'campaign.settings', expect: { daily_budget: '7000' }, readBackFields: 'id,daily_budget',
    })
    expect(d.spendsMoney[0]).toMatch(/Raising campaign "Campaign A".*50\.00 EUR to 70\.00 EUR: the campaign is on/)
    expect((d.before as SettingsRecord).undo).toEqual({ dailyBudgetCents: 5000 })
  })
  it('a cut is safe; a paused campaign spends nothing yet (said)', () => {
    expect(ok(campaignSettingsDraft({ campaignId: C, dailyBudgetCents: 3000 }, live())).spendsMoney).toEqual([])
    const paused = ok(campaignSettingsDraft({ campaignId: C, dailyBudgetCents: 9000 }, live({ campaign: campaign({ status: 'PAUSED' }) })))
    expect(paused.spendsMoney[0]).toMatch(/nothing spends yet: the campaign is not on/)
  })
  it('the same amount is skipped, never sent', () => {
    expect(refusal(campaignSettingsDraft({ campaignId: C, dailyBudgetCents: 5000 }, live()))).toMatch(/Nothing to change: .*already 50\.00 EUR/)
  })
  it('daily → lifetime (CMP-037, unverified): sent alone, Meta decides; every ad set needs an end time', () => {
    expect(refusal(campaignSettingsDraft({ campaignId: C, lifetimeBudgetCents: 100000 }, live()))).toMatch(/needs every ad set to have an end time/)
    const d = ok(campaignSettingsDraft({ campaignId: C, lifetimeBudgetCents: 100000 }, live({ adSets: [child(A1, { endTime: '2026-12-01T00:00:00+0000' })] })))
    expect(d.requests[0].params).toEqual({ lifetime_budget: '100000' })
    expect(d.warnings.join(' ')).toMatch(/documents no such switch/)
    expect(d.spendsMoney).toHaveLength(1)
    expect((d.before as SettingsRecord).undo).toEqual({ dailyBudgetCents: 5000 })
  })
  it('campaign budget ON (CMP-039, unverified): SPENDS MONEY; undo moves the old ad set budgets back', () => {
    const l = live({ campaign: campaign({ dailyBudget: null }), adSets: [child(A1, { dailyBudget: '2000' }), child(A2, { dailyBudget: '1000' })] })
    const d = ok(campaignSettingsDraft({ campaignId: C, dailyBudgetCents: 4000 }, l))
    expect(d.warnings.join(' ')).toMatch(/documents only turning it off/)
    expect(d.spendsMoney[0]).toMatch(/replaces the ad sets' own budgets \(now 20\.00 EUR \+ 10\.00 EUR\)/)
    expect((d.before as SettingsRecord).undo).toEqual({ adSetBudgets: [{ adSetId: A1, dailyBudgetCents: 2000 }, { adSetId: A2, dailyBudgetCents: 1000 }] })
  })
  it('campaign budget OFF (CMP-038): every non-deleted ad set, same kind, ≤ 70; Advantage+ goes off (said); more in total spends', () => {
    expect(refusal(campaignSettingsDraft({ campaignId: C, adSetBudgets: [{ adSetId: A1, dailyBudgetCents: 2500 }] }, live()))).toMatch(/EVERY ad set.*missing: 120000000000004/)
    expect(refusal(campaignSettingsDraft({ campaignId: C, adSetBudgets: [{ adSetId: A1, dailyBudgetCents: 2500 }, { adSetId: A2, lifetimeBudgetCents: 2500 }] }, live()))).toMatch(/all daily or all lifetime/)
    const many = live({ adSets: Array.from({ length: 71 }, (_, i) => child(String(120000000000100 + i))) })
    expect(refusal(campaignSettingsDraft({ campaignId: C, adSetBudgets: many.adSets!.map((a) => ({ adSetId: a.id, dailyBudgetCents: 100 })) }, many))).toMatch(/more than 70/)
    const d = ok(campaignSettingsDraft({ campaignId: C, adSetBudgets: [{ adSetId: A1, dailyBudgetCents: 3000 }, { adSetId: A2, dailyBudgetCents: 3000 }] }, live()))
    expect(d.requests[0].params).toEqual({ adset_budgets: `[{"adset_id":"${A1}","daily_budget":3000},{"adset_id":"${A2}","daily_budget":3000}]` })
    expect(d.requests[0].readBackFields).toBe('id,daily_budget,lifetime_budget')
    expect(d.spendsMoney[0]).toMatch(/add up to 60\.00 EUR, against the campaign's daily 50\.00 EUR/)
    expect(d.warnings.join(' ')).toMatch(/ADVANTAGE_PLUS_SALES: moving the budgets to the ad sets turns Advantage\+ off/)
    expect((d.before as SettingsRecord).undo).toEqual({ dailyBudgetCents: 5000 })
    expect(refusal(campaignSettingsDraft({ campaignId: C, adSetBudgets: [{ adSetId: A1, dailyBudgetCents: 1 }] }, live({ campaign: campaign({ dailyBudget: null }) })))).toMatch(/has no campaign budget/)
  })
})

describe('budget sharing, bid strategy, spend cap', () => {
  it('budget sharing OFF is for good: no undo for it, said', () => {
    const d = ok(campaignSettingsDraft({ campaignId: C, budgetSharing: false }, live({ campaign: campaign({ dailyBudget: null, budgetSharing: true }) })))
    expect(d.requests[0].params).toEqual({ is_adset_budget_sharing_enabled: 'false' })
    expect(d.requests[0].undoable).toBe(false)
    expect((d.before as SettingsRecord).undo).toBeNull()
    expect(d.warnings.join(' ')).toMatch(/for good.*3858418/)
  })
  it('auto → cost cap names EVERY ad set\'s cap; back again is undo with the old caps', () => {
    expect(refusal(campaignSettingsDraft({ campaignId: C, bidStrategy: 'COST_CAP' }, live()))).toMatch(/needs each ad set's cap.*missing/)
    const d = ok(campaignSettingsDraft({ campaignId: C, bidStrategy: 'COST_CAP', adSetBidAmounts: [{ adSetId: A1, bidAmountCents: 900 }, { adSetId: A2, bidAmountCents: 800 }] }, live()))
    expect(d.requests[0].params).toEqual({ bid_strategy: 'COST_CAP', adset_bid_amounts: `{"${A1}":900,"${A2}":800}` })
    // Round 2 N4 — automatic bidding → a cap cannot raise spend: no spend line.
    expect(d.spendsMoney).toEqual([])
    expect((d.before as SettingsRecord).undo).toEqual({ bidStrategy: 'LOWEST_COST_WITHOUT_CAP' })
    const back = ok(campaignSettingsDraft({ campaignId: C, bidStrategy: 'LOWEST_COST_WITHOUT_CAP' }, live({ campaign: campaign({ bidStrategy: 'COST_CAP' }), adSets: [child(A1, { bidAmount: '900' }), child(A2, { bidAmount: '800' })] })))
    expect(back.spendsMoney[0]).toMatch(/Removing .*cost per result goal: without a cap/)
    expect((back.before as SettingsRecord).undo).toEqual({ bidStrategy: 'COST_CAP', adSetBidAmounts: [{ adSetId: A1, bidAmountCents: 900 }, { adSetId: A2, bidAmountCents: 800 }] })
  })
  it('Meta\'s limits: a ROAS goal under a campaign budget never switches away; no campaign budget → the ad set\'s; sharing on; > 70 ad sets', () => {
    expect(refusal(campaignSettingsDraft({ campaignId: C, bidStrategy: 'COST_CAP', adSetBidAmounts: [{ adSetId: A1, bidAmountCents: 1 }] }, live({ campaign: campaign({ bidStrategy: 'LOWEST_COST_WITH_MIN_ROAS' }) })))).toMatch(/cannot currently switch/)
    expect(refusal(campaignSettingsDraft({ campaignId: C, bidStrategy: 'COST_CAP' }, live({ campaign: campaign({ dailyBudget: null }) })))).toMatch(/on each ad set/)
    expect(refusal(campaignSettingsDraft({ campaignId: C, bidStrategy: 'LOWEST_COST_WITH_BID_CAP' }, live({ campaign: campaign({ budgetSharing: true }) })))).toMatch(/4834006/)
    const to = ok(campaignSettingsDraft({ campaignId: C, bidStrategy: 'LOWEST_COST_WITH_MIN_ROAS' }, live()))
    expect(to.warnings.join(' ')).toMatch(/is for good/)
    expect((to.before as SettingsRecord).noUndo?.join(' ')).toMatch(/cannot be switched/)
  })
  it('spend cap: set, raise (SPENDS), remove with Meta\'s value (SPENDS, no ceiling); a campaign that cannot have one is refused', () => {
    expect(ok(campaignSettingsDraft({ campaignId: C, spendCapCents: 20000 }, live())).requests[0]).toMatchObject({ params: { spend_cap: '20000' }, expect: { spend_cap: '20000' }, raisesSpend: false })
    const raise = ok(campaignSettingsDraft({ campaignId: C, spendCapCents: 30000 }, live({ campaign: campaign({ spendCap: '20000' }) })))
    expect(raise.spendsMoney[0]).toMatch(/Raising .*spend cap from 200\.00 EUR to 300\.00 EUR/)
    const remove = ok(campaignSettingsDraft({ campaignId: C, spendCapCents: null }, live({ campaign: campaign({ spendCap: '20000' }) })))
    expect(remove.requests[0].params).toEqual({ spend_cap: '922337203685478' })
    expect(remove.requests[0].expect).toEqual({})
    expect(remove.spendsMoney[0]).toMatch(/no ceiling/)
    expect((remove.before as SettingsRecord).undo).toEqual({ spendCapCents: 20000 })
    expect(refusal(campaignSettingsDraft({ campaignId: C, spendCapCents: 20000 }, live({ campaign: campaign({ canUseSpendCap: false }) })))).toMatch(/cannot have a spend cap/)
  })
})

describe('review A1 — each new cap against the ad set\'s bid now', () => {
  it('an ACTIVE capped campaign, an ad set cap of 1.00, a cost cap of 100.00: SPENDS MONEY, the request raises spend', () => {
    const capped = (bid: string | null) => live({ campaign: campaign({ bidStrategy: 'LOWEST_COST_WITH_BID_CAP' }), adSets: [child(A1, { bidAmount: bid })] })
    const d = ok(campaignSettingsDraft({ campaignId: C, bidStrategy: 'COST_CAP', adSetBidAmounts: [{ adSetId: A1, bidAmountCents: 10000 }] }, capped('100')))
    expect(d.spendsMoney[0]).toMatch(/ad set 120000000000002 1\.00 EUR → 100\.00 EUR — the campaign is on/)
    expect(d.requests[0].raisesSpend).toBe(true)
    // An unreadable cap on a capped ad set is said too.
    expect(ok(campaignSettingsDraft({ campaignId: C, bidStrategy: 'COST_CAP', adSetBidAmounts: [{ adSetId: A1, bidAmountCents: 100 }] }, capped(null))).spendsMoney[0]).toMatch(/had a cap Nexus could not read/)
  })
  it('round 2 N4 — automatic bidding → a cap: no spend line, whatever the amounts (a cap cannot raise spend)', () => {
    const d = ok(campaignSettingsDraft({ campaignId: C, bidStrategy: 'COST_CAP', adSetBidAmounts: [{ adSetId: A1, bidAmountCents: 10000 }] }, live({ adSets: [child(A1, { bidAmount: '100' })] })))
    expect(d.spendsMoney).toEqual([])
    expect(d.requests[0].raisesSpend).toBe(false)
  })
  it('round 2 N1 — a cap → a ROAS goal removes the cap: SPENDS MONEY', () => {
    const d = ok(campaignSettingsDraft({ campaignId: C, bidStrategy: 'LOWEST_COST_WITH_MIN_ROAS' }, live({ campaign: campaign({ bidStrategy: 'COST_CAP' }) })))
    expect(d.spendsMoney.join(' ')).toMatch(/cost per result goal of campaign "Campaign A" .* is removed for a ROAS goal/)
    expect(d.requests[0].raisesSpend).toBe(true)
  })
  it('round 2 N3 — an old name with characters Nexus does not send is not put back by undo (said)', () => {
    const d = ok(campaignSettingsDraft({ campaignId: C, name: 'Campaign B' }, live({ campaign: campaign({ name: 'Campaign \u202eA' }) })))
    expect((d.before as SettingsRecord).undo).toBeNull()
    expect((d.before as SettingsRecord).noUndo?.join(' ')).toMatch(/old name has characters/)
    expect((ok(campaignSettingsDraft({ campaignId: C, name: 'Campaign B' }, live({ campaign: campaign({ name: 'Saldi 👨‍👩‍👧' }) }))).before as SettingsRecord).undo).toEqual({ name: 'Saldi 👨‍👩‍👧' })
  })
  it('bid cap → cost cap at the SAME amount still SPENDS (a cost cap is an average); a cap kept with new amounts is set-meta-ad-set\'s', () => {
    const capped = live({ campaign: campaign({ bidStrategy: 'LOWEST_COST_WITH_BID_CAP' }), adSets: [child(A1, { bidAmount: '900' })] })
    const d = ok(campaignSettingsDraft({ campaignId: C, bidStrategy: 'COST_CAP', adSetBidAmounts: [{ adSetId: A1, bidAmountCents: 900 }] }, capped))
    expect(d.spendsMoney.join(' ')).toMatch(/AVERAGE cost near the goal, so single bids may go above the old cap/)
    expect(d.requests[0].raisesSpend).toBe(true)
    expect(refusal(campaignSettingsDraft({ campaignId: C, bidStrategy: 'LOWEST_COST_WITH_BID_CAP', adSetBidAmounts: [{ adSetId: A1, bidAmountCents: 1200 }] }, capped))).toMatch(/set-meta-ad-set bidAmountCents/)
  })
})

describe('category, promoted object, objective, pacing, the rest', () => {
  it('a special ad category needs its countries, warns about targeting and the customer goal reset', () => {
    expect(refusal(campaignSettingsDraft({ campaignId: C, specialAdCategory: 'HOUSING' }, live()))).toMatch(/countries/)
    const d = ok(campaignSettingsDraft({ campaignId: C, specialAdCategory: 'HOUSING', specialAdCategoryCountries: ['IT'] }, live()))
    expect(d.requests[0].params).toEqual({ special_ad_category: 'HOUSING', special_ad_category_country: '["IT"]' })
    expect(d.warnings.join(' ')).toMatch(/customer lifecycle goal goes back to broad/)
    // Review A3 — the reset widens who sees the ads.
    expect(d.spendsMoney[0]).toMatch(/widens its audience/)
    expect(d.requests[0].raisesSpend).toBe(true)
    expect((d.before as SettingsRecord).undo).toEqual({ specialAdCategory: 'NONE' })
  })
  it('a promoted object is sent whole (Meta replaces it), with the account\'s own pixel only', () => {
    const d = ok(campaignSettingsDraft({ campaignId: C, promotedObject: { customEventType: 'ADD_TO_CART' } }, live()))
    expect(JSON.parse(d.requests[0].params.promoted_object)).toEqual({ pixel_id: '120000000000050', custom_event_type: 'ADD_TO_CART' })
    expect((d.before as SettingsRecord).undo).toEqual({ promotedObject: { pixelId: '120000000000050', customEventType: 'PURCHASE' } })
    expect(refusal(campaignSettingsDraft({ campaignId: C, promotedObject: { pixelId: '120000000000059' } }, live()))).toMatch(/not one of the chosen ad account's own pixels/)
    expect(refusal(campaignSettingsDraft({ campaignId: C, promotedObject: { productCatalogId: '120000000000060' } }, live()))).toMatch(/did not check the catalog/)
    expect(refusal(campaignSettingsDraft({ campaignId: C, promotedObject: { productCatalogId: '120000000000060' } }, live({ catalogProblem: 'Catalog 120000000000060 is not one the chosen ad account\'s business portfolio owns or was given, so it is not sent.' })))).toMatch(/not one the chosen ad account's business portfolio owns/)
    expect(ok(campaignSettingsDraft({ campaignId: C, promotedObject: { productCatalogId: '120000000000060' } }, live({ catalogProblem: null }))).requests[0].params.promoted_object).toMatch(/"product_catalog_id":"120000000000060"/)
    // Review B3 — a pixel rule is an ad set's only.
    expect(refusal(campaignSettingsDraft({ campaignId: C, promotedObject: { pixelRule: '{"url":{"i_contains":"thanks"}}' } }, live()))).toMatch(/pixel rule is an ad set's/)
    expect(refusal(campaignSettingsDraft({ campaignId: C, promotedObject: { customEventType: 'LEAD' } }, live({ campaign: campaign({ promotedObject: { page_id: '1' } }) })))).toMatch(/holds page_id/)
  })
  it('the objective only of a campaign with no ad set', () => {
    expect(refusal(campaignSettingsDraft({ campaignId: C, objective: 'OUTCOME_TRAFFIC' }, live()))).toMatch(/has ad sets: Meta does not document/)
    expect(ok(campaignSettingsDraft({ campaignId: C, objective: 'OUTCOME_TRAFFIC' }, live({ adSets: [] }))).requests[0].params).toEqual({ objective: 'OUTCOME_TRAFFIC' })
  })
  it('pacing on the campaign under a campaign budget; accelerated SPENDS; day_parting needs a lifetime budget', () => {
    expect(ok(campaignSettingsDraft({ campaignId: C, pacing: 'no_pacing' }, live())).spendsMoney[0]).toMatch(/Accelerated delivery/)
    expect(refusal(campaignSettingsDraft({ campaignId: C, pacing: 'day_parting' }, live()))).toMatch(/needs a lifetime budget/)
    const scheduled = live({ campaign: campaign({ dailyBudget: null, lifetimeBudget: '900000', pacingType: ['day_parting'] }) })
    expect(ok(campaignSettingsDraft({ campaignId: C, pacing: 'standard' }, scheduled)).spendsMoney[0]).toMatch(/delivers at every hour/)
    expect(refusal(campaignSettingsDraft({ campaignId: C, pacing: 'no_pacing' }, live({ campaign: campaign({ dailyBudget: null }) })))).toMatch(/set on each ad set/)
  })
  it('legacy Advantage+ shopping and archived campaigns: refused in words; an archived one takes a name', () => {
    expect(refusal(campaignSettingsDraft({ campaignId: C, name: 'B' }, live({ campaign: campaign({ smartPromotionType: 'AUTOMATED_SHOPPING_ADS' }) })))).toMatch(/legacy Advantage\+/)
    expect(refusal(campaignSettingsDraft({ campaignId: C, dailyBudgetCents: 9000 }, live({ campaign: campaign({ status: 'ARCHIVED' }) })))).toMatch(/only its name/)
    expect(ok(campaignSettingsDraft({ campaignId: C, name: 'Campaign B' }, live({ campaign: campaign({ status: 'ARCHIVED' }) }))).requests[0].params).toEqual({ name: 'Campaign B' })
  })
  it('nothing named: the rows answered in words are said', () => {
    expect(refusal(campaignSettingsDraft({ campaignId: C }, live()))).toMatch(/Name at least one setting.*set-meta-ad-set startTime.*frequencyCaps.*deprecated/)
  })
  it('reads only what a request needs; the plan and basis are stable for the same live state', () => {
    expect(campaignReadsNeeded({ campaignId: C, name: 'x' }, campaign())).toEqual({ adSets: false, pixels: false, catalog: null })
    expect(campaignReadsNeeded({ campaignId: C, promotedObject: { productSetId: '120000000000061' } }, campaign())).toMatchObject({ catalog: { catalogId: null, productSetId: '120000000000061' } })
    expect(campaignReadsNeeded({ campaignId: C, promotedObject: { customEventType: 'LEAD' } }, campaign())).toMatchObject({ pixels: true })
    const a = ok(campaignSettingsDraft({ campaignId: C, dailyBudgetCents: 7000 }, live()))
    const b = ok(campaignSettingsDraft({ campaignId: C, dailyBudgetCents: 7000 }, live({ campaign: campaign({ effectiveStatus: 'WITH_ISSUES' }) })))
    expect(JSON.stringify(a.stands)).toBe(JSON.stringify(b.stands))
    const moved = ok(campaignSettingsDraft({ campaignId: C, dailyBudgetCents: 7000 }, live({ campaign: campaign({ dailyBudget: '6000' }) })))
    expect(JSON.stringify(moved.stands)).not.toBe(JSON.stringify(a.stands))
  })
})
