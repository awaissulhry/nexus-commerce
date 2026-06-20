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

const BUILDER_SLUGS = new Set(['budget', 'placement', 'bid', 'negative-targeting', 'keyword-harvesting', 'dayparting-schedule'])

// metric NAME (builder) → context dot-path + how to convert the builder's value to the context unit.
// The CAMPAIGN_PERFORMANCE_BUDGET context exposes campaign.{acos,roas,spendCents,salesCents,budgetUtilization}
// (acos/roas/budgetUtilization are ratios; *Cents are integer cents). 'frac' = %÷100, 'cents' = €×100.
const CAMPAIGN_METRIC: Record<string, { field: string; conv: 'frac' | 'cents' | 'plain' }> = {
  ACOS: { field: 'campaign.acos', conv: 'frac' },
  ROAS: { field: 'campaign.roas', conv: 'plain' },
  Spend: { field: 'campaign.spendCents', conv: 'cents' },
  Sales: { field: 'campaign.salesCents', conv: 'cents' },
  'Budget Utilization': { field: 'campaign.budgetUtilization', conv: 'frac' },
}
// SP placement target (builder) → Amazon placement enum (stored in dynamicBidding.placementBidding).
const PLACEMENT_ENUM: Record<string, string> = {
  tos: 'PLACEMENT_TOP',
  pdp: 'PLACEMENT_PRODUCT_PAGE',
  ros: 'PLACEMENT_REST_OF_SEARCH',
}
// SEARCH_TERM_CONVERTING/WASTING context → searchTerm.{orders,clicks,spendCents,salesCents} (negative + harvest).
const SEARCHTERM_METRIC: Record<string, { field: string; conv: 'frac' | 'cents' | 'plain' }> = {
  Orders: { field: 'searchTerm.orders', conv: 'plain' },
  'PPC Orders': { field: 'searchTerm.orders', conv: 'plain' },
  Clicks: { field: 'searchTerm.clicks', conv: 'plain' },
  Spend: { field: 'searchTerm.spendCents', conv: 'cents' },
  Sales: { field: 'searchTerm.salesCents', conv: 'cents' },
}
// KEYWORD_HIGH_ACOS context → adTarget.{acos,spendCents,salesCents,orders} (bid).
const ADTARGET_METRIC: Record<string, { field: string; conv: 'frac' | 'cents' | 'plain' }> = {
  ACOS: { field: 'adTarget.acos', conv: 'frac' },
  Spend: { field: 'adTarget.spendCents', conv: 'cents' },
  Sales: { field: 'adTarget.salesCents', conv: 'cents' },
  Orders: { field: 'adTarget.orders', conv: 'plain' },
}
const NEG_SCOPE: Record<string, string> = { adgroup: 'AD_GROUP', campaign: 'CAMPAIGN', both: 'CAMPAIGN' }

interface BuilderCond { metric?: string; op?: string; value?: string | number }
interface BuilderGroup { conditions?: BuilderCond[]; action?: { op?: string; value?: string | number; placeTarget?: string } }
interface EngineLeaf { field: string; op: string; value: number }

const num = (v: unknown): number => Number(v) || 0
const convert = (raw: unknown, conv: 'frac' | 'cents' | 'plain'): number =>
  conv === 'frac' ? num(raw) / 100 : conv === 'cents' ? Math.round(num(raw) * 100) : num(raw)

// Flatten the builder's condition groups (all AND) → engine leaves, dropping metrics the
// context doesn't expose (logged, so the gap is visible rather than silently never-matching).
function translateConditions(groups: BuilderGroup[], map: typeof CAMPAIGN_METRIC, ruleId: string): EngineLeaf[] {
  const out: EngineLeaf[] = []
  for (const g of groups) {
    for (const c of g.conditions ?? []) {
      const m = c.metric ? map[c.metric] : undefined
      if (!m || !c.op) { if (c.metric) logger.warn('[ads-rule-adapter] unmapped metric — condition skipped', { ruleId, metric: c.metric }); continue }
      out.push({ field: m.field, op: c.op, value: convert(c.value, m.conv) })
    }
  }
  return out
}

export interface TranslatedRule { conditions: EngineLeaf[]; actions: Array<Record<string, unknown>> }

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
    return {
      conditions: translateConditions(groups, CAMPAIGN_METRIC, rule.id),
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
    return {
      conditions: translateConditions(groups, CAMPAIGN_METRIC, rule.id),
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

  if (slug === 'bid') {
    const act = groups[0]?.action ?? {}
    return {
      conditions: translateConditions(groups, ADTARGET_METRIC, rule.id),
      actions: [{
        type: 'bid_apply',
        op: act.op ?? 'set',
        value: num(act.value),
        // bid guardrails reuse the budget floor/ceiling fields if the builder set them; else 5¢ floor handled in the handler
        minEur: a0.budgetFloor != null ? num(a0.budgetFloor) : null,
        maxEur: a0.budgetCeiling != null ? num(a0.budgetCeiling) : null,
        campaignIds: Array.isArray(a0.campaigns) ? (a0.campaigns as Array<{ id: string }>).map((c) => c.id) : [],
        reason: `Bid rule ${rule.id}`,
      }],
    }
  }

  if (slug === 'negative-targeting') {
    // SEARCH_TERM_WASTING context carries the query + campaign/adgroup; conditions gate on its metrics.
    return {
      conditions: translateConditions(groups, SEARCHTERM_METRIC, rule.id),
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
    return { conditions: translateConditions(groups, SEARCHTERM_METRIC, rule.id), actions }
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
