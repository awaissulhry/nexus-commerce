/**
 * Google Ads changes, G5 (2026-10-15) — Google's recommendations and its auto-apply settings, read live from Google: the
 * "from" side of apply-google-recommendations, dismiss-google-recommendations and set-google-auto-apply. One GAQL query
 * per part, on the account's change allowance (write-client.ts `liveRows`).
 *
 * Fields checked on 2026-10-15 in https://developers.google.com/google-ads/api/fields/v25/recommendation: resource_name,
 * type, dismissed, campaign, ad_group, campaign_budget (selectable; resource_name filterable); impact and every
 * `*_recommendation` detail below are MESSAGE fields, selectable whole only (not filterable). The detail messages
 * (reference rpc/v25/Recommendation.*): CampaignBudgetRecommendation {current_budget_amount_micros,
 * recommended_budget_amount_micros}, KeywordRecommendation {keyword, recommended_cpc_bid_micros},
 * MoveUnusedBudgetRecommendation {excess_campaign_budget, budget_recommendation}, TargetCpaOptInRecommendation
 * {recommended_target_cpa_micros}, TargetRoasOptInRecommendation {recommended_target_roas,
 * required_campaign_budget_amount_micros}, RaiseTargetCpa / LowerTargetRoas {target_adjustment {current_average_target_micros,
 * recommended_target_multiplier}}, UseBroadMatchKeywordRecommendation {suggested_keywords_count,
 * required_campaign_budget_amount_micros}, ForecastingSetTargetCpa / Roas {recommended_target_cpa_micros |
 * recommended_target_roas}. Impact metrics are WEEKLY (RecommendationMetrics).
 * Auto-apply: recommendation_subscription.type / status (selectable, filterable); a subscription's resource name is
 * customers/{c}/recommendationSubscriptions/{type} (rpc/v25/RecommendationSubscription).
 *
 * A recommendation is named by the end of its resource name (google-ad-details view recommendations gives it as
 * recommendationId). Google says a recommendation can change several times a day and its resource name then goes stale.
 */
import { AUTO_APPLY_QUERY } from './gaql.js'
import { GoogleAdsReadError } from './errors.js'
import { centsOfMicros, idOf } from './live.js'
import { liveRows } from './write-client.js'
import type { GoogleAdsTarget } from './types.js'

type Json = Record<string, any>
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : null)
const num = (value: unknown): number | null => (value === undefined || value === null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value))

