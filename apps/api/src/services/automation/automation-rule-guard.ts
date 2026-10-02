/**
 * R9 (MCP full control, part 06 §3 and gap 4) — what a rule Claude saves must be. Pure: no reads, no writes.
 *
 * The ads rule routes take any `actions` / `conditions` (a trigger allowlist only), and four silent failures are on
 * record (memory reference_four_inert_ads_rules): a cap of 0 refuses everything; `targetAcos: 30` instead of 0.3; a
 * condition on a field the trigger never hands the rule never matches; an empty condition list matches everything.
 * A rule Claude saves is refused, in words, for each of them, and for:
 *   · any action Claude may not automate — every pause above all (Owner rule: lower bids, never pause), with the
 *     substitute (no-pause.ts) — and any action outside the allowlist of its kind;
 *   · a missing scope: the whole account must be said (`wholeAccount: true`), never implied;
 *   · missing caps: runs per day, writes per day and value per run are required and above 0.
 *
 * Engine-native shapes only: conditions are flat `{ field, op, value }` leaves (what every stored rule holds), actions
 * `{ type, …params }`. The rule builder's nested shape stays the builder's.
 */
import { refusedActionsOf } from './no-pause.js'
import { ADS_TRIGGER_FIELDS, FRACTION_MAX, MARKETING_TRIGGER_FIELDS } from './ads-trigger-fields.js'

export type RuleKind = 'amazon-ads' | 'ebay-ads' | 'marketing'
export const RULE_KINDS: readonly RuleKind[] = ['amazon-ads', 'ebay-ads', 'marketing']

export interface RuleScope {
  marketplace?: string | null
  portfolioId?: string | null
  campaignId?: string | null
  productId?: string | null
  /** eBay: the campaigns it may act on. */
  campaignIds?: string[] | null
  /** The whole account, said out loud. */
  wholeAccount?: boolean
}

export interface RuleCaps {
  maxExecutionsPerDay?: number | null
  maxWritesPerDay?: number | null
  maxValueCentsEur?: number | null
  maxDailyAdSpendCentsEur?: number | null
}

/** A rule as Claude saves it: the merged result of an edit, or a new rule. */
export interface RuleDraft {
  kind: RuleKind
  name?: string
  trigger?: unknown
  conditions?: unknown
  actions?: unknown
  /** eBay: one action. */
  action?: unknown
  /** eBay: the run's own limits. */
  guardrails?: unknown
  scope?: RuleScope | null
  caps?: RuleCaps | null
}

/** The actions a Claude rule of each kind may carry (plan part 06 §3: bids, budgets, placements, negatives, harvest, retail guard, notify). */
export const ALLOWED_ACTIONS: Record<RuleKind, ReadonlySet<string>> = {
  'amazon-ads': new Set([
    'bid_down', 'bid_up', 'bid_apply', 'lower_bid_to_floor', 'bid_to_target_acos', 'scale_bids_for_price_change', 'raise_bids_for_rank_defense',
    'adjust_ad_budget', 'budget_apply', 'set_daily_budget', 'pace_budget', 'set_campaign_target_acos',
    'placement_apply', 'set_placement_multiplier', 'defend_top_of_search',
    'add_negative_exact', 'add_negative_phrase', 'sync_negatives_across_campaigns', 'promote_to_exact', 'harvest_and_negate',
    'retail_guard', 'notify', 'alert_operator', 'log_only',
  ]),
  'ebay-ads': new Set(['adjust_ad_rate', 'set_rate_to_breakeven_factor', 'bid_down_keyword', 'alert']),
  marketing: new Set(['mkt_set_budget', 'mkt_adjust_budget', 'notify', 'alert_operator', 'log_only']),
}

const OPS = new Set(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'contains', 'exists'])
/** Action parameters that are ratios: a fraction (0.3), never a percent (30). */
const FRACTION_PARAMS = ['targetAcos', 'acos', 'maxAcos', 'targetRoasFloor']
/** The largest believable fraction: an ACOS of 500 %. Above it, a percent was written where a fraction belongs. */
const MAX_FRACTION = 5

const isObject = (v: unknown): v is Record<string, unknown> => v != null && typeof v === 'object' && !Array.isArray(v)
const posInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0

/** The action types of a draft, in order. */
export function draftActionTypes(draft: RuleDraft): string[] {
  const list = draft.kind === 'ebay-ads' ? [draft.action] : Array.isArray(draft.actions) ? draft.actions : []
  return list.map((a) => (isObject(a) ? String(a.type ?? '') : '')).filter(Boolean)
}

function scopeProblems(draft: RuleDraft): string[] {
  const s = draft.scope ?? {}
  const named = draft.kind === 'ebay-ads'
    ? Boolean(s.marketplace || (s.campaignIds && s.campaignIds.length))
    : draft.kind === 'marketing'
      ? Boolean(s.marketplace)
      : Boolean(s.marketplace || s.portfolioId || s.campaignId || s.productId)
  const out: string[] = []
  if (!named && s.wholeAccount !== true) {
    out.push(draft.kind === 'ebay-ads'
      ? 'scope: name the campaigns (campaignIds) or the market (marketplace) it may act on, or say wholeAccount: true'
      : draft.kind === 'marketing'
        ? 'scope: name the market (marketplace) it may act on, or say wholeAccount: true'
        : 'scope: name the market, portfolio, campaign or product it may act on, or say wholeAccount: true — a rule with no scope reaches every campaign')
  }
  if (named && s.wholeAccount === true) out.push('scope: wholeAccount: true and a narrower scope at once — say one')
  if (s.portfolioId && s.campaignId) out.push('scope: a portfolio and a campaign at once — a campaign belongs to at most one portfolio; name one')
  return out
}

