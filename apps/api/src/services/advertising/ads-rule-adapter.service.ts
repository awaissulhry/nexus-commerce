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
import { normalizeHarvestWire, normalizeHarvestBidMode } from './ads-harvest-wire.js'

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
  // BP.P4 — H10's Bid metric list carries "Current Bid"; the KEYWORD_HIGH_ACOS context now
  // carries adTarget.bidCents for it (one findMany over the emitted targets, in the emitter).
  'Current Bid': { field: 'adTarget.bidCents', conv: 'cents' },
}
/**
 * SOV_BID context → the target's share signals plus the carried-over perf metrics. Fractions (0..1).
 *
 * 🔴 SOV-P1 (2026-08-22) — two changes, both because a metric name must describe the number behind it.
 *
 * · **'Impression Share' REMOVED.** `buildSovBidContexts` assigned `impressionSharePct: s.sovPct`,
 *   so it and 'Share of Voice' were byte-identical: two entries in the operator's metric list, one
 *   value, and no way to tell from the builder that picking either changed nothing. Amazon's real
 *   impression share does exist (`topOfSearchIS`) but it is CAMPAIGN-grain, and a campaign number
 *   gating a keyword-grain action is a different metric wearing the same name — which is the defect
 *   being removed, not a fix for it. Re-offer it when a keyword-grain source ships.
 *
 * · **'Top Campaign Share' → 'Campaign Concentration'.** The value is unchanged and correct: our
 *   single biggest campaign's share of the impressions WE took on a query. The old name read as a
 *   share of the market — it is a measure of our own cannibalisation. 769 of 1,000 queries sit at
 *   exactly 100 % (one campaign), so `< 100 %` is the honest way to ask "are several of my campaigns
 *   bidding against each other here?".
 *
 * 'Share of Voice' keeps its name because SOV-P1 made the name TRUE: it is now Amazon's own
 * per-query market impression share (`ads-sov-keyword-share.service.ts`), not our impression mix.
 *
 * Safe to rename: 0 SOV rules exist on the account (W7 deleted the legacy 51 and none has been
 * authored since), so no stored condition carries the old key.
 */
const SOV_METRIC: Record<string, { field: string; conv: 'frac' | 'cents' | 'plain' }> = {
  'Share of Voice': { field: 'adTarget.sovPct', conv: 'frac' },
  'Campaign Concentration': { field: 'adTarget.topSharePct', conv: 'frac' },
  ...ADTARGET_METRIC,
}
// KEYWORD_RANK_BID context → the target's organic/paid rank signal (from KeywordRank, latest per
// keyword) plus a couple perf metrics. Rank/volume are bare counts; lower rank number = better.
const RANK_METRIC: Record<string, { field: string; conv: 'frac' | 'cents' | 'plain' }> = {
  'Organic Rank': { field: 'adTarget.organicRank', conv: 'plain' },
  'Sponsored Rank': { field: 'adTarget.sponsoredRank', conv: 'plain' },
  'Rank Change': { field: 'adTarget.rankDelta', conv: 'plain' },
  'Search Volume': { field: 'adTarget.searchVolume', conv: 'plain' },
  /**
   * 🔴 KT-P3 (2026-08-22) — 'Share of Voice' REMOVED, and it is the one metric on this tab that had
   * to go rather than be held.
   *
   * It named `adTarget.sovPct`, which `buildKeywordRankBidContexts` never emits — the exact defect
   * this file's own header forbids two screens up, so the condition compared against `undefined`
   * and silently never matched.
   *
   * The fix is removal, not wiring, because the only available source points the WRONG WAY.
   * `analyzeShareOfVoice`'s `sovPct` is this query's impressions ÷ our own account's total
   * impressions across every query and all four marketplaces — an account mix share, not a share of
   * any market. Measured on prod 2026-08-22 (SOV-P): median 0.0026%, so `"< 50%"` matches 1000 of
   * 1000 rows; and against Amazon's own per-query share it runs at Spearman ρ = −0.2445, negative in
   * all four markets (DE −0.3454 · ES −0.3516 · IT −0.1735 · FR −0.5667). A rescale would not fix
   * it — the error's sign flips across the head queries, and the damage is in the TAIL, which is
   * where a rank rule lives: our five strongest real positions all read 0.000x%.
   *
   * So this is NOT the [[feedback_keep_placeholder_controls]] case. The four rank metrics above are
   * HELD (visible, with the reason, awaiting a feed) because they are real capabilities with no
   * source yet. This one had a source that would have made the rule act backwards.
   *
   * If a per-keyword market share is wanted here, the honest source is `SearchQueryPerformance`
   * (Σ impressionsBrand ÷ MAX impressionsTotal, never SUM) — proposed as KT-P4.
   */
  ACOS: { field: 'adTarget.acos', conv: 'frac' },
  Spend: { field: 'adTarget.spendCents', conv: 'cents' },
}
// NEG-P1 — the builder's Negation Level, honoured in FULL. 'both' used to map to CAMPAIGN
// silently; now every selected level is written. First entry doubles as the display scope.
const NEG_LEVELS: Record<string, string[]> = { adgroup: ['AD_GROUP'], campaign: ['CAMPAIGN'], both: ['AD_GROUP', 'CAMPAIGN'] }

