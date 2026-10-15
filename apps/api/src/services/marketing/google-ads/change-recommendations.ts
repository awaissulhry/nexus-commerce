/**
 * Google Ads changes, G5 (2026-10-15) — Google's recommendations: apply them (with the overrides Google allows per type),
 * dismiss them, and switch Google's auto-apply on or off per type.
 *
 * Checked 2026-10-15 in the v25 reference and guide (developers.google.com/google-ads/api/reference/rpc/v25/…,
 * …/docs/recommendations):
 *   - ApplyRecommendationRequest / DismissRecommendationRequest have no validate_only: Google cannot check an apply or a
 *     dismiss first. The preview says so; the run reads the recommendation again (it must still be there, under the same
 *     resource name, with the same facts) before it sends anything.
 *   - With partial_failure false (Nexus: all or nothing) every recommendation of one request is of the same type
 *     (RecommendationError.DIFFERENT_TYPES_NOT_SUPPORTED); at most 100 per request.
 *   - ApplyRecommendationOperation.apply_parameters (one per type): campaign_budget {new_budget_amount_micros},
 *     keyword {ad_group, match_type, cpc_bid_micros}, target_cpa_opt_in {target_cpa_micros, new_campaign_budget_amount_micros},
 *     target_roas_opt_in {target_roas, new_campaign_budget_amount_micros}, raise_target_cpa {target_cpa_multiplier},
 *     lower_target_roas {target_roas_multiplier}, move_unused_budget {budget_micros_to_move}, use_broad_match_keyword
 *     {new_budget_amount_micros}, set_target_cpa / forecasting_set_target_cpa {target_cpa_micros,
 *     campaign_budget_amount_micros}, set_target_roas / forecasting_set_target_roas {target_roas,
 *     campaign_budget_amount_micros}, raise_target_cpa_bid_too_low {target_multiplier > 1},
 *     raise_target_cpa_performance_bid_too_low {target_cpa_multiplier > 1}, lower_target_roas_performance_bid_too_low
 *     {target_roas_multiplier < 1}. Target ROAS is 0.01 … 1000.
 *   - Auto-apply: RecommendationSubscription {type, status ENABLED | PAUSED}, made by create, changed by update (mask
 *     `status`), never deleted; the types Google auto-applies (guide, "Subscription-supported recommendation types").
 *
 * Money: an apply that raises a budget, a bid or a target CPA, lowers a target ROAS, hands bidding to Google, or widens
 * keywords, networks or audiences can make the account spend more — SPENDS MONEY, each in words. Undo: Google cannot
 * un-apply a recommendation. Nexus puts back exactly what it knows: the daily amount a budget recommendation replaced.
 * Types that make or move whole campaigns (Performance Max upgrades, a catch-all Shopping campaign) are refused: Google
 * may make them enabled, and Nexus makes new campaigns paused.
 */
import { changeLines, money, plural, type GoogleChangeDraft } from './change-draft.js'
import { microsOfCents, type LiveBudget, type LiveCampaign } from './live.js'
import type { LiveAutoApply, LiveRecommendation } from './live-recommendations.js'
import type { GoogleMutateOperation } from './write-client.js'

// ── what each type does ─────────────────────────────────────────────────────────────────────────────────────────

/** The apply parameters Nexus sends (the gateway's GOOGLE_RECOMMENDATION_APPLY_PARAMETERS). */
export type ApplyParam =
  | 'campaignBudget' | 'keyword' | 'targetCpaOptIn' | 'targetRoasOptIn' | 'raiseTargetCpa' | 'lowerTargetRoas' | 'moveUnusedBudget'
  | 'useBroadMatchKeyword' | 'setTargetCpa' | 'setTargetRoas' | 'forecastingSetTargetCpa' | 'forecastingSetTargetRoas'
  | 'raiseTargetCpaBidTooLow' | 'raiseTargetCpaPerformanceBidTooLow' | 'lowerTargetRoasPerformanceBidTooLow'

interface TypeRule {
  /** What applying it does, in words. */
  does: string
  /** How it can make the account spend more: always, when a budget goes up, when an enabled campaign gets a new ad, or never. */
  spends: 'always' | 'budget' | 'new-ad' | null
  /** The overrides a person may give, and the apply parameter they go in. */
  param?: ApplyParam
  overrides?: ReadonlyArray<'budgetCents' | 'targetCpaCents' | 'targetRoas' | 'multiplier' | 'matchType' | 'bidCents'>
}

