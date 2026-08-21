/**
 * ES1 — Manual-rule Suggestions.
 *
 * Manual-control ads rules are propose-only (force dry-run). When one matches, the engine calls
 * generateSuggestionsFromExecution() to record each proposed action as an AdsRuleSuggestion the
 * operator can Approve (apply live) or Dismiss on the Suggestions page. Deduped per
 * rule×entity×change so a recurring 15-min tick doesn't pile up duplicates.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { EXCLUDE_AMS_DAILY } from '../ads-core/ams-daily.js'

interface Entity { type: string; id: string; name: string | null }
function extractEntity(context: unknown): Entity | null {
  const c = (context ?? {}) as { campaign?: { id?: string; name?: string }; searchTerm?: { query?: string; externalCampaignId?: string }; adTarget?: { id?: string }; marketplace?: string }
  if (c.campaign?.id) return { type: 'CAMPAIGN', id: c.campaign.id, name: c.campaign.name ?? null }
  if (c.searchTerm?.query) return { type: 'SEARCH_TERM', id: `${c.searchTerm.externalCampaignId ?? ''}:${c.searchTerm.query}`, name: c.searchTerm.query }
  if (c.adTarget?.id) return { type: 'AD_TARGET', id: c.adTarget.id, name: null }
  if (c.marketplace) return { type: 'MARKETPLACE', id: c.marketplace, name: c.marketplace }
  return null
}

/**
 * ADX A2.1 — action types that tell the operator something rather than propose a change.
 * A notification has nothing to approve or dismiss, so it belongs in the activity feed,
 * not the suggestions queue. `log_only` is included for the same reason.
 */
const NON_PROPOSAL_ACTIONS = new Set(['notify', 'alert_operator', 'log_only'])

/**
 * 🔴 HV.8c — actions that sweep the account from a single firing, and therefore have no entity.
 *
 * The dedupe key is `(ruleId, entityId, proposedKey)`, which works perfectly for an action that
 * acts ON its context: `bid_down` produced **60 cards carrying 60 distinct payloads** — sixty real
 * proposals about sixty keywords. A SWEEP does the same thing regardless of which context happened
 * to trigger it, so the entity is noise, and the key multiplies one proposal by however many
 * contexts matched.
 *
 * Measured on prod 2026-08-13: `harvest_and_negate` holds **18 cards carrying 2 distinct payloads**
 * — one proposal per rule, replicated across all nine marketplaces
 * (`MARKETPLACE:NL/IE/IT/DE/PL/UK/FR/ES/SE`). Worse than merely noisy: the payload itself says
 * `scoped: false` and `wouldNegate: 14` — an ACCOUNT-WIDE sweep — while five of the nine cards are
 * filed against markets whose connection has `writesEnabledAt: NULL` and cannot be written to at
 * all. An operator approving the NL card would be approving an account-wide negation.
 *
 * So these collapse to one card against a stable account-level entity, which is also the truthful
 * one: the proposal is not about NL.
 */
const SWEEP_ACTIONS = new Set(['harvest_and_negate', 'sync_negatives_across_campaigns'])

/** The one entity an account-wide sweep is actually about. */
const ACCOUNT_ENTITY = { type: 'ACCOUNT', id: 'account', name: 'the whole account' } as const

// ── SG.0 — the view families ─────────────────────────────────────────────────
/**
 * The Suggestions page groups the queue into H10's tabs by ACTION TYPE. This is the ONE map —
 * the /count endpoint, the list route's `family` filter and the page all read it. A client-side
 * copy is how the Automations type filter came to be blind to 17 of 51 rules; never make one.
 */
export type SuggestionFamily = 'bids' | 'new-keywords' | 'negatives' | 'budget' | 'placement' | 'other'
export const SUGGESTION_FAMILIES: readonly SuggestionFamily[] = ['bids', 'new-keywords', 'negatives', 'budget', 'placement', 'other']
const FAMILY_BY_ACTION: Record<string, SuggestionFamily> = {
  bid_apply: 'bids', bid_down: 'bids', bid_up: 'bids', lower_bid_to_floor: 'bids',
  raise_bids_for_rank_defense: 'bids', scale_bids_for_price_change: 'bids',
  pause_target: 'bids', enable_target: 'bids',
  promote_to_exact: 'new-keywords', harvest_and_negate: 'new-keywords',
  add_negative_exact: 'negatives', add_negative_phrase: 'negatives', sync_negatives_across_campaigns: 'negatives',
  budget_apply: 'budget', adjust_ad_budget: 'budget', set_daily_budget: 'budget', reroute_marketplace_budget: 'budget',
  placement_apply: 'placement', set_placement_multiplier: 'placement',
}
export function familyOf(actionType: unknown): SuggestionFamily {
  return FAMILY_BY_ACTION[String(actionType ?? '')] ?? 'other'
}
/** Family of a stored row. The action type leads `proposedKey`, so old rows resolve too. */
export function familyOfRow(row: { proposedAction: unknown; proposedKey: string }): SuggestionFamily {
  const t = (row.proposedAction as { type?: unknown } | null)?.type ?? row.proposedKey.split(':')[0]
  return familyOf(t)
}

/**
 * SG.2d — the rule's own ACoS criterion, for the ADAPTIVE traffic dot.
 *
 * The dot's precedence is: campaign target ACoS → THIS (the threshold the operator wrote into
 * the rule that produced the row) → the default 30% band. Reads BOTH rule shapes (engine-flat
 * `[{field,op,value}]` and builder-nested `[{conditions:[…]}]` — reading only one is how the
 * grid once printed "—" on 18 of 18 rules), takes the first `.acos` condition, and normalises
 * the stored unit with the established discriminator: a share cannot exceed 1, so ≤ 1 is a
 * fraction (0.4 → 40) and anything above is already a percent (the 0.3-vs-30 trap is live in
 * stored rules — never blind-multiply).
 */
export function acosThresholdOf(conditions: unknown): number | null {
  const leaves: Array<Record<string, unknown>> = []
  const walk = (list: unknown) => {
    if (!Array.isArray(list)) return
    for (const c of list) {
      if (!c || typeof c !== 'object') continue
      const o = c as Record<string, unknown>
      if (Array.isArray(o.conditions)) walk(o.conditions) // builder group
      else leaves.push(o) // engine-flat leaf
    }
  }
  walk(conditions)
  for (const leaf of leaves) {
    const field = String(leaf.field ?? '')
    if (!/\.acos$/i.test(field)) continue
    const v = Number(leaf.value)
    if (!Number.isFinite(v) || v <= 0) continue
    return v <= 1 ? v * 100 : v
  }
  return null
}

// stable change-kind key (intent, not current value) so the same proposed change dedupes.
function proposedKey(action: Record<string, unknown>): string {
  const parts = [String(action.type ?? '')]
  if (action.op != null) parts.push(String(action.op))
  if (action.value != null) parts.push(String(action.value))
  if (action.placement != null) parts.push(String(action.placement))
  return parts.join(':')
}