interface BuilderCond {
  metric?: string
  op?: string
  value?: string | number
  /**
   * EA5.2 — the engine field this condition came FROM, when it was read off a stored rule.
   * Present only on a round-trip; a freshly-built condition has none and resolves by metric.
   */
  field?: string
  /**
   * PLC-P7 — which PLACEMENT LANE this condition measures: 'campaign' (the default, and every
   * non-placement rule) or one of 'tos' | 'pdp' | 'ros'. Written by the Placement builder on every
   * condition since it shipped, and read by nothing until PLC-P7 — see `placementScopedField`.
   */
  scope?: string
}
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

/**
 * ── BUD-P2 (2026-08-21) — ONE test for "which campaigns may this budget rule move" ────────────
 *
 * A budget rule exists in TWO shapes, and only one of them was ever recognised:
 *   · **engine-native** — `actions[].type === 'adjust_ad_budget'`, governed by
 *     `CampaignRuleAssignment` (D1).
 *   · **builder** — `actions[0].type === 'budget'` carrying the picker's `campaigns: [{id}]`,
 *     which `budget_apply` has honoured since EA4.
 *
 * 🔴 Three call sites tested only the first — the evaluator's assignment block, `reachForRules`,
 * and the Apply Rules column CATALOGUE — so a builder budget rule was **invisible in the column's
 * dropdown**, **ungoverned by assignment**, and **over-reported by reach** (every campaign in
 * scope, not the twelve the operator picked), while the handler quietly enforced the picker list
 * all along. Latent today only because W7 left 0 budget rules and 0 assignment rows.
 *
 * `builderBudgetCampaignIds` returns the three states `RuleScope.assignedCampaignIds` documents:
 *   · `null`  — not assignment-governed (every non-budget rule; unchanged)
 *   · `[]`    — governed and assigned to nothing → matches NO campaign (H10's "None")
 *   · `[ids]` — governed by exactly those campaigns
 *
 * A BUILDER rule is governed by its **own** stored list, not by a table read. The two are kept
 * equal in both directions by `rule-campaign-binding.service`, so the answers agree — but reading
 * the rule means a failed mirror can only make the COLUMN stale (visible, correctable), never
 * make a live rule silently inert. An engine-native rule keeps reading the table, as D1 built it.
 */
export function isEngineBudgetRule(actions: unknown): boolean {
  return Array.isArray(actions)
    && actions.some((a) => String((a as { type?: unknown })?.type ?? '') === 'adjust_ad_budget')
}

/**
 * The picker list of a BUILDER budget rule, or `null` if this is not one. `null` also covers a
 * pre-EA4 budget rule that stored no campaigns array at all — it stays ungoverned rather than
 * silently becoming a rule that matches nothing.
 */
