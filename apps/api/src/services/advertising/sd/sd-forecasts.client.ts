/**
 * Sponsored Display extras (P3c) — Amazon's forecast for a planned Sponsored Display ad group: POST /sd/forecasts
 * ("Return forecasts for an ad group that may or may not exist", operation createSDForecast), checked against Amazon's
 * Sponsored Display 3.0 OpenAPI (read 2026-10-20). It creates nothing at Amazon and changes nothing: a read-only POST
 * (gateway/ads.ts ADS_READ_POSTS), through sd-answer.ts `sdCall`.
 *
 *   media type  application/vnd.sdforecasts.v3.1+json, both ways; errors { code, details }
 *   request     SDForecastRequest { campaign { startDate (YYYYMMDD, today or later, required), endDate, costType, budget },
 *               adGroup { bidOptimization (required), creativeType, defaultBid }, productAds [≤ 100 { sku }] (sellers),
 *               targetingClauses [≤ 100 { expression, bid (required when there is no defaultBid) }],
 *               negativeTargetingClauses [≤ 100], optimizationRules [{ ruleConditions }] }. Other fields do not move it.
 *   response    SDForecastResponse { bidOptimization, lifetimeForecasts, weeklyForecasts, dailyForecasts: [≤ 4 { metric
 *               IMPRESSIONS | REACH | CLICKS | CONVERSIONS (preview only), value { min, max } }], curves: [{ graph BUDGET,
 *               meetThreshold, points: [{ isFocus, x: { value } (a budget), y: [{ label CLICKS | REACH, value { min, max } }] }] }],
 *               forecastStatus COMPLETE | IMPRESSION_TARGETING_TOO_NARROW | IMPRESSION_TARGETING_TOO_BROAD }
 */
import type { ClientContext } from '../ads-api-client.js'
import type { SdExpression } from '../sd-target-expression.js'
import { SdAmazonError, sdCall } from './sd-answer.js'

export const SD_FORECAST_PATH = '/sd/forecasts'
const FORECAST_MIME = 'application/vnd.sdforecasts.v3.1+json'

/** What Nexus asks a forecast for. Amounts in the market's currency; dates YYYYMMDD. */
export interface SdForecastInput {
  campaign: { startDate: string; endDate?: string | null; costType: 'cpc' | 'vcpm'; budget?: number | null }
  adGroup: { bidOptimization: 'clicks' | 'conversions' | 'reach'; creativeType?: 'IMAGE' | 'VIDEO' | null; defaultBid?: number | null }
  skus: readonly string[]
  targets: ReadonlyArray<{ expression: SdExpression; bid?: number | null }>
  negatives?: ReadonlyArray<{ type: 'asinSameAs' | 'asinBrandSameAs'; value: string }>
  costControl?: { metric: string; threshold: number } | null
}

/** The request body, built apart from the call so its shape is testable without a network. */
export function sdForecastBody(input: SdForecastInput): Record<string, unknown> {
  return {
    campaign: {
      startDate: input.campaign.startDate,
      ...(input.campaign.endDate ? { endDate: input.campaign.endDate } : {}),
      costType: input.campaign.costType,
      ...(input.campaign.budget != null ? { budget: input.campaign.budget, budgetType: 'daily' } : {}),
    },
    adGroup: {
      bidOptimization: input.adGroup.bidOptimization,
      ...(input.adGroup.creativeType ? { creativeType: input.adGroup.creativeType } : {}),
      ...(input.adGroup.defaultBid != null ? { defaultBid: input.adGroup.defaultBid } : {}),
    },
    productAds: input.skus.map((sku) => ({ sku })),
    targetingClauses: input.targets.map((t) => ({ expressionType: 'manual', expression: t.expression, ...(t.bid != null ? { bid: t.bid } : {}) })),
    ...(input.negatives?.length ? { negativeTargetingClauses: input.negatives.map((n) => ({ expressionType: 'manual', expression: [{ type: n.type, value: n.value }] })) } : {}),
    ...(input.costControl
      ? { optimizationRules: [{ state: 'enabled', ruleConditions: [{ metricName: input.costControl.metric, comparisonOperator: 'LESS_THAN_OR_EQUAL_TO', threshold: input.costControl.threshold }] }] }
      : {}),
  }
}

export interface SdForecastRange { min: number | null; max: number | null }
export interface SdForecast {
  status: string | null
  bidOptimization: string | null
  lifetime: Record<string, SdForecastRange>
  weekly: Record<string, SdForecastRange>
  daily: Record<string, SdForecastRange>
  /** The budget curve: each point a daily budget (the market's currency) and the clicks / reach it would bring. */
  budgetCurve: Array<{ budget: number | null; focus: boolean; clicks: SdForecastRange | null; reach: SdForecastRange | null }>
  /** Amazon's own flag: whether the budget is used enough to show the curve. */
  curveMeetsThreshold: boolean | null
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const range = (v: unknown): SdForecastRange => ({ min: num(obj(v).min), max: num(obj(v).max) })
const byMetric = (list: unknown): Record<string, SdForecastRange> =>
  Object.fromEntries((Array.isArray(list) ? list : []).map((f) => [String(obj(f).metric ?? '?'), range(obj(f).value)]))

/** Amazon's answer, read. An answer with no forecast list and no status is not understood. */
export function parseSdForecast(answer: unknown): SdForecast {
  const a = obj(answer)
  if (!Array.isArray(a.lifetimeForecasts) && !Array.isArray(a.dailyForecasts) && typeof a.forecastStatus !== 'string') {
    throw new SdAmazonError("Amazon's forecast answer was not understood, so Nexus shows no forecast.")
  }
  const curve = obj((Array.isArray(a.curves) ? a.curves : []).find((c) => obj(c).graph === 'BUDGET'))
  const label = (y: unknown, name: string) => {
    const hit = (Array.isArray(y) ? y : []).find((v) => obj(v).label === name)
    return hit ? range(obj(hit).value) : null
  }
  return {
    status: typeof a.forecastStatus === 'string' ? a.forecastStatus : null,
    bidOptimization: typeof a.bidOptimization === 'string' ? a.bidOptimization : null,
    lifetime: byMetric(a.lifetimeForecasts),
    weekly: byMetric(a.weeklyForecasts),
    daily: byMetric(a.dailyForecasts),
    budgetCurve: (Array.isArray(curve.points) ? curve.points : []).map((p) => {
      const point = obj(p)
      const x = point.x
      const budget = num(obj(Array.isArray(x) ? x[0] : x).value)
      return { budget, focus: point.isFocus === true, clicks: label(point.y, 'CLICKS'), reach: label(point.y, 'REACH') }
    }),
    curveMeetsThreshold: typeof curve.meetThreshold === 'boolean' ? curve.meetThreshold : null,
  }
}

/** Amazon's forecast for one planned ad group. A read: nothing is made or changed at Amazon. */
export async function sdForecast(ctx: ClientContext, input: SdForecastInput): Promise<SdForecast> {
  return parseSdForecast(await sdCall<unknown>({
    profileId: ctx.profileId, region: ctx.region, method: 'POST', path: SD_FORECAST_PATH,
    body: sdForecastBody(input), contentType: FORECAST_MIME, acceptHeader: FORECAST_MIME,
  }))
}
