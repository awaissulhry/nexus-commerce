/**
 * EA1 — Builder-rule → engine-native adapter.
 *
 * The Rules & Automation BUILDERS (budget/placement/bid/negative/harvest/dayparting)
 * store rules in a UI-friendly shape:
 *   conditions: [{ match:'all', lookback, exclude, conditions:[{metric,op,value}], action:{op,value,placeTarget?} }]
 *   actions:    [{ type:'<slug>', campaigns, budgetFloor/Ceiling, placeFloor/Ceiling, ... }]
 *
 * The EXECUTION ENGINE (automation-rule.service + conditions-tree + ACTION_HANDLERS)
 * expects the engine-native shape:
 *   conditions: [{ field:'campaign.acos', op:'gte', value:0.4 }]   ← dot-path + numeric/fractional
 *   actions:    [{ type:'budget_apply', op, value, minEur, maxEur }] ← a registered handler
 *
 * maybeTranslateAdsRule() reshapes a builder rule in-memory at evaluation time (hooked into
 * evaluateRule, domain-gated) so the existing engine — context-builders, conditions-tree,
 * handlers, safety spine, audit rows — runs it unchanged. Returns null for non-builder rules.
 */
import { logger } from '../../utils/logger.js'

const BUILDER_SLUGS = new Set(['budget', 'placement', 'bid', 'negative-targeting', 'keyword-harvesting', 'dayparting-schedule', 'sov', 'keyword-tracker'])

