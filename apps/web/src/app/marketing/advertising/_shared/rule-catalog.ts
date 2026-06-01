/** Shared catalogs for the advertising rule builder + library (AX3.8).
 *  Mirrors the AutomationRule engine contract: conditions [{field,op,value}],
 *  actions [{type, ...params}], one of 4 advertising triggers. */

export interface RuleTrigger { key: string; label: string; blurb: string }
export const TRIGGERS: RuleTrigger[] = [
  { key: 'SCHEDULE', label: '⏱ Scheduled (runs every 15 min)', blurb: 'Runs on a fixed cadence — for harvest/negate, retail guard, and other time-based automations.' },
  { key: 'AD_TARGET_UNDERPERFORMING', label: 'Target performance', blurb: 'Evaluate keyword/product targets on spend, sales, ACOS, orders.' },
  { key: 'CAC_SPIKE', label: 'ACOS / CAC spike', blurb: 'Fire when efficiency degrades beyond a threshold.' },
  { key: 'AD_SPEND_PROFITABILITY_BREACH', label: 'Profitability breach', blurb: 'Fire when ad-driven net margin goes negative.' },
  { key: 'FBA_AGE_THRESHOLD_REACHED', label: 'FBA aged stock', blurb: 'Fire as inventory approaches long-term-storage fees.' },
]

export interface ConditionField { field: string; label: string; hint: string }
export const CONDITION_FIELDS: ConditionField[] = [
  { field: 'campaign.acos', label: 'Campaign ACOS', hint: 'ratio — 0.30 = 30%' },
  { field: 'campaign.dailyBudget', label: 'Campaign daily budget', hint: '€ value' },
  { field: 'adTarget.spendCents', label: 'Target spend', hint: 'cents — 2000 = €20' },
  { field: 'adTarget.salesCents', label: 'Target sales', hint: 'cents' },
  { field: 'adTarget.bidCents', label: 'Target bid', hint: 'cents' },
  { field: 'adTarget.clicks', label: 'Target clicks', hint: 'count' },
  { field: 'adTarget.ordersCount', label: 'Target orders', hint: 'count' },
  { field: 'profit.netCents', label: 'Net profit', hint: 'cents — can be negative' },
  { field: 'fbaAge.daysToLtsThreshold', label: 'Days to LTS fee', hint: 'days' },
]

export const OPS: Array<{ op: string; label: string }> = [
  { op: 'gte', label: '≥' }, { op: 'gt', label: '>' }, { op: 'lte', label: '≤' },
  { op: 'lt', label: '<' }, { op: 'eq', label: '=' }, { op: 'ne', label: '≠' },
]

export interface ActionParam { key: string; label: string; type: 'number' | 'text' | 'select'; default?: string | number; options?: string[]; hint?: string }
export interface ActionType { type: string; label: string; blurb: string; params: ActionParam[] }
export const ACTION_TYPES: ActionType[] = [
  { type: 'bid_down', label: 'Lower bid', blurb: 'Reduce target/ad-group bid by %', params: [
    { key: 'target', label: 'Apply to', type: 'select', options: ['ad_target', 'ad_group'], default: 'ad_target' },
    { key: 'percent', label: 'Down %', type: 'number', default: 20 },
    { key: 'floorCents', label: 'Floor (¢)', type: 'number', default: 5 },
  ] },
  { type: 'bid_up', label: 'Raise bid', blurb: 'Increase target/ad-group bid by %', params: [
    { key: 'target', label: 'Apply to', type: 'select', options: ['ad_target', 'ad_group'], default: 'ad_target' },
    { key: 'percent', label: 'Up %', type: 'number', default: 15 },
  ] },
  { type: 'pause_ad_group', label: 'Pause ad group', blurb: 'Set the ad group to PAUSED', params: [] },
  { type: 'pause_campaign', label: 'Pause campaign', blurb: 'Set the campaign to PAUSED', params: [] },
  { type: 'adjust_ad_budget', label: 'Adjust budget', blurb: 'Change daily budget by % (or set value)', params: [
    { key: 'percent', label: 'Change %', type: 'number', default: 15, hint: 'positive = raise' },
  ] },
  { type: 'create_amazon_promotion', label: 'Create promotion', blurb: 'Launch a discount for the product', params: [
    { key: 'discountPct', label: 'Discount %', type: 'number', default: 15 },
    { key: 'durationDays', label: 'Duration (days)', type: 'number', default: 14 },
  ] },
  { type: 'liquidate_aged_stock', label: 'Liquidate aged stock', blurb: 'Promo + pause ads + boost budget combo', params: [
    { key: 'discountPct', label: 'Discount %', type: 'number', default: 15 },
    { key: 'durationDays', label: 'Duration (days)', type: 'number', default: 14 },
    { key: 'budgetBoostPct', label: 'Budget boost %', type: 'number', default: 25 },
  ] },
  { type: 'notify', label: 'Notify only', blurb: 'Alert the operator, no write', params: [
    { key: 'message', label: 'Message', type: 'text', default: 'Rule triggered' },
  ] },
  // AU.1
  { type: 'harvest_and_negate', label: '🌾 Harvest & negate keywords', blurb: 'Auto-negate wasters + promote converters to exact-match', params: [
    { key: 'windowDays', label: 'Look-back (days)', type: 'number', default: 60, hint: 'Search-term window' },
    { key: 'minSpendCents', label: 'Min waste spend (¢)', type: 'number', default: 1000, hint: '1000 = €10' },
    { key: 'minOrders', label: 'Min orders to graduate', type: 'number', default: 2 },
    { key: 'graduationBidEur', label: 'Starting bid for new exact (€)', type: 'number', default: 0.5 },
  ] },
  { type: 'resume_campaign', label: '▶ Resume campaign', blurb: 'Set a paused campaign back to ENABLED', params: [] },
  // AU.2
  { type: 'retail_guard', label: '🛡 Retail guard (pause OOS/lost Buy Box)', blurb: 'Pause campaigns advertising out-of-stock or Buy Box-lost products', params: [] },
]

