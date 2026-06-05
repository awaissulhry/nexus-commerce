/**
 * RC6.3 — the full engine vocabulary, in one place. The old RuleBuilder exposed
 * only 6 triggers / 10 fields / 8 actions; this is the complete surface the
 * evaluator + action handlers actually support (verified against the backend
 * ALLOWED_TRIGGERS, the 86-automation catalogue, and conditions-tree.ts):
 *   · 19 triggers   · 19 condition fields   · 9 operators   · 26 actions
 * Human units (%, €, ×, days) convert to the engine's raw values on save.
 */

export type FieldUnit = 'ratio' | 'pct' | 'eur' | 'roas' | 'num' | 'days'
export type Entity = 'campaign' | 'adGroup' | 'adTarget' | 'searchTerm' | 'profit' | 'budget' | 'fbaAge' | 'schedule'

export interface TriggerDef { t: string; label: string; hint: string; entity: Entity }
export interface FieldDef { f: string; label: string; unit: FieldUnit; entity: Entity }
export interface OpDef { v: string; l: string; numeric: boolean }
export type ParamKind = 'pct' | 'eur' | 'num' | 'days' | 'sel' | 'text'
export interface ActionParam { k: string; label: string; kind: ParamKind; def: number | string; options?: Array<{ v: string; l: string }>; save?: 'ratio' | 'cents'; hint?: string }
export interface ActionDef { t: string; label: string; cat: string; params: ActionParam[]; desc: string }

// ── Triggers (19) — exactly the backend ALLOWED_TRIGGERS set ──────────────────
export const TRIGGERS: TriggerDef[] = [
  { t: 'CAC_SPIKE', label: 'Campaign ACOS spikes', hint: 'Runs when a campaign’s ACOS / CPC climbs.', entity: 'campaign' },
  { t: 'CAMPAIGN_PERFORMANCE_BUDGET', label: 'Campaign performance / budget', hint: 'ROAS, ACOS, spend or budget-use per campaign.', entity: 'campaign' },
  { t: 'CAMPAIGN_ROAS_DECLINING', label: 'Campaign ROAS declining', hint: 'Week-over-week ROAS decline per campaign.', entity: 'campaign' },
  { t: 'CAMPAIGN_NO_SALES', label: 'Campaign spending with no sales', hint: 'Spend accrues with zero orders.', entity: 'campaign' },
  { t: 'NEW_TO_BRAND_WINNER', label: 'New-to-brand winner', hint: 'Campaign winning new-to-brand customers.', entity: 'campaign' },
  { t: 'CVR_DROP', label: 'Conversion-rate drop', hint: 'A campaign’s conversion rate drops sharply.', entity: 'campaign' },
  { t: 'AD_GROUP_UNDERPERFORMING', label: 'Ad group underperforming', hint: 'Ad-group spend vs sales / ACOS.', entity: 'adGroup' },
  { t: 'AD_TARGET_UNDERPERFORMING', label: 'Target underperforming', hint: 'Per keyword / ASIN target spend vs sales.', entity: 'adTarget' },
  { t: 'KEYWORD_WASTED_SPEND', label: 'Keyword wasting spend', hint: 'A keyword spends without converting.', entity: 'adTarget' },
  { t: 'KEYWORD_HIGH_ACOS', label: 'Keyword high ACOS', hint: 'Converts, but at too high an ACOS.', entity: 'adTarget' },
  { t: 'KEYWORD_LOW_CTR', label: 'Keyword low CTR', hint: 'Chronically low click-through rate.', entity: 'adTarget' },
  { t: 'KEYWORD_ZERO_IMPRESSIONS', label: 'Keyword starved (no impressions)', hint: 'Gets (almost) no impressions.', entity: 'adTarget' },
  { t: 'KEYWORD_SCALE_OPPORTUNITY', label: 'Keyword scale opportunity', hint: 'A proven winner with headroom to grow.', entity: 'adTarget' },
  { t: 'KEYWORD_RISING_STAR', label: 'Keyword rising star', hint: 'A keyword whose orders are accelerating.', entity: 'adTarget' },
  { t: 'SEARCH_TERM_CONVERTING', label: 'Search term converting', hint: 'An auto/broad search term starts converting.', entity: 'searchTerm' },
  { t: 'SEARCH_TERM_WASTING', label: 'Search term wasting spend', hint: 'A search term burns spend with no orders.', entity: 'searchTerm' },
  { t: 'AD_SPEND_PROFITABILITY_BREACH', label: 'Profitability breach', hint: 'Ad spend overtakes true product profit.', entity: 'profit' },
  { t: 'FBA_AGE_THRESHOLD_REACHED', label: 'FBA stock ageing', hint: 'A SKU nears long-term-storage age.', entity: 'fbaAge' },
  { t: 'SCHEDULE', label: 'On a schedule', hint: 'Runs the action on a cadence — engine actions, caps, sweeps.', entity: 'schedule' },
]