/**
 * SG.9 — the mute set for a producer, as `${entityType}|${entityId}` keys.
 *
 * H10's third verb ("Pausing Suggestions") means *stop collecting data on this keyword or
 * target for suggestions* — the entity keeps running at Amazon, we simply stop proposing for
 * it. That is enforced HERE, at the writer, not at read time: a muted entity must stop
 * generating rows, otherwise the queue keeps growing behind a filter and the operator's
 * "stop suggesting this" was cosmetic.
 */
export async function mutedKeys(scope: 'rules' | 'ai' | 'recommendations'): Promise<Set<string>> {
  try {
    const rows = await prisma.adsSuggestionMute.findMany({ where: { scope }, select: { entityType: true, entityId: true } })
    return new Set(rows.map((r) => `${r.entityType}|${r.entityId}`))
  } catch {
    // A mute table we cannot read must not silently un-mute the account: callers treat a
    // throw as "unknown" and skip proposing nothing new — but an empty set here would do the
    // opposite. Fail LOUD-ish by returning empty only after logging; the tick is idempotent.
    logger.warn('[ads-suggestions] mute lookup failed — proposing without mutes this tick')
    return new Set()
  }
}

export async function generateSuggestionsFromExecution(args: {
  ruleId: string; ruleName: string; trigger: string; executionId: string
  context: unknown
  actions: Array<Record<string, unknown>>
  actionResults: Array<{ type: string; ok?: boolean; output?: unknown }>
}): Promise<number> {
  try {
    const entity = extractEntity(args.context)
    if (!entity) return 0
    const muted = await mutedKeys('rules')
    const marketplace = (args.context as { marketplace?: string })?.marketplace ?? null
    let written = 0
    for (let i = 0; i < args.actionResults.length; i++) {
      const res = args.actionResults[i]
      const action = args.actions[i] ?? {}
      // only surface ACTIONABLE proposals — skip failures, no-change, allowlist-skips
      const out = (res.output ?? {}) as { noChange?: boolean; skipped?: string; noActiveWindow?: boolean; wouldChange?: unknown }
      if (res.ok === false || out.noChange || out.skipped || out.noActiveWindow) continue

      // ADX A2.1 — a suggestion is a CHANGE an operator can approve or dismiss. Two
      // categories were passing the filter above and drowning the queue.
      //
      // Measured on prod 2026-08-04, the first time this pipeline had ever produced
      // anything: of 227 pending rows, 117 were notifications, 48 were results that
      // explicitly reported changing nothing, and only 11 were a specific change to a
      // specific entity. A 5% signal rate. The 22 surviving rules were producing good
      // proposals — promote "motorradjacke herren sommer" to exact and negate it in
      // broad, trim GALE BROAD DE by 15% on ACOS — and they were unfindable.
      //
      // This was my own regression: ADX.2 made every matched dry-run propose, without
      // asking whether the action was the kind of thing you approve.
      if (NON_PROPOSAL_ACTIONS.has(String(action.type ?? ''))) continue
      if (out.wouldChange === 0 || out.wouldChange === '0') continue
      const key = proposedKey(action)
      // HV.8c — a sweep is filed against the account, not against whichever context tripped it.
      // Everything else keeps its real entity, so `bid_down`'s sixty distinct proposals stay sixty.
      const sweep = SWEEP_ACTIONS.has(String(action.type ?? ''))
      const ent = sweep ? ACCOUNT_ENTITY : entity
      // SG.9 — the operator muted this entity: stop proposing for it. The entity keeps
      // running at Amazon; only the suggestions stop (H10's "Pausing Suggestions").
      if (muted.has(`${ent.type}|${ent.id}`)) continue
      // upsert on the dedupe key — keep one row per rule×entity×change. The update branch never
      // touches `status` (the operator's decision is not overwritten by a tick); resurrection is
      // the LIFECYCLE SWEEP's job, with its windows (see sweepSuggestionLifecycle below).
      // `lastSeenAt` is stamped on every sighting: it records the newest evaluation that still
      // proposes this change, which is what expiry and re-propose both key on. `createdAt` stays
      // the FIRST sighting.
      const proposal = { ...action, ...(res.output as object) } as object
      await prisma.adsRuleSuggestion.upsert({
        where: { ruleId_entityId_proposedKey: { ruleId: args.ruleId, entityId: ent.id, proposedKey: key } },
        create: {
          ruleId: args.ruleId, ruleName: args.ruleName, executionId: args.executionId, trigger: args.trigger, marketplace,
          entityType: ent.type, entityId: ent.id, entityName: ent.name,
          proposedAction: proposal, proposedKey: key, status: 'pending',
        },
        update: {
          executionId: args.executionId, proposedAction: proposal, lastSeenAt: new Date(),
        },
      })
      written++
    }
    return written
  } catch (e) {
    logger.warn('[ads-suggestions] generate failed', { ruleId: args.ruleId, error: (e as Error).message })
    return 0
  }
}

// ── S.1 — Navigation resolver ────────────────────────────────────────────────
// A suggestion records WHICH entity it touches (entityType + entityId), but the
// Suggestions page needs to deep-link the operator to the exact sub-page that
// entity lives on. We resolve that link at READ time (no migration, no writes) so
// it also fixes historical rows — notably AD_TARGET rows, whose entityName was
// stored null (the operator otherwise saw a raw cuid).
const ADS_BASE = '/marketing/ads'

export interface SuggestionSource {
  /** Deep link to the source sub-page, or null when the entity can't be resolved. */
  href: string | null
  /** Human label for the entity (campaign name · keyword text · search query · marketplace). */
  label: string
  campaignId?: string
  campaignName?: string
  adGroupId?: string
  adGroupName?: string
  /** Keyword/target text (AD_TARGET) or the search query (SEARCH_TERM). */
  keyword?: string
  /** Match type for AD_TARGET (EXACT | PHRASE | BROAD | …). */
  matchType?: string
  marketplace?: string | null
}

/** The minimal suggestion shape the resolver reads. */
export interface SourceRow {
  entityType: string
  entityId: string
  entityName: string | null
  marketplace: string | null
}

/** Pre-fetched lookups, keyed for O(1) resolution (see attachSourceLinks). */
export interface SourceLookups {
  /** Campaign by internal id (CAMPAIGN entities). */
  campaign: Map<string, { id: string; name: string }>
  /** AdTarget by internal id, flattened with its ad-group + campaign (AD_TARGET entities). */
  adTarget: Map<string, {
    expressionValue: string; expressionType: string; adGroupId: string
    adGroupName: string | null; campaignId: string | null; campaignName: string | null
  }>
  /** Campaign by `${externalCampaignId}|${marketplace}` and a bare `${externalCampaignId}` fallback (SEARCH_TERM entities). */
  extCampaign: Map<string, { id: string; name: string }>
}

const emptyLookups = (): SourceLookups => ({ campaign: new Map(), adTarget: new Map(), extCampaign: new Map() })