// metric NAME (builder) → context dot-path + how to convert the builder's value to the context unit.
// The CAMPAIGN_PERFORMANCE_BUDGET context exposes campaign.{acos,roas,spendCents,salesCents,
// impressions,clicks,orders,ctr,cvr,cpcCents,budgetUtilization} (ratios are fractions 0..1;
// *Cents are integer cents). 'frac' = %÷100, 'cents' = €×100.
//
// 🔴 Every entry here must name a field its context builder actually emits — an entry pointing at
// a missing field makes the condition compare against undefined and silently never match. P2.1
// closed the other direction too: a builder metric with NO entry now refuses the rule instead of
// dropping the condition (a dropped AND-condition makes a rule LOOSER, which is the wrong failure).
const CAMPAIGN_METRIC: Record<string, { field: string; conv: 'frac' | 'cents' | 'plain' }> = {
  ACOS: { field: 'campaign.acos', conv: 'frac' },
  ROAS: { field: 'campaign.roas', conv: 'plain' },
  Spend: { field: 'campaign.spendCents', conv: 'cents' },
  Sales: { field: 'campaign.salesCents', conv: 'cents' },
  'Budget Utilization': { field: 'campaign.budgetUtilization', conv: 'frac' },
  Impressions: { field: 'campaign.impressions', conv: 'plain' },
  Clicks: { field: 'campaign.clicks', conv: 'plain' },
  Orders: { field: 'campaign.orders', conv: 'plain' },
  'PPC Orders': { field: 'campaign.orders', conv: 'plain' },
  CTR: { field: 'campaign.ctr', conv: 'frac' },
  CVR: { field: 'campaign.cvr', conv: 'frac' },
  CPC: { field: 'campaign.cpcCents', conv: 'cents' },
}
// SP placement target (builder) → Amazon placement enum (stored in dynamicBidding.placementBidding).
const PLACEMENT_ENUM: Record<string, string> = {
  tos: 'PLACEMENT_TOP',
  pdp: 'PLACEMENT_PRODUCT_PAGE',
  ros: 'PLACEMENT_REST_OF_SEARCH',
}
// SEARCH_TERM_CONVERTING/WASTING context → searchTerm.{orders,clicks,impressions,spendCents,
// salesCents,acos,roas,ctr,cvr,cpcCents} (negative + harvest).
const SEARCHTERM_METRIC: Record<string, { field: string; conv: 'frac' | 'cents' | 'plain' }> = {
  Orders: { field: 'searchTerm.orders', conv: 'plain' },
  'PPC Orders': { field: 'searchTerm.orders', conv: 'plain' },
  Clicks: { field: 'searchTerm.clicks', conv: 'plain' },
  Spend: { field: 'searchTerm.spendCents', conv: 'cents' },
  Sales: { field: 'searchTerm.salesCents', conv: 'cents' },
  Impressions: { field: 'searchTerm.impressions', conv: 'plain' },
  ACOS: { field: 'searchTerm.acos', conv: 'frac' },
  ROAS: { field: 'searchTerm.roas', conv: 'plain' },
  CTR: { field: 'searchTerm.ctr', conv: 'frac' },
  CVR: { field: 'searchTerm.cvr', conv: 'frac' },
  CPC: { field: 'searchTerm.cpcCents', conv: 'cents' },
}
// KEYWORD_HIGH_ACOS context → adTarget.{acos,roas,spendCents,salesCents,orders,clicks,impressions,
// ctr,cvr,cpcCents} (bid).
const ADTARGET_METRIC: Record<string, { field: string; conv: 'frac' | 'cents' | 'plain' }> = {
  ACOS: { field: 'adTarget.acos', conv: 'frac' },
  ROAS: { field: 'adTarget.roas', conv: 'plain' },
  Spend: { field: 'adTarget.spendCents', conv: 'cents' },
  Sales: { field: 'adTarget.salesCents', conv: 'cents' },
  Orders: { field: 'adTarget.orders', conv: 'plain' },
  'PPC Orders': { field: 'adTarget.orders', conv: 'plain' },
  Clicks: { field: 'adTarget.clicks', conv: 'plain' },
  Impressions: { field: 'adTarget.impressions', conv: 'plain' },
  CTR: { field: 'adTarget.ctr', conv: 'frac' },
  CVR: { field: 'adTarget.cvr', conv: 'frac' },
  CPC: { field: 'adTarget.cpcCents', conv: 'cents' },
}
// SOV_BID context → the target's Share-of-Voice signal (from analyzeShareOfVoice, matched per keyword)
// plus the carried-over perf metrics. SOV fields are fractions (0..1).
const SOV_METRIC: Record<string, { field: string; conv: 'frac' | 'cents' | 'plain' }> = {
  'Share of Voice': { field: 'adTarget.sovPct', conv: 'frac' },
  'Top Campaign Share': { field: 'adTarget.topSharePct', conv: 'frac' },
  'Impression Share': { field: 'adTarget.impressionSharePct', conv: 'frac' },
  ...ADTARGET_METRIC,
}
// KEYWORD_RANK_BID context → the target's organic/paid rank signal (from KeywordRank, latest per
// keyword) plus a couple perf metrics. Rank/volume are bare counts; lower rank number = better.
const RANK_METRIC: Record<string, { field: string; conv: 'frac' | 'cents' | 'plain' }> = {
  'Organic Rank': { field: 'adTarget.organicRank', conv: 'plain' },
  'Sponsored Rank': { field: 'adTarget.sponsoredRank', conv: 'plain' },
  'Rank Change': { field: 'adTarget.rankDelta', conv: 'plain' },
  'Search Volume': { field: 'adTarget.searchVolume', conv: 'plain' },
  'Share of Voice': { field: 'adTarget.sovPct', conv: 'frac' },
  ACOS: { field: 'adTarget.acos', conv: 'frac' },
  Spend: { field: 'adTarget.spendCents', conv: 'cents' },
}
const NEG_SCOPE: Record<string, string> = { adgroup: 'AD_GROUP', campaign: 'CAMPAIGN', both: 'CAMPAIGN' }

interface BuilderCond { metric?: string; op?: string; value?: string | number }
interface BuilderGroup { conditions?: BuilderCond[]; action?: { op?: string; value?: string | number; placeTarget?: string } }
interface EngineLeaf { field: string; op: string; value: number }

const num = (v: unknown): number => Number(v) || 0

/**
 * The campaigns an operator picked, from either spelling the writers use: `campaigns: [{id}]`
 * (RuleBuilder / ScheduleBuilder) or `campaignIds: [id]` (Autopilot `coordination.ts`). The second
 * was silently ignored everywhere before EA4, so the Autopilot's scoping never bound.
 */
function builderCampaignIds(a0: Record<string, unknown>): string[] {
  if (Array.isArray(a0.campaigns)) return (a0.campaigns as Array<{ id?: unknown }>).map((c) => String(c?.id ?? '')).filter(Boolean)
  if (Array.isArray(a0.campaignIds)) return (a0.campaignIds as unknown[]).map((c) => String(c ?? '')).filter(Boolean)
  return []
}
const convert = (raw: unknown, conv: 'frac' | 'cents' | 'plain'): number =>
  conv === 'frac' ? num(raw) / 100 : conv === 'cents' ? Math.round(num(raw) * 100) : num(raw)