// ── Condition fields (19) ─────────────────────────────────────────────────────
export const FIELDS: FieldDef[] = [
  { f: 'campaign.acos', label: 'Campaign ACOS', unit: 'ratio', entity: 'campaign' },
  { f: 'campaign.roas', label: 'Campaign ROAS', unit: 'roas', entity: 'campaign' },
  { f: 'campaign.spendCents', label: 'Campaign spend', unit: 'eur', entity: 'campaign' },
  { f: 'campaign.budgetUtilization', label: 'Budget used', unit: 'ratio', entity: 'campaign' },
  { f: 'campaign.declinePct', label: 'Campaign ROAS decline', unit: 'pct', entity: 'campaign' },
  { f: 'campaign.ntbOrders', label: 'New-to-brand orders', unit: 'num', entity: 'campaign' },
  { f: 'adGroup.acos', label: 'Ad-group ACOS', unit: 'ratio', entity: 'adGroup' },
  { f: 'adGroup.spendCents', label: 'Ad-group spend', unit: 'eur', entity: 'adGroup' },
  { f: 'adGroup.salesCents', label: 'Ad-group sales', unit: 'eur', entity: 'adGroup' },
  { f: 'adTarget.acos', label: 'Target ACOS', unit: 'ratio', entity: 'adTarget' },
  { f: 'adTarget.roas', label: 'Target ROAS', unit: 'roas', entity: 'adTarget' },
  { f: 'adTarget.spendCents', label: 'Target spend', unit: 'eur', entity: 'adTarget' },
  { f: 'adTarget.salesCents', label: 'Target sales', unit: 'eur', entity: 'adTarget' },
  { f: 'adTarget.orders', label: 'Target orders', unit: 'num', entity: 'adTarget' },
  { f: 'adTarget.growthPct', label: 'Target order growth', unit: 'pct', entity: 'adTarget' },
  { f: 'searchTerm.spendCents', label: 'Search-term spend', unit: 'eur', entity: 'searchTerm' },
  { f: 'profit.netCents', label: 'Net profit', unit: 'eur', entity: 'profit' },
  { f: 'budget.monthlySpendCents', label: 'Month-to-date spend', unit: 'eur', entity: 'budget' },
  { f: 'fbaAge.daysToLtsThreshold', label: 'Days to long-term storage', unit: 'days', entity: 'fbaAge' },
]

// ── Operators (9) — numeric-relevant first ────────────────────────────────────
export const OPS: OpDef[] = [
  { v: 'gte', l: '≥', numeric: true },
  { v: 'lte', l: '≤', numeric: true },
  { v: 'gt', l: '>', numeric: true },
  { v: 'lt', l: '<', numeric: true },
  { v: 'eq', l: '=', numeric: true },
  { v: 'ne', l: '≠', numeric: true },
  { v: 'in', l: 'in list', numeric: false },
  { v: 'contains', l: 'contains', numeric: false },
  { v: 'exists', l: 'exists', numeric: false },
]

// ── Actions (26) ──────────────────────────────────────────────────────────────
const sel = (k: string, label: string, options: Array<{ v: string; l: string }>, def: string): ActionParam => ({ k, label, kind: 'sel', def, options })
const pct = (k: string, label: string, def: number, save?: 'ratio'): ActionParam => ({ k, label, kind: 'pct', def, save })
const eur = (k: string, label: string, def: number, save?: 'cents'): ActionParam => ({ k, label, kind: 'eur', def, save })
const num = (k: string, label: string, def: number): ActionParam => ({ k, label, kind: 'num', def })
const days = (k: string, label: string, def: number): ActionParam => ({ k, label, kind: 'days', def })
const text = (k: string, label: string): ActionParam => ({ k, label, kind: 'text', def: '' })
const SCOPE = sel('target', 'Scope', [{ v: 'ad_group', l: 'Ad group' }, { v: 'keyword', l: 'Keyword' }], 'ad_group')

