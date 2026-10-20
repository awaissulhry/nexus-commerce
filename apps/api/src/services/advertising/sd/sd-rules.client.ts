/**
 * Sponsored Display extras (P3c) — Amazon's optimization rules (cost control), budget rules, budget recommendations and
 * budget usage for Sponsored Display, read and changed through sd-answer.ts `sdCall` (the channel gateway). Checked
 * against Amazon's Sponsored Display 3.0 OpenAPI (read 2026-10-20):
 *
 * Optimization rules (tag "Optimization Rules", beta; IT since 2024-05). application/json both ways.
 *   GET  /sd/optimizationRules                  OptimizationRule[] — filters optimizationRuleIdFilter / adGroupIdFilter
 *                                               (≤ 50 ids each), name (exact), stateFilter; paged by startIndex + count
 *   GET  /sd/optimizationRules/{id}             one OptimizationRule
 *   POST /sd/optimizationRules                  [CreateOptimizationRule] → 207 [{ code, description, ruleId }]
 *   PUT  /sd/optimizationRules                  [UpdateOptimizationRule] → 207 [{ code, description, ruleId }]
 *   GET  /sd/adGroups/{adGroupId}/optimizationRules           the rules on one ad group
 *   POST /sd/adGroups/{adGroupId}/optimizationRules            { optimizationRuleIds: [one] } → 207 [{ code, description, ruleId }]
 *   POST /sd/adGroups/{adGroupId}/optimizationRules/disassociate  { optimizationRuleIds: [one] } → 207 { code, responses:
 *                                               [{ code, details, optimizationRuleId }] }
 *   A rule is { ruleId, ruleName, state: enabled (paused is "coming later"), ruleConditions: [exactly one { metricName
 *   COST_PER_ORDER | COST_PER_CLICK | COST_PER_THOUSAND_VIEWABLE_IMPRESSIONS, comparisonOperator LESS_THAN_OR_EQUAL_TO,
 *   threshold }] }. There is no delete. Amazon's notes on create: one rule per ad group; only ad groups with product ads
 *   (ASIN or SKU); it overrides the targets' manual bids and may add targets; the campaign's budget must be at least 5×
 *   a cost per order, 10× a cost per 1,000 viewable impressions, 20× a cost per click. Threshold minimums: 5, 0.5, 1.
 *
 * Budget rules (tag "Budget Rules"). application/json both ways; errors are { code, details }.
 *   GET  /sd/budgetRules?pageSize (≤ 30, required)&nextToken    { budgetRulesForAdvertiserResponse: SDBudgetRule[], nextToken }
 *   GET  /sd/budgetRules/{id}                   { budgetRule }
 *   POST /sd/budgetRules                        { budgetRulesDetails: [≤ 25 SDBudgetRuleDetails] } → 207 { responses: [{ code, details, ruleId }] }
 *   PUT  /sd/budgetRules                        { budgetRulesDetails: [≤ 25 { ruleId, ruleState, ruleDetails }] } → 207 likewise
 *   GET  /sd/budgetRules/{id}/campaigns?pageSize (≤ 30)&nextToken  { associatedCampaigns: [{ campaignId, campaignName, ruleStatus }] }
 *   GET  /sd/campaigns/{campaignId}/budgetRules  { associatedRules: SDBudgetRule[] } — the shape of the Sponsored Products
 *                                               read (ads-api-client.ts parseCampaignBudgetRules), so that parser reads it
 *   POST /sd/campaigns/{campaignId}/budgetRules  { budgetRuleIds: [≤ 25] } → 207 { responses: [{ code, details, ruleId }] }
 *                                               (≤ 250 rules a campaign; rule names unique within a campaign)
 *   DELETE /sd/campaigns/{campaignId}/budgetRules/{id}         → 200 {}
 *   SDBudgetRuleDetails: name (≤ 355), ruleType SCHEDULE | PERFORMANCE, budgetIncreaseBy { type PERCENT, value } (a rule
 *   only raises), duration { dateRangeTypeRuleDuration { startDate ≥ today, endDate } | eventTypeRuleDuration { eventId }
 *   (an event id comes from a budget-rule recommendation, which the Sponsored Display API does not offer) }, recurrence
 *   { type DAILY | WEEKLY, daysOfWeek, intraDaySchedule [≤ 1 { startTime, endTime } as hh:mm:ss] },
 *   performanceMeasureCondition { metricName ACOS | CTR | CVR | ROAS, comparisonOperator, threshold }. No delete.
 *
 * Budget recommendations and usage (read-only POSTs; gateway/ads.ts ADS_READ_POSTS).
 *   POST /sd/campaigns/budgetRecommendations   application/vnd.sdbudgetrecommendations.v3+json { campaignIds: [≤ 100] } → 207
 *        { budgetRecommendationsSuccessResults: [{ index, campaignId, suggestedBudget, sevenDaysMissedOpportunities }],
 *          budgetRecommendationsErrorResults: [{ index, campaignId, code, details }] }
 *   POST /sd/campaigns/budget/usage            application/vnd.sdcampaignbudgetusage.v1+json { campaignIds: [≤ 100] } → 207
 *        { success: [{ campaignId, budgetUsagePercent, budget, usageUpdatedTimestamp, index }], error: [{ campaignId, code, details, index }] }
 *
 * Amounts are Amazon's: decimals in the market's currency. The tools turn them into minor units.
 */