/**
 * Pure: map one suggestion row + the pre-fetched lookups → a SuggestionSource.
 * Degrades gracefully (href:null, best-effort label) when the entity is gone.
 */
export function resolveSourceLink(row: SourceRow, lk: SourceLookups): SuggestionSource {
  const fallback = row.entityName ?? row.entityId
  switch (row.entityType) {
    case 'CAMPAIGN': {
      const c = lk.campaign.get(row.entityId)
      if (!c) return { href: null, label: fallback, marketplace: row.marketplace }
      return { href: `${ADS_BASE}/campaigns/${c.id}`, label: c.name, campaignId: c.id, campaignName: c.name, marketplace: row.marketplace }
    }
    case 'SEARCH_TERM': {
      // entityId is `${externalCampaignId}:${query}` — the query itself may contain ':'.
      const idx = row.entityId.indexOf(':')
      const ext = idx >= 0 ? row.entityId.slice(0, idx) : row.entityId
      const query = (idx >= 0 ? row.entityId.slice(idx + 1) : '') || row.entityName || ''
      const c = lk.extCampaign.get(`${ext}|${row.marketplace ?? ''}`) ?? lk.extCampaign.get(ext)
      if (!c) return { href: null, label: query || fallback, keyword: query || undefined, marketplace: row.marketplace }
      return { href: `${ADS_BASE}/campaigns/${c.id}?tab=search-terms`, label: query || c.name, keyword: query || undefined, campaignId: c.id, campaignName: c.name, marketplace: row.marketplace }
    }
    case 'AD_TARGET': {
      const t = lk.adTarget.get(row.entityId)
      if (!t) return { href: null, label: fallback, marketplace: row.marketplace }
      const href = t.campaignId ? `${ADS_BASE}/campaigns/${t.campaignId}/ad-groups/${t.adGroupId}?tab=targets` : null
      return {
        href, label: t.expressionValue || fallback, keyword: t.expressionValue || undefined,
        matchType: t.expressionType || undefined, campaignId: t.campaignId ?? undefined, campaignName: t.campaignName ?? undefined,
        adGroupId: t.adGroupId, adGroupName: t.adGroupName ?? undefined, marketplace: row.marketplace,
      }
    }
    case 'MARKETPLACE':
      // Marketplace-scope rules (e.g. budget caps) → the Ad Manager grid (market lives in a shared store, not the URL).
      return { href: `${ADS_BASE}/campaigns`, label: row.entityId, marketplace: row.entityId }
    case 'ACCOUNT':
      // HV.8c — an account-wide sweep. It has no single entity to link to, and inventing one is how
      // this proposal came to be filed against nine marketplaces including five that cannot be
      // written to. The rules board is the honest destination.
      return { href: `${ADS_BASE}/rules-automation`, label: 'the whole account', marketplace: row.marketplace }
    default:
      return { href: null, label: fallback, marketplace: row.marketplace }
  }
}

/**
 * Batch-resolve a list of suggestions: three `findMany`s (campaign / adTarget / ext-campaign),
 * one per entity family, then a pure per-row map. O(1) DB round-trips regardless of list size.
 */
export async function attachSourceLinks<T extends SourceRow>(items: T[]): Promise<Array<T & { source: SuggestionSource }>> {
  if (items.length === 0) return []
  const campaignIds = new Set<string>()
  const adTargetIds = new Set<string>()
  const extIds = new Set<string>()
  for (const it of items) {
    if (it.entityType === 'CAMPAIGN') campaignIds.add(it.entityId)
    else if (it.entityType === 'AD_TARGET') adTargetIds.add(it.entityId)
    else if (it.entityType === 'SEARCH_TERM') {
      const idx = it.entityId.indexOf(':')
      extIds.add(idx >= 0 ? it.entityId.slice(0, idx) : it.entityId)
    }
  }

  const [campaigns, adTargets, extCampaigns] = await Promise.all([
    campaignIds.size
      ? prisma.campaign.findMany({ where: { id: { in: [...campaignIds] } }, select: { id: true, name: true } })
      : Promise.resolve([] as Array<{ id: string; name: string }>),
    adTargetIds.size
      ? prisma.adTarget.findMany({
          where: { id: { in: [...adTargetIds] } },
          select: { id: true, expressionValue: true, expressionType: true, adGroupId: true, adGroup: { select: { name: true, campaign: { select: { id: true, name: true } } } } },
        })
      : Promise.resolve([] as Array<{ id: string; expressionValue: string; expressionType: string; adGroupId: string; adGroup: { name: string; campaign: { id: string; name: string } | null } | null }>),
    extIds.size
      ? prisma.campaign.findMany({ where: { externalCampaignId: { in: [...extIds] } }, select: { id: true, name: true, externalCampaignId: true, marketplace: true } })
      : Promise.resolve([] as Array<{ id: string; name: string; externalCampaignId: string | null; marketplace: string | null }>),
  ])

  const lk = emptyLookups()
  for (const c of campaigns) lk.campaign.set(c.id, { id: c.id, name: c.name })
  for (const t of adTargets) {
    lk.adTarget.set(t.id, {
      expressionValue: t.expressionValue, expressionType: t.expressionType, adGroupId: t.adGroupId,
      adGroupName: t.adGroup?.name ?? null, campaignId: t.adGroup?.campaign?.id ?? null, campaignName: t.adGroup?.campaign?.name ?? null,
    })
  }
  for (const c of extCampaigns) {
    if (!c.externalCampaignId) continue
    lk.extCampaign.set(`${c.externalCampaignId}|${c.marketplace ?? ''}`, { id: c.id, name: c.name })
    if (!lk.extCampaign.has(c.externalCampaignId)) lk.extCampaign.set(c.externalCampaignId, { id: c.id, name: c.name }) // bare-ext fallback → first seen
  }

  return items.map((it) => ({ ...it, source: resolveSourceLink(it, lk) }))
}

// ── SG.2 — the decision data: live metrics, current values, the projected value ──────────────
//
// The operator judges a suggestion against the entity's real performance, so every row carries:
//   metrics   trailing 30-day performance for the entity the suggestion touches. NULL when the
//             entity has no performance row in the window — target-level coverage is ~18% of
//             targets (measured, BID.S2), so absence is the COMMON case and must render "—",
//             never a confident 0. When a row exists, its zeros are real zeros.
//   current   the live value the change would move (bid cents / daily budget EUR) + the
//             campaign's own target ACoS, read at request time — never parsed out of the frozen
//             `wouldChange` string.
//   suggested the projected new value, computed from the action's op/value against `current` —
//             ONE implementation, so the Suggested column cannot drift from what apply computes
//             (the handler's own min/max clamps still bind at apply time; this is the preview).
//
// 🔴 Aggregates over AmazonAdsDailyPerformance MUST exclude the AMS-stream duplicates
// (EXCLUDE_AMS_DAILY — the RPT session measured +40.7% spend without it), and must never read
// the AdTarget lifetime counters (dead columns, zero on all rows since H.2e).