/** A recommendation id as Nexus takes it: the end of its resource name, never a quote, a backslash, a slash or a space. */
export const RECOMMENDATION_ID = /^[^\s'"\\/]{1,200}$/

export interface LiveRecommendationMetrics { costCents: number | null; clicks: number | null; impressions: number | null; conversions: number | null }

export interface LiveRecommendation {
  recommendationId: string
  resourceName: string
  type: string
  dismissed: boolean
  campaignId: string | null
  adGroupId: string | null
  /** The budget it changes (CAMPAIGN_BUDGET, FORECASTING_CAMPAIGN_BUDGET, MARGINAL_ROI_CAMPAIGN_BUDGET, MOVE_UNUSED_BUDGET). */
  budgetId: string | null
  /** Google's weekly estimate before and after (null when Google gave none, or it was not read). */
  impact: { base: LiveRecommendationMetrics; potential: LiveRecommendationMetrics } | null
  /** Budget types: the amount now and the amount Google recommends (cents a day). */
  budget: { currentCents: number | null; recommendedCents: number | null } | null
  /** MOVE_UNUSED_BUDGET: the budget the money is taken from. */
  excessBudgetId: string | null
  /** KEYWORD: the keyword Google suggests. */
  keyword: { text: string; matchType: string | null; bidCents: number | null } | null
  /** Bidding targets Google suggests (target CPA in cents, target ROAS as a ratio). */
  targetCpaCents: number | null
  targetRoas: number | null
  /** RAISE_TARGET_CPA / LOWER_TARGET_ROAS (and their "bid too low" kinds): the factor and the target it starts from (micros, as Google gives it). */
  adjustment: { multiplier: number | null; currentAverageTargetMicros: number | null } | null
  /** The budget Google says the campaign needs after it (target ROAS opt-in, broad match). */
  requiredBudgetCents: number | null
  /** USE_BROAD_MATCH_KEYWORD: how many keywords turn to broad match. */
  broadMatchKeywords: number | null
}

const DETAILS = [
  'recommendation.impact', 'recommendation.campaign_budget_recommendation', 'recommendation.forecasting_campaign_budget_recommendation',
  'recommendation.marginal_roi_campaign_budget_recommendation', 'recommendation.move_unused_budget_recommendation',
  'recommendation.keyword_recommendation', 'recommendation.target_cpa_opt_in_recommendation', 'recommendation.target_roas_opt_in_recommendation',
  'recommendation.raise_target_cpa_recommendation', 'recommendation.lower_target_roas_recommendation',
  'recommendation.use_broad_match_keyword_recommendation', 'recommendation.set_target_cpa_recommendation',
  'recommendation.set_target_roas_recommendation', 'recommendation.forecasting_set_target_cpa_recommendation',
  'recommendation.forecasting_set_target_roas_recommendation',
]
const BASIC = ['recommendation.resource_name', 'recommendation.type', 'recommendation.dismissed', 'recommendation.campaign', 'recommendation.ad_group', 'recommendation.campaign_budget']

/** The recommendations of these resource names, with their details (`details` false: only what every type has). */
export function liveRecommendationsQuery(resourceNames: string[], details = true): string {
  const names = resourceNames.map((n) => `'${n}'`).join(', ')
  return `SELECT ${[...BASIC, ...(details ? DETAILS : [])].join(', ')} FROM recommendation WHERE recommendation.resource_name IN (${names})`
}

const metrics = (m: Json | undefined): LiveRecommendationMetrics => ({
  costCents: centsOfMicros(m?.costMicros), clicks: num(m?.clicks), impressions: num(m?.impressions), conversions: num(m?.conversions),
})

export function liveRecommendationOf(row: Json): LiveRecommendation {
  const r = row.recommendation ?? {}
  const resourceName = str(r.resourceName) ?? ''
  const budgetRec = r.campaignBudgetRecommendation ?? r.forecastingCampaignBudgetRecommendation ?? r.marginalRoiCampaignBudgetRecommendation
    ?? r.moveUnusedBudgetRecommendation?.budgetRecommendation
  const kw = r.keywordRecommendation
  const adjustment = (r.raiseTargetCpaRecommendation ?? r.lowerTargetRoasRecommendation)?.targetAdjustment
  const setCpa = r.setTargetCpaRecommendation ?? r.forecastingSetTargetCpaRecommendation
  const setRoas = r.setTargetRoasRecommendation ?? r.forecastingSetTargetRoasRecommendation
  return {
    recommendationId: resourceName.slice(resourceName.lastIndexOf('/') + 1),
    resourceName,
    type: str(r.type) ?? 'UNKNOWN',
    dismissed: r.dismissed === true,
    campaignId: idOf(r.campaign),
    adGroupId: idOf(r.adGroup),
    budgetId: idOf(r.campaignBudget),
    impact: r.impact && (r.impact.baseMetrics || r.impact.potentialMetrics) ? { base: metrics(r.impact.baseMetrics), potential: metrics(r.impact.potentialMetrics) } : null,
    budget: budgetRec ? { currentCents: centsOfMicros(budgetRec.currentBudgetAmountMicros), recommendedCents: centsOfMicros(budgetRec.recommendedBudgetAmountMicros) } : null,
    excessBudgetId: idOf(r.moveUnusedBudgetRecommendation?.excessCampaignBudget),
    keyword: kw?.keyword ? { text: str(kw.keyword.text) ?? '', matchType: str(kw.keyword.matchType), bidCents: centsOfMicros(kw.recommendedCpcBidMicros) } : null,
    targetCpaCents: centsOfMicros(r.targetCpaOptInRecommendation?.recommendedTargetCpaMicros ?? setCpa?.recommendedTargetCpaMicros),
    targetRoas: num(r.targetRoasOptInRecommendation?.recommendedTargetRoas ?? setRoas?.recommendedTargetRoas),
    adjustment: adjustment ? { multiplier: num(adjustment.recommendedTargetMultiplier), currentAverageTargetMicros: num(adjustment.currentAverageTargetMicros) } : null,
    requiredBudgetCents: centsOfMicros(r.targetRoasOptInRecommendation?.requiredCampaignBudgetAmountMicros ?? r.useBroadMatchKeywordRecommendation?.requiredCampaignBudgetAmountMicros),
    broadMatchKeywords: num(r.useBroadMatchKeywordRecommendation?.suggestedKeywordsCount),
  }
}

/**
 * The recommendations named (by id), live; one that Google no longer has (applied, replaced, gone) is missing from the
 * answer. When Google refuses the query with the details (a detail it does not answer for this account), it is read
 * again without them: the change then says what it could not read.
 */
export async function liveRecommendations(target: GoogleAdsTarget, customer: string, recommendationIds: string[]): Promise<{ recommendations: LiveRecommendation[]; detailsRead: boolean }> {
  const names = [...new Set(recommendationIds)].map((id) => {
    if (!RECOMMENDATION_ID.test(id)) throw new Error(`"${id}" is not a recommendation id. Nothing was sent.`)
    return `${customer}/recommendations/${id}`
  })
  if (!names.length) return { recommendations: [], detailsRead: true }
  try {
    const rows = await liveRows<Json>(target, liveRecommendationsQuery(names), 'ads.search.live.recommendations')
    return { recommendations: rows.map(liveRecommendationOf), detailsRead: true }
  } catch (err) {
    if (!(err instanceof GoogleAdsReadError) || err.failure.httpStatus !== 400) throw err
    const rows = await liveRows<Json>(target, liveRecommendationsQuery(names, false), 'ads.search.live.recommendations')
    return { recommendations: rows.map(liveRecommendationOf), detailsRead: false }
  }
}

// ── auto-apply ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface LiveAutoApply { type: string; status: string | null }

/** Google's auto-apply settings: one per recommendation type that has ever been set (ENABLED or PAUSED; never deleted). */
export async function liveAutoApply(target: GoogleAdsTarget): Promise<LiveAutoApply[]> {
  const rows = await liveRows<Json>(target, AUTO_APPLY_QUERY, 'ads.search.live.auto-apply')
  return rows
    .map((row) => ({ type: str(row.recommendationSubscription?.type) ?? '', status: str(row.recommendationSubscription?.status) }))
    .filter((s) => s.type)
    .sort((a, b) => a.type.localeCompare(b.type))
}
