/**
 * Sponsored Display extras (P3c) — sd-forecast: Amazon's forecast of impressions, reach (viewable impressions) and clicks
 * for a PLANNED Sponsored Display ad group — its dates, cost type, budget, optimization, products, targets and an optional
 * cost control — through advertising/sd/sd-forecasts.client.ts (POST /sd/forecasts, "forecasts for an ad group that may
 * or may not exist"). A read: Amazon makes and changes nothing, so it needs no approval; nothing is asked in sandbox mode.
 *
 * Targets are written as Nexus's SD builders write them (sd-target-expression.ts): a product (ASIN), a category (Amazon's
 * category id) or an audience (an audience id, or views / purchases remarketing with its window). Amounts are minor units
 * of the market's currency; Amazon's answer is a min – max range per metric (lifetime, a week, a day) and, when the budget
 * is used enough, a curve of daily budgets against clicks or reach.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { sdForecast } from '../../advertising/sd/sd-forecasts.client.js'
import { SD_RULE_MIN_THRESHOLD, type SdRuleMetric } from '../../advertising/sd/sd-rules.client.js'
import { sdTargetExpression, SdTargetRefused, type SdExpression } from '../../advertising/sd-target-expression.js'
import {
  amazonDay, amountOf, centsOf, isoDateArg, money, realDay, sandboxRead, sdAnswered, sdMarketArg, sdMarketOf, todayIso,
} from './ads-sd-kit.js'
import type { AgentTool } from '../tool-types.js'

const ADSPEND = FIELDS.financialsAdspendView
const MAX = 100

const COST_CONTROL: Record<string, SdRuleMetric> = {
  'cost-per-order': 'COST_PER_ORDER', 'cost-per-click': 'COST_PER_CLICK', 'cost-per-1000-viewable-impressions': 'COST_PER_THOUSAND_VIEWABLE_IMPRESSIONS',
}
/** Amazon's pairing (SD 3.0 BaseAdGroup.bidOptimization): reach is a vCPM ad group; clicks and conversions are CPC. */
const PAYS_FOR: Record<string, 'cpc' | 'vcpm'> = { reach: 'vcpm', clicks: 'cpc', conversions: 'cpc' }
const STATUS_WORDS: Record<string, string> = {
  COMPLETE: 'Amazon forecast it.',
  IMPRESSION_TARGETING_TOO_NARROW: 'Amazon says the targeting is too narrow: its impression forecast tells nothing useful. Add targets or widen them.',
  IMPRESSION_TARGETING_TOO_BROAD: 'Amazon says the targeting is too broad: its impression forecast tells nothing useful. Narrow the targets.',
}

const input = z.object({
  market: sdMarketArg.describe('the Amazon market as business-overview lists it (IT, DE, FR, ES, UK, …)'),
  startDate: isoDateArg.describe('the planned first day, YYYY-MM-DD, today or later'),
  endDate: isoDateArg.optional().describe('the planned last day, YYYY-MM-DD (Amazon forecasts 7 days without one)'),
  costType: z.enum(['cpc', 'vcpm']).default('cpc').describe('how the campaign pays: cpc (per click) or vcpm (per 1,000 viewable impressions)'),
  dailyBudgetCents: z.coerce.number().int().min(1).max(100_000_000).optional().describe("the planned daily budget, minor units of the market's currency"),
  bidOptimization: z.enum(['clicks', 'conversions', 'reach']).describe('what the ad group optimizes for: clicks or conversions (cpc), reach (vcpm)'),
  creativeType: z.enum(['image', 'video']).optional().describe('the creative: image (Amazon\'s default) or video'),
  defaultBidCents: z.coerce.number().int().min(1).max(100_000).optional().describe("the ad group's default bid, minor units; without it every target needs bidCents"),
  skus: z.array(z.string().trim().min(1).max(100)).min(1).max(MAX).describe('the SKUs it would advertise (sellers advertise by SKU)'),
  targets: z.array(z.object({
    kind: z.enum(['product', 'category', 'audience']).describe('product (an ASIN), category (Amazon\'s category id) or audience'),
    value: z.string().trim().min(1).max(200).describe('the ASIN, the category id, the audience id, or for remarketing the scope: exactProduct, similarProduct, relatedProduct (purchases) or a category id'),
    audienceType: z.enum(['audience', 'views-remarketing', 'purchases-remarketing']).optional().describe('audience: an Amazon audience id (default), or people who viewed / bought'),
    lookbackDays: z.coerce.number().int().min(1).max(365).optional().describe('remarketing window in days: views 7, 14, 30, 60, 90; purchases also 180, 365'),
    bidCents: z.coerce.number().int().min(2).max(100_000).optional().describe("this target's bid, minor units (else the default bid)"),
  })).min(1).max(MAX).describe('the targets it would have'),
  negatives: z.array(z.object({
    kind: z.enum(['asin', 'brand']).describe('a product (ASIN) or a brand (Amazon\'s brand id) it would not show on'),
    value: z.string().trim().min(1).max(100).describe('the ASIN or brand id'),
  })).max(MAX).optional().describe('negative product targets it would have'),
  costControl: z.object({
    metric: z.enum(['cost-per-order', 'cost-per-click', 'cost-per-1000-viewable-impressions']).describe('the cost Amazon would keep at or below the limit'),
    thresholdCents: z.coerce.number().int().min(1).max(10_000_000).describe('the limit, minor units'),
  }).optional().describe('an optimization rule (cost control) it would carry, as set-sd-optimization-rule makes one'),
})
type Args = z.infer<typeof input>