export interface SuggestionMetrics {
  windowDays: number
  impressions: number
  clicks: number
  spendCents: number
  salesCents: number
  orders: number
  /** derived; null when the denominator is 0 — "not measurable", never 0 */
  acos: number | null
  roas: number | null
  ctr: number | null
  cvr: number | null
  cpcCents: number | null
}

export interface SuggestionCurrent {
  bidCents?: number | null
  dailyBudgetEur?: number | null
  /** the campaign's own target ACoS, as PERCENT (stored as a fraction; both units exist in the
   *  wild — same defensive discriminator as toImpressionShareFraction: a target over 1 is
   *  already a percent). */
  targetAcosPct?: number | null
  entityStatus?: string | null
}

export interface SuggestionDestination {
  matchType: string
  bidCents: number | null
  campaignName: string | null
  /** SPONSORED_PRODUCTS | SPONSORED_BRANDS | SPONSORED_DISPLAY — the SP/SB/SD pill */
  adProduct: string | null
  adGroupName: string | null
  note: string
}

export interface SuggestionSuggested {
  bidCents?: number | null
  budgetEur?: number | null
  /**
   * SG.2b/f — where the change LANDS (H10's approve-hover card: "will be added to the
   * following entities when changes are applied"). New keywords resolve the action's external
   * ad-group id; negatives resolve the external campaign (+ ad group at AD_GROUP scope). A
   * promote today has ONE destination — the list shape is H10's, and multi-destination
   * harvest is the known ENGINE gap, not a display one.
   */
  destinations?: SuggestionDestination[]
}

const WINDOW_DAYS = 30
const BID_FLOOR_CENTS = 5

function derive(sum: { impressions: number; clicks: number; spendCents: number; salesCents: number; orders: number }): SuggestionMetrics {
  return {
    windowDays: WINDOW_DAYS,
    ...sum,
    acos: sum.salesCents > 0 ? sum.spendCents / sum.salesCents : null,
    roas: sum.spendCents > 0 ? sum.salesCents / sum.spendCents : null,
    ctr: sum.impressions > 0 ? sum.clicks / sum.impressions : null,
    cvr: sum.clicks > 0 ? sum.orders / sum.clicks : null,
    cpcCents: sum.clicks > 0 ? Math.round(sum.spendCents / sum.clicks) : null,
  }
}

const asPct = (v: unknown): number | null => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return n <= 1 ? n * 100 : n
}

/** The projected new value for a bid-family action, in cents. Mirrors the handlers' math. */
export function projectBidCents(action: Record<string, unknown>, currentCents: number | null): number | null {
  const type = String(action.type ?? '')
  const op = String(action.op ?? '')
  const v = Number(action.value)
  if (type === 'lower_bid_to_floor') return BID_FLOOR_CENTS
  if (type === 'bid_down' && currentCents != null) return Math.round(currentCents * (1 - Number(action.percent ?? 0) / 100))
  if (type === 'bid_up' && currentCents != null) return Math.round(currentCents * (1 + Number(action.percent ?? 0) / 100))
  if (type === 'bid_apply' && Number.isFinite(v)) {
    if (op === 'setValue') return Math.round(v * 100) // builder bid values are EUR
    if (currentCents == null) return null
    if (op === 'incPct') return Math.round(currentCents * (1 + v / 100))
    if (op === 'decPct') return Math.round(currentCents * (1 - v / 100))
  }
  return null
}

/** The projected new daily budget for a budget-family action, in EUR. Mirrors the handlers. */
export function projectBudgetEur(action: Record<string, unknown>, currentEur: number | null): number | null {
  const type = String(action.type ?? '')
  const op = String(action.op ?? '')
  const v = Number(action.value)
  if (type === 'set_daily_budget' && Number.isFinite(v)) return v
  if (type === 'adjust_ad_budget' && currentEur != null) return Math.max(1, currentEur * (1 + Number(action.percent ?? 0) / 100))
  if (type === 'budget_apply' && Number.isFinite(v)) {
    if (op === 'setValue') return v
    if (currentEur == null) return null
    if (op === 'incPct') return Math.max(1, currentEur * (1 + v / 100))
    if (op === 'decPct') return Math.max(1, currentEur * (1 - v / 100))
  }
  return null
}

export interface DecisionRow extends SourceRow {
  proposedAction: unknown
  proposedKey: string
}