const BIDDING = 'Google sets every bid itself from now (it can bid higher than today)'
export const RECOMMENDATION_TYPES: Readonly<Record<string, TypeRule>> = {
  CAMPAIGN_BUDGET: { does: 'sets the daily budget Google recommends', spends: 'budget', param: 'campaignBudget', overrides: ['budgetCents'] },
  FORECASTING_CAMPAIGN_BUDGET: { does: 'sets the daily budget Google recommends ahead of expected traffic', spends: 'budget' },
  MARGINAL_ROI_CAMPAIGN_BUDGET: { does: 'sets the daily budget Google recommends for a better return', spends: 'budget' },
  MOVE_UNUSED_BUDGET: { does: 'moves unused daily budget from another budget to this campaign\'s budget', spends: 'always', param: 'moveUnusedBudget', overrides: ['budgetCents'] },
  KEYWORD: { does: 'adds the keyword Google suggests (Google adds it ENABLED)', spends: 'always', param: 'keyword', overrides: ['matchType', 'bidCents'] },
  USE_BROAD_MATCH_KEYWORD: { does: 'turns the campaign\'s keywords to broad match (more searches show the ads)', spends: 'always', param: 'useBroadMatchKeyword', overrides: ['budgetCents'] },
  KEYWORD_MATCH_TYPE: { does: 'widens the match type of keywords (more searches show the ads)', spends: 'always' },
  TARGET_CPA_OPT_IN: { does: `switches the campaign to Target CPA bidding: ${BIDDING}`, spends: 'always', param: 'targetCpaOptIn', overrides: ['targetCpaCents', 'budgetCents'] },
  TARGET_ROAS_OPT_IN: { does: `switches the campaign to Target ROAS bidding: ${BIDDING}`, spends: 'always', param: 'targetRoasOptIn', overrides: ['targetRoas', 'budgetCents'] },
  MAXIMIZE_CONVERSIONS_OPT_IN: { does: `switches the campaign to Maximize conversions: ${BIDDING} and aims to spend the whole budget`, spends: 'always' },
  MAXIMIZE_CONVERSION_VALUE_OPT_IN: { does: `switches the campaign to Maximize conversion value: ${BIDDING} and aims to spend the whole budget`, spends: 'always' },
  MAXIMIZE_CLICKS_OPT_IN: { does: `switches the campaign to Maximize clicks: ${BIDDING} and aims to spend the whole budget`, spends: 'always' },
  ENHANCED_CPC_OPT_IN: { does: 'turns on Enhanced CPC: Google raises bids for clicks it judges likely to convert', spends: 'always' },
  SET_TARGET_CPA: { does: `sets a target CPA on the campaign: ${BIDDING}`, spends: 'always', param: 'setTargetCpa', overrides: ['targetCpaCents', 'budgetCents'] },
  SET_TARGET_ROAS: { does: `sets a target ROAS on the campaign: ${BIDDING}`, spends: 'always', param: 'setTargetRoas', overrides: ['targetRoas', 'budgetCents'] },
  FORECASTING_SET_TARGET_CPA: { does: `sets a target CPA ahead of expected traffic: ${BIDDING}`, spends: 'always', param: 'forecastingSetTargetCpa', overrides: ['targetCpaCents', 'budgetCents'] },
  FORECASTING_SET_TARGET_ROAS: { does: `raises the budget ahead of expected traffic and sets a target ROAS: ${BIDDING}`, spends: 'always', param: 'forecastingSetTargetRoas', overrides: ['targetRoas', 'budgetCents'] },
  RAISE_TARGET_CPA: { does: 'raises the target CPA (Google bids higher)', spends: 'always', param: 'raiseTargetCpa', overrides: ['multiplier'] },
  RAISE_TARGET_CPA_BID_TOO_LOW: { does: 'raises a target CPA Google judges too low (Google bids higher; it can take minutes)', spends: 'always', param: 'raiseTargetCpaBidTooLow', overrides: ['multiplier'] },
  RAISE_TARGET_CPA_PERFORMANCE_BID_TOO_LOW: { does: 'raises a target CPA Google judges too low (Google bids higher)', spends: 'always', param: 'raiseTargetCpaPerformanceBidTooLow', overrides: ['multiplier'] },
  LOWER_TARGET_ROAS: { does: 'lowers the target ROAS (Google bids higher)', spends: 'always', param: 'lowerTargetRoas', overrides: ['multiplier'] },
  LOWER_TARGET_ROAS_PERFORMANCE_BID_TOO_LOW: { does: 'lowers a target ROAS Google judges too high (Google bids higher)', spends: 'always', param: 'lowerTargetRoasPerformanceBidTooLow', overrides: ['multiplier'] },
  SEARCH_PARTNERS_OPT_IN: { does: 'adds Google\'s search partners to the campaign (more places show the ads)', spends: 'always' },
  DISPLAY_EXPANSION_OPT_IN: { does: 'adds the Display Network to the campaign (more places show the ads)', spends: 'always' },
  CUSTOM_AUDIENCE_OPT_IN: { does: 'makes a custom audience Google suggests for the campaign (it can widen who sees the ads)', spends: 'always' },
  PERFORMANCE_MAX_FINAL_URL_OPT_IN: { does: 'turns on final URL expansion: Google may send people to other pages of the site and match more searches', spends: 'always' },
  RESPONSIVE_SEARCH_AD: { does: 'adds the responsive search ad Google suggests (Google adds it ENABLED)', spends: 'new-ad' },
  TEXT_AD: { does: 'adds the ad Google suggests (Google adds it ENABLED)', spends: 'new-ad' },
  RESPONSIVE_SEARCH_AD_ASSET: { does: 'adds the headlines or descriptions Google suggests to the ad (the ad\'s text changes; its numbers stay)', spends: null },
  RESPONSIVE_SEARCH_AD_IMPROVE_AD_STRENGTH: { does: 'replaces the ad\'s text with Google\'s suggestion (its numbers stay)', spends: null },
  OPTIMIZE_AD_ROTATION: { does: 'lets Google show the ads it expects to do best more often', spends: null },
  DYNAMIC_IMAGE_EXTENSION_OPT_IN: { does: 'lets Google add images from the site to the ads', spends: null },
}