export const ACTIONS: ActionDef[] = [
  // Bidding
  { t: 'bid_down', label: 'Lower bids', cat: 'Bidding', desc: 'Reduce the bid by a percentage.', params: [SCOPE, pct('percent', 'Lower by', 20)] },
  { t: 'bid_up', label: 'Raise bids', cat: 'Bidding', desc: 'Increase the bid by a percentage.', params: [SCOPE, pct('percent', 'Raise by', 15)] },
  { t: 'lower_bid_to_floor', label: 'Drop bids to the floor', cat: 'Bidding', desc: 'Cut the bid to the €0.05 floor — keep presence, kill the bleed.', params: [] },
  { t: 'raise_bids_for_rank_defense', label: 'Raise bids to defend rank', cat: 'Bidding', desc: 'Push priority-keyword bids up to protect ranking.', params: [pct('percent', 'Raise by', 15)] },
  { t: 'scale_bids_for_price_change', label: 'Re-bid for price change', cat: 'Bidding', desc: 'Rescale bids when the product price changes so ACOS stays consistent.', params: [] },
  { t: 'bid_to_target_acos', label: 'Optimise bids to target ACOS', cat: 'Bidding', desc: 'Tune every bid toward an ACOS target (profit-native or fixed).', params: [sel('acosMode', 'Mode', [{ v: 'profit', l: 'Profit-native' }, { v: 'fixed', l: 'Fixed target' }], 'profit'), pct('targetAcos', 'Target ACOS (fixed mode)', 30, 'ratio')] },
  { t: 'set_campaign_target_acos', label: 'Set campaign target ACOS', cat: 'Bidding', desc: 'Set the campaign-level target ACOS the engine bids toward.', params: [pct('targetAcos', 'Target ACOS', 30, 'ratio')] },
  // Budget
  { t: 'adjust_ad_budget', label: 'Adjust budget by % (±)', cat: 'Budget', desc: 'Raise or lower the daily budget by a percentage (negative trims).', params: [pct('percent', 'Adjust by', 20)] },
  { t: 'set_daily_budget', label: 'Set daily budget', cat: 'Budget', desc: 'Pin the daily budget to an exact amount.', params: [eur('budgetEur', 'Budget €/day', 20)] },
  { t: 'reroute_marketplace_budget', label: 'Reroute budget to best market', cat: 'Budget', desc: 'Shift budget toward the best-returning marketplaces.', params: [] },
  // State
  { t: 'pause_campaign', label: 'Pause the campaign', cat: 'State', desc: 'Pause the matching campaign.', params: [] },
  { t: 'resume_campaign', label: 'Resume the campaign', cat: 'State', desc: 'Resume a paused campaign.', params: [] },
  { t: 'enable_campaign', label: 'Enable the campaign', cat: 'State', desc: 'Enable the campaign.', params: [] },
  { t: 'pause_ad_group', label: 'Pause the ad group', cat: 'State', desc: 'Pause the matching ad group (coarse but decisive).', params: [] },
  { t: 'pause_all_campaigns', label: 'Pause ALL campaigns (failsafe)', cat: 'State', desc: 'Pause every campaign — a guaranteed spend failsafe.', params: [] },
  // Pruning & negation
  { t: 'archive_keyword', label: 'Archive the keyword', cat: 'Pruning', desc: 'Permanently archive the keyword (clean, not just pause).', params: [] },
  { t: 'add_negative_exact', label: 'Add negative-exact keyword', cat: 'Negation', desc: 'Add the term as a negative-exact so it stops costing you.', params: [] },
  { t: 'sync_negatives_across_campaigns', label: 'Sync negatives across campaigns', cat: 'Negation', desc: 'Propagate every negative to all relevant campaigns.', params: [] },
  // Harvesting
  { t: 'promote_to_exact', label: 'Promote to exact keyword', cat: 'Harvesting', desc: 'Graduate a converting search term into its own exact keyword.', params: [num('minOrders', 'Min orders', 2), eur('bidEur', 'Start bid €', 0.5)] },
  { t: 'harvest_and_negate', label: 'Harvest & negate search terms', cat: 'Harvesting', desc: 'Promote converting terms and negate wasteful ones in one pass.', params: [days('windowDays', 'Look-back window', 60), num('minOrders', 'Promote ≥ orders', 2), eur('minSpendCents', 'Negate ≥ spend €', 10, 'cents')] },
  // Inventory
  { t: 'retail_guard', label: 'Retail guard (stock & Buy Box)', cat: 'Inventory', desc: 'Pause ads on out-of-stock / lost-Buy-Box products; resume when healthy.', params: [] },
  { t: 'liquidate_aged_stock', label: 'Liquidate aged stock', cat: 'Inventory', desc: 'Push ads / promotions to clear stock nearing long-term storage.', params: [] },
  { t: 'create_amazon_promotion', label: 'Create a promotion', cat: 'Inventory', desc: 'Create an Amazon promotion (e.g. to move aged stock).', params: [pct('percent', 'Discount %', 10)] },
  // Placement
  { t: 'set_placement_multiplier', label: 'Set placement bid multiplier', cat: 'Placement', desc: 'Tune the bid multiplier for a placement (e.g. Top of Search).', params: [pct('multiplier', 'Multiplier %', 50)] },
  // Alerting
  { t: 'notify', label: 'Notify me', cat: 'Alert', desc: 'Send a notification — no campaign change.', params: [text('message', 'Message')] },
  { t: 'alert_operator', label: 'Alert operator (urgent)', cat: 'Alert', desc: 'Raise an urgent operator alert — no campaign change.', params: [text('message', 'Message')] },
]