export async function attachDecisionData<T extends DecisionRow>(
  items: T[],
): Promise<Array<T & { metrics: SuggestionMetrics | null; current: SuggestionCurrent; suggested: SuggestionSuggested; volume: number | null }>> {
  if (items.length === 0) return []
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000)

  const targetIds = [...new Set(items.filter((i) => i.entityType === 'AD_TARGET').map((i) => i.entityId))]
  const campaignIds = [...new Set(items.filter((i) => i.entityType === 'CAMPAIGN').map((i) => i.entityId))]
  const termPairs = items
    .filter((i) => i.entityType === 'SEARCH_TERM')
    .map((i) => {
      const idx = i.entityId.indexOf(':')
      return { ext: idx >= 0 ? i.entityId.slice(0, idx) : i.entityId, query: idx >= 0 ? i.entityId.slice(idx + 1) : '' }
    })

  const [targets, campaigns] = await Promise.all([
    targetIds.length
      ? prisma.adTarget.findMany({
        where: { id: { in: targetIds } },
        select: {
          id: true, bidCents: true, status: true, externalTargetId: true,
          adGroup: { select: { campaign: { select: { dynamicBidding: true } } } },
        },
      })
      : [],
    campaignIds.length
      ? prisma.campaign.findMany({
        where: { id: { in: campaignIds } },
        select: { id: true, dailyBudget: true, status: true, externalCampaignId: true, dynamicBidding: true },
      })
      : [],
  ])
  const targetById = new Map(targets.map((t) => [t.id, t] as const))
  const campaignById = new Map(campaigns.map((c) => [c.id, c] as const))

  // SG.2b/f — destination resolution for the approve-hover card.
  // promote_to_exact carries an EXTERNAL ad-group id; negatives carry an EXTERNAL campaign id
  // (+ ad group at AD_GROUP scope). Batch-resolve both families.
  const acts = items.map((i) => (i.proposedAction ?? {}) as Record<string, unknown>)
  const destExtIds = [
    ...new Set(
      acts
        .filter((a) => String(a.type ?? '') === 'promote_to_exact' && typeof a.adGroupId === 'string')
        .map((a) => a.adGroupId as string)
        .concat(
          acts
            .filter((a) => String(a.type ?? '').startsWith('add_negative') && typeof a.externalAdGroupId === 'string')
            .map((a) => a.externalAdGroupId as string),
        ),
    ),
  ]
  const negExtCampaignIds = [
    ...new Set(
      acts
        .filter((a) => String(a.type ?? '').startsWith('add_negative') && typeof a.externalCampaignId === 'string')
        .map((a) => a.externalCampaignId as string),
    ),
  ]
  // HP1/NEG-P wire rules: the dry-run's own `outcomes[]` carries the full creation set (LOCAL
  // ad-group ids, per-destination bids for promotes, level for negatives) — the engine computed
  // it, so the hover card reads it verbatim, never a parallel expansion of the mapping.
  // Negatives adopted the same contract on 2026-08-21 (peer push 09751db79).
  const wireCreates = (a: Record<string, unknown>) => {
    const t = String(a.type ?? '')
    return (t === 'promote_to_exact' || t.startsWith('add_negative')) && Array.isArray(a.outcomes)
      ? (a.outcomes as Array<Record<string, unknown>>).filter((o) => o?.wouldCreate === true && typeof o.adGroupId === 'string')
      : []
  }
  const localDestIds = [...new Set(acts.flatMap((a) => wireCreates(a).map((o) => o.adGroupId as string)))]
  const [destGroups, negCampaigns, localDestGroups] = await Promise.all([
    destExtIds.length
      ? prisma.adGroup.findMany({
        where: { externalAdGroupId: { in: destExtIds } },
        select: { externalAdGroupId: true, name: true, campaign: { select: { name: true, adProduct: true } } },
      })
      : [],
    negExtCampaignIds.length
      ? prisma.campaign.findMany({
        where: { externalCampaignId: { in: negExtCampaignIds } },
        select: { externalCampaignId: true, name: true, adProduct: true },
      })
      : [],
    localDestIds.length
      ? prisma.adGroup.findMany({
        where: { id: { in: localDestIds } },
        select: { id: true, name: true, campaign: { select: { name: true, adProduct: true } } },
      })
      : [],
  ])
  const destByExt = new Map(destGroups.map((g) => [g.externalAdGroupId, g] as const))
  const negCampByExt = new Map(negCampaigns.map((c) => [c.externalCampaignId, c] as const))
  const destByLocalId = new Map(localDestGroups.map((g) => [g.id, g] as const))

  // SG.2f — market search volume for SEARCH_TERM rows, from the Brand Analytics feed (brand-level
  // rows, asin null = the whole market's volume). Latest period wins; absence renders "—" — the
  // feed covers a minority of queries and a missing row is not a zero.
  const termQueries = [...new Set(termPairs.map((p) => p.query).filter(Boolean))]
  const termMkts = [...new Set(items.filter((i) => i.entityType === 'SEARCH_TERM').map((i) => i.marketplace).filter((x): x is string => !!x))]
  const volRows = termQueries.length
    ? await prisma.searchQueryPerformance.findMany({
      where: { searchQuery: { in: termQueries }, ...(termMkts.length ? { marketplace: { in: termMkts } } : {}), asin: null },
      select: { searchQuery: true, marketplace: true, searchQueryVolume: true, startDate: true },
      orderBy: { startDate: 'desc' },
      take: 2000,
    })
    : []
  const volByKey = new Map<string, number>()
  for (const v of volRows) {
    const k = `${v.marketplace}|${v.searchQuery}`
    if (!volByKey.has(k)) volByKey.set(k, v.searchQueryVolume) // newest first
  }

  const extTargetIds = targets.map((t) => t.externalTargetId).filter((x): x is string => !!x)
  const extCampaignIds = campaigns.map((c) => c.externalCampaignId).filter((x): x is string => !!x)

  const sum = (r: { _sum: { impressions: number | null; clicks: number | null; costMicros: bigint | null; sales7dCents: number | null; orders7d: number | null } }) => ({
    impressions: r._sum.impressions ?? 0,
    clicks: r._sum.clicks ?? 0,
    spendCents: Math.round(Number(r._sum.costMicros ?? 0) / 10_000),
    salesCents: r._sum.sales7dCents ?? 0,
    orders: r._sum.orders7d ?? 0,
  })

  const [targetPerf, campaignPerf, termRows] = await Promise.all([
    extTargetIds.length
      ? prisma.amazonAdsDailyPerformance.groupBy({
        by: ['entityId'],
        where: { entityType: 'AD_TARGET', entityId: { in: extTargetIds }, date: { gte: since }, ...EXCLUDE_AMS_DAILY },
        _sum: { impressions: true, clicks: true, costMicros: true, sales7dCents: true, orders7d: true },
      })
      : [],
    extCampaignIds.length
      ? prisma.amazonAdsDailyPerformance.groupBy({
        by: ['entityId'],
        where: { entityType: 'CAMPAIGN', entityId: { in: extCampaignIds }, date: { gte: since }, ...EXCLUDE_AMS_DAILY },
        _sum: { impressions: true, clicks: true, costMicros: true, sales7dCents: true, orders7d: true },
      })
      : [],
    termPairs.length
      ? prisma.amazonAdsSearchTerm.findMany({
        where: {
          campaignId: { in: [...new Set(termPairs.map((p) => p.ext))] },
          query: { in: [...new Set(termPairs.map((p) => p.query))] },
          date: { gte: since },
        },
        select: { campaignId: true, query: true, impressions: true, clicks: true, costMicros: true, sales7dCents: true, orders7d: true },
      })
      : [],
  ])
  const perfByExtTarget = new Map(targetPerf.map((r) => [r.entityId, sum(r)] as const))
  const perfByExtCampaign = new Map(campaignPerf.map((r) => [r.entityId, sum(r)] as const))
  // Exact-pair reduction — a `campaignId IN … AND query IN …` fetch is a cross product, so the
  // fold matches the exact (campaign, query) pair and nothing else.
  const perfByTermPair = new Map<string, { impressions: number; clicks: number; spendCents: number; salesCents: number; orders: number }>()
  for (const r of termRows) {
    const key = `${r.campaignId}:${r.query}`
    const acc = perfByTermPair.get(key) ?? { impressions: 0, clicks: 0, spendCents: 0, salesCents: 0, orders: 0 }
    acc.impressions += r.impressions
    acc.clicks += r.clicks
    acc.spendCents += Math.round(Number(r.costMicros) / 10_000)
    acc.salesCents += r.sales7dCents ?? 0
    acc.orders += r.orders7d ?? 0
    perfByTermPair.set(key, acc)
  }

  return items.map((it) => {
    const action = (it.proposedAction ?? {}) as Record<string, unknown>
    let metrics: SuggestionMetrics | null = null
    const current: SuggestionCurrent = {}
    const suggested: SuggestionSuggested = {}
    let volume: number | null = null
    if (it.entityType === 'AD_TARGET') {
      const t = targetById.get(it.entityId)
      if (t) {
        current.bidCents = t.bidCents
        current.entityStatus = t.status
        current.targetAcosPct = asPct((t.adGroup?.campaign?.dynamicBidding as { targetAcos?: unknown } | null)?.targetAcos)
        const p = t.externalTargetId ? perfByExtTarget.get(t.externalTargetId) : undefined
        if (p) metrics = derive(p)
      }
      suggested.bidCents = projectBidCents(action, current.bidCents ?? null)
    } else if (it.entityType === 'CAMPAIGN') {
      const c = campaignById.get(it.entityId)
      if (c) {
        current.dailyBudgetEur = c.dailyBudget != null ? Number(c.dailyBudget) : null
        current.entityStatus = c.status
        current.targetAcosPct = asPct((c.dynamicBidding as { targetAcos?: unknown } | null)?.targetAcos)
        const p = c.externalCampaignId ? perfByExtCampaign.get(c.externalCampaignId) : undefined
        if (p) metrics = derive(p)
      }
      suggested.budgetEur = projectBudgetEur(action, current.dailyBudgetEur ?? null)
    } else if (it.entityType === 'SEARCH_TERM') {
      const p = perfByTermPair.get(it.entityId)
      if (p) metrics = derive(p)
      volume = volByKey.get(`${it.marketplace}|${it.entityName ?? it.entityId.slice(it.entityId.indexOf(':') + 1)}`) ?? null
      // a harvest promotion proposes a STARTING bid — surface it in the same column family
      const bidEur = Number(action.bidEur)
      if (Number.isFinite(bidEur) && bidEur > 0) suggested.bidCents = Math.round(bidEur * 100)
      const type = String(action.type ?? '')
      const creates = wireCreates(action)
      if (type === 'promote_to_exact' && creates.length > 0) {
        // HP1 wire rule — one term fans into the mapped destinations × ticked types, each with
        // its own resolved bid. Read straight off the dry-run's outcomes.
        suggested.destinations = creates.map((o) => {
          const g = destByLocalId.get(o.adGroupId as string)
          const bidEur = Number(o.bidEur)
          return {
            matchType: String(o.matchType ?? 'EXACT'),
            bidCents: Number.isFinite(bidEur) && bidEur > 0 ? Math.round(bidEur * 100) : null,
            campaignName: g?.campaign?.name ?? null,
            adProduct: g?.campaign?.adProduct ?? null,
            adGroupName: g?.name ?? 'ad group',
            note: 'Applicable',
          }
        })
      } else if (type === 'promote_to_exact' && typeof action.adGroupId === 'string') {
        const g = destByExt.get(action.adGroupId)
        if (g) {
          suggested.destinations = [{
            campaignName: g.campaign?.name ?? null, adProduct: g.campaign?.adProduct ?? null,
            adGroupName: g.name, matchType: 'EXACT', bidCents: suggested.bidCents ?? null, note: 'Applicable',
          }]
        }
      } else if (type.startsWith('add_negative') && creates.length > 0) {
        // NEG-P wire rule — same outcomes[] contract as harvest: one term negated across the
        // mapped destinations, each at its own level. Read verbatim; the destination's campaign
        // names the row even for CAMPAIGN-level entries (dst is the mapped ad group).
        suggested.destinations = creates.map((o) => {
          const g = destByLocalId.get(o.adGroupId as string)
          const mt = String(o.matchType ?? 'EXACT')
          const campaignWide = String(o.level ?? '') === 'CAMPAIGN'
          return {
            matchType: mt.startsWith('NEGATIVE') ? mt : `NEGATIVE_${mt}`,
            bidCents: null,
            campaignName: g?.campaign?.name ?? null,
            adProduct: g?.campaign?.adProduct ?? null,
            adGroupName: campaignWide ? null : (g?.name ?? 'ad group'),
            note: campaignWide ? 'Campaign-wide' : 'Applicable',
          }
        })
      } else if (type.startsWith('add_negative')) {
        const c = typeof action.externalCampaignId === 'string' ? negCampByExt.get(action.externalCampaignId) : undefined
        const g = typeof action.externalAdGroupId === 'string' ? destByExt.get(action.externalAdGroupId) : undefined
        const scope = action.scope === 'CAMPAIGN' ? 'CAMPAIGN' : 'AD_GROUP'
        suggested.destinations = [{
          matchType: type === 'add_negative_phrase' ? 'NEGATIVE_PHRASE' : 'NEGATIVE_EXACT',
          bidCents: null,
          campaignName: c?.name ?? null,
          adProduct: c?.adProduct ?? null,
          adGroupName: scope === 'CAMPAIGN' ? null : (g?.name ?? 'the source ad group'),
          note: scope === 'CAMPAIGN' ? 'Campaign-wide' : 'Applicable',
        }]
      }
    }
    return { ...it, metrics, current, suggested, volume }
  })
}