/** Types Nexus does not apply, and why (each says what to do instead). */
export const NOT_APPLIED: Readonly<Record<string, string>> = {
  PERFORMANCE_MAX_OPT_IN: 'it makes a new Performance Max campaign, which Google may start enabled (Nexus makes new campaigns paused: build it with build-google-campaigns)',
  UPGRADE_SMART_SHOPPING_CAMPAIGN_TO_PERFORMANCE_MAX: 'it turns a campaign into a new Performance Max campaign, which Google may start enabled',
  UPGRADE_LOCAL_CAMPAIGN_TO_PERFORMANCE_MAX: 'it turns a campaign into a new Performance Max campaign, which Google may start enabled',
  SHOPPING_MIGRATE_REGULAR_SHOPPING_CAMPAIGN_OFFERS_TO_PERFORMANCE_MAX: 'it moves products from Shopping campaigns into Performance Max campaigns',
  MIGRATE_DYNAMIC_SEARCH_ADS_CAMPAIGN_TO_PERFORMANCE_MAX: 'it moves a Dynamic Search Ads campaign into Performance Max',
  SHOPPING_TARGET_ALL_OFFERS: 'it makes a new catch-all Shopping campaign, which Google may start enabled (build it with build-google-campaigns)',
  CALLOUT_ASSET: 'Google needs the callouts to add (set-google-assets adds them)',
  SITELINK_ASSET: 'Google needs the sitelinks to add (set-google-assets adds them)',
  CALL_ASSET: 'Google needs the phone number to add',
  LEAD_FORM_ASSET: 'Google needs the lead form to add',
}
const NOT_APPLIED_DEFAULT = 'Google\'s reference does not say what applying it changes in the account; act on it in Google Ads or Merchant Center, or dismiss it'

/** The types Google applies by itself when auto-apply is on (Google's guide, "Subscription-supported recommendation types"). */
export const AUTO_APPLY_TYPES = [
  'ENHANCED_CPC_OPT_IN', 'KEYWORD', 'KEYWORD_MATCH_TYPE', 'LOWER_TARGET_ROAS', 'MAXIMIZE_CLICKS_OPT_IN', 'OPTIMIZE_AD_ROTATION',
  'RAISE_TARGET_CPA', 'RESPONSIVE_SEARCH_AD', 'RESPONSIVE_SEARCH_AD_IMPROVE_AD_STRENGTH', 'SEARCH_PARTNERS_OPT_IN', 'SET_TARGET_CPA',
  'SET_TARGET_ROAS', 'TARGET_CPA_OPT_IN', 'TARGET_ROAS_OPT_IN', 'USE_BROAD_MATCH_KEYWORD',
] as const
/** Auto-apply types that can make the account spend more by themselves when on (new ads count: Google adds them enabled). */
const AUTO_APPLY_SAFE = new Set(['OPTIMIZE_AD_ROTATION', 'RESPONSIVE_SEARCH_AD_IMPROVE_AD_STRENGTH'])

/** A Google type in words (`TARGET_CPA_OPT_IN` → "target CPA opt in"). */
const words = (type: string) => type.toLowerCase().replace(/_/g, ' ').replace(/\b(cpa|roas|roi)\b/g, (m) => m.toUpperCase())