// ── Helpers ───────────────────────────────────────────────────────────────────
export const fieldDef = (f: string) => FIELDS.find((x) => x.f === f)
export const triggerDef = (t: string) => TRIGGERS.find((x) => x.t === t)
export const actionDef = (t: string) => ACTIONS.find((x) => x.t === t)

export const fieldSuffix = (u: FieldUnit) => (u === 'eur' ? '€' : u === 'ratio' || u === 'pct' ? '%' : u === 'roas' ? '×' : u === 'days' ? 'days' : '')
export const paramSuffix = (k: ParamKind) => (k === 'eur' ? '€' : k === 'pct' ? '%' : k === 'days' ? 'days' : '')

/** Suggested fields for a trigger: same-entity fields first, then schedule/budget
 *  caps, then everything (so Advanced users are never boxed in). */
export function suggestedFields(trigger: string): FieldDef[] {
  const ent = triggerDef(trigger)?.entity
  if (!ent || ent === 'schedule') return [...FIELDS]
  const same = FIELDS.filter((f) => f.entity === ent)
  const rest = FIELDS.filter((f) => f.entity !== ent)
  return [...same, ...rest]
}

/** UI value → engine raw, by field unit. */
export function condToRaw(unit: FieldUnit, v: number): number {
  if (unit === 'ratio') return v / 100
  if (unit === 'eur') return Math.round(v * 100)
  return v // pct (raw %), roas, num, days
}
export function condFromRaw(unit: FieldUnit, raw: number): number {
  if (unit === 'ratio') return raw * 100
  if (unit === 'eur') return raw / 100
  return raw
}

/** UI value → engine raw, by action param. */
export function paramToRaw(p: ActionParam, v: string): unknown {
  if (p.kind === 'text' || p.kind === 'sel') return v
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  if (p.save === 'ratio') return n / 100
  if (p.save === 'cents') return Math.round(n * 100)
  return n
}

/** Plain-English fragment for an action + its params (for the live preview). */
export function actionPhrase(type: string, params: Record<string, string>): string {
  const d = actionDef(type)
  if (!d) return type.replace(/_/g, ' ')
  const bits: string[] = []
  for (const p of d.params) {
    const raw = params[p.k]
    if (raw == null || raw === '') continue
    if (p.kind === 'sel') { const o = p.options?.find((x) => x.v === raw); bits.push(o?.l ?? raw); continue }
    if (p.kind === 'text') continue
    bits.push(`${raw}${paramSuffix(p.kind)}`)
  }
  return bits.length ? `${d.label.toLowerCase()} (${bits.join(', ')})` : d.label.toLowerCase()
}
