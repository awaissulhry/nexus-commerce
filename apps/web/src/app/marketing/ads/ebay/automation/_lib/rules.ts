/**
 * ER3.2 — rule DSL mirrors (API: ebay-ads-automation.service.ts) + the label
 * maps and sentence renderer that make rules glass-box on the hub (C8: UI
 * speaks Amazon-style metric names; payloads keep server ids).
 */

export type RuleMetric = 'ad_fees_cents' | 'sales_cents' | 'clicks' | 'impressions' | 'sold_qty' | 'acos_pct' | 'ctr_pct' | 'fee_pct_of_sales' | 'rate_minus_breakeven'
export type RuleOp = 'gt' | 'gte' | 'lt' | 'lte'
export type RuleBenchmark = 'account_avg' | 'campaign_avg' | 'break_even'
export interface RuleCondition {
  metric: RuleMetric; windowDays: number; op: RuleOp; threshold?: number
  benchmark?: RuleBenchmark; multiplier?: number; excludeRecentDays?: number
}
export interface RuleTrigger { scope: 'CPS_AD' | 'CPC_KEYWORD'; all: RuleCondition[] }
export interface RuleActionDef {
  type: 'adjust_ad_rate' | 'set_rate_to_breakeven_factor' | 'pause_ad' | 'reactivate_ad' | 'pause_keyword' | 'bid_down_keyword' | 'alert'
  deltaPct?: number; factor?: number; minRatePct?: number; bidDeltaPct?: number
}
export interface AutomationRule {
  id: string; name: string; enabled: boolean; mode: string; marketplace: string | null
  scope: { campaignIds?: string[] } | null
  trigger: RuleTrigger; action: RuleActionDef; guardrails: Record<string, unknown> | null
  cooldownHours: number; lastEvaluatedAt: string | null; updatedAt?: string
  version?: number // ER5 — current config version
  executions?: Array<{ id?: string; status: string; evaluated: number; matched: number; proposed: number; applied: number; createdAt: string; ruleVersion?: number | null }>
}

/** ER5 — one immutable config snapshot (GET /automation/rules/:id/versions) */
export interface RuleVersionRow {
  id: string; version: number; name: string; marketplace: string | null
  scope: { campaignIds?: string[] } | null
  trigger: RuleTrigger; action: RuleActionDef; guardrails: Record<string, unknown> | null
  cooldownHours: number; changedBy: string | null; note: string | null; createdAt: string
}
export interface RuleTemplate { name: string; trigger: RuleTrigger; action: RuleActionDef; guardrails: object; cooldownHours: number }

export const METRIC_LABELS: Record<RuleMetric, string> = {
  ad_fees_cents: 'Ad fees', sales_cents: 'Ad sales', clicks: 'Clicks', impressions: 'Impressions',
  sold_qty: 'Sold', acos_pct: 'ACOS', ctr_pct: 'CTR', fee_pct_of_sales: 'Ad fees % of sales',
  rate_minus_breakeven: 'Rate − break-even',
}
export const OP_LABELS: Record<RuleOp, string> = { gt: '>', gte: '≥', lt: '<', lte: '≤' }
export const BENCH_LABELS: Record<RuleBenchmark, string> = { account_avg: 'account average', campaign_avg: 'campaign average', break_even: 'break-even' }
/** cents-denominated metrics take € in the editor, cents on the wire */
export const CENTS_METRICS: RuleMetric[] = ['ad_fees_cents', 'sales_cents']
export const PCT_METRICS: RuleMetric[] = ['acos_pct', 'ctr_pct', 'fee_pct_of_sales']

export const ACTIONS_FOR_SCOPE: Record<RuleTrigger['scope'], RuleActionDef['type'][]> = {
  CPS_AD: ['adjust_ad_rate', 'set_rate_to_breakeven_factor', 'pause_ad', 'reactivate_ad', 'alert'],
  CPC_KEYWORD: ['pause_keyword', 'bid_down_keyword', 'alert'],
}
export const ACTION_LABELS: Record<RuleActionDef['type'], string> = {
  adjust_ad_rate: 'Step the ad rate', set_rate_to_breakeven_factor: 'Set rate to break-even × factor',
  pause_ad: 'Remove the ad from its campaign', reactivate_ad: 'Re-promote the listing',
  pause_keyword: 'Pause the keyword', bid_down_keyword: 'Lower the keyword bid', alert: 'Alert only (no write)',
}

export function conditionValueLabel(c: RuleCondition): string {
  if (c.benchmark) {
    const m = c.multiplier ?? 1
    return m === 1 ? BENCH_LABELS[c.benchmark] : `${m}× ${BENCH_LABELS[c.benchmark]}`
  }
  const t = c.threshold ?? 0
  if (CENTS_METRICS.includes(c.metric)) return `€${(t / 100).toFixed(2)}`
  if (PCT_METRICS.includes(c.metric)) return `${t}%`
  if (c.metric === 'rate_minus_breakeven') return `${t} pts`
  return String(t)
}

export function conditionSentence(c: RuleCondition): string {
  const win = `over the last ${c.windowDays}d${c.excludeRecentDays ? ` (excl. last ${c.excludeRecentDays}d)` : ''}`
  return `${METRIC_LABELS[c.metric]} ${win} ${OP_LABELS[c.op]} ${conditionValueLabel(c)}`
}

export function actionSentence(a: RuleActionDef): string {
  switch (a.type) {
    case 'adjust_ad_rate': return `step the ad rate ${(a.deltaPct ?? -10) > 0 ? '+' : ''}${a.deltaPct ?? -10}% (floor ${a.minRatePct ?? 2}%, never above break-even)`
    case 'set_rate_to_breakeven_factor': return `set the rate to break-even × ${a.factor ?? 0.8} (floor ${a.minRatePct ?? 2}%)`
    case 'pause_ad': return 'remove the ad from its campaign'
    case 'reactivate_ad': return 're-promote the listing (only if live and in stock)'
    case 'pause_keyword': return 'pause the keyword'
    case 'bid_down_keyword': return `lower the keyword bid ${a.bidDeltaPct ?? -20}% (floor €0.02 / campaign floor)`
    case 'alert': return 'raise an operator alert (no write)'
  }
}

export function scopeLabel(r: Pick<AutomationRule, 'marketplace' | 'scope' | 'trigger'>): string {
  const n = r.scope?.campaignIds?.length ?? 0
  if (n > 0) return `${n} campaign${n === 1 ? '' : 's'}`
  return `Global · ${r.marketplace ? r.marketplace.replace('EBAY_', 'eBay ') : 'all eBay markets'}`
}

export const KIND_LABELS: Record<string, string> = {
  adjust_ad_rate: 'Rate step', pause_ad: 'Ad removal', reactivate_ad: 'Re-promote',
  pause_keyword: 'Keyword pause', bid_down_keyword: 'Bid down', add_negative: 'Negative keyword',
  alert: 'Alert', rate_discovery_step: 'Rate discovery', enroll_catch_all: 'Coverage',
}
export const kindLabel = (k: string): string => KIND_LABELS[k] ?? k.replace(/_/g, ' ')

/** ER3.2 — the Why payload written by the evaluator (conditionResults since ER3.2). */
export interface WhyReasoning {
  rule?: string; windowDays?: number; ratePct?: number | null; breakEven?: number | null
  clampNote?: string | null
  facts?: { impressions: number; clicks: number; adFeesCents: number; salesCents: number; soldQty: number }
  conditions?: RuleCondition[]
  conditionResults?: Array<RuleCondition & { value: number | null; cmp: number | null; pass: boolean | null }>
}