export function builderBudgetCampaignIds(actions: unknown): string[] | null {
  const a0 = Array.isArray(actions) ? (actions[0] as Record<string, unknown> | undefined) : undefined
  if (!a0 || String(a0.type ?? '') !== 'budget') return null
  if (!Array.isArray(a0.campaigns) && !Array.isArray(a0.campaignIds)) return null
  return builderCampaignIds(a0)
}

/**
 * PLC-P2 — the picker list of ANY builder draft, keyed by the slug the caller expects.
 *
 * `builderBudgetCampaignIds` above refuses anything that is not a budget rule, which is right for
 * its callers (the assignment column, `reachForRules`) — they are asking a question about budget
 * governance specifically. The draft PREVIEW asks a different question: "which campaigns did the
 * operator put in this rule's picker", and it asks it of budget and placement drafts alike.
 *
 * Deliberately NOT a loosening of the function above: a `null` from that one means "not
 * assignment-governed", a distinction three call sites depend on. This one returns `null` only
 * when the draft is not the slug asked for or carries no picker array at all.
 */
export function builderDraftCampaignIds(actions: unknown, slug: string): string[] | null {
  const a0 = Array.isArray(actions) ? (actions[0] as Record<string, unknown> | undefined) : undefined
  if (!a0 || String(a0.type ?? '') !== slug) return null
  if (!Array.isArray(a0.campaigns) && !Array.isArray(a0.campaignIds)) return null
  return builderCampaignIds(a0)
}

/** True for a budget rule of EITHER shape — the catalogue test the column should have used. */
export function isBudgetRuleOfAnyShape(actions: unknown): boolean {
  return isEngineBudgetRule(actions) || builderBudgetCampaignIds(actions) != null
}
const convert = (raw: unknown, conv: 'frac' | 'cents' | 'plain'): number =>
  conv === 'frac' ? num(raw) / 100 : conv === 'cents' ? Math.round(num(raw) * 100) : num(raw)

// Flatten the builder's condition groups (all AND) → engine leaves.
//
// 🔴 P2.1 — an unmapped metric REFUSES, it no longer drops. The old behaviour logged a warning
// and skipped the condition, and because groups are flattened AND-only, every skip made the rule
// LOOSER — a rule saying "negate at ACOS > 80%" would have negated at any ACOS. Unmapped metrics
// are collected and returned; the caller fails the whole rule closed and names them.
/**
 * PLC-P7 — a `campaign.<metric>` field re-pointed at one lane's copy of the same metric.
 *
 * Returns the field UNCHANGED for the campaign scope, an unknown scope, or a field that is not
 * campaign-shaped. That conservatism is the point: this runs inside the one function every rule
 * type's conditions pass through, and the failure direction to avoid is a stray `scope` key
 * silently moving a Bid or Harvest rule's condition to a field nothing emits — which evaluates as
 * `undefined` and never matches, the exact defect this fixes.
 */