// Flatten the builder's condition groups (all AND) → engine leaves.
//
// 🔴 P2.1 — an unmapped metric REFUSES, it no longer drops. The old behaviour logged a warning
// and skipped the condition, and because groups are flattened AND-only, every skip made the rule
// LOOSER — a rule saying "negate at ACOS > 80%" would have negated at any ACOS. Unmapped metrics
// are collected and returned; the caller fails the whole rule closed and names them.
function translateConditions(groups: BuilderGroup[], map: typeof CAMPAIGN_METRIC, ruleId: string): { leaves: EngineLeaf[]; unmapped: string[] } {
  const leaves: EngineLeaf[] = []
  const unmapped: string[] = []
  /**
   * 🔴 EA4 — FAIL OPEN, closed. A rule whose actions are builder-shaped but whose `conditions` are
   * engine-native flat leaves has no `g.conditions` to iterate, so this used to return zero leaves
   * — and `evaluateConditions` treats an EMPTY list as `true`. The rule then matched every context
   * on every tick, unrestricted. That is reachable by any partial write over one of the stored
   * rules, and it is the one failure direction that must never happen silently: an over-tight rule
   * does nothing, an over-loose one writes to the whole account.
   *
   * Stored conditions that yield no builder leaves are reported as untranslatable, which the
   * evaluator already turns into a no-match and the save routes already turn into a 400.
   */
  const anyBuilderLeaves = groups.some((g) => Array.isArray(g?.conditions) && g.conditions.length > 0)
  if (groups.length > 0 && !anyBuilderLeaves) {
    logger.warn('[ads-rule-adapter] builder action with non-builder conditions — refusing rather than matching everything', { ruleId, groups: groups.length })
    return { leaves: [], unmapped: ['<conditions are not builder-shaped>'] }
  }
  for (const g of groups) {
    for (const c of g.conditions ?? []) {
      const m = c.metric ? map[c.metric] : undefined
      if (!m || !c.op) {
        if (c.metric) { unmapped.push(c.metric); logger.warn('[ads-rule-adapter] unmapped metric — rule will be refused, not loosened', { ruleId, metric: c.metric }) }
        continue
      }
      leaves.push({ field: m.field, op: c.op, value: convert(c.value, m.conv) })
    }
  }
  return { leaves, unmapped }
}

export interface TranslatedRule {
  conditions: EngineLeaf[]
  actions: Array<Record<string, unknown>>
  /** Non-empty ⇒ the rule must NOT run: these builder metrics have no engine field. The
   *  evaluator treats it as no-match (fail closed); the save routes refuse it with a 400. */
  untranslatable?: string[]
}

/**
 * What each builder slug becomes at execution time — the governance vocabulary. The graduation
 * ceiling and the conflict detectors reason over ACTION TYPES; a stored builder rule carries only
 * its slug, so without this table a builder rule is invisible to both (measured 2026-08-15: no
 * slug appears in REVERSIBLE_ACTIONS/STRUCTURAL_ACTIONS or any OPPOSED pair). Kept beside the
 * translation so the two cannot drift.
 */
export const BUILDER_SLUG_ACTIONS: Record<string, string[]> = {
  budget: ['budget_apply'],
  placement: ['placement_apply'],
  bid: ['bid_apply'],
  sov: ['bid_apply'],
  'keyword-tracker': ['bid_apply'],
  'negative-targeting': ['add_negative_exact'],
  'keyword-harvesting': ['promote_to_exact', 'add_negative_exact'],
  'dayparting-schedule': ['dayparting_apply'],
}

/**
 * Save-time validation: the builder metrics in `rule.conditions` that cannot translate for this
 * rule's slug. Empty for non-builder rules and for fully-translatable ones. The create/update
 * routes 400 on a non-empty answer so an untranslatable rule cannot be stored at all.
 */