// ── SG.3 — delivery truth + undo linkage for APPLIED rows ────────────────────
//
// An apply returns at ENQUEUE, and the write gate runs later in the drain worker — so
// `appliedResult.ok` is "accepted for delivery", never "landed at Amazon". This join reads the
// write's actual fate:
//
//   delivered  the queue row reached SUCCESS (or a create carries its externalTargetId)
//   pending    still queued / in flight — the drain worker has not settled it yet
//   refused    the gate said no AFTER the apply (SKIPPED · WRITE_GATE_DENIED), in its own words
//   failed     dead-lettered or errored — the change exists locally and Amazon never took it
//   unknown    a pre-SG row whose result shape carries no fate — absence, not success
//
// `undo` resolves the AdvertisingActionLog handle the rollback service is keyed on — matched on
// (entityId, createdAt within a short window of decidedAt), NEVER the change feed's h:/a:
// display ids (reference_ads_changes_display_ids: passing a display id claims a real change
// does not exist). No handle ⇒ "no undo is offered for this row here" — which is a different
// claim from "cannot be undone", and only one of them is true.

export interface SuggestionDelivery {
  state: 'delivered' | 'pending' | 'refused' | 'failed' | 'unknown'
  detail: string | null
}
export interface SuggestionUndo { actionLogId: string; rolledBack: boolean }

interface AppliedRow { entityType: string; entityId: string; decidedAt: Date | null; appliedResult: unknown }

const UNDO_MATCH_BEFORE_MS = 10_000
const UNDO_MATCH_AFTER_MS = 60_000