const PLACEMENT_SCOPE_KEYS = new Set(['tos', 'pdp', 'ros'])
export function placementScopedField(field: string, scope: string | undefined): string {
  if (!scope || !PLACEMENT_SCOPE_KEYS.has(scope)) return field
  if (!field.startsWith('campaign.')) return field
  const metric = field.slice('campaign.'.length)
  // Only metrics a lane actually carries. `budgetUtilization`, `dailyBudgetCents` and
  // `avgDailySpendCents` are campaign facts with no per-lane meaning — a lane has no budget — so a
  // scoped condition on one stays campaign-wide rather than pointing at a field that is never
  // emitted.
  const LANE_METRICS = new Set(['impressions', 'clicks', 'orders', 'spendCents', 'salesCents', 'acos', 'roas', 'ctr', 'cvr', 'cpcCents'])
  if (!LANE_METRICS.has(metric)) return field
  return `placement.${scope}.${metric}`
}

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
      /**
       * 🔴 PLC-P7 — the condition's own SCOPE, honoured at last.
       *
       * The Placement builder writes `scope` on every condition ('campaign' | 'tos' | 'pdp' |
       * 'ros') and this function read `metric`, `op` and `value` only — so "IF Top of Search ·
       * ACoS > 40%" evaluated the CAMPAIGN's ACoS. A stored-but-unread control on the one dropdown
       * that separates a Placement rule from a Budget one, and the cardinal sin of this section.
       *
       * The rewrite is deliberately narrow: it applies ONLY where the map's field is already a
       * `campaign.*` field and the scope names one of the three lanes. Anything else — a
       * `searchTerm.*` map, `scope: 'campaign'`, an unknown scope — falls through unchanged, so no
       * other rule type can be moved by a stray key.
       *
       * `PLACEMENT_SCOPE_FIELD` is not a second metric map: it re-points the same metric at the
       * same shape one level down (`campaign.acos` → `placement.tos.acos`), which is exactly how
       * `buildCampaignBudgetContexts` emits it. The conversion (percent → fraction, euros → cents)
       * still comes from the metric, because that is a property of the metric and not of the lane.
       */
      const field = placementScopedField(m.field, c.scope)
      leaves.push({ field, op: c.op, value: convert(c.value, m.conv) })
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
  /**
   * BP.P4b — the rule's criteria BLOCKS, one per builder group, each with ITS OWN action.
   *
   * H10's semantics (and the builder's whole UI — "Criteria 1", "Criteria 2", per-block THEN):
   * each block is an independent IF→THEN. The old translation flattened every group's conditions
   * into ONE AND-list and executed only `groups[0].action` — a two-block rule was silently
   * mangled into (all conditions of both blocks) → block 1's action, block 2's THEN discarded.
   *
   * The evaluator selects per context: blocks are checked IN ORDER and the first whose
   * conditions match acts (stated in the builder UI). `conditions`/`actions` above mirror
   * blocks[0] so every single-block consumer behaves exactly as before.
   */
  blocks?: Array<{ conditions: EngineLeaf[]; actions: Array<Record<string, unknown>> }>
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
  // C2 — a Bid rule produces a bid write OR a target status write, decided by its THEN op.
  bid: ['bid_apply', 'pause_target', 'enable_target'],
  sov: ['bid_apply'],
  'keyword-tracker': ['bid_apply'],
  'negative-targeting': ['add_negative_exact'],
  'keyword-harvesting': ['promote_to_exact', 'add_negative_exact'],
  'dayparting-schedule': ['dayparting_apply'],
}

/**
 * BP.P1 (2026-08-21) — the engine action types a rule will ACTUALLY produce, op-aware.
 *
 * The graduation ceiling used to judge a builder rule by everything its SLUG could produce
 * (`BUILDER_SLUG_ACTIONS`), so every Bid rule carried `pause_target` in its expansion and was
 * capped at PROPOSE — including a plain "Decrease Bid by 15%" that can never write a status.
 * A rule is judged by what IT does, and what it does is what the translation emits: this reads
 * `maybeTranslateAdsRule` itself, so the judgement and the execution cannot drift.
 *
 * Falls back to the conservative slug expansion when the rule cannot translate (untranslatable
 * conditions — those rules never run anyway), and to the raw types for engine-native rules.
 */
