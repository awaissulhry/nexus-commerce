/** Shared catalogs for the advertising rule builder + library (AX3.8).
 *  Mirrors the AutomationRule engine contract: conditions [{field,op,value}],
 *  actions [{type, ...params}], one of 4 advertising triggers. */

export interface RuleTrigger { key: string; label: string; blurb: string }
export const TRIGGERS: RuleTrigger[] = [
  { key: 'SCHEDULE', label: '⏱ Scheduled (every 15 min)', blurb: 'Runs on a fixed cadence — harvest, retail guard, bid optimization, budget cap.' },
  { key: 'AD_TARGET_UNDERPERFORMING', label: 'Target underperforming', blurb: 'Fire on keyword/product targets with poor spend, sales, ACOS, or orders.' },
  { key: 'CAC_SPIKE', label: 'ACOS / CAC spike', blurb: 'Fire when campaign efficiency degrades beyond a threshold.' },
  { key: 'AD_SPEND_PROFITABILITY_BREACH', label: 'Profitability breach', blurb: 'Fire when ad-driven net margin goes negative.' },
  { key: 'FBA_AGE_THRESHOLD_REACHED', label: 'FBA aged stock', blurb: 'Fire as inventory approaches long-term-storage fees.' },
  { key: 'CAMPAIGN_PERFORMANCE_BUDGET', label: 'Campaign budget/ROAS', blurb: 'Fire based on campaign-level spend, ROAS, and budget utilisation.' },
  { key: 'KEYWORD_ZERO_IMPRESSIONS', label: '🔇 Zero impressions', blurb: 'Fire when a keyword spends money but gets ZERO impressions — delivery failure signal.' },
  { key: 'KEYWORD_LOW_CTR', label: '📉 Low CTR', blurb: 'Fire when CTR drops below 0.2% with 500+ impressions — irrelevant traffic.' },
  { key: 'CVR_DROP', label: '📊 Conversion rate drop', blurb: 'Fire when CVR drops >40% week-over-week — competitor or listing issue.' },
  { key: 'KEYWORD_WASTED_SPEND', label: '🗑️ Wasted keyword', blurb: 'Fire when a keyword spends above threshold with zero orders in 14 days.' },
  { key: 'SEARCH_TERM_CONVERTING', label: '🎯 Converting search term', blurb: 'Fire when a broad/auto search term reaches min orders — ready for exact promotion.' },
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
  // AU.4 — budget failsafe (available on SCHEDULE trigger)
  { field: 'budget.monthlySpendCents', label: 'Monthly ad spend (¢)', hint: '100000 = €1,000' },
  // New precision trigger fields
  { field: 'adTarget.impressions', label: 'Target impressions', hint: 'count in window' },
  { field: 'adTarget.ctr', label: 'Target CTR', hint: 'ratio — 0.002 = 0.2%' },
  { field: 'adTarget.currentCvr', label: 'Current CVR', hint: 'ratio — 0.05 = 5%' },
  { field: 'adTarget.previousCvr', label: 'Previous week CVR', hint: 'ratio for CVR_DROP trigger' },
  { field: 'adTarget.spendCents', label: 'Target spend (¢)', hint: '1000 = €10' },
  { field: 'adTarget.clicks', label: 'Target clicks', hint: 'count' },
  { field: 'searchTerm.orders', label: 'Search term orders', hint: 'count — for SEARCH_TERM_CONVERTING' },
  { field: 'searchTerm.spendCents', label: 'Search term spend (¢)', hint: 'for SEARCH_TERM_CONVERTING' },
  { field: 'campaign.roas', label: 'Campaign ROAS', hint: 'ratio — 5 = 5× return' },
  { field: 'campaign.budgetUtilization', label: 'Budget utilization', hint: 'ratio — 0.9 = 90% used' },
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
  // AU.4
  { type: 'pause_all_campaigns', label: '⛔ Pause ALL campaigns (budget kill-switch)', blurb: 'Immediately pause every enabled campaign — use as a hard monthly spend cap', params: [
    { key: 'reason', label: 'Reason note', type: 'text', default: 'Monthly budget cap reached' },
  ] },
  // AU.6
  { type: 'set_placement_multiplier', label: '📍 Set placement bid multiplier', blurb: 'Adjust the Top-of-Search (or other) placement bid % for a campaign', params: [
    { key: 'placement', label: 'Placement', type: 'select', options: ['PLACEMENT_TOP', 'PLACEMENT_PRODUCT_PAGE', 'PLACEMENT_REST_OF_SEARCH'], default: 'PLACEMENT_TOP' },
    { key: 'percentage', label: 'Bid adjustment %', type: 'number', default: 30, hint: '0–900; 0 = remove boost' },
  ] },
  { type: 'add_negative_exact', label: '🚫 Negate keyword (exact)', blurb: 'Add a specific term as NEGATIVE EXACT to the campaign', params: [
    { key: 'keyword', label: 'Keyword to negate', type: 'text', default: '' },
  ] },
  { type: 'promote_to_exact', label: '⬆️ Promote search term → exact', blurb: 'Create exact-match keyword from a converting search term', params: [
    { key: 'bidEur', label: 'Starting bid (€)', type: 'number', default: 0.5 },
  ] },
  { type: 'sync_negatives_across_campaigns', label: '🌐 Negate across ALL campaigns', blurb: 'Add a wasted keyword as negative to every campaign in the marketplace', params: [] },
  { type: 'set_campaign_target_acos', label: '🎯 Set target ACOS for campaign', blurb: 'Update the campaign\'s profit-based target ACOS used by bid optimization', params: [
    { key: 'targetAcos', label: 'Target ACOS', type: 'number', default: 0.3, hint: '0.30 = 30%' },
  ] },
  { type: 'set_daily_budget', label: '💰 Set daily budget (fixed €)', blurb: 'Set a campaign\'s daily budget to a specific value', params: [
    { key: 'budgetEur', label: 'Daily budget (€)', type: 'number', default: 50 },
  ] },
  { type: 'enable_campaign', label: '▶️ Enable campaign', blurb: 'Re-enable a paused campaign', params: [] },
  { type: 'archive_keyword', label: '🗄️ Archive keyword (permanent)', blurb: 'Permanently archive a keyword — stronger than pausing', params: [] },
  { type: 'lower_bid_to_floor', label: '⬇️ Lower bid to minimum', blurb: 'Set bid to €0.05 floor — keeps data flowing, minimizes waste', params: [
    { key: 'floorCents', label: 'Floor bid (¢)', type: 'number', default: 5, hint: '5 = €0.05' },
  ] },
  { type: 'raise_bids_for_rank_defense', label: '🛡️ Raise bids for rank defense', blurb: 'Raise ALL keyword bids in a campaign to defend position', params: [
    { key: 'percent', label: 'Raise %', type: 'number', default: 20 },
  ] },
  { type: 'scale_bids_for_price_change', label: '💱 Scale bids for price change', blurb: 'Proportionally adjust bids when product price changes', params: [
    { key: 'oldPriceEur', label: 'Old price (€)', type: 'number', default: 0 },
    { key: 'newPriceEur', label: 'New price (€)', type: 'number', default: 0 },
  ] },
  { type: 'alert_operator', label: '🔔 Alert (with severity)', blurb: 'Send an alert with severity level: info, warning, critical', params: [
    { key: 'severity', label: 'Severity', type: 'select', options: ['info', 'warning', 'critical'], default: 'info' },
    { key: 'message', label: 'Message', type: 'text', default: 'Automation triggered' },
  ] },
  // Core automation
  { type: 'bid_to_target_acos', label: '🎯 Optimize bids to target ACOS', blurb: 'Adjust keyword bids toward profit-based targets (Bayesian-smoothed for sparse keywords)', params: [
    { key: 'profitMode', label: 'Profit-native mode', type: 'select', options: ['true', 'false'], default: 'true' },
    { key: 'bayesian', label: 'Bayesian sparse handling', type: 'select', options: ['true', 'false'], default: 'true' },
    { key: 'acosMode', label: 'Lifecycle', type: 'select', options: ['profit', 'balanced', 'growth'], default: 'profit' },
  ] },
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
  { key: 'bid-optimization', category: 'Sales', name: '🎯 Bid optimization (profit-native)', description: 'Runs twice daily: adjusts every keyword bid toward its product\'s true profit-based ACOS target using Bayesian smoothing for low-data keywords. This is what Pacvue and Perpetua charge €500+/mo for.', trigger: 'SCHEDULE', conditions: [], actions: [{ type: 'bid_to_target_acos', profitMode: true, bayesian: true, acosMode: 'profit' }], maxExecutionsPerDay: 2 },
  // AU.1 — Harvest & negate (scheduled)
  { key: 'auto-harvest-negate', category: 'Sales', name: '🌾 Auto harvest & negate', description: 'Every tick: negate search terms that spent €10+ with zero orders; promote terms with 2+ orders to exact-match campaigns. The #1 way to stop wasted spend.', trigger: 'SCHEDULE', conditions: [], actions: [{ type: 'harvest_and_negate', windowDays: 60, minSpendCents: 1000, minOrders: 2, graduationBidEur: 0.5 }, { type: 'notify', message: 'Harvest & negate ran — check execution log for terms moved' }], maxExecutionsPerDay: 3 },
  // AU.2 — Retail guard (scheduled)
  { key: 'retail-guard', category: 'Sales', name: '🛡 Retail guard', description: 'Every 15 min: automatically pause campaigns advertising out-of-stock products or products that lost the Buy Box — so you never pay for traffic you can\'t convert.', trigger: 'SCHEDULE', conditions: [], actions: [{ type: 'retail_guard' }, { type: 'notify', message: 'Retail guard paused campaign(s) — check execution log' }], maxExecutionsPerDay: 96 },
  // AU.4 — budget failsafe
  { key: 'monthly-budget-cap', category: 'Other', name: '⛔ Monthly budget cap', description: 'Instantly pause ALL campaigns the moment your monthly ad spend hits your cap. Guaranteed never-overspend. Set your cap in the condition.', trigger: 'SCHEDULE', conditions: [{ field: 'budget.monthlySpendCents', op: 'gte', value: 200000 }], actions: [{ type: 'pause_all_campaigns', reason: 'Monthly budget cap reached' }, { type: 'notify', message: '⛔ Monthly budget cap hit — all campaigns paused' }], maxExecutionsPerDay: 96 },
]