import { parseCampaignBudgetRules, type AmazonBudgetRule, type ClientContext } from '../ads-api-client.js'
import { SdAmazonError, SD_ANSWER_NOT_UNDERSTOOD, sdCall, sdItemOutcome, seg, type SdItemOutcome } from './sd-answer.js'

const JSON_TYPE = 'application/json'
/**
 * One call. `create`: a POST that makes a rule is not sent again on a 5xx (Amazon may have made it before it answered;
 * a second one would be a duplicate): the failure is said, and the name check of the next request finds the first.
 */
const call = <T>(ctx: ClientContext, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, opts: { mime?: string; create?: boolean } = {}) => {
  const mime = opts.mime ?? JSON_TYPE
  return sdCall<T>({
    profileId: ctx.profileId, region: ctx.region, method, path, ...(body !== undefined ? { body, contentType: mime } : {}), acceptHeader: mime,
    ...(opts.create ? { noServerErrorRetry: true } : {}),
  })
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const query = (params: Record<string, string | number | null | undefined>) => {
  const q = Object.entries(params).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
  return q.length ? `?${q.join('&')}` : ''
}
const notUnderstood = (what: string) => new SdAmazonError(`Amazon's answer about ${what} was not understood, so Nexus cannot say what it holds.`)

// ── Optimization rules ────────────────────────────────────────────────────────────────────────────────────────────

export type SdRuleMetric = 'COST_PER_ORDER' | 'COST_PER_CLICK' | 'COST_PER_THOUSAND_VIEWABLE_IMPRESSIONS'
/** Amazon's lowest threshold per metric, in the market's currency (RuleCondition.threshold). */
export const SD_RULE_MIN_THRESHOLD: Record<SdRuleMetric, number> = { COST_PER_ORDER: 5, COST_PER_CLICK: 0.5, COST_PER_THOUSAND_VIEWABLE_IMPRESSIONS: 1 }
/** How many times the threshold the campaign's daily budget must be at least (POST /sd/optimizationRules notes). */
export const SD_RULE_BUDGET_MULTIPLE: Record<SdRuleMetric, number> = { COST_PER_ORDER: 5, COST_PER_CLICK: 20, COST_PER_THOUSAND_VIEWABLE_IMPRESSIONS: 10 }

/** One optimization rule as Amazon holds it. `threshold` in the market's currency. */
export interface SdOptimizationRule {
  ruleId: string
  name: string | null
  state: string | null
  metric: string | null
  comparison: string | null
  threshold: number | null
}

function parseRule(raw: unknown): SdOptimizationRule | null {
  const r = obj(raw)
  const ruleId = text(r.ruleId)
  if (!ruleId) return null
  const condition = obj(Array.isArray(r.ruleConditions) ? r.ruleConditions[0] : null)
  return { ruleId, name: text(r.ruleName), state: text(r.state), metric: text(condition.metricName), comparison: text(condition.comparisonOperator), threshold: num(condition.threshold) }
}

function parseRules(answer: unknown, what: string): SdOptimizationRule[] {
  if (!Array.isArray(answer)) throw notUnderstood(what)
  return answer.map(parseRule).filter((r): r is SdOptimizationRule => !!r)
}

/** The account's optimization rules (filters as Amazon takes them, ≤ 50 ids each), one page. */
export async function listSdOptimizationRules(ctx: ClientContext, opts: { ruleIds?: readonly string[]; adGroupIds?: readonly string[]; name?: string; startIndex?: number; count?: number } = {}): Promise<SdOptimizationRule[]> {
  const path = `/sd/optimizationRules${query({
    startIndex: opts.startIndex, count: opts.count, name: opts.name,
    optimizationRuleIdFilter: opts.ruleIds?.length ? opts.ruleIds.slice(0, 50).join(',') : null,
    adGroupIdFilter: opts.adGroupIds?.length ? opts.adGroupIds.slice(0, 50).join(',') : null,
  })}`
  return parseRules(await call<unknown>(ctx, 'GET', path), 'its optimization rules')
}

/** One optimization rule; null when Amazon answers 404. */
export async function getSdOptimizationRule(ctx: ClientContext, ruleId: string): Promise<SdOptimizationRule | null> {
  try {
    const rule = parseRule(await call<unknown>(ctx, 'GET', `/sd/optimizationRules/${seg(ruleId)}`))
    if (!rule) throw notUnderstood(`optimization rule ${ruleId}`)
    return rule
  } catch (error) {
    if (error instanceof SdAmazonError && error.status === 404) return null
    throw error
  }
}

/** The optimization rules on one ad group (Amazon's ad group id). */
export async function adGroupSdOptimizationRules(ctx: ClientContext, externalAdGroupId: string): Promise<SdOptimizationRule[]> {
  return parseRules(await call<unknown>(ctx, 'GET', `/sd/adGroups/${seg(externalAdGroupId)}/optimizationRules`), `the optimization rule of ad group ${externalAdGroupId}`)
}

/** The rule's one condition, as Amazon takes it. `threshold` in the market's currency. */
export interface SdRuleInput { name: string; metric: SdRuleMetric; threshold: number }
const ruleBody = (r: SdRuleInput) => ({
  state: 'enabled',
  ruleName: r.name,
  ruleConditions: [{ metricName: r.metric, comparisonOperator: 'LESS_THAN_OR_EQUAL_TO', threshold: r.threshold }],
})

/** The first item of a 207 answer that is a bare array (or one item), read. */
function firstItem(answer: unknown, idKey: string): SdItemOutcome {
  const items = Array.isArray(answer) ? answer : answer && typeof answer === 'object' ? [answer] : []
  return items.length ? sdItemOutcome(items[0], idKey) : { ok: false, id: null, error: SD_ANSWER_NOT_UNDERSTOOD }
}

/** A new optimization rule (enabled: Amazon's only state). Its id, or Amazon's refusal. */
export async function createSdOptimizationRule(ctx: ClientContext, rule: SdRuleInput): Promise<SdItemOutcome> {
  const outcome = firstItem(await call<unknown>(ctx, 'POST', '/sd/optimizationRules', [ruleBody(rule)], { create: true }), 'ruleId')
  return outcome.ok && !outcome.id ? { ok: false, id: null, error: SD_ANSWER_NOT_UNDERSTOOD } : outcome
}

/** A rule's name and condition, sent whole (Amazon's update replaces them). */
export async function updateSdOptimizationRule(ctx: ClientContext, ruleId: string, rule: SdRuleInput): Promise<SdItemOutcome> {
  return firstItem(await call<unknown>(ctx, 'PUT', '/sd/optimizationRules', [{ ruleId, ...ruleBody(rule) }]), 'ruleId')
}

/** The rule on an ad group (Amazon's ad group id): Amazon takes one rule per ad group. */
export async function attachSdOptimizationRule(ctx: ClientContext, externalAdGroupId: string, ruleId: string): Promise<SdItemOutcome> {
  return firstItem(await call<unknown>(ctx, 'POST', `/sd/adGroups/${seg(externalAdGroupId)}/optimizationRules`, { optimizationRuleIds: [ruleId] }), 'ruleId')
}

/** The rule off an ad group: its targets bid their own bids again. */
export async function detachSdOptimizationRule(ctx: ClientContext, externalAdGroupId: string, ruleId: string): Promise<SdItemOutcome> {
  const answer = obj(await call<unknown>(ctx, 'POST', `/sd/adGroups/${seg(externalAdGroupId)}/optimizationRules/disassociate`, { optimizationRuleIds: [ruleId] }))
  if (Array.isArray(answer.responses) && answer.responses.length) return sdItemOutcome(answer.responses[0], 'optimizationRuleId')
  return sdItemOutcome(answer, 'optimizationRuleId')
}

// ── Budget rules ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Amazon's page size limit for the budget-rule lists. */
const SD_BUDGET_RULE_PAGE = 30

/** One budget rule: the Sponsored Products read's fields, its hours of the day, and Amazon's own details (sent back whole on an update). */
export type SdBudgetRule = AmazonBudgetRule & {
  /** recurrence.intraDaySchedule[0], as Amazon writes it (hh:mm:ss). */
  window: { startTime: string; endTime: string } | null
  details: Record<string, unknown>
}

function parseBudgetRules(list: unknown, what: string): SdBudgetRule[] {
  if (!Array.isArray(list)) throw notUnderstood(what)
  const parsed = parseCampaignBudgetRules(list)
  if ('error' in parsed) throw notUnderstood(what)
  return parsed.rules.map((rule, i) => {
    const details = obj(obj(list[i]).ruleDetails)
    const day = obj(Array.isArray(obj(details.recurrence).intraDaySchedule) ? (obj(details.recurrence).intraDaySchedule as unknown[])[0] : null)
    const startTime = text(day.startTime)
    const endTime = text(day.endTime)
    return { ...rule, window: startTime && endTime ? { startTime, endTime } : null, details }
  })
}

/** One page of the account's budget rules, and the token of the next. */
export async function listSdBudgetRules(ctx: ClientContext, nextToken?: string | null): Promise<{ rules: SdBudgetRule[]; nextToken: string | null }> {
  const answer = obj(await call<unknown>(ctx, 'GET', `/sd/budgetRules${query({ pageSize: SD_BUDGET_RULE_PAGE, nextToken })}`))
  return { rules: parseBudgetRules(answer.budgetRulesForAdvertiserResponse, 'its budget rules'), nextToken: text(answer.nextToken) }
}

/** One budget rule; null when Amazon answers 404. */
export async function getSdBudgetRule(ctx: ClientContext, ruleId: string): Promise<SdBudgetRule | null> {
  try {
    const answer = obj(await call<unknown>(ctx, 'GET', `/sd/budgetRules/${seg(ruleId)}`))
    if (!answer.budgetRule) throw notUnderstood(`budget rule ${ruleId}`)
    return parseBudgetRules([answer.budgetRule], `budget rule ${ruleId}`)[0] ?? null
  } catch (error) {
    if (error instanceof SdAmazonError && error.status === 404) return null
    throw error
  }
}

/** One page of the campaigns a budget rule is on (Amazon's ids and names, and the rule's status on each). */
export async function sdBudgetRuleCampaigns(ctx: ClientContext, ruleId: string, nextToken?: string | null): Promise<{ campaigns: Array<{ campaignId: string; name: string | null; ruleStatus: string | null }>; nextToken: string | null }> {
  const answer = obj(await call<unknown>(ctx, 'GET', `/sd/budgetRules/${seg(ruleId)}/campaigns${query({ pageSize: SD_BUDGET_RULE_PAGE, nextToken })}`))
  if (!Array.isArray(answer.associatedCampaigns)) throw notUnderstood(`the campaigns of budget rule ${ruleId}`)
  const campaigns = answer.associatedCampaigns
    .map((c) => ({ campaignId: text(obj(c).campaignId) ?? '', name: text(obj(c).campaignName), ruleStatus: text(obj(c).ruleStatus) }))
    .filter((c) => c.campaignId)
  return { campaigns, nextToken: text(answer.nextToken) }
}

/** The budget rules on one campaign (Amazon's campaign id). */
export async function sdCampaignBudgetRules(ctx: ClientContext, externalCampaignId: string): Promise<SdBudgetRule[]> {
  const answer = obj(await call<unknown>(ctx, 'GET', `/sd/campaigns/${seg(externalCampaignId)}/budgetRules`))
  return parseBudgetRules(answer.associatedRules, `the budget rules of campaign ${externalCampaignId}`)
}

/** The first item of a budget-rule 207 answer ({ responses: [...] }), read. */
function firstResponse(answer: unknown): SdItemOutcome {
  const list = obj(answer).responses
  return Array.isArray(list) && list.length ? sdItemOutcome(list[0], 'ruleId') : { ok: false, id: null, error: SD_ANSWER_NOT_UNDERSTOOD }
}

/** A new budget rule (SDBudgetRuleDetails, built by the tool). Its id, or Amazon's refusal. */
export async function createSdBudgetRule(ctx: ClientContext, details: Record<string, unknown>): Promise<SdItemOutcome> {
  const outcome = firstResponse(await call<unknown>(ctx, 'POST', '/sd/budgetRules', { budgetRulesDetails: [details] }, { create: true }))
  return outcome.ok && !outcome.id ? { ok: false, id: null, error: SD_ANSWER_NOT_UNDERSTOOD } : outcome
}

/** A budget rule's state and details, sent whole. */
export async function updateSdBudgetRule(ctx: ClientContext, ruleId: string, ruleState: 'ACTIVE' | 'PAUSED', details: Record<string, unknown>): Promise<SdItemOutcome> {
  return firstResponse(await call<unknown>(ctx, 'PUT', '/sd/budgetRules', { budgetRulesDetails: [{ ruleId, ruleState, ruleDetails: details }] }))
}

/** A budget rule on a campaign (Amazon's campaign id). */
export async function attachSdBudgetRule(ctx: ClientContext, externalCampaignId: string, ruleId: string): Promise<SdItemOutcome> {
  return firstResponse(await call<unknown>(ctx, 'POST', `/sd/campaigns/${seg(externalCampaignId)}/budgetRules`, { budgetRuleIds: [ruleId] }))
}

/** A budget rule off a campaign: Amazon answers 200 with an empty object, or refuses (thrown). */
export async function detachSdBudgetRule(ctx: ClientContext, externalCampaignId: string, ruleId: string): Promise<SdItemOutcome> {
  await call<unknown>(ctx, 'DELETE', `/sd/campaigns/${seg(externalCampaignId)}/budgetRules/${seg(ruleId)}`)
  return { ok: true, id: ruleId, error: null }
}

// ── Budget recommendations and usage ──────────────────────────────────────────────────────────────────────────────

export const SD_BUDGET_RECOMMENDATIONS_PATH = '/sd/campaigns/budgetRecommendations'
export const SD_BUDGET_USAGE_PATH = '/sd/campaigns/budget/usage'
const RECOMMENDATIONS_MIME = 'application/vnd.sdbudgetrecommendations.v3+json'
const USAGE_MIME = 'application/vnd.sdcampaignbudgetusage.v1+json'
/** Amazon's most campaign ids per call, for both. */
const SD_BUDGET_IDS_PER_CALL = 100

/** Amazon's suggested daily budget and what the last 7 days missed, per campaign (Amazon's id). Amounts in the market's currency. */
export interface SdBudgetRecommendation {
  campaignId: string
  suggestedBudget: number | null
  window: { from: string | null; to: string | null }
  percentTimeInBudget: number | null
  missed: {
    sales: { low: number | null; high: number | null }
    clicks: { low: number | null; high: number | null }
    impressions: { low: number | null; high: number | null }
    viewableImpressions: { low: number | null; high: number | null }
  }
}

/** The campaigns Amazon could not answer for, in its words, by Amazon's campaign id. */
export type SdCampaignErrors = Array<{ campaignId: string; error: string }>

const errorsOf = (list: unknown): SdCampaignErrors =>
  (Array.isArray(list) ? list : []).map((raw) => {
    const e = obj(raw)
    return { campaignId: text(e.campaignId) ?? '?', error: [text(e.code), text(e.details)].filter(Boolean).join(' — ') || 'no reason given' }
  })

/** Amazon's budget recommendations for up to 100 campaigns (Amazon's ids). A read: it changes nothing. */
export async function sdBudgetRecommendations(ctx: ClientContext, externalCampaignIds: readonly string[]): Promise<{ recommendations: SdBudgetRecommendation[]; errors: SdCampaignErrors }> {
  const answer = obj(await call<unknown>(ctx, 'POST', SD_BUDGET_RECOMMENDATIONS_PATH, { campaignIds: externalCampaignIds.slice(0, SD_BUDGET_IDS_PER_CALL) }, { mime: RECOMMENDATIONS_MIME }))
  if (!Array.isArray(answer.budgetRecommendationsSuccessResults) && !Array.isArray(answer.budgetRecommendationsErrorResults)) throw notUnderstood('budget recommendations')
  const recommendations = (Array.isArray(answer.budgetRecommendationsSuccessResults) ? answer.budgetRecommendationsSuccessResults : []).map((raw) => {
    const r = obj(raw)
    const m = obj(r.sevenDaysMissedOpportunities)
    const pair = (low: string, high: string) => ({ low: num(m[low]), high: num(m[high]) })
    return {
      campaignId: text(r.campaignId) ?? '?',
      suggestedBudget: num(r.suggestedBudget),
      window: { from: text(m.startDate), to: text(m.endDate) },
      percentTimeInBudget: num(m.percentTimeInBudget),
      missed: {
        sales: pair('estimatedMissedSalesLower', 'estimatedMissedSalesUpper'),
        clicks: pair('estimatedMissedClicksLower', 'estimatedMissedClicksUpper'),
        impressions: pair('estimatedMissedImpressionsLower', 'estimatedMissedImpressionsUpper'),
        viewableImpressions: pair('estimatedMissedViewableImpressionsLower', 'estimatedMissedViewableImpressionsUpper'),
      },
    }
  })
  return { recommendations, errors: errorsOf(answer.budgetRecommendationsErrorResults) }
}

/** How much of today's budget a campaign has used, as Amazon last measured it. `budget` in the market's currency. */
export interface SdBudgetUsage { campaignId: string; usedPercent: number | null; budget: number | null; asOf: string | null }

/** Amazon's budget usage for up to 100 campaigns (Amazon's ids). A read: it changes nothing. */
export async function sdBudgetUsage(ctx: ClientContext, externalCampaignIds: readonly string[]): Promise<{ usage: SdBudgetUsage[]; errors: SdCampaignErrors }> {
  const answer = obj(await call<unknown>(ctx, 'POST', SD_BUDGET_USAGE_PATH, { campaignIds: externalCampaignIds.slice(0, SD_BUDGET_IDS_PER_CALL) }, { mime: USAGE_MIME }))
  if (!Array.isArray(answer.success) && !Array.isArray(answer.error)) throw notUnderstood('budget usage')
  const usage = (Array.isArray(answer.success) ? answer.success : []).map((raw) => {
    const u = obj(raw)
    return { campaignId: text(u.campaignId) ?? '?', usedPercent: num(u.budgetUsagePercent), budget: num(u.budget), asOf: text(u.usageUpdatedTimestamp) }
  })
  return { usage, errors: errorsOf(answer.error) }
}