// ── apply ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ApplyOverrides {
  budgetCents?: number
  targetCpaCents?: number
  targetRoas?: number
  multiplier?: number
  matchType?: 'EXACT' | 'PHRASE' | 'BROAD'
  bidCents?: number
}

export interface ApplyRequest { items: Array<{ recommendationId: string } & ApplyOverrides> }

export interface ApplyLiveState {
  recommendations: LiveRecommendation[]
  /** Whether the recommendations' details (amounts, targets, keyword) were read. */
  detailsRead: boolean
  campaigns: LiveCampaign[]
  budgets: LiveBudget[]
}

/** One applied recommendation, as the record keeps it; a budget one with the amount it replaced (before) and wrote (after). */
export interface AppliedRecord { recommendationId: string; type: string; campaignId: string | null; budgetId?: string; budgetCents?: number | null }
export interface ApplyRecord { applied: AppliedRecord[] }

/** The budget types whose apply Nexus can put back exactly (the daily amount they replaced). */
export const BUDGET_UNDO_TYPES = new Set(['CAMPAIGN_BUDGET', 'FORECASTING_CAMPAIGN_BUDGET', 'MARGINAL_ROI_CAMPAIGN_BUDGET'])

export const NOT_CHECKED_APPLY = 'Google cannot check an apply first (its RecommendationService has no validate_only). When the approved '
  + 'change runs, Nexus reads each recommendation again and sends it only if it is still there, unchanged; Google then '
  + 'applies all or none.'
export const NOT_CHECKED_DISMISS = 'Google cannot check a dismiss first (its RecommendationService has no validate_only). When the '
  + 'approved change runs, Nexus reads each recommendation again and sends it only if it is still there; Google then dismisses all or none.'

function overrideProblem(rule: TypeRule, type: string, o: ApplyOverrides): string | null {
  const given = (Object.keys(o) as Array<keyof ApplyOverrides>).filter((k) => o[k] !== undefined)
  const allowed = new Set(rule.overrides ?? [])
  const wrong = given.filter((k) => !allowed.has(k))
  if (wrong.length) return `a ${words(type)} recommendation takes ${allowed.size ? [...allowed].join(', ') : 'no override'} (not ${wrong.join(', ')})`
  if (o.targetRoas !== undefined && (o.targetRoas < 0.01 || o.targetRoas > 1000)) return 'a target ROAS is 0.01 to 1000'
  if (o.multiplier !== undefined) {
    if (rule.param === 'lowerTargetRoasPerformanceBidTooLow' && !(o.multiplier < 1)) return 'this multiplier lowers the target ROAS: below 1'
    if ((rule.param === 'raiseTargetCpaBidTooLow' || rule.param === 'raiseTargetCpaPerformanceBidTooLow') && !(o.multiplier > 1)) return 'this multiplier raises the target CPA: above 1'
  }
  return null
}

/** The apply parameter of one recommendation, from the person's overrides (none = Google's own values). */
function applyParameter(customer: string, rule: TypeRule, rec: LiveRecommendation, o: ApplyOverrides): Record<string, unknown> | { refusal: string } | null {
  const given = Object.values(o).some((v) => v !== undefined)
  if (!given || !rule.param) return null
  const budget = o.budgetCents !== undefined ? microsOfCents(o.budgetCents) : undefined
  switch (rule.param) {
    case 'campaignBudget': return { campaignBudget: { newBudgetAmountMicros: budget } }
    case 'moveUnusedBudget': return { moveUnusedBudget: { budgetMicrosToMove: budget } }
    case 'useBroadMatchKeyword': return { useBroadMatchKeyword: { newBudgetAmountMicros: budget } }
    case 'keyword': {
      const matchType = o.matchType ?? rec.keyword?.matchType
      if (!rec.adGroupId || !matchType) return { refusal: `Recommendation ${rec.recommendationId}: Google did not say its ad group or match type, so Nexus cannot send an override.` }
      return { keyword: { adGroup: `${customer}/adGroups/${rec.adGroupId}`, matchType, ...(o.bidCents !== undefined ? { cpcBidMicros: microsOfCents(o.bidCents) } : {}) } }
    }
    case 'targetCpaOptIn': {
      const cpa = o.targetCpaCents ?? rec.targetCpaCents
      if (cpa === null || cpa === undefined) return { refusal: `Recommendation ${rec.recommendationId}: give targetCpaCents (Google requires it with an override).` }
      return { targetCpaOptIn: { targetCpaMicros: microsOfCents(cpa), ...(budget ? { newCampaignBudgetAmountMicros: budget } : {}) } }
    }
    case 'targetRoasOptIn': {
      const roas = o.targetRoas ?? rec.targetRoas
      return { targetRoasOptIn: { ...(roas !== null && roas !== undefined ? { targetRoas: roas } : {}), ...(budget ? { newCampaignBudgetAmountMicros: budget } : {}) } }
    }
    case 'setTargetCpa':
    case 'forecastingSetTargetCpa':
      return { [rule.param]: { ...(o.targetCpaCents !== undefined ? { targetCpaMicros: microsOfCents(o.targetCpaCents) } : {}), ...(budget ? { campaignBudgetAmountMicros: budget } : {}) } }
    case 'setTargetRoas':
    case 'forecastingSetTargetRoas':
      return { [rule.param]: { ...(o.targetRoas !== undefined ? { targetRoas: o.targetRoas } : {}), ...(budget ? { campaignBudgetAmountMicros: budget } : {}) } }
    case 'raiseTargetCpa': return { raiseTargetCpa: { targetCpaMultiplier: o.multiplier } }
    case 'lowerTargetRoas': return { lowerTargetRoas: { targetRoasMultiplier: o.multiplier } }
    case 'raiseTargetCpaBidTooLow': return { raiseTargetCpaBidTooLow: { targetMultiplier: o.multiplier } }
    case 'raiseTargetCpaPerformanceBidTooLow': return { raiseTargetCpaPerformanceBidTooLow: { targetCpaMultiplier: o.multiplier } }
    case 'lowerTargetRoasPerformanceBidTooLow': return { lowerTargetRoasPerformanceBidTooLow: { targetRoasMultiplier: o.multiplier } }
  }
}