export function producedActionTypes(rule: { id?: string; actions?: unknown; conditions?: unknown }): string[] {
  const raw = (Array.isArray(rule.actions) ? rule.actions : [])
    .map((a) => String((a as { type?: unknown })?.type ?? '')).filter(Boolean)
  if (!isBuilderShapedAdsRule(rule)) return raw
  const translated = maybeTranslateAdsRule({ id: String(rule.id ?? 'ceiling'), actions: rule.actions, conditions: rule.conditions })
  if (!translated || translated.untranslatable?.length) {
    return raw.flatMap((t) => BUILDER_SLUG_ACTIONS[t] ?? [t])
  }
  // BP.P4b — a multi-block rule is judged by EVERY block's action (a rule that bids in block 1
  // and pauses in block 2 is structural), deduped for a stable answer.
  const types = (translated.blocks ?? [{ conditions: translated.conditions, actions: translated.actions }])
    .flatMap((b) => b.actions.map((a) => String(a.type ?? '')))
    .filter(Boolean)
  return [...new Set(types)]
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
  pause_target: 'bid', enable_target: 'bid',
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
    case 'pause_target': return 'Pause the target'
    case 'enable_target': return 'Unpause the target'
    case 'bid_apply': {
      // C1 — the two computed ops describe themselves; the five arithmetic ones read as before.
      const op = String(a.op ?? 'set')
      if (op === 'setCpc') return 'Set bid to the target’s measured CPC'
      if (op === 'targetAcos') return `Set bid to CPC × (${num(a.value)}% target ÷ actual ACoS)`
      return `Adjust bid ${op} ${num(a.value)}`
    }
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
  /**
   * Builder-shaped condition groups — one group, AND-joined, because that is all the engine stores.
   *
   * 🔴 Each leaf carries `field`, the ORIGINAL engine field it came from. A builder metric name is
   * context-FREE — "ACOS" is `campaign.acos` in a budget rule and `adTarget.acos` in a bid rule —
   * so re-deriving the field on save from the rule's slug silently rewrites it. Measured on prod:
   * editing `campaign.acos >= 0.4` on a `bid_down` rule stored it back as `adTarget.acos >= 0.45`,
   * changing which entity the rule reads. The field round-trips verbatim instead.
   */
  groups: Array<{ conditions: Array<{ metric: string; op: string; value: string; field: string }> }>
  /** one line per stored action, for the read-only summary */
  actionSummary: string[]
  /**
   * How much of this rule the builder may write back. NOT all-or-nothing — the PATCH route applies
   * only the fields present in the body, so "cannot represent the action" is no reason to refuse
   * an edit to the criteria.
   *
   *   'full'     — a builder-shaped rule: everything, as before.
   *   'criteria' — engine-native, every condition maps: name · criteria · caps · scope.
   *                `actions` is NEVER sent, so the rule keeps the action the engine is running.
   *   'meta'     — engine-native with a condition the builder cannot draw: name · caps · scope
   *                only. Criteria stay read-only because saving them would DROP the one not shown.
   */
  editLevel: 'full' | 'criteria' | 'meta'
  /** kept for callers that only need the yes/no; true only for `editLevel === 'full'` */
  editable: boolean
  /**
   * What the builder cannot carry, shown verbatim to the operator. Each entry names a concrete
   * thing, never a vague "unsupported". Non-empty does NOT mean nothing can be edited — read
   * `editLevel` for that.
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

  const leaves: Array<{ metric: string; op: string; value: string; field: string }> = []
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
    leaves.push({ metric: m.metric, op: String(c.op ?? 'gte'), value: String(unconvert(c.value, m.conv)), field: f })
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

  // 🔴 The criteria are editable whenever every stored condition round-trips — an unrepresentable
  // ACTION does not block that, because the save simply omits `actions`. Only an unmapped
  // CONDITION forces meta-only: showing 1 of 2 conditions and then writing that back would delete
  // the one the builder could not draw.
  const treeShaped = conds.some((c) => c && typeof c === 'object' && c.field == null)
  const editLevel: 'full' | 'criteria' | 'meta' =
    unmappedFields.length > 0 || treeShaped || !slug ? 'meta' : 'criteria'

  return {
    slug,
    groups: leaves.length ? [{ conditions: leaves }] : [],
    actionSummary: actions.map(describeAction),
    editLevel,
    editable: false, // an engine-native rule is never fully editable — see editLevel
    blockers,
    unmappedFields,
  }
}

/**
 * What to STORE for a rule's conditions, given what the builder sent.
 *
 * 🔴 An engine-native rule must stay engine-native. The builder always sends its own nested groups;
 * writing those onto a rule whose actions are engine types would leave a pair no adapter handles —
 * `maybeTranslateAdsRule` only fires on builder-shaped ACTIONS, so the nested conditions would
 * reach `evaluateFlatList`, whose leaves have no `field`, and throw mid-tick.
 *
 * So: translate back down to flat leaves, using the same maps the forward direction uses. The rule
 * keeps the shape the engine already runs, and nothing about its actions is touched.
 */
export function conditionsForStorage(
  existing: { actions?: unknown },
  incomingConditions: unknown,
): { conditions: object[]; unmapped: string[] } {
  const groups = (Array.isArray(incomingConditions) ? incomingConditions : []) as BuilderGroup[]
  const isNested = groups.some((g) => Array.isArray(g?.conditions))
  // A builder-shaped rule stores the builder shape, exactly as before.
  if (isBuilderShapedAdsRule(existing) || !isNested) return { conditions: groups as object[], unmapped: [] }

  const a0 = (Array.isArray(existing.actions) ? existing.actions[0] : null) as { type?: string } | null
  const slug = ENGINE_TYPE_SLUG[String(a0?.type ?? '')] ?? 'budget'
  const map = slug === 'sov' ? SOV_METRIC
    : slug === 'keyword-tracker' ? RANK_METRIC
      : slug === 'bid' ? ADTARGET_METRIC
        : slug === 'negative-targeting' || slug === 'keyword-harvesting' ? SEARCHTERM_METRIC
          : CAMPAIGN_METRIC
  // Cross-context, for the same reason the inverse reads that way: stored rules mix contexts.
  const merged = { ...CAMPAIGN_METRIC, ...SEARCHTERM_METRIC, ...ADTARGET_METRIC, ...SOV_METRIC, ...RANK_METRIC, ...map }
  const { leaves, unmapped } = translateConditions(groups, merged, 'patch')

  /**
   * 🔴 Restore the ORIGINAL field wherever the condition carried one.
   *
   * A builder metric name is context-free: "ACOS" resolves to `campaign.acos` or `adTarget.acos`
   * depending only on which map is consulted, and the map is chosen from the rule's slug. So a
   * `campaign.acos` condition on a `bid_down` rule came back as `adTarget.acos` — measured on
   * prod, editing 40 → 45 also moved the rule from reading the CAMPAIGN's ACoS to the TARGET's.
   *
   * The conversion (percent → fraction) still comes from the metric, because that is a property of
   * the metric and not of the field. Only the field name is pinned.
   */
  const orig: string[] = []
  for (const g of groups) for (const c of g.conditions ?? []) if (c.metric) orig.push(c.field ?? '')
  const pinned = leaves.map((l, i) => (orig[i] ? { ...l, field: orig[i] } : l))
  return { conditions: pinned as unknown as object[], unmapped }
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

  /**
   * BP.P4b — the three campaign-action families translate PER GROUP now. Each builder group is
   * its own IF→THEN block (that is the builder's UI and H10's semantics); the old shape flattened
   * every group's conditions into one AND-list and ran only `groups[0].action`, so a two-block
   * rule was silently mangled. Selection is the evaluator's: first matched block acts.
   */
  if (slug === 'budget') {
    const blocks: NonNullable<TranslatedRule['blocks']> = []
    const unmappedAll: string[] = []
    for (const g of groups.length ? groups : [{} as BuilderGroup]) {
      const act = g?.action ?? {}
      const { leaves, unmapped } = translateConditions([g], CAMPAIGN_METRIC, rule.id)
      unmappedAll.push(...unmapped)
      blocks.push({
        conditions: leaves,
        actions: [{
          type: 'budget_apply',
          op: act.op ?? 'set',
          value: num(act.value),
          minEur: a0.budgetFloor != null ? num(a0.budgetFloor) : 1,
          maxEur: a0.budgetCeiling != null ? num(a0.budgetCeiling) : null,
          // BUD-P3 — the rule's own lookback (Advanced Settings), honoured by per-window
          // CAMPAIGN_PERFORMANCE_BUDGET passes in the evaluator; absent = the trigger's 7 days.
          ...(typeof a0.windowDays === 'number' && Number.isFinite(a0.windowDays)
            ? { windowDays: Math.max(7, Math.min(90, Math.round(a0.windowDays))) } : {}),
          // 🔴 EA4 — the picker's campaigns were dropped here, so a Budget rule listing 12
          // campaigns ran account-wide. `budget_apply` reads this now; empty = no restriction.
          campaignIds: builderCampaignIds(a0),
          reason: `Budget rule ${rule.id}`,
        }],
      })
    }
    return {
      conditions: blocks[0].conditions,
      actions: blocks[0].actions,
      blocks,
      ...(unmappedAll.length ? { untranslatable: unmappedAll } : {}),
    }
  }

  if (slug === 'placement') {
    const blocks: NonNullable<TranslatedRule['blocks']> = []
    const unmappedAll: string[] = []
    for (const g of groups.length ? groups : [{} as BuilderGroup]) {
      const act = g?.action ?? {}
      const { leaves, unmapped } = translateConditions([g], CAMPAIGN_METRIC, rule.id)
      unmappedAll.push(...unmapped)
      blocks.push({
        conditions: leaves,
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
      })
    }
    return {
      conditions: blocks[0].conditions,
      actions: blocks[0].actions,
      blocks,
      ...(unmappedAll.length ? { untranslatable: unmappedAll } : {}),
    }
  }

  // Bid · SOV · Keyword Tracker are all keyword-bid-adjustment rules → the bid_apply handler. They
  // differ only in which signal their criteria gate on (perf vs SOV vs rank) → the metric map.
  if (slug === 'bid' || slug === 'sov' || slug === 'keyword-tracker') {
    const map = slug === 'sov' ? SOV_METRIC : slug === 'keyword-tracker' ? RANK_METRIC : ADTARGET_METRIC
    const label = slug === 'sov' ? 'SOV bid rule' : slug === 'keyword-tracker' ? 'Keyword Tracker bid rule' : 'Bid rule'
    const blocks: NonNullable<TranslatedRule['blocks']> = []
    const unmappedAll: string[] = []
    for (const g of groups.length ? groups : [{} as BuilderGroup]) {
      const act = g?.action ?? {}
      const { leaves, unmapped } = translateConditions([g], map, rule.id)
      unmappedAll.push(...unmapped)
      /**
       * C2 — a THEN of Pause/Unpause is a STATUS write, not a bid write, so it emits its own
       * action type rather than becoming a `bid_apply` op.
       *
       * Keeping one handler to one job is the point: `bid_apply` computes and clamps a bid, and
       * teaching it to sometimes write a status instead would make its floor, ceiling and
       * `applyBuilderOp` all dead code on half its calls. The campaign allowlist is carried
       * across because a pause must respect the builder's picker exactly as a bid does.
       */
      const action = (act.op === 'pauseTarget' || act.op === 'enableTarget')
        ? {
          type: act.op === 'pauseTarget' ? 'pause_target' : 'enable_target',
          campaignIds: builderCampaignIds(a0),
          reason: `${label} ${rule.id}`,
        }
        : {
          type: 'bid_apply',
          op: act.op ?? 'set',
          value: num(act.value),
          // SK1 stores bid guardrails as bidFloor/bidCeiling (fall back to the legacy budget*
          // fields); the handler still enforces a €0.05 floor regardless.
          minEur: a0.bidFloor != null ? num(a0.bidFloor) : a0.budgetFloor != null ? num(a0.budgetFloor) : null,
          maxEur: a0.bidCeiling != null ? num(a0.bidCeiling) : a0.budgetCeiling != null ? num(a0.budgetCeiling) : null,
          campaignIds: builderCampaignIds(a0),
          // BP.P4 — the rule's own lookback (Bid rules; `windowDays` on the stored action) rides
          // into the handler so computed ops measure over the window the operator chose.
          ...(typeof a0.windowDays === 'number' ? { windowDays: a0.windowDays } : {}),
          reason: `${label} ${rule.id}`,
        }
      blocks.push({ conditions: leaves, actions: [action] })
    }
    return {
      conditions: blocks[0].conditions,
      actions: blocks[0].actions,
      blocks,
      ...(unmappedAll.length ? { untranslatable: unmappedAll } : {}),
    }
  }

  /**
   * HP1 — the two search-term families translate their condition groups as OR-of-ANDs.
   *
   * Their groups share ONE THEN (unlike the campaign family, where each block carries its own
   * action), so multiple criteria blocks mean "this bar OR that bar". The old flatten AND-ed
   * every group's conditions together — stricter than authored, fail-safe but false. The blocks
   * reuse BP.P4b's evaluator selection (first matching block acts; the actions are identical
   * across blocks, so first-match IS the OR).
   */
  if (slug === 'negative-targeting') {
    /**
     * NEG-P1 — the WHOLE form rides into execution, exactly HP1's move one tab over. The stored
     * shape is the harvest wire's shape, so `normalizeHarvestWire` reads it verbatim: the ad-group
     * mapping matrix (look-set gates which contexts may act; create-ticks decide what is created
     * where — E → negative exact, P → negative phrase, product → negative product target), the
     * Search Terms contains-filters, the brand/competitor filters ("never negate your own brand
     * terms" is a WRITE-PATH promise now, not copy) and dedupe. `levels` honours the Negation
     * Level select including 'both' (previously a silent CAMPAIGN). Default = adgroup, matching
     * the builder's default and the measured landing rate (ad-group 99% vs campaign 0 of 20).
     */
    const wire = normalizeHarvestWire(a0)
    const levels = NEG_LEVELS[String(a0.negationLevel ?? 'adgroup')] ?? ['AD_GROUP']
    const actions: Array<Record<string, unknown>> = [{
      type: 'add_negative_exact',
      scope: levels[0],
      levels,
      negative: wire,
      protectConverting: a0.protectConverting !== false,
      protectDays: a0.protectDays != null ? num(a0.protectDays) : 30,
      reason: `Negative rule ${rule.id}`,
    }]
    const blocks: NonNullable<TranslatedRule['blocks']> = []
    const unmappedAll: string[] = []
    for (const g of groups.length ? groups : [{} as BuilderGroup]) {
      const { leaves, unmapped } = translateConditions([g], SEARCHTERM_METRIC, rule.id)
      unmappedAll.push(...unmapped)
      blocks.push({ conditions: leaves, actions })
    }
    return {
      conditions: blocks[0].conditions,
      actions,
      blocks,
      ...(unmappedAll.length ? { untranslatable: unmappedAll } : {}),
    }
  }

  if (slug === 'keyword-harvesting') {
    /**
     * HP1 — the WHOLE form rides into execution. `normalizeHarvestWire` carries the ad-group
     * mapping matrix, the Search Terms contains-filters, the brand filters and `dedupe`;
     * `action.bid` carries the mode+value so the handler computes the bid (CPC-inheriting by
     * default) instead of the pre-HP1 €0.75 constant behind a "Suggested bid" label. The
     * negate-in-source action gets the SAME source allowlist, so a mapped rule never negates a
     * term it did not harvest.
     */
    const wire = normalizeHarvestWire(a0)
    const bid = (a0.bid ?? {}) as { mode?: unknown; value?: unknown }
    const actions: Array<Record<string, unknown>> = [{
      type: 'promote_to_exact',
      bid: { mode: normalizeHarvestBidMode(bid.mode), value: bid.value != null && String(bid.value).trim() !== '' ? num(bid.value) : null },
      harvest: wire,
      reason: `Harvest rule ${rule.id}`,
    }]
    if (a0.negateInSource === true) {
      actions.push({
        type: 'add_negative_exact', scope: 'AD_GROUP',
        ...(wire.blocks ? { sourceLookAdGroupIds: [...new Set(wire.blocks.flatMap((b) => b.look))] } : {}),
        reason: `Harvest negate-in-source ${rule.id}`,
      })
    }
    const blocks: NonNullable<TranslatedRule['blocks']> = []
    const unmappedAll: string[] = []
    for (const g of groups.length ? groups : [{} as BuilderGroup]) {
      const { leaves, unmapped } = translateConditions([g], SEARCHTERM_METRIC, rule.id)
      unmappedAll.push(...unmapped)
      blocks.push({ conditions: leaves, actions })
    }
    return {
      conditions: blocks[0].conditions,
      actions,
      blocks,
      ...(unmappedAll.length ? { untranslatable: unmappedAll } : {}),
    }
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