export async function attachDeliveryData<T extends AppliedRow>(
  items: T[],
): Promise<Array<T & { delivery: SuggestionDelivery; undo: SuggestionUndo | null }>> {
  if (items.length === 0) return []

  const queueIds = [...new Set(items
    .map((i) => ((i.appliedResult as { output?: { outboundQueueId?: unknown } } | null)?.output?.outboundQueueId))
    .filter((x): x is string => typeof x === 'string'))]
  const decideds = items.map((i) => i.decidedAt).filter((d): d is Date => d != null)
  const entityIds = [...new Set(items.map((i) => i.entityId))]

  const [queueRows, logRows] = await Promise.all([
    queueIds.length
      ? prisma.outboundSyncQueue.findMany({
        where: { id: { in: queueIds } },
        select: { id: true, syncStatus: true, errorCode: true, errorMessage: true, isDead: true, syncedAt: true },
      })
      : [],
    entityIds.length && decideds.length
      ? prisma.advertisingActionLog.findMany({
        where: {
          entityId: { in: entityIds },
          createdAt: {
            gte: new Date(Math.min(...decideds.map((d) => d.getTime())) - UNDO_MATCH_BEFORE_MS),
            lte: new Date(Math.max(...decideds.map((d) => d.getTime())) + UNDO_MATCH_AFTER_MS),
          },
        },
        select: { id: true, entityId: true, createdAt: true, rolledBackAt: true },
        orderBy: { createdAt: 'asc' },
      })
      : [],
  ])
  const queueById = new Map(queueRows.map((q) => [q.id, q] as const))
  const logsByEntity = new Map<string, typeof logRows>()
  for (const l of logRows) {
    const arr = logsByEntity.get(l.entityId) ?? []
    arr.push(l)
    logsByEntity.set(l.entityId, arr)
  }

  return items.map((it) => {
    const ar = (it.appliedResult ?? null) as { ok?: boolean; error?: string; output?: Record<string, unknown> } | null
    const out = ar?.output ?? {}
    let delivery: SuggestionDelivery = { state: 'unknown', detail: null }

    const qid = typeof out.outboundQueueId === 'string' ? out.outboundQueueId : null
    const q = qid ? queueById.get(qid) : undefined
    if (q) {
      if (q.syncStatus === 'SUCCESS') delivery = { state: 'delivered', detail: q.syncedAt ? `synced ${q.syncedAt.toISOString()}` : null }
      else if (q.syncStatus === 'PENDING' || q.syncStatus === 'IN_PROGRESS') delivery = { state: 'pending', detail: 'queued — the drain worker has not settled this write yet' }
      else if (q.syncStatus === 'SKIPPED' && q.errorCode === 'WRITE_GATE_DENIED') delivery = { state: 'refused', detail: q.errorMessage ?? 'the write gate declined this change after it was approved' }
      else if (q.syncStatus === 'FAILED' || q.isDead) delivery = { state: 'failed', detail: q.errorMessage ?? (q.isDead ? 'dead-lettered after retries' : 'delivery failed') }
      else delivery = { state: 'unknown', detail: `queue: ${q.syncStatus}` }
    } else if (out.reachedAmazon === true || typeof out.externalTargetId === 'string') {
      delivery = { state: 'delivered', detail: out.alreadyExisted === true ? 'already existed at Amazon' : null }
    } else if (typeof out.confirmed === 'number' || typeof out.failedWrites === 'number') {
      // HP1 wire result: per-destination outcomes with an overall verdict.
      const failed = Number(out.failedWrites ?? 0)
      delivery = failed > 0
        ? { state: 'failed', detail: ar?.error ?? `${failed} creation(s) did not reach Amazon` }
        : { state: 'delivered', detail: `${Number(out.confirmed ?? 0)} creation(s) confirmed` }
    } else if (out.denied) {
      const d = out.denied as { deniedAt?: string; reason?: string }
      delivery = { state: 'refused', detail: d.reason ?? ar?.error ?? 'refused at the write gate' }
    } else if (ar?.ok === false) {
      delivery = { state: 'failed', detail: ar.error ?? null }
    }

    let undo: SuggestionUndo | null = null
    if (it.decidedAt) {
      const t = it.decidedAt.getTime()
      const candidates = (logsByEntity.get(it.entityId) ?? []).filter(
        (l) => l.createdAt.getTime() >= t - UNDO_MATCH_BEFORE_MS && l.createdAt.getTime() <= t + UNDO_MATCH_AFTER_MS,
      )
      // nearest to the decision wins — never join on a truncated timestamp (the KT.7 lesson)
      candidates.sort((a, b) => Math.abs(a.createdAt.getTime() - t) - Math.abs(b.createdAt.getTime() - t))
      const hit = candidates[0]
      if (hit) undo = { actionLogId: hit.id, rolledBack: hit.rolledBackAt != null }
    }

    return { ...it, delivery, undo }
  })
}

// ── SG.1 — scope resolution for the list + pricing routes ───────────────────
/**
 * Resolve the filter bar's scope grains to a campaign-id set, SERVER-side, so the grid, the
 * money tiles and the pricing endpoint all describe the same rows. `null` = unscoped.
 *
 * The line join is the /advertising/scope-options picker's own (Product parent → children →
 * AdProductAd → adGroup.campaignId) — never a parallel definition of "the line's campaigns",
 * or the picker and the filter drift. Precedence is most-specific-wins: campaign ⊃ portfolio ⊃
 * line (a campaign has at most one portfolio, so combining them is redundant or contradictory).
 */
export async function scopeCampaignIds(q: { campaign?: string; portfolio?: string; line?: string }): Promise<Set<string> | null> {
  if (q.campaign) return new Set([q.campaign])
  if (q.portfolio) {
    const rows = await prisma.campaign.findMany({ where: { portfolioId: q.portfolio }, select: { id: true } })
    return new Set(rows.map((r) => r.id))
  }
  if (q.line) {
    const children = await prisma.product.findMany({
      where: { OR: [{ id: q.line }, { parentId: q.line }] },
      select: { id: true },
    })
    const ads = children.length
      ? await prisma.adProductAd.findMany({
        where: { productId: { in: children.map((c) => c.id) } },
        select: { adGroup: { select: { campaignId: true } } },
      })
      : []
    return new Set(ads.map((a) => a.adGroup?.campaignId).filter((x): x is string => !!x))
  }
  return null
}

// ── SG.0 — lifecycle sweep ───────────────────────────────────────────────────
//
// The queue holds the engine's CURRENT opinion, not a history. Two moves, both driven by
// `lastSeenAt` (the newest evaluation that still proposes the change):
//
//   EXPIRE      pending, and the engine has stopped re-proposing it for the rule's window
//               → status 'expired', decidedBy 'system:stale'. The data moved on, the rule was
//               disabled, or the rule was deleted — either way the row is no longer anyone's
//               current opinion and must not sit in the operator's queue looking actionable.
//   RE-PROPOSE  a decided row the engine STILL proposes (lastSeenAt > decidedAt):
//               'expired' rows return to pending immediately — expiry is a system state, not a
//               veto. 'dismissed' rows return only after REPROPOSE_AFTER_MS and only when the
//               decision was the operator's plain dismiss — 'operator:paused' rows stay out
//               (the operator paused the underlying target; re-nagging them is noise).
//
// Ridden by the rule-evaluator tick (no new cron); every call is cheap and idempotent.

const DAY_MS = 24 * 3600 * 1000
export const DEFAULT_EXPIRE_MS = 3 * DAY_MS
export const REPROPOSE_AFTER_MS = 7 * DAY_MS

/**
 * How long a pending row may go un-re-proposed before it expires, for one rule.
 * Engine rules evaluate every tick, so 3 days of silence means the data moved on. A builder rule
 * carries a schedule and may legitimately be silent for its whole interval — a weekly rule must
 * not false-expire on day 3 — so its window is 2× the interval, floored at the default.
 * Builder schedule shape (RuleBuilder.tsx): { frequency: 'Hourly'|'Daily'|'Weekly'|'Monthly'|'Custom',
 * everyN, interval: 'Days'|'Weeks'|'Months' }.
 */