export function applyDraft(customer: string, currency: string, request: ApplyRequest, live: ApplyLiveState): GoogleChangeDraft | { refusal: string } {
  if (!request.items.length) return { refusal: 'Name at least one recommendation (google-ad-details view recommendations lists them).' }
  const byId = new Map(live.recommendations.map((r) => [r.recommendationId, r]))
  const campaignById = new Map(live.campaigns.map((c) => [c.campaignId, c]))
  const budgetById = new Map(live.budgets.map((b) => [b.budgetId, b]))
  const operations: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const spends: string[] = []
  const warnings: string[] = []
  const before: ApplyRecord = { applied: [] }
  const after: ApplyRecord = { applied: [] }
  const seen = new Set<string>()
  const budgetsTouched = new Set<string>()
  let type: string | null = null
  for (const item of request.items) {
    if (seen.has(item.recommendationId)) return { refusal: `Recommendation ${item.recommendationId} is named twice.` }
    seen.add(item.recommendationId)
    const rec = byId.get(item.recommendationId)
    if (!rec) return { refusal: `Recommendation ${item.recommendationId} is not in this account now: Google applied, replaced or withdrew it (its id changes when Google refreshes it). Read the recommendations again (google-ad-details view recommendations).` }
    if (type && rec.type !== type) return { refusal: `Google applies one type of recommendation per request: this asks for ${words(type)} and ${words(rec.type)}. Ask for each type on its own.` }
    type = rec.type
    const rule = RECOMMENDATION_TYPES[rec.type]
    if (!rule) return { refusal: `Nexus does not apply a ${words(rec.type)} recommendation: ${NOT_APPLIED[rec.type] ?? NOT_APPLIED_DEFAULT}.` }
    const { recommendationId: _id, ...overrides } = item
    const problem = overrideProblem(rule, rec.type, overrides)
    if (problem) return { refusal: `Recommendation ${rec.recommendationId}: ${problem}.` }
    const param = applyParameter(customer, rule, rec, overrides)
    if (param && 'refusal' in param) return { refusal: param.refusal as string }
    operations.push({ resourceName: rec.resourceName, ...(param ?? {}) })

    const campaign = rec.campaignId ? campaignById.get(rec.campaignId) ?? null : null
    const where = campaign ? `campaign "${campaign.name}"` : rec.budgetId ? `budget ${rec.budgetId}` : 'the account'
    const idle = campaign && campaign.status !== 'ENABLED' ? ` (the campaign is ${String(campaign.status ?? 'not enabled').toLowerCase()}: nothing spends until it is enabled)` : ''
    const record: AppliedRecord = { recommendationId: rec.recommendationId, type: rec.type, campaignId: rec.campaignId }
    const beforeRecord: AppliedRecord = { ...record }
    let to = rule.does
    if (rule.spends === 'budget' || rule.param === 'campaignBudget') {
      const b = rec.budgetId ? budgetById.get(rec.budgetId) : undefined
      if (!rec.budgetId || !b) return { refusal: `Recommendation ${rec.recommendationId}: its budget is not in this account now (or Google did not name it).` }
      if (budgetsTouched.has(b.budgetId)) return { refusal: `Two recommendations change the budget "${b.name ?? b.budgetId}": apply one of them.` }
      budgetsTouched.add(b.budgetId)
      const nowCents = b.amountCents
      const newCents = overrides.budgetCents ?? rec.budget?.recommendedCents ?? null
      to = `daily budget ${money(newCents, currency)}${overrides.budgetCents !== undefined ? ' (your amount)' : ''}`
      lines.push([`budget "${b.name ?? b.budgetId}" (${where})`, `${money(nowCents, currency)} a day`, to])
      Object.assign(beforeRecord, { budgetId: b.budgetId, budgetCents: nowCents })
      Object.assign(record, { budgetId: b.budgetId, budgetCents: newCents })
      const enabled = b.campaigns.filter((c) => c.status === 'ENABLED').length
      const note = enabled === 0 ? ' (no campaign on it is enabled now: nothing spends until one is)' : ` (${plural(enabled, 'enabled campaign')} on it)`
      if (newCents === null) spends.push(`Applies Google's ${words(rec.type)} recommendation to "${b.name ?? b.budgetId}": Google did not say the new amount, so it can raise the budget${note}.`)
      else if (nowCents === null || newCents > nowCents) spends.push(`Raises the daily budget "${b.name ?? b.budgetId}" from ${money(nowCents, currency)} to ${money(newCents, currency)}${note}.`)
    } else {
      const detail = describe(rec, overrides, currency)
      lines.push([`${words(rec.type)} (${where})`, 'as now', detail ? `${rule.does}: ${detail}` : rule.does])
      if (rule.spends === 'always') spends.push(`${capital(words(rec.type))} on ${where}: ${rule.does}${detail ? ` (${detail})` : ''}${idle}.`)
      if (rule.spends === 'new-ad' && campaign?.status === 'ENABLED') spends.push(`${capital(words(rec.type))} on ${where}: ${rule.does}; it can serve at once.`)
      if (rule.spends === null) warnings.push(`${capital(words(rec.type))} on ${where}: ${rule.does}.`)
      if (overrides.budgetCents !== undefined && rule.param !== 'moveUnusedBudget') {
        const current = campaign?.budget?.amountCents ?? null
        if (current === null || overrides.budgetCents > current) spends.push(`Sets the daily budget of ${where} to ${money(overrides.budgetCents, currency)} (now ${money(current, currency)})${idle}.`)
      }
    }
    const cost = rec.impact ? [rec.impact.base.costCents, rec.impact.potential.costCents] : null
    if (cost && cost[0] !== null && cost[1] !== null && cost[1] > cost[0]) {
      spends.push(`Google estimates the weekly cost of ${where} goes from ${money(cost[0], currency)} to ${money(cost[1], currency)} (Google's estimate).`)
    }
    if (rec.dismissed) warnings.push(`Recommendation ${rec.recommendationId} was dismissed; Google lets it be applied anyway.`)
    before.applied.push(beforeRecord)
    after.applied.push(record)
  }
  if (!live.detailsRead) warnings.push('Google did not answer the details of these recommendations (amounts, targets, keyword): the preview cannot say them.')
  const exact = after.applied.every((a) => BUDGET_UNDO_TYPES.has(a.type) && a.budgetCents != null)
  warnings.push(exact
    ? 'Google cannot un-apply a recommendation; undo here sets the old daily amount again.'
    : 'Google cannot un-apply a recommendation, and Nexus cannot put this one back: undo it by hand (set-google-campaign, set-google-keywords, set-google-status …).')
  const { changes, more } = changeLines(lines)
  return {
    summary: `Google Ads: apply ${plural(after.applied.length, `${words(type!)} recommendation`)} of Google.`,
    changes,
    totals: { operations: operations.length, applied: after.applied.length, ...(more ? { linesNotShown: more } : {}) },
    warnings,
    spendsMoney: spends,
    skipped: [],
    operations,
    stands: {
      // Each recommendation as it is now (not Google's estimates, which move), and what it changes as it is now.
      recommendations: live.recommendations.filter((r) => seen.has(r.recommendationId)).map(({ impact: _impact, ...r }) => r)
        .sort((a, b) => a.recommendationId.localeCompare(b.recommendationId)),
      campaigns: [...new Set(live.recommendations.filter((r) => seen.has(r.recommendationId)).map((r) => r.campaignId).filter((x): x is string => !!x))].sort()
        .map((id) => ({ campaignId: id, status: campaignById.get(id)?.status ?? null, budgetCents: campaignById.get(id)?.budget?.amountCents ?? null })),
      budgets: [...budgetsTouched].sort().map((id) => ({ budgetId: id, amountCents: budgetById.get(id)?.amountCents ?? null, campaigns: budgetById.get(id)?.campaigns.map((c) => `${c.campaignId}:${c.status}`).sort() ?? [] })),
      detailsRead: live.detailsRead,
    },
    before,
    after,
  }
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** What a recommendation sets, in words, with the person's overrides (or Google's values). */
function describe(rec: LiveRecommendation, o: ApplyOverrides, currency: string): string | null {
  const parts: string[] = []
  if (rec.keyword) parts.push(`"${rec.keyword.text}" ${o.matchType ?? rec.keyword.matchType ?? ''}`.trim() + `${o.bidCents !== undefined ? `, max CPC ${money(o.bidCents, currency)}` : rec.keyword.bidCents ? `, Google suggests max CPC ${money(rec.keyword.bidCents, currency)}` : ''}`)
  const cpa = o.targetCpaCents ?? rec.targetCpaCents
  if (cpa !== null && cpa !== undefined && ['TARGET_CPA_OPT_IN', 'SET_TARGET_CPA', 'FORECASTING_SET_TARGET_CPA'].includes(rec.type)) parts.push(`target CPA ${money(cpa, currency)}`)
  const roas = o.targetRoas ?? rec.targetRoas
  if (roas !== null && roas !== undefined && ['TARGET_ROAS_OPT_IN', 'SET_TARGET_ROAS', 'FORECASTING_SET_TARGET_ROAS'].includes(rec.type)) parts.push(`target ROAS ${Math.round(roas * 100)} %`)
  const factor = o.multiplier ?? rec.adjustment?.multiplier
  if (factor !== null && factor !== undefined) {
    const from = rec.adjustment?.currentAverageTargetMicros
    const isCpa = rec.type.includes('CPA')
    parts.push(`× ${factor}${isCpa && from ? ` (target CPA about ${money(Math.round(from / 10_000), currency)} → ${money(Math.round((from * factor) / 10_000), currency)})` : ''}`)
  }
  if (rec.broadMatchKeywords) parts.push(`${plural(rec.broadMatchKeywords, 'keyword')}`)
  if (rec.type === 'MOVE_UNUSED_BUDGET') {
    if (rec.excessBudgetId) parts.push(`taken from budget ${rec.excessBudgetId}`)
    if (o.budgetCents === undefined && rec.budget?.recommendedCents != null) parts.push(`this campaign's budget ${money(rec.budget.currentCents, currency)} → ${money(rec.budget.recommendedCents, currency)} a day`)
  }
  if (o.budgetCents !== undefined) parts.push(rec.type === 'MOVE_UNUSED_BUDGET' ? `${money(o.budgetCents, currency)} a day moved` : `daily budget ${money(o.budgetCents, currency)}`)
  else if (rec.requiredBudgetCents) parts.push(`Google says it needs a daily budget of ${money(rec.requiredBudgetCents, currency)} (the budget stays as it is)`)
  return parts.length ? parts.join(', ') : null
}