export function listUntranslatableMetrics(rule: { id?: string; actions?: unknown; conditions?: unknown }): string[] {
  if (!isBuilderShapedAdsRule(rule)) return []
  const t = maybeTranslateAdsRule({ id: rule.id ?? 'unsaved', actions: rule.actions, conditions: rule.conditions })
  return t?.untranslatable ?? []
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// EA4 — the REVERSE direction: engine-native rule → what the builder can show.
//
// 🔴 Why this exists. Measured on prod 2026-08-19: **0 of 51** stored rules are builder-shaped —
// 31 are template-seeded, 20 arrived through the API, and all of them store engine-native
// `conditions: [{field, op, value}]` + `actions: [{type: 'bid_to_target_acos', …}]`. The builder's
// edit mode reads `conditions[].conditions`, `actions[0].control/campaigns/schedule` — four keys
// that exist on NONE of them — so opening any rule showed a blank form with the name filled in.
// Worse, `RuleBuilder` fell back to a hard-coded default condition per group, so pressing Save
// would have written those defaults over a live rule's real criteria.
//
// The forward translation above has always been one-way. This is the inverse, deliberately in the
// SAME file so the two cannot drift: every map below is derived from the forward map, never
// re-typed.
//
// ── What "representable" means, and why most rules are NOT ──────────────────────────────────────
// The builder can only *produce* six engine action types (`BUILDER_SLUG_ACTIONS` above). An engine
// rule using anything else — `bid_to_target_acos` with its `profitMode`/`targetAcos`, a two-action
// `[adjust_ad_budget, notify]`, `retail_guard`, `alert_operator` — has no control in the builder to
// carry it. Those rules open READ-ONLY: conditions and scope shown truthfully, the action rendered
// as a summary line, Save disabled. Showing an editable form we cannot faithfully save is how a
// working automation gets destroyed.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** field → builder metric, inverted from a forward map. First spelling wins (Orders before PPC
 *  Orders), so the round-trip is stable even though several metrics share one field. */
function invert(map: Record<string, { field: string; conv: 'frac' | 'cents' | 'plain' }>): Record<string, { metric: string; conv: 'frac' | 'cents' | 'plain' }> {
  const out: Record<string, { metric: string; conv: 'frac' | 'cents' | 'plain' }> = {}
  for (const [metric, m] of Object.entries(map)) if (!out[m.field]) out[m.field] = { metric, conv: m.conv }
  return out
}
const INV_CAMPAIGN = invert(CAMPAIGN_METRIC)
const INV_SEARCHTERM = invert(SEARCHTERM_METRIC)
const INV_ADTARGET = invert(ADTARGET_METRIC)
const INV_SOV = invert(SOV_METRIC)
const INV_RANK = invert(RANK_METRIC)

/** cents → €, fraction → %, plain → itself. The exact inverse of `convert`. */
const unconvert = (v: unknown, conv: 'frac' | 'cents' | 'plain'): number =>
  conv === 'frac' ? num(v) * 100 : conv === 'cents' ? num(v) / 100 : num(v)

/**
 * Which builder slug an engine rule belongs to, and therefore which metric map reads its
 * conditions. Derived from `BUILDER_SLUG_ACTIONS` plus the engine-native types each tab already
 * claims in the web's `RULE_TAB_ACTION_TYPES` — kept here so one file answers "what is this rule".
 */
const ENGINE_TYPE_SLUG: Record<string, string> = {
  budget_apply: 'budget', adjust_ad_budget: 'budget', set_daily_budget: 'budget', pace_budget: 'budget',
  placement_apply: 'placement', set_placement_multiplier: 'placement', defend_top_of_search: 'placement',
  bid_apply: 'bid', bid_to_target_acos: 'bid', bid_up: 'bid', bid_down: 'bid',
  lower_bid_to_floor: 'bid', raise_bids_for_rank_defense: 'bid', scale_bids_for_price_change: 'bid',
  set_campaign_target_acos: 'bid',
  add_negative_exact: 'negative-targeting', add_negative_phrase: 'negative-targeting',
  sync_negatives_across_campaigns: 'negative-targeting',
  promote_to_exact: 'keyword-harvesting', harvest_and_negate: 'keyword-harvesting',
  dayparting_apply: 'dayparting-schedule', refresh_dayparting: 'dayparting-schedule',
}

/** Every inverse map merged — the fallback when a rule's condition names another context's field.
 *  Built from the same forward maps, so it gains a field the moment the forward direction does. */
const INV_ANY: ReturnType<typeof invert> = { ...INV_CAMPAIGN, ...INV_SEARCHTERM, ...INV_ADTARGET, ...INV_SOV, ...INV_RANK }

const INV_BY_SLUG: Record<string, ReturnType<typeof invert>> = {
  budget: INV_CAMPAIGN, placement: INV_CAMPAIGN,
  bid: INV_ADTARGET, sov: INV_SOV, 'keyword-tracker': INV_RANK,
  'negative-targeting': INV_SEARCHTERM, 'keyword-harvesting': INV_SEARCHTERM,
  'dayparting-schedule': INV_CAMPAIGN,
}