export function expiryWindowMs(rule: { actions: unknown } | null | undefined): number {
  const actions = Array.isArray(rule?.actions) ? (rule.actions as Array<Record<string, unknown>>) : []
  let intervalMs = 0
  for (const a of actions) {
    const sched = a?.schedule as { frequency?: string; everyN?: number | string; interval?: string } | undefined
    if (!sched?.frequency) continue
    const f = String(sched.frequency).toLowerCase()
    let ms = 0
    if (f === 'hourly') ms = 3600 * 1000
    else if (f === 'daily') ms = DAY_MS
    else if (f === 'weekly') ms = 7 * DAY_MS
    else if (f === 'monthly') ms = 30 * DAY_MS
    else if (f === 'custom') {
      const n = Math.max(1, Number(sched.everyN) || 1)
      const unit = String(sched.interval ?? 'Days').toLowerCase()
      ms = n * (unit === 'months' ? 30 * DAY_MS : unit === 'weeks' ? 7 * DAY_MS : DAY_MS)
    }
    intervalMs = Math.max(intervalMs, ms)
  }
  return Math.max(DEFAULT_EXPIRE_MS, 2 * intervalMs)
}

export async function sweepSuggestionLifecycle(now = new Date()): Promise<{ expired: number; reproposed: number }> {
  try {
    // Group the rules that still exist by their expiry window; a deleted rule's rows fall into
    // the default group (its lastSeenAt stopped moving the moment it was deleted, which is the
    // honest clock for them).
    const openRuleIds = (
      await prisma.adsRuleSuggestion.findMany({ where: { status: 'pending' }, select: { ruleId: true }, distinct: ['ruleId'] })
    ).map((r) => r.ruleId)
    const rules = openRuleIds.length
      ? await prisma.automationRule.findMany({ where: { id: { in: openRuleIds } }, select: { id: true, actions: true } })
      : []
    const windowByRule = new Map(rules.map((r) => [r.id, expiryWindowMs(r)]))
    const byWindow = new Map<number, string[]>()
    for (const id of openRuleIds) {
      const w = windowByRule.get(id) ?? DEFAULT_EXPIRE_MS
      byWindow.set(w, [...(byWindow.get(w) ?? []), id])
    }
    let expired = 0
    for (const [windowMs, ids] of byWindow) {
      const res = await prisma.adsRuleSuggestion.updateMany({
        where: { status: 'pending', ruleId: { in: ids }, lastSeenAt: { lt: new Date(now.getTime() - windowMs) } },
        data: { status: 'expired', decidedAt: now, decidedBy: 'system:stale' },
      })
      expired += res.count
    }

    // Re-propose needs a column-to-column comparison (lastSeenAt > decidedAt), which Prisma's
    // updateMany cannot express — raw SQL, parameterised.
    const backToPending = await prisma.$executeRaw`
      UPDATE "AdsRuleSuggestion"
      SET "status" = 'pending', "decidedAt" = NULL, "decidedBy" = NULL
      WHERE ("status" = 'expired' AND "lastSeenAt" > "decidedAt")
         OR ("status" = 'dismissed' AND "decidedBy" = 'operator'
             AND "decidedAt" < ${new Date(now.getTime() - REPROPOSE_AFTER_MS)}
             AND "lastSeenAt" > "decidedAt")`
    return { expired, reproposed: Number(backToPending) }
  } catch (e) {
    logger.warn('[ads-suggestions] lifecycle sweep failed', { error: (e as Error).message })
    return { expired: 0, reproposed: 0 }
  }
}

// ── SG.9 — "stop suggesting for this one" ────────────────────────────────────
/** Mirrors the routes file's DecideOutcome so the bulk endpoint can treat every verb alike. */
export type DecideResult = { ok: boolean; httpStatus?: number; error?: string; refused?: boolean; result?: unknown }

/**
 * H10's third verb, at its real meaning. Their KB: *"Pausing a Suggestion means you no longer
 * wish to collect data on the keyword or target in the campaign and ad group for suggestions"*,
 * and it *"ensur[es] that it remains active regardless of performance"*. So muting is the
 * OPPOSITE of pausing the entity: nothing is written to Amazon, the target keeps running, and
 * only the proposing stops.
 *
 * Two effects, and both are needed or the verb half-works:
 *   1. the mute row — consulted by the writer, so no NEW row is generated for the entity;
 *   2. every pending row for that entity moves to `muted`, so the queue clears immediately
 *      rather than keeping proposals the operator just said they did not want to see.
 *
 * `muted` is out of the lifecycle sweep's reach by construction: the sweep only touches
 * `pending`, `expired`, and `dismissed` rows whose decidedBy is exactly 'operator'.
 */
export async function muteSuggestion(id: string, opts: { by?: string } = {}): Promise<DecideResult> {
  const sug = await prisma.adsRuleSuggestion.findUnique({ where: { id } })
  if (!sug) return { ok: false, httpStatus: 404, error: 'not_found' }
  if (sug.status !== 'pending') return { ok: false, httpStatus: 409, error: `already ${sug.status}` }
  await prisma.adsSuggestionMute.upsert({
    where: { scope_entityType_entityId: { scope: 'rules', entityType: sug.entityType, entityId: sug.entityId } },
    create: {
      scope: 'rules', entityType: sug.entityType, entityId: sug.entityId,
      entityName: sug.entityName, marketplace: sug.marketplace,
      reason: `muted from the Suggestions queue (suggestion ${sug.id})`, createdBy: opts.by ?? 'operator',
    },
    update: {},
  })
  const { count } = await prisma.adsRuleSuggestion.updateMany({
    where: { entityType: sug.entityType, entityId: sug.entityId, status: 'pending' },
    data: { status: 'muted', decidedAt: new Date(), decidedBy: 'operator:muted' },
  })
  return { ok: true, result: { muted: count } }
}

/** Un-mute: the entity may be proposed for again, and its muted rows return to the queue. */
export async function unmuteSuggestion(id: string): Promise<DecideResult> {
  const sug = await prisma.adsRuleSuggestion.findUnique({ where: { id } })
  if (!sug) return { ok: false, httpStatus: 404, error: 'not_found' }
  if (sug.status !== 'muted') return { ok: false, httpStatus: 409, error: `cannot unmute ${sug.status}` }
  await prisma.adsSuggestionMute.deleteMany({ where: { scope: 'rules', entityType: sug.entityType, entityId: sug.entityId } })
  const { count } = await prisma.adsRuleSuggestion.updateMany({
    where: { entityType: sug.entityType, entityId: sug.entityId, status: 'muted' },
    data: { status: 'pending', decidedAt: null, decidedBy: null },
  })
  return { ok: true, result: { restored: count } }
}
