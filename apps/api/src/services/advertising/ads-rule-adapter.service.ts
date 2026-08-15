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
        campaignIds: Array.isArray(a0.campaigns) ? (a0.campaigns as Array<{ id: string }>).map((c) => c.id) : [],
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
        campaignIds: Array.isArray(a0.campaigns) ? (a0.campaigns as Array<{ id: string }>).map((c) => c.id) : [],
        reason: `Dayparting schedule ${rule.id}`,
      }],
    }
  }

  return null
}