/** Human summary of an engine action, for the read-only line. Never a promise the UI can keep. */
function describeAction(a: Record<string, unknown>): string {
  const t = String(a.type ?? '?')
  const pct = a.percent != null ? `${num(a.percent) > 0 ? '+' : ''}${num(a.percent)}%` : null
  switch (t) {
    case 'adjust_ad_budget': return `Adjust daily budget${pct ? ` by ${pct}` : ''}`
    case 'budget_apply': return `Set daily budget ${String(a.op ?? 'set')} ${num(a.value)}`
    case 'bid_to_target_acos': return `Bid to target ACoS${a.targetAcos != null ? ` ${unconvert(a.targetAcos, 'frac').toFixed(1)}%` : ''}${a.profitMode ? ' (profit mode)' : ''}`
    case 'bid_apply': return `Adjust bid ${String(a.op ?? 'set')} ${num(a.value)}`
    case 'bid_up': return `Raise bids${pct ? ` by ${pct}` : ''}`
    case 'bid_down': return `Lower bids${pct ? ` by ${pct}` : ''}`
    case 'lower_bid_to_floor': return 'Lower bid to the floor'
    case 'raise_bids_for_rank_defense': return 'Raise bids to defend rank'
    case 'placement_apply': return `Set ${String(a.placement ?? 'placement')} ${String(a.op ?? 'set')} ${num(a.value)}%`
    case 'set_placement_multiplier': return 'Set placement multiplier'
    case 'defend_top_of_search': return 'Defend top of search'
    case 'add_negative_exact': return `Add negative exact (${String(a.scope ?? 'CAMPAIGN')})`
    case 'add_negative_phrase': return `Add negative phrase (${String(a.scope ?? 'CAMPAIGN')})`
    case 'promote_to_exact': return `Promote to exact${a.bidEur != null ? ` at €${num(a.bidEur).toFixed(2)}` : ''}`
    case 'harvest_and_negate': return 'Harvest the term and negate it in source'
    case 'notify': case 'alert_operator': return `Notify ${String(a.target ?? 'operator')}`
    case 'retail_guard': return 'Retail guard'
    case 'archive_keyword': return 'Archive the keyword'
    case 'pause_campaign': return 'Pause the campaign'
    case 'pause_all_campaigns': return 'Pause every campaign'
    default: return t.replace(/_/g, ' ')
  }
}

export interface BuilderView {
  /** the slug whose builder should render this rule, or null when nothing claims it */
  slug: string | null
  /** builder-shaped condition groups — one group, AND-joined, because that is all the engine stores */
  groups: Array<{ conditions: Array<{ metric: string; op: string; value: string }> }>
  /** one line per stored action, for the read-only summary */
  actionSummary: string[]
  /** true when the builder could faithfully re-save this rule; false ⇒ open read-only */
  editable: boolean
  /**
   * Why it is not editable — shown verbatim to the operator. Empty when `editable`.
   * Each entry names a concrete thing the builder cannot carry, never a vague "unsupported".
   */
  blockers: string[]
  /** engine condition fields with no builder metric — these would be LOST on save */
  unmappedFields: string[]
}

/**
 * Read an ENGINE-NATIVE advertising rule as the builder would show it.
 *
 * Returns null for a builder-shaped rule — those hydrate from their own stored JSON and need no
 * translation. Never throws: a rule it cannot read comes back `editable: false` with the reason.
 */