const sdForecastTool: AgentTool = {
  name: 'sd-forecast',
  title: 'Sponsored Display forecast',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  restrictedFields: { budgetCents: ADSPEND },
  input,
  description:
    "Amazon's forecast for a PLANNED Sponsored Display ad group, read live from Amazon (POST /sd/forecasts makes and changes "
    + 'nothing): impressions, reach (viewable impressions) and clicks as min – max ranges for the whole run, a week and a '
    + 'day, Amazon\'s status (complete, or targeting too narrow / too broad), and when the budget is used enough a curve of '
    + "daily budgets against clicks or reach (budgetCents). Give the market, dates, how it pays (cpc or vcpm) and what it "
    + 'optimizes for (clicks / conversions on cpc, reach on vcpm), the SKUs, the targets (products, categories, audiences, '
    + 'remarketing) with bids or a default bid, and optionally a budget, negatives and a cost control. Amounts are minor '
    + "units of the market's currency. Use it before create-ad-campaign / create-ad-group or set-sd-optimization-rule.",
  async handler(args) {
    const a = args as Args
    const m = await sdMarketOf(a.market)
    if ('refusal' in m) return { ok: false, error: m.refusal }
    if (!realDay(a.startDate) || (a.endDate && !realDay(a.endDate))) return { ok: false, error: 'startDate and endDate must be real dates (YYYY-MM-DD).' }
    if (a.startDate < todayIso()) return { ok: false, error: `Amazon forecasts from today or later, not from ${a.startDate}.` }
    if (a.endDate && a.endDate < a.startDate) return { ok: false, error: `endDate ${a.endDate} is before startDate ${a.startDate}.` }
    if (PAYS_FOR[a.bidOptimization] !== a.costType) {
      return { ok: false, error: `Amazon optimizes a ${a.costType} ad group for ${a.costType === 'vcpm' ? 'reach' : 'clicks or conversions'}, not ${a.bidOptimization}.` }
    }
    const targets: Array<{ expression: SdExpression; bid: number | null }> = []
    for (const [i, t] of a.targets.entries()) {
      if (t.bidCents == null && a.defaultBidCents == null) return { ok: false, error: `targets[${i}] has no bidCents and there is no defaultBidCents: Amazon needs one of them.` }
      try {
        const audienceType = t.kind !== 'audience' ? null : t.audienceType === 'views-remarketing' ? 'VIEWS_REMARKETING' : t.audienceType === 'purchases-remarketing' ? 'PURCHASES_REMARKETING' : 'AUDIENCE'
        targets.push({ expression: sdTargetExpression({ kind: t.kind.toUpperCase(), value: t.value, audienceType, lookbackDays: t.lookbackDays ?? null }), bid: t.bidCents != null ? amountOf(t.bidCents) : null })
      } catch (error) {
        if (error instanceof SdTargetRefused) return { ok: false, error: `targets[${i}]: ${error.message}` }
        throw error
      }
    }
    if (a.costControl) {
      const min = Math.round(SD_RULE_MIN_THRESHOLD[COST_CONTROL[a.costControl.metric]] * 100)
      if (a.costControl.thresholdCents < min) return { ok: false, error: `Amazon's lowest ${a.costControl.metric} limit is ${money(min, m.currency)}.` }
    }
    const sandbox = sandboxRead()
    if (sandbox) return sandbox
    return sdAnswered('', async () => {
      const f = await sdForecast(m.ctx, {
        campaign: { startDate: amazonDay(a.startDate), endDate: a.endDate ? amazonDay(a.endDate) : null, costType: a.costType, budget: a.dailyBudgetCents != null ? amountOf(a.dailyBudgetCents) : null },
        adGroup: { bidOptimization: a.bidOptimization, creativeType: a.creativeType ? (a.creativeType.toUpperCase() as 'IMAGE' | 'VIDEO') : null, defaultBid: a.defaultBidCents != null ? amountOf(a.defaultBidCents) : null },
        skus: a.skus,
        targets,
        negatives: (a.negatives ?? []).map((n) => ({ type: n.kind === 'asin' ? 'asinSameAs' as const : 'asinBrandSameAs' as const, value: n.kind === 'asin' ? n.value.toUpperCase() : n.value })),
        costControl: a.costControl ? { metric: COST_CONTROL[a.costControl.metric], threshold: amountOf(a.costControl.thresholdCents) } : null,
      })
      const curve = f.budgetCurve.map((p) => ({ budgetCents: centsOf(p.budget), focus: p.focus, clicks: p.clicks, reach: p.reach }))
      // At most 12 points: evenly spaced, the focus point kept.
      const step = Math.max(1, Math.ceil(curve.length / 12))
      const shownCurve = curve.filter((p, i) => i % step === 0 || p.focus)
      return {
        ok: true,
        data: {
          market: m.market, currency: m.currency, status: f.status, says: f.status ? STATUS_WORDS[f.status] ?? f.status : null,
          bidOptimization: f.bidOptimization, lifetime: f.lifetime, weekly: f.weekly, daily: f.daily,
          ...(curve.length ? { budgetCurve: shownCurve, curveMeetsThreshold: f.curveMeetsThreshold } : {}),
          planned: { skus: a.skus.length, targets: targets.length, negatives: a.negatives?.length ?? 0, costControl: a.costControl ? `${a.costControl.metric} at most ${money(a.costControl.thresholdCents, m.currency)}` : null },
          note: `Amazon's forecast for ${m.market}: ranges from its models, not a promise. Nothing was made at Amazon.`,
        },
      }
    })
  },
}

export const ADS_SD_FORECAST_TOOLS: AgentTool[] = [sdForecastTool]