// ── dismiss ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DismissRecord { recommendations: Array<{ recommendationId: string; type: string; campaignId: string | null; dismissed: boolean }> }

export function dismissDraft(request: { recommendationIds: string[] }, live: { recommendations: LiveRecommendation[]; campaigns: LiveCampaign[] }): GoogleChangeDraft | { refusal: string } {
  if (!request.recommendationIds.length) return { refusal: 'Name at least one recommendation (google-ad-details view recommendations lists them).' }
  const byId = new Map(live.recommendations.map((r) => [r.recommendationId, r]))
  const campaignName = (id: string | null) => (id ? live.campaigns.find((c) => c.campaignId === id)?.name ?? id : null)
  const operations: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const skipped: string[] = []
  const before: DismissRecord = { recommendations: [] }
  const after: DismissRecord = { recommendations: [] }
  let type: string | null = null
  for (const id of [...new Set(request.recommendationIds)]) {
    const rec = byId.get(id)
    if (!rec) return { refusal: `Recommendation ${id} is not in this account now: Google applied, replaced or withdrew it. Read the recommendations again (google-ad-details view recommendations).` }
    if (rec.dismissed) { skipped.push(`Recommendation ${id} (${words(rec.type)}) is already dismissed.`); continue }
    if (type && rec.type !== type) return { refusal: `Google dismisses one type of recommendation per request: this asks for ${words(type)} and ${words(rec.type)}. Ask for each type on its own.` }
    type = rec.type
    operations.push({ resourceName: rec.resourceName })
    const where = campaignName(rec.campaignId)
    lines.push([`${words(rec.type)}${where ? ` (campaign "${where}")` : ''}`, 'open', 'dismissed'])
    before.recommendations.push({ recommendationId: id, type: rec.type, campaignId: rec.campaignId, dismissed: false })
    after.recommendations.push({ recommendationId: id, type: rec.type, campaignId: rec.campaignId, dismissed: true })
  }
  if (!operations.length) return { refusal: `Nothing to change: ${skipped.join(' ')}` }
  const { changes, more } = changeLines(lines)
  return {
    summary: `Google Ads: dismiss ${plural(operations.length, `${words(type!)} recommendation`)} of Google.`,
    changes,
    totals: { operations: operations.length, dismissed: operations.length, ...(more ? { linesNotShown: more } : {}) },
    warnings: ['Nothing in the account changes. A dismiss cannot be undone (Google has no way to bring it back as new), but Google still lets a dismissed recommendation be applied.'],
    spendsMoney: [],
    skipped,
    operations,
    stands: { recommendations: after.recommendations.map((r) => `${r.recommendationId}:${r.type}`).sort() },
    before,
    after,
  }
}