export function engineRuleToBuilderView(rule: {
  id: string
  conditions?: unknown
  actions?: unknown
}): BuilderView | null {
  if (isBuilderShapedAdsRule(rule)) return null

  const actions = (Array.isArray(rule.actions) ? rule.actions : []) as Array<Record<string, unknown>>
  const conds = (Array.isArray(rule.conditions) ? rule.conditions : []) as Array<Record<string, unknown>>
  const types = actions.map((a) => String(a?.type ?? ''))
  const slug = types.map((t) => ENGINE_TYPE_SLUG[t]).find(Boolean) ?? null
  const inv = slug ? INV_BY_SLUG[slug] ?? INV_CAMPAIGN : INV_CAMPAIGN

  const leaves: Array<{ metric: string; op: string; value: string }> = []
  const unmappedFields: string[] = []
  for (const c of conds) {
    // A tree-shaped payload ({kind:'and',…}) is not a leaf list; the builder has no UI for nesting.
    if (!c || typeof c !== 'object' || c.field == null) continue
    const f = String(c.field)
    // 🔴 Fall back ACROSS contexts. Stored rules mix them freely — measured 2026-08-19, six
    // `adjust_ad_budget` rules gate on `adTarget.spendCents` and five bid rules on `campaign.acos`
    // — and the slug's own map holds only its own prefix, so those read as unmapped even though
    // the metric exists. Engine field names carry their context (`campaign.acos` is not
    // `adTarget.acos`), so a cross-map lookup cannot mis-resolve one for another.
    const m = inv[f] ?? INV_ANY[f]
    if (!m) { unmappedFields.push(f); continue }
    leaves.push({ metric: m.metric, op: String(c.op ?? 'gte'), value: String(unconvert(c.value, m.conv)) })
  }

  const blockers: string[] = []
  // 🔴 The builder writes ONE action from a fixed set. Anything else cannot survive a save.
  const producible = new Set(Object.values(BUILDER_SLUG_ACTIONS).flat())
  const unproducible = types.filter((t) => !producible.has(t))
  if (unproducible.length) blockers.push(`this rule's action${unproducible.length > 1 ? 's' : ''} (${unproducible.join(', ')}) ${unproducible.length > 1 ? 'have' : 'has'} no control in this builder`)
  if (actions.length > 1) blockers.push(`it stores ${actions.length} actions and the builder writes one`)
  if (unmappedFields.length) blockers.push(`${unmappedFields.length} condition field${unmappedFields.length > 1 ? 's have' : ' has'} no builder metric (${unmappedFields.join(', ')})`)
  if (!slug) blockers.push('no rule type claims this action')
  if (conds.some((c) => c && typeof c === 'object' && c.field == null)) blockers.push('its conditions are a nested tree, which the builder cannot draw')

  return {
    slug,
    groups: leaves.length ? [{ conditions: leaves }] : [],
    actionSummary: actions.map(describeAction),
    editable: blockers.length === 0,
    blockers,
    unmappedFields,
  }
}

export function isBuilderShapedAdsRule(rule: { actions?: unknown }): boolean {
  const a0 = (Array.isArray(rule.actions) ? rule.actions[0] : null) as { type?: string } | null
  return !!a0 && typeof a0.type === 'string' && BUILDER_SLUGS.has(a0.type)
}

/**
 * Translate a builder-shaped advertising rule to engine-native shape. Returns null if the rule
 * isn't builder-shaped OR its type isn't handled yet (EA1 = budget + placement; bid/negative/
 * harvest/dayparting land in EA2). Non-handled builder rules return null → engine leaves them as-is.
 */