export interface RuleTemplate {
  key: string; category: 'Sales' | 'Relevancy' | 'Other'; name: string; description: string
  trigger: string; conditions: Array<{ field: string; op: string; value: number }>
  actions: Array<Record<string, unknown>>
  maxExecutionsPerDay?: number; maxDailyAdSpendCentsEur?: number
}
export const TEMPLATES: RuleTemplate[] = [
  { key: 'reach-target-acos', category: 'Sales', name: 'Reach target ACOS', description: 'Lower bids on targets running above a 35% ACOS to pull efficiency back to goal.', trigger: 'CAC_SPIKE', conditions: [{ field: 'campaign.acos', op: 'gte', value: 0.35 }], actions: [{ type: 'bid_down', target: 'ad_target', percent: 20, floorCents: 5 }], maxExecutionsPerDay: 50 },
  { key: 'cut-wasted-spend', category: 'Sales', name: 'Cut wasted spend', description: 'Pause targets that have spent €20+ with zero orders.', trigger: 'AD_TARGET_UNDERPERFORMING', conditions: [{ field: 'adTarget.spendCents', op: 'gte', value: 2000 }, { field: 'adTarget.salesCents', op: 'eq', value: 0 }], actions: [{ type: 'pause_ad_group' }, { type: 'notify', message: 'Paused wasteful target' }], maxExecutionsPerDay: 30 },
  { key: 'scale-winners', category: 'Sales', name: 'Scale winners (+budget)', description: 'Raise budget 15% on campaigns under 20% ACOS that are spending well.', trigger: 'AD_TARGET_UNDERPERFORMING', conditions: [{ field: 'campaign.acos', op: 'lte', value: 0.2 }, { field: 'adTarget.spendCents', op: 'gte', value: 5000 }], actions: [{ type: 'adjust_ad_budget', percent: 15 }], maxExecutionsPerDay: 10, maxDailyAdSpendCentsEur: 20000 },
  { key: 'raise-converters', category: 'Relevancy', name: 'Raise bids on strong converters', description: 'Push bids up 15% on targets with 2+ orders and healthy ACOS.', trigger: 'AD_TARGET_UNDERPERFORMING', conditions: [{ field: 'adTarget.ordersCount', op: 'gte', value: 2 }, { field: 'campaign.acos', op: 'lte', value: 0.25 }], actions: [{ type: 'bid_up', target: 'ad_target', percent: 15 }], maxExecutionsPerDay: 30 },
  { key: 'defend-margin', category: 'Other', name: 'Defend margin (alert)', description: 'Alert when ad-driven net margin turns negative — no automated write.', trigger: 'AD_SPEND_PROFITABILITY_BREACH', conditions: [{ field: 'profit.netCents', op: 'lt', value: 0 }], actions: [{ type: 'notify', message: 'Negative ad margin detected' }], maxExecutionsPerDay: 10 },
  { key: 'liquidate-aged', category: 'Other', name: 'Liquidate aged stock', description: 'As stock nears LTS fees, run a promo, pause ads, and boost budget to clear it.', trigger: 'FBA_AGE_THRESHOLD_REACHED', conditions: [{ field: 'fbaAge.daysToLtsThreshold', op: 'lte', value: 14 }], actions: [{ type: 'liquidate_aged_stock', discountPct: 15, durationDays: 14, budgetBoostPct: 25 }], maxExecutionsPerDay: 20, maxDailyAdSpendCentsEur: 10000 },
  // AU.1 — Harvest & negate (scheduled)
  { key: 'auto-harvest-negate', category: 'Sales', name: '🌾 Auto harvest & negate', description: 'Every tick: negate search terms that spent €10+ with zero orders; promote terms with 2+ orders to exact-match campaigns. The #1 way to stop wasted spend.', trigger: 'SCHEDULE', conditions: [], actions: [{ type: 'harvest_and_negate', windowDays: 60, minSpendCents: 1000, minOrders: 2, graduationBidEur: 0.5 }, { type: 'notify', message: 'Harvest & negate ran — check execution log for terms moved' }], maxExecutionsPerDay: 3 },
  // AU.2 — Retail guard (scheduled)
  { key: 'retail-guard', category: 'Sales', name: '🛡 Retail guard', description: 'Every 15 min: automatically pause campaigns advertising out-of-stock products or products that lost the Buy Box — so you never pay for traffic you can\'t convert.', trigger: 'SCHEDULE', conditions: [], actions: [{ type: 'retail_guard' }, { type: 'notify', message: 'Retail guard paused campaign(s) — check execution log' }], maxExecutionsPerDay: 96 },
]