// ── auto-apply ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface AutoApplyRecord { types: Array<{ type: string; status: 'ENABLED' | 'PAUSED' | null }> }

export function autoApplyDraft(customer: string, request: { types: Array<{ type: string; status: 'ENABLED' | 'PAUSED' }> }, live: { subscriptions: LiveAutoApply[] }): GoogleChangeDraft | { refusal: string } {
  if (!request.types.length) return { refusal: 'Name at least one recommendation type.' }
  const operations: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const spends: string[] = []
  const skipped: string[] = []
  const before: AutoApplyRecord = { types: [] }
  const after: AutoApplyRecord = { types: [] }
  const seen = new Set<string>()
  for (const t of request.types) {
    if (seen.has(t.type)) return { refusal: `${words(t.type)} is named twice.` }
    seen.add(t.type)
    if (!(AUTO_APPLY_TYPES as readonly string[]).includes(t.type)) return { refusal: `Google does not auto-apply ${words(t.type)} recommendations (it auto-applies: ${AUTO_APPLY_TYPES.map(words).join(', ')}).` }
    const now = live.subscriptions.find((s) => s.type === t.type)
    const nowStatus = (now?.status === 'ENABLED' || now?.status === 'PAUSED' ? now.status : null) as 'ENABLED' | 'PAUSED' | null
    if ((nowStatus ?? 'PAUSED') === t.status) { skipped.push(`Auto-apply of ${words(t.type)} is already ${t.status === 'ENABLED' ? 'on' : 'off'}.`); continue }
    const resourceName = `${customer}/recommendationSubscriptions/${t.type}`
    operations.push(now
      ? { recommendationSubscriptionOperation: { update: { resourceName, status: t.status }, updateMask: 'status' } }
      : { recommendationSubscriptionOperation: { create: { type: t.type, status: t.status } } })
    lines.push([`auto-apply of ${words(t.type)}`, nowStatus === 'ENABLED' ? 'on' : nowStatus === 'PAUSED' ? 'off (paused)' : 'off (never set)', t.status === 'ENABLED' ? 'ON' : 'off (paused)'])
    before.types.push({ type: t.type, status: nowStatus })
    after.types.push({ type: t.type, status: t.status })
    if (t.status === 'ENABLED') {
      const rule = RECOMMENDATION_TYPES[t.type]
      if (!AUTO_APPLY_SAFE.has(t.type)) spends.push(`Lets Google apply its ${words(t.type)} recommendations BY ITSELF from now, with no person approving each${rule ? `: it ${rule.does}` : ''}.`)
    }
  }
  if (!operations.length) return { refusal: `Nothing to change: ${skipped.join(' ')}` }
  const { changes, more } = changeLines(lines)
  const on = after.types.filter((t) => t.status === 'ENABLED').length
  return {
    summary: `Google Ads auto-apply: ${[on && `turn ON for ${plural(on, 'type')}`, after.types.length - on && `turn off for ${plural(after.types.length - on, 'type')}`].filter(Boolean).join(', ')}.`,
    changes,
    totals: { operations: operations.length, on, off: after.types.length - on, ...(more ? { linesNotShown: more } : {}) },
    warnings: on ? ['Google applies what auto-apply allows without asking Nexus; google-ad-details view acts-on-its-own shows what it did.'] : [],
    spendsMoney: spends,
    skipped,
    operations,
    stands: { subscriptions: live.subscriptions.filter((s) => seen.has(s.type)).map((s) => `${s.type}:${s.status}`).sort() },
    before,
    after,
  }
}