export function maybeTranslateAdsRule(rule: { id: string; actions?: unknown; conditions?: unknown }): TranslatedRule | null {
  if (!isBuilderShapedAdsRule(rule)) return null
  const a0 = (rule.actions as Array<Record<string, unknown>>)[0]
  const groups = (Array.isArray(rule.conditions) ? rule.conditions : []) as BuilderGroup[]
  const slug = a0.type as string

  if (slug === 'budget') {
    const act = groups[0]?.action ?? {}
    const { leaves, unmapped } = translateConditions(groups, CAMPAIGN_METRIC, rule.id)
    return {
      conditions: leaves,
      ...(unmapped.length ? { untranslatable: unmapped } : {}),
      actions: [{
        type: 'budget_apply',
        op: act.op ?? 'set',
        value: num(act.value),
        minEur: a0.budgetFloor != null ? num(a0.budgetFloor) : 1,
        maxEur: a0.budgetCeiling != null ? num(a0.budgetCeiling) : null,
        // 🔴 EA4 — the picker's campaigns were dropped here, so a Budget rule listing 12 campaigns
        // ran account-wide. `budget_apply` reads this now; empty still means "no restriction".
        campaignIds: builderCampaignIds(a0),
        reason: `Budget rule ${rule.id}`,
      }],
    }
  }

  if (slug === 'placement') {
    const act = groups[0]?.action ?? {}
    const { leaves, unmapped } = translateConditions(groups, CAMPAIGN_METRIC, rule.id)
    return {
      conditions: leaves,
      ...(unmapped.length ? { untranslatable: unmapped } : {}),
      actions: [{
        type: 'placement_apply',
        placement: PLACEMENT_ENUM[act.placeTarget ?? 'tos'] ?? 'PLACEMENT_TOP',
        op: act.op ?? 'set',
        value: num(act.value),
        minPct: a0.placeFloor != null ? num(a0.placeFloor) : 0,
        maxPct: a0.placeCeiling != null ? num(a0.placeCeiling) : 900,
        campaignIds: builderCampaignIds(a0), // EA4 — as budget above
        reason: `Placement rule ${rule.id}`,
      }],
    }
  }

  // Bid · SOV · Keyword Tracker are all keyword-bid-adjustment rules → the bid_apply handler. They
  // differ only in which signal their criteria gate on (perf vs SOV vs rank) → the metric map.
  if (slug === 'bid' || slug === 'sov' || slug === 'keyword-tracker') {
    const act = groups[0]?.action ?? {}
    const map = slug === 'sov' ? SOV_METRIC : slug === 'keyword-tracker' ? RANK_METRIC : ADTARGET_METRIC
    const label = slug === 'sov' ? 'SOV bid rule' : slug === 'keyword-tracker' ? 'Keyword Tracker bid rule' : 'Bid rule'
    const { leaves, unmapped } = translateConditions(groups, map, rule.id)
    return {
      conditions: leaves,
      ...(unmapped.length ? { untranslatable: unmapped } : {}),
      actions: [{
        type: 'bid_apply',
        op: act.op ?? 'set',
        value: num(act.value),
        // SK1 stores bid guardrails as bidFloor/bidCeiling (fall back to the legacy budget* fields); the
        // handler still enforces a €0.05 floor regardless.
        minEur: a0.bidFloor != null ? num(a0.bidFloor) : a0.budgetFloor != null ? num(a0.budgetFloor) : null,
        maxEur: a0.bidCeiling != null ? num(a0.bidCeiling) : a0.budgetCeiling != null ? num(a0.budgetCeiling) : null,
        campaignIds: builderCampaignIds(a0),
        reason: `${label} ${rule.id}`,
      }],
    }
  }

  if (slug === 'negative-targeting') {
    // SEARCH_TERM_WASTING context carries the query + campaign/adgroup; conditions gate on its metrics.
    const { leaves, unmapped } = translateConditions(groups, SEARCHTERM_METRIC, rule.id)
    return {
      conditions: leaves,
      ...(unmapped.length ? { untranslatable: unmapped } : {}),
      actions: [{
        type: 'add_negative_exact',
        scope: NEG_SCOPE[(a0.negationLevel as string) ?? 'campaign'] ?? 'CAMPAIGN',
        protectConverting: a0.protectConverting !== false,
        protectDays: a0.protectDays != null ? num(a0.protectDays) : 30,
        reason: `Negative rule ${rule.id}`,
      }],
    }
  }

  if (slug === 'keyword-harvesting') {
    // SEARCH_TERM_CONVERTING context. promote_to_exact reads query+adGroup from context; bid from the rule.
    const bidMode = (a0.bid as { mode?: string; value?: string } | undefined)?.mode
    const bidValue = (a0.bid as { mode?: string; value?: string } | undefined)?.value
    const actions: Array<Record<string, unknown>> = [{
      type: 'promote_to_exact',
      bidEur: bidMode === 'fixed' && bidValue ? num(bidValue) : 0.75,
      reason: `Harvest rule ${rule.id}`,
    }]
    // negate-in-source: also add the harvested term as a negative in its source ad group
    if (a0.negateInSource === true) actions.push({ type: 'add_negative_exact', scope: 'AD_GROUP', reason: `Harvest negate-in-source ${rule.id}` })
    const { leaves, unmapped } = translateConditions(groups, SEARCHTERM_METRIC, rule.id)
    return { conditions: leaves, ...(unmapped.length ? { untranslatable: unmapped } : {}), actions }
  }

  if (slug === 'dayparting-schedule') {
    // SCHEDULE trigger (always-match, conditions empty). The handler does the time-window logic.
    return {
      conditions: [],
      actions: [{
        type: 'dayparting_apply',
        timezone: (a0.timezone as string) ?? 'Europe/Rome',
        windows: Array.isArray(a0.windows) ? a0.windows : [],
        campaignIds: builderCampaignIds(a0),
        reason: `Dayparting schedule ${rule.id}`,
      }],
    }
  }

  return null
}