function capProblems(draft: RuleDraft): string[] {
  const c = draft.caps ?? {}
  const out: string[] = []
  const need = (key: keyof RuleCaps, words: string) => {
    if (!posInt(c[key])) out.push(`caps.${key}: required, a whole number above 0 (${words}) — a cap of 0 refuses every run`)
  }
  need('maxExecutionsPerDay', 'runs per day')
  need('maxWritesPerDay', 'writes per day')
  need('maxValueCentsEur', 'euro cents one run may commit')
  if (c.maxDailyAdSpendCentsEur != null && !posInt(c.maxDailyAdSpendCentsEur)) out.push('caps.maxDailyAdSpendCentsEur: a whole number above 0, or leave it out')
  return out
}

function actionProblems(draft: RuleDraft): string[] {
  const out: string[] = []
  const types = draftActionTypes(draft)
  const list = draft.kind === 'ebay-ads' ? [draft.action] : Array.isArray(draft.actions) ? draft.actions : []
  if (draft.kind !== 'ebay-ads' && (!Array.isArray(draft.actions) || !draft.actions.length)) out.push('actions: at least one action')
  if (draft.kind !== 'ebay-ads' && Array.isArray(draft.actions) && draft.actions.length > 20) out.push('actions: at most 20')
  if (list.some((a) => !isObject(a) || typeof a.type !== 'string' || !a.type)) out.push('actions: each one is { type, …parameters }')
  for (const refused of refusedActionsOf(types)) out.push(`${refused.type}: refused — ${refused.why}; use ${refused.instead}`)
  const refusedTypes = new Set(refusedActionsOf(types).map((r) => r.type))
  for (const type of types) {
    if (!refusedTypes.has(type) && !ALLOWED_ACTIONS[draft.kind].has(type)) out.push(`${type}: not an action a Claude ${draft.kind} rule may carry (allowed: ${[...ALLOWED_ACTIONS[draft.kind]].join(', ')})`)
  }
  for (const a of list) {
    if (!isObject(a)) continue
    for (const key of FRACTION_PARAMS) {
      const v = a[key]
      if (typeof v === 'number' && v > MAX_FRACTION) out.push(`${String(a.type)}.${key}: ${v} reads as a percent — write it as a fraction (0.3 for 30 %)`)
    }
  }
  return out
}

function conditionProblems(draft: RuleDraft, emitted: readonly string[] | undefined): string[] {
  const out: string[] = []
  const conds = draft.conditions
  if (!Array.isArray(conds) || conds.length === 0) return ['conditions: at least one — an empty list matches everything']
  if (conds.length > 50) out.push('conditions: at most 50')
  conds.forEach((c, i) => {
    const at = `condition ${i + 1}`
    if (!isObject(c) || typeof c.field !== 'string' || !c.field) {
      out.push(`${at}: a flat { field, op, value } (the rule builder's nested groups stay in the builder)`)
      return
    }
    if (!OPS.has(String(c.op))) out.push(`${at}: op is one of ${[...OPS].join(', ')}`)
    if (emitted && !emitted.includes(c.field)) {
      out.push(`${at}: ${c.field} is not a field the ${String(draft.trigger)} trigger hands a rule, so it would never match (it hands: ${emitted.join(', ')})`)
    }
    const max = FRACTION_MAX[c.field.split('.').pop() ?? '']
    if (max != null && typeof c.value === 'number' && c.value > max) {
      out.push(`${at}: ${c.field} ${String(c.op)} ${c.value} reads as a percent — ${c.field} is a fraction (0.3 for 30 %)`)
    }
  })
  return out
}

/** Every reason this rule may not be saved by Claude, in words; empty when it may. */
export function guardRule(draft: RuleDraft): string[] {
  const out: string[] = []
  if (typeof draft.name !== 'string' || !draft.name.trim() || draft.name.length > 120) out.push('name: required, at most 120 characters')
  if (draft.kind === 'ebay-ads') {
    out.push(...actionProblems(draft))
    const g = isObject(draft.guardrails) ? draft.guardrails : {}
    if (!posInt(g.maxActionsPerRun)) out.push('guardrails.maxActionsPerRun: required, a whole number above 0 (how many listings or keywords one run may change)')
    out.push(...scopeProblems(draft))
    return out
  }
  const triggers = draft.kind === 'marketing' ? MARKETING_TRIGGER_FIELDS : ADS_TRIGGER_FIELDS
  const trigger = typeof draft.trigger === 'string' ? draft.trigger : ''
  if (!triggers[trigger]) out.push(`trigger: one of ${Object.keys(triggers).join(', ')}`)
  out.push(...conditionProblems(draft, triggers[trigger]))
  out.push(...actionProblems(draft))
  out.push(...capProblems(draft))
  out.push(...scopeProblems(draft))
  return out
}
