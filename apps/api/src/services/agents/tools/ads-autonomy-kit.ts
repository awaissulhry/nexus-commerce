/**
 * ADS AUTONOMY W2 (AA-W2-2) — the kit of every Amazon ad change tool that may run by the business's rule INSIDE the ads
 * strategy (the strategy-bound tools: AA-W2-6..13 wire it in; no tool uses it yet). Design: agent-results/5 §2.2–2.4,
 * §5. A change runs alone only inside BOTH the strategy where it lands and the tool's own Claude limits, the tighter
 * winning; this kit holds the part every such tool shares.
 *
 *   facts    `buildLimitFacts` (in the dry run, `handler`): where each item lands and the strategy's limits there, each
 *            with the row it comes from (ads-strategy/autonomy.ts, on W1's resolver: an ad group or a campaign takes the
 *            SAFER value across its products); this change counted (items, Amazon writes, raises, the largest move, the
 *            budget it adds); what already ran by rule in the last 24 hours, per market and per entity; the engines that
 *            also move it; the protected terms and products it meets; and, for a change that can add spend in a market
 *            with a monthly cap, the month's forecast against it. The preview stores them as `limitFacts`, so `withinLimits` stays pure (it reads nothing) and a
 *            stored preview can be judged again (the commit's re-check, the watch week, the history test).
 *   ledger   no new table: the business's approvals run by rule (decisionVia auto) decided in the last 24 hours, and the
 *            steps of plans run by rule, each counted from the `this` block its own preview stored. A request handed
 *            back (stale, refused, failed) clears its decisionVia and no longer counts — the business cap's rows and
 *            window (claude-trust.service.ts autoRunsInLastDay). A bulk request is one run with many writes.
 *   checks   C1–C7 of the design (§2.4), plus every row inside its own scope's strategy and, for a change that can add
 *            spend, the month: pure, each null or the sentence a person reads. `commonRefusal` runs them in order. C5's
 *            daily limits are the market row's (AA-W2-2b): empty is 0, so nothing that adds to one runs by rule.
 *   limits   the Claude limits every strategy-bound tool shares (`adKitLimits`: items per run, changes of one entity by
 *            rule a day, engine-owned) and the raise / cut steps (`STEP_PCT_LIMITS`, `STEP_POINT_LIMITS`). A limit that
 *            can add spend defaults to 0: until a person types a number, only lowering changes run alone.
 *   note     `limitsNote`: each limit, its value, this change's value, and where the limit comes from.
 *   watch    AA-W2-4 — `asWatched`: a stored preview as the watch level judges it (today also counts the watched changes
 *            that would have run; a watch the strategy set reads as auto when it is what holds the change).
 *
 * Live and sandbox are judged the same. The existing brakes stay in front of every check here: nexus.run, Pause, the
 * business's cap of runs by rule and the write gate (a gate refusal is refused at preview and never queued).
 */
import { z } from 'zod'
import { FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import {
  BID_SOURCE,
  DAILY_SOURCE,
  RATE_DAYS,
  bidLimitsOfScope,
  enginesOnCampaigns,
  entityKey,
  monthProjections,
  protectedNegativeWhy,
  resolveEntityScopes,
  strategyForScopes,
  type AdEntityRef,
  type DailySource,
  type EntityScope,
  type MonthProjection,
  type ScopeLimits,
  type ScopeStrategy,
} from '../../advertising/ads-strategy/autonomy.js'
import { clampToStrategy, stepClamp } from '../../advertising/ads-strategy/bids.js'
import { actionOfTool } from '../../advertising/ads-strategy/claude.js'
import { STRATEGY_MONEY, type ClaudeActionType } from '../../advertising/ads-strategy/fields.js'
import type { StrategySource } from '../../advertising/ads-strategy/resolve.js'
import { strategyWords } from '../../advertising/ads-strategy/source-words.js'
import { PLAN_TOOL, type ClaudeTrust } from '../tool-types.js'
import { amountLabel } from './ads-tool-guards.js'

export type { AdEntityRef } from '../../advertising/ads-strategy/autonomy.js'

/** Bumped when the stored shape changes: a preview of another version is never judged (a person decides). */
export const LIMIT_FACTS_VERSION = 1
/** The window of "today": the business cap's 24 hours (claude-trust.service.ts AUTO_CAP_WINDOW_MS; the test pins it). */
export const RULE_DAY_MS = 24 * 3600_000
/** The most items one request may hold: the tool contract bounds every list to 250. */
export const MAX_KIT_ITEMS = 250

// ── What a change is made of ──────────────────────────────────────────────────────────────────────

/**
 * One change of one entity, in the entity's own units: money in minor units of its campaign's currency (never
 * converted), a placement or a target ACoS in whole percent, a status by Amazon's word.
 *   bid          a keyword's or a target's bid; `fromCents` null: a NEW keyword or target (graduate, create).
 *                `forced`: a stop's low bid (no lowest bid and no step binds it, as at the write gate).
 *   dailyBudget  a campaign's daily budget.
 *   status       ENABLED / PAUSED / ARCHIVED; `dailyBudgetCents`: the campaign budget that starts (or stops) spending.
 *                AA-W2-9 — `from` LOW_BIDS: a campaign stopped with low bids (a restore restarts it, its budget in full).
 *   negative     a new negative keyword or target (it only lowers spend).
 *   liveWrites   AA-W2-9 — a campaign on or off the live-write allowlist (a Nexus switch: it moves no bid or budget
 *                itself; every write it lets through is judged on its own).
 *   automation   AA-W2-11 — an ads rule saved, or an automation turned up or tuned, for this scope: Nexus only, it moves
 *                no value itself (the automation acts as itself, inside its own caps).
 */
export type KitChange =
  | { field: 'bid'; fromCents: number | null; toCents: number; forced?: boolean }
  | { field: 'dailyBudget'; fromCents: number | null; toCents: number }
  | { field: 'placementPct' | 'targetAcosPct'; fromPct: number | null; toPct: number }
  | { field: 'status'; from: string | null; to: 'ENABLED' | 'PAUSED' | 'ARCHIVED'; dailyBudgetCents?: number }
  | { field: 'negative'; term: string; matchType?: string | null }
  | { field: 'liveWrites'; from: boolean; to: boolean }
  | { field: 'automation' }

export interface KitItem {
  entity: AdEntityRef
  change: KitChange
  /** Recorded in Nexus only (a target ACoS the optimiser reads, a dismissed suggestion): no write reaches Amazon. */
  nexusOnly?: boolean
}

export type Direction = 'raise' | 'cut' | 'same'

/** What one change does to spend, measured. Pure. */
export interface Measured {
  direction: Direction
  /** Relative move of a money value (a bid, a budget) from a value above 0. */
  pct: number | null
  /** Move of a percent value (a placement, a target ACoS), in points. */
  points: number | null
  newBidCents: number | null
  /** The daily budget it starts (positive) or stops (negative) spending. */
  addedDailyCents: number
}

const round2 = (n: number) => Math.round(n * 100) / 100
const dir = (delta: number): Direction => (delta > 0 ? 'raise' : delta < 0 ? 'cut' : 'same')

export function measure(change: KitChange): Measured {
  const none = { pct: null, points: null, newBidCents: null, addedDailyCents: 0 }
  switch (change.field) {
    case 'bid':
    case 'dailyBudget': {
      const from = change.fromCents
      const delta = change.toCents - (from ?? 0)
      return {
        ...none,
        // A new keyword or target adds spend whatever its bid.
        direction: from == null && change.field === 'bid' ? 'raise' : dir(delta),
        pct: from != null && from > 0 ? round2((Math.abs(delta) / from) * 100) : null,
        ...(change.field === 'bid' ? { newBidCents: change.toCents } : { addedDailyCents: delta }),
      }
    }
    case 'placementPct':
    case 'targetAcosPct': {
      const delta = change.toPct - (change.fromPct ?? 0)
      return { ...none, direction: dir(delta), points: round2(Math.abs(delta)) }
    }
    case 'status': {
      const budget = change.dailyBudgetCents ?? 0
      if (change.to === 'ENABLED' && change.from !== 'ENABLED') return { ...none, direction: 'raise', addedDailyCents: budget }
      if (change.to !== 'ENABLED' && change.from === 'ENABLED') return { ...none, direction: 'cut', addedDailyCents: -budget }
      return { ...none, direction: 'same' }
    }
    case 'negative':
      return { ...none, direction: 'cut' }
    case 'liveWrites':
    case 'automation':
      return { ...none, direction: 'same' }
  }
}

// ── The facts a preview stores ────────────────────────────────────────────────────────────────────

export interface DayCounts {
  /** Changes: each entity changed counts one, in Nexus or at Amazon (Claude's daily limit of changes counts these). */
  changes: number
  /** Changes that reach Amazon. */
  writes: number
  raises: number
  /** Daily budget added (minor units of the market's currency). */
  budgetIncreaseCents: number
}

export interface ThisChange {
  markets: string[]
  items: number
  writes: number
  raises: number
  cuts: number
  /** The largest relative move of a bid or a budget, up and down (0: none). */
  largestRaisePct: number
  largestCutPct: number
  /** The largest move of a placement or a target ACoS, in points. */
  largestRaisePoints: number
  largestCutPoints: number
  highestNewBidCents: number | null
  budgetIncreaseCents: number
  /**
   * AA-W2-7 — raises of a bid or a budget from 0 (or from none): no percent measures them. `unboundedRaises`: those
   * where the ads strategy sets no highest bid either (a budget has none), so nothing bounds them. Absent: none.
   */
  raisesFromZero?: number
  unboundedRaises?: number
  byMarket: Record<string, DayCounts & { addedDailyCents: number }>
  /** Every entity it touches, once: the per-entity ledger counts runs by these keys. */
  entities: string[]
  /** Rows outside their own scope's strategy (a bid outside its band, or a larger step than it allows): every row is checked. */
  rowsOutsideStrategy: number
  firstOutside: { entity: string; why: string } | null
}

/** One strategy subject a change lands on: an ad group, a campaign, a product (`<market>|<subject>`). */
export interface ScopeFacts extends ScopeStrategy {
  market: string
  label: string
}

export interface MarketFacts {
  /** Null: no strategy row in this market — nothing runs alone there. */
  strategy: { version: string } | null
  currency: string
  maxActionsPerRun: number | null
  /** Claude's daily limits of what runs by rule here (the market row; null: not set — read as 0). */
  maxChangesPerDay: number | null
  maxRaisesPerDay: number | null
  maxBudgetIncreasePerDayCents: number | null
  /** Keyed by DAILY_SOURCE (a money limit's row under a name that is not money). */
  sources: Partial<Record<'maxActionsPerRun' | DailySource, StrategySource>>
}

export interface LimitFacts {
  v: typeof LIMIT_FACTS_VERSION
  tool: string
  /** The kind of ad action (the strategy's claudeAutonomy key); null for a tool the strategy has no kind for. */
  action: ClaudeActionType | null
  markets: Record<string, MarketFacts>
  scopes: Record<string, ScopeFacts>
  /** Each placed entity's scope key. */
  entityScopes: Record<string, string>
  /** What a person calls each entity. */
  labels: Record<string, string>
  this: ThisChange
  /** Run by rule in the last 24 hours, per market of this change (this change not counted). */
  today: Record<string, DayCounts>
  /** The entity of this change that ran by rule most often in the last 24 hours, and how often. */
  perEntityToday: { maxChangesByRule: number; entity: string | null }
  /** Entities Nexus cannot place in a market (not found, no market): a person decides. */
  unplaced: Array<{ entity: string; why: string }>
  /** Campaigns an enabled rule or schedule also moves. */
  engineOwned: Array<{ campaignId: string; label: string; by: string[] }>
  /** Protected terms and protected products this change meets. */
  protectedHit: Array<{ entity: string; why: string }>
  /** For a change that can add spend: each market's month, where a monthly cap is in force (none: no entry). */
  monthProjection?: Record<string, MonthProjection>
  /** AA-W2-4 — judged at watch (`asWatched`): "today" also counts the watched changes that would have run by rule. */
  watchedToday?: true
}

/**
 * The money keys of the facts, each with the permission that reveals it, for a tool's `restrictedFields`: the
 * strategy's own (STRATEGY_MONEY) and the kit's. A money value always sits under one of these, never under a generic key.
 */
export const LIMIT_FACTS_MONEY: Readonly<Record<string, string>> = {
  ...STRATEGY_MONEY,
  ...Object.fromEntries(
    ['highestNewBidCents', 'budgetIncreaseCents', 'addedDailyCents', 'maxBudgetIncreasePerDayCents', 'spentCents', 'ratePerDayCents', 'projectedCents', 'afterCents', 'capCents',
      // AA-W2-8 — the strategy's ACoS target where a change lands.
      'strategyTargetAcosPct']
      .map((key) => [key, FIELDS.financialsAdspendView]),
  ),
}

/** The stored facts of a preview, or null when it carries none (or of another version): such a preview is never inside. */
export function limitFactsOf(preview: unknown): LimitFacts | null {
  const facts = (preview as { limitFacts?: unknown } | null | undefined)?.limitFacts as LimitFacts | undefined
  return facts && typeof facts === 'object' && facts.v === LIMIT_FACTS_VERSION && facts.this && facts.markets ? facts : null
}

// ── Today's ledger ────────────────────────────────────────────────────────────────────────────────

export interface RuleRunLedger {
  byMarket: Record<string, DayCounts>
  /** Runs per entity key (a run touching an entity several times counts once). */
  byEntity: Record<string, number>
  /** Runs counted (previews that carried limit facts). */
  runs: number
}

const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const NO_RUNS: DayCounts = Object.freeze({ changes: 0, writes: 0, raises: 0, budgetIncreaseCents: 0 })

/** Pure: the ledger of stored previews, each one run; a preview without limit facts adds nothing. */
export function ledgerOf(previews: readonly unknown[]): RuleRunLedger {
  const out: RuleRunLedger = { byMarket: {}, byEntity: {}, runs: 0 }
  for (const preview of previews) {
    const facts = limitFactsOf(preview)
    if (!facts) continue
    out.runs++
    for (const [market, c] of Object.entries(facts.this.byMarket ?? {})) {
      const day = (out.byMarket[market] ??= { ...NO_RUNS })
      day.changes += count(c?.changes)
      day.writes += count(c?.writes)
      day.raises += count(c?.raises)
      day.budgetIncreaseCents += count(c?.budgetIncreaseCents)
    }
    for (const entity of new Set(Array.isArray(facts.this.entities) ? facts.this.entities : [])) {
      if (typeof entity === 'string') out.byEntity[entity] = (out.byEntity[entity] ?? 0) + 1
    }
  }
  return out
}

/**
 * What ran by rule in this business in the last 24 hours: single requests and the steps of plans whose decision was
 * the business's rule (a step that was skipped never ran). `excludeApprovalId`: the request this dry run re-checks
 * (ToolContext.approvalId — at the commit's re-check and in `execute`), so it is not counted against itself. AA-W2-3 —
 * for a plan, only its steps that have not run are left out: a step re-checked when it runs counts the steps of its own
 * plan that ran before it.
 */
export async function ruleRunLedger(opts: { excludeApprovalId?: string | null; now?: Date } = {}): Promise<RuleRunLedger> {
  const since = new Date((opts.now ?? new Date()).getTime() - RULE_DAY_MS)
  const exclude = opts.excludeApprovalId?.trim() || null
  const [single, steps] = await Promise.all([
    prisma.agentApproval.findMany({
      where: { decisionVia: 'auto', decidedAt: { gte: since }, toolName: { not: PLAN_TOOL }, ...(exclude ? { id: { not: exclude } } : {}) },
      select: { preview: true },
    }),
    prisma.agentPlanStep.findMany({
      where: {
        approval: { decisionVia: 'auto', decidedAt: { gte: since } },
        status: { not: 'skipped' },
        ...(exclude ? { OR: [{ approvalId: { not: exclude } }, { approvalId: exclude, status: 'done' }] } : {}),
      },
      select: { preview: true },
    }),
  ])
  return ledgerOf([...single, ...steps].map((row) => row.preview))
}

// ── Building the facts ────────────────────────────────────────────────────────────────────────────

/** What a person calls the subject an entity resolves through. */
function subjectLabel(scope: EntityScope): string {
  if (scope.kind === 'adGroup' || scope.kind === 'campaign' || scope.kind === 'products') return scope.label
  if (scope.kind === 'productAd') return scope.subject?.startsWith('product:') ? `the product of ${scope.label}` : `the ad group of ${scope.label}`
  return scope.subject?.startsWith('adGroup:') ? `the ad group of ${scope.label}` : `the campaign of ${scope.label}`
}

/** Pure: why a bid sits outside its own scope's strategy (its band, or a larger step than it allows), or null. */
export function bidOutsideWhy(change: Extract<KitChange, { field: 'bid' }>, scope: Pick<ScopeStrategy, 'limits' | 'sources'>, currency: string): string | null {
  const limits = bidLimitsOfScope(scope)
  const from = change.fromCents
  // W1-5's own arithmetic: the band (a stop's forced lowering is exempt from the lowest bid), then the step.
  const band = clampToStrategy(change.toCents, limits, { currentCents: from, forced: change.forced === true })
  if (band.held) {
    const side = band.held.side === 'max' ? 'above the highest bid' : 'below the lowest bid'
    return `the new bid ${amountLabel(change.toCents, currency)} is ${side} ${amountLabel(band.held.limit.value, currency)} (${strategyWords(band.held.limit.source)})`
  }
  if (change.forced !== true && from != null && from > 0 && limits.maxChangePct) {
    const step = stepClamp(from, change.toCents, null, limits)
    if (step.cents !== change.toCents) {
      return `the bid moves ${round2((Math.abs(change.toCents - from) / from) * 100)} % (${amountLabel(from, currency)} → ${amountLabel(change.toCents, currency)}), more than the largest change ${limits.maxChangePct.value} % (${strategyWords(limits.maxChangePct.source)})`
    }
  }
  return null
}

const CUT_WORDS: Record<KitChange['field'], string> = {
  bid: 'lowering its bid',
  dailyBudget: 'lowering its budget',
  placementPct: 'lowering a placement',
  targetAcosPct: 'lowering its target ACoS',
  status: 'stopping it',
  negative: 'negating',
  liveWrites: 'taking it off the live-write allowlist',
  automation: 'changing what acts on it',
}

/**
 * The facts of one change, read in the business of the call, for its preview. `approvalId`: the request a dry run
 * re-checks (not counted in today's ledger). `projectMonth`: the change can add spend without adding a budget (a
 * restore puts bids back) — a change that adds a daily budget is always projected. Only a market with a monthly cap is
 * projected. The run rate is the recent past: a change that restarts spend says what it restarts as an item's
 * `dailyBudgetCents`, which counts in full.
 */
export async function buildLimitFacts(input: {
  tool: string
  items: readonly KitItem[]
  approvalId?: string | null
  projectMonth?: boolean
  /** AA-W2-10, AA-W2-11 — rules or schedules C4 does not count as an engine that also moves it (a rule whose own
   *  suggestion is applied, the automation being turned up or saved). */
  exceptIds?: readonly string[]
  now?: Date
}): Promise<LimitFacts> {
  const action = actionOfTool(input.tool)
  const scopes = await resolveEntityScopes(input.items.map((i) => i.entity))
  const { markets: strategies, subjects } = await strategyForScopes(scopes.values(), action)

  const facts: LimitFacts = {
    v: LIMIT_FACTS_VERSION, tool: input.tool, action, markets: {}, scopes: {}, entityScopes: {}, labels: {},
    this: {
      markets: [], items: input.items.length, writes: 0, raises: 0, cuts: 0, largestRaisePct: 0, largestCutPct: 0,
      largestRaisePoints: 0, largestCutPoints: 0, highestNewBidCents: null, budgetIncreaseCents: 0, byMarket: {}, entities: [],
      rowsOutsideStrategy: 0, firstOutside: null,
    },
    today: {}, perEntityToday: { maxChangesByRule: 0, entity: null }, unplaced: [], engineOwned: [], protectedHit: [],
  }
  // The market's currency: its campaigns' own (a new campaign's market: the month's campaigns, else the schema's EUR).
  const currencyIn = (market: string) => [...scopes.values()].find((s) => s.market === market && s.currency)?.currency ?? null

  for (const scope of scopes.values()) {
    facts.labels[scope.key] = scope.label
    if (!scope.market || !scope.subject) { facts.unplaced.push({ entity: scope.key, why: scope.unplaced ?? `${scope.label} cannot be placed in a market` }); continue }
    const key = `${scope.market}|${scope.subject}`
    facts.entityScopes[scope.key] = key
    if (!facts.scopes[key]) facts.scopes[key] = { market: scope.market, label: `${subjectLabel(scope)} (${scope.market})`, ...subjects.get(key)! }
  }
  for (const [market, s] of strategies) {
    facts.markets[market] = {
      strategy: s.version ? { version: s.version } : null,
      currency: currencyIn(market) ?? 'EUR',
      maxActionsPerRun: s.maxActionsPerRun?.value ?? null,
      maxChangesPerDay: s.daily.maxChangesPerDay,
      maxRaisesPerDay: s.daily.maxRaisesPerDay,
      maxBudgetIncreasePerDayCents: s.daily.maxBudgetIncreasePerDayCents,
      sources: { ...(s.maxActionsPerRun ? { maxActionsPerRun: s.maxActionsPerRun.source } : {}), ...s.daily.sources },
    }
  }

  const t = facts.this
  const entities = new Set<string>()
  for (const item of input.items) {
    const key = entityKey(item.entity)
    entities.add(key)
    const scope = scopes.get(key)!
    const m = measure(item.change)
    // An item Nexus cannot place counts in the totals only (C1 refuses it).
    const day = scope.market ? (t.byMarket[scope.market] ??= { ...NO_RUNS, addedDailyCents: 0 }) : null
    if (day) day.changes++
    if (!item.nexusOnly) { t.writes++; if (day) day.writes++ }
    if (m.direction === 'raise') {
      t.raises++; if (day) day.raises++
      if (m.pct != null) t.largestRaisePct = Math.max(t.largestRaisePct, m.pct)
      if (m.points != null) t.largestRaisePoints = Math.max(t.largestRaisePoints, m.points)
    } else if (m.direction === 'cut') {
      t.cuts++
      if (m.pct != null) t.largestCutPct = Math.max(t.largestCutPct, m.pct)
      if (m.points != null) t.largestCutPoints = Math.max(t.largestCutPoints, m.points)
    }
    if (m.newBidCents != null) t.highestNewBidCents = Math.max(t.highestNewBidCents ?? 0, m.newBidCents)
    if (m.addedDailyCents > 0) { t.budgetIncreaseCents += m.addedDailyCents; if (day) day.budgetIncreaseCents += m.addedDailyCents }
    if (day) day.addedDailyCents += m.addedDailyCents

    const scopeFacts = facts.scopes[facts.entityScopes[key] ?? '']
    if (!scopeFacts) continue
    // AA-W2-7 — a raise from 0 has no percent: held by the strategy's highest bid where it lands, else unbounded.
    if (m.direction === 'raise' && m.pct == null && (item.change.field === 'bid' || item.change.field === 'dailyBudget')) {
      t.raisesFromZero = (t.raisesFromZero ?? 0) + 1
      const capped = item.change.field === 'bid' && scopeFacts.limits.maxBidCents != null && !!scopeFacts.sources.maxBid
      if (!capped) t.unboundedRaises = (t.unboundedRaises ?? 0) + 1
    }
    // Every row against its own scope's strategy (a bulk change too: not only the lines its preview shows).
    if (item.change.field === 'bid') {
      const why = bidOutsideWhy(item.change, scopeFacts, scope.currency ?? facts.markets[scopeFacts.market]?.currency ?? 'EUR')
      if (why) { t.rowsOutsideStrategy++; t.firstOutside ??= { entity: key, why: `${scope.label}: ${why}` } }
    }
    // C3 — a protected term or a protected product's ASIN is never negated, and a protected product's ads are never
    // lowered or stopped, by rule.
    if (item.change.field === 'negative') {
      const why = await protectedNegativeWhy({ term: item.change.term, matchType: item.change.matchType, market: scope.market, campaignId: scope.campaignId })
      if (why) facts.protectedHit.push({ entity: key, why })
    } else if (m.direction === 'cut' && scopeFacts.limits.protect === true && scopeFacts.sources.protect) {
      facts.protectedHit.push({ entity: key, why: `${scope.label}: the ads strategy protects a product it advertises (${strategyWords(scopeFacts.sources.protect)}), so ${CUT_WORDS[item.change.field]} waits for a person` })
    }
  }
  t.entities = [...entities]
  t.markets = Object.keys(t.byMarket).sort()

  // C4 — what an enabled rule or schedule also moves.
  const campaigns = new Map<string, string>()
  for (const s of scopes.values()) {
    if (!s.campaignId || campaigns.has(s.campaignId)) continue
    campaigns.set(s.campaignId, s.kind === 'campaign' ? s.label : `the campaign of ${s.label}`)
  }
  for (const [campaignId, by] of await enginesOnCampaigns(campaigns.keys(), { exceptIds: input.exceptIds })) facts.engineOwned.push({ campaignId, label: campaigns.get(campaignId)!, by })

  // C5, C6 — what already ran by rule.
  const ledger = await ruleRunLedger({ excludeApprovalId: input.approvalId, now: input.now })
  for (const market of t.markets) facts.today[market] = ledger.byMarket[market] ?? { ...NO_RUNS }
  for (const entity of t.entities) {
    const runs = ledger.byEntity[entity] ?? 0
    if (runs > facts.perEntityToday.maxChangesByRule) facts.perEntityToday = { maxChangesByRule: runs, entity }
  }

  // The month, for a change that can add spend.
  const projected = t.markets.filter((m) => t.byMarket[m].addedDailyCents > 0 || (input.projectMonth === true && t.byMarket[m].raises > 0))
  if (projected.length) {
    const months = await monthProjections(projected.map((market) => ({ market, view: strategies.get(market)?.view ?? null, addedDailyCents: t.byMarket[market].addedDailyCents })), input.now)
    // A market without a monthly cap has no month to keep under: left out.
    if (months.size) facts.monthProjection = Object.fromEntries(months)
    for (const [market, p] of months) if (!currencyIn(market) && facts.markets[market]) facts.markets[market].currency = p.currency
  }
  return facts
}

// ── The Claude limits every strategy-bound tool shares ────────────────────────────────────────────

/**
 * The limits of a strategy-bound tool (`AgentTool.limits`), named by the `limitsTighten` convention so tightening stays
 * a free brake. `maxItems`: 50 for a bulk tool, 0 where every request should wait for a person until he types a number
 * (pause, enable, archive). `extra`: the tool's own (its raise and cut steps, a start bid, …).
 */
export function adKitLimits<S extends z.ZodRawShape>(opts: { maxItems: number }, extra?: S) {
  return z.object({
    maxItems: z.number().int().min(0).max(MAX_KIT_ITEMS).default(opts.maxItems)
      .describe('the most items (bids, targets, campaigns) one request may change when it runs by rule; 0 = every request waits for a person'),
    maxChangesPerEntityPerDay: z.number().int().min(0).max(24).default(1)
      .describe('the most times Claude may change one campaign, ad group, target or ad by rule in 24 hours (no back and forth)'),
    allowEngineOwned: z.boolean().default(false)
      .describe('let a change run by rule on a campaign an enabled rule or schedule also moves; never by default'),
    ...(extra ?? ({} as S)),
  })
}

/** A bid's or a budget's raise and cut, in percent of the value before: no raise runs alone until a person sets one. */
export const STEP_PCT_LIMITS = {
  maxRaisePct: z.number().min(0).max(100).default(0)
    .describe('the largest raise, in percent, that may run without a person; 0 = every raise waits for a person'),
  maxCutPct: z.number().min(0).max(100).default(100)
    .describe('the largest cut, in percent, that may run without a person (the ads strategy also bounds it)'),
}

/** A placement's or a target ACoS's raise and cut, in points. */
export const STEP_POINT_LIMITS = {
  maxRaisePoints: z.number().min(0).max(900).default(0)
    .describe('the largest raise, in percentage points, that may run without a person; 0 = every raise waits for a person'),
  maxCutPoints: z.number().min(0).max(900).default(100)
    .describe('the largest cut, in percentage points, that may run without a person'),
}

// ── The common checks (pure) ──────────────────────────────────────────────────────────────────────

type Limits = Record<string, unknown>
const numberIn = (limits: Limits, key: string, fallback: number) => (typeof limits[key] === 'number' ? (limits[key] as number) : fallback)
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`
const A_PERSON = 'a person decides'
/** The strategy's names of Claude's daily limits (fields.ts labels, lower-cased). */
const DAILY_WORDS: Record<'maxChangesPerDay' | 'maxRaisesPerDay' | 'maxBudgetIncreasePerDayCents', string> = {
  maxChangesPerDay: 'most changes Claude may run by rule a day',
  maxRaisesPerDay: 'most raises Claude may run by rule a day',
  maxBudgetIncreasePerDayCents: 'most budget increase Claude may run by rule a day',
}

const ACTION_WORDS: Record<ClaudeActionType, string> = {
  bid: 'bid changes',
  negative: 'negative keywords',
  harvest: 'new exact keywords from search terms',
  placement: 'placement adjustments',
  budget: 'budget changes',
  target: 'target ACoS changes',
  suggestion: 'decisions on rule suggestions',
  stop: 'stopping ads with low bids',
  restore: "restoring stopped ads' bids",
  create: 'new campaigns',
  rule: 'ads rules',
  undo: 'undoing ad changes',
  allowlist: 'putting a campaign on the live-write allowlist',
  automation: 'turning ads automations up and tuning their settings',
  pause: 'pausing ads (a real pause)',
  enable: 'switching paused ads back on',
  archive: 'archiving ads (for good)',
}
/** What a strategy level below auto allows, in W1-8's words (claude-trust.service.ts narrowedWhy). */
const ALLOWS: Record<Exclude<ClaudeTrust, 'auto'>, (what: string) => string> = {
  off: (what) => `turns ${what} off for Claude`,
  ask: (what) => `lets Claude only ask for ${what}`,
  confirm: (what) => `lets Claude go no further than confirm in Claude for ${what}`,
  // AA-W2-4 — watch never runs alone: the rule's verdict is recorded and a person decides.
  watch: (what) => `only watches ${what}`,
}

/** C1 — every entity is placed in a market, and a strategy covers every market it touches. */
export function strategyRefusal(facts: LimitFacts): string | null {
  const unplaced = facts.unplaced[0]
  if (unplaced) return `${unplaced.why}: Nexus cannot tell which ads strategy covers it; ${A_PERSON}`
  const bare = facts.this.markets.filter((m) => !facts.markets[m]?.strategy)
  return bare.length ? `there is no ads strategy for ${bare.join(', ')}: nothing runs alone there; ${A_PERSON}` : null
}

/** C2 — the strategy lets Claude do this kind alone at every scope it lands on (it narrows; it never widens). */
export function aloneRefusal(facts: LimitFacts): string | null {
  if (!facts.action) return null
  for (const scope of Object.values(facts.scopes)) {
    const level = scope.limits.claudeLevel
    const source = scope.sources.claudeLevel
    if (!level || level === 'auto' || !source) continue
    return `the ads strategy ${ALLOWS[level](ACTION_WORDS[facts.action])} at ${scope.label} (${strategyWords(source)}); ${A_PERSON}`
  }
  return null
}

/** C3 — never a protected term or a protected product's ASIN negated, never a protected product's ads lowered or stopped. */
export function protectedRefusal(facts: LimitFacts): string | null {
  const hit = facts.protectedHit[0]
  if (!hit) return null
  const more = facts.protectedHit.length - 1
  return `${hit.why}${more ? ` (and ${plural(more, 'more item')})` : ''}; ${A_PERSON}`
}

/** Every row inside its own scope's strategy (checked on every row, not only the lines a preview shows). */
export function outsideRefusal(facts: LimitFacts): string | null {
  const t = facts.this
  if (!t.rowsOutsideStrategy || !t.firstOutside) return null
  return `${t.rowsOutsideStrategy} of ${plural(t.items, 'item')} ${t.rowsOutsideStrategy === 1 ? 'is' : 'are'} outside the ads strategy — ${t.firstOutside.why}; ${A_PERSON}`
}

/** C4 — nothing it touches is also moved by an enabled rule or schedule, unless the tool's limits allow it. */
export function engineOwnedRefusal(facts: LimitFacts, limits: Limits): string | null {
  const owned = facts.engineOwned[0]
  if (!owned || limits.allowEngineOwned === true) return null
  return `${owned.label} is also moved by ${owned.by.join(', ')}; Claude does not change what an engine moves without a person (allowEngineOwned is off)`
}

/**
 * C5 — per market: what ran by rule in the last 24 hours plus this change, within Claude's daily limits on the market's
 * strategy row — changes, raises and budget increase. A limit the strategy does not set is 0 (fail closed): nothing that
 * adds to it runs by rule. A change that adds nothing to a limit is not held by it.
 */
export function dailyRefusal(facts: LimitFacts): string | null {
  const ran = facts.watchedToday ? 'ran or would have run by rule' : 'ran by rule'
  for (const market of facts.this.markets) {
    const mine = facts.this.byMarket[market]
    const today = facts.today[market] ?? NO_RUNS
    const m = facts.markets[market]
    if (!mine || !m) continue
    const money = (cents: number) => amountLabel(cents, m.currency)
    const limits: Array<{ key: 'maxChangesPerDay' | 'maxRaisesPerDay' | 'maxBudgetIncreasePerDayCents'; adds: number; ran: number; words: (n: number) => string; none: string }> = [
      { key: 'maxChangesPerDay', adds: mine.changes, ran: today.changes, words: (n) => plural(n, 'change'), none: 'no change' },
      { key: 'maxRaisesPerDay', adds: mine.raises, ran: today.raises, words: (n) => plural(n, 'raise'), none: 'no raise' },
      { key: 'maxBudgetIncreasePerDayCents', adds: mine.budgetIncreaseCents, ran: today.budgetIncreaseCents, words: (n) => `${money(n)} of daily budget`, none: 'no budget increase' },
    ]
    for (const l of limits) {
      const max = m[l.key]
      if (l.adds <= 0 || l.ran + l.adds <= (max ?? 0)) continue
      if (max == null) return `${market}: the ads strategy sets no daily limit for this (${DAILY_WORDS[l.key]}) — empty is 0, so ${l.none} runs by rule here; ${A_PERSON}`
      const allowed = l.key === 'maxBudgetIncreasePerDayCents' ? money(max) : String(max)
      const source = m.sources[DAILY_SOURCE[l.key]]
      return `${market}: ${l.words(l.ran)} ${ran} in the last 24 hours and this adds ${l.words(l.adds)}, more than the ${allowed} a day the ads strategy allows (${DAILY_WORDS[l.key]}${source ? `, ${strategyWords(source)}` : ''}); ${A_PERSON}`
    }
  }
  return null
}

/**
 * AA-W2-4 — a stored preview as the watch level judges it, as if the kinds it watches were at auto: "today" (per market,
 * and per entity) also counts the watched changes the rule would have run (`watched`, their ledger), and — when the
 * ads strategy is what holds this change at watch (`strategyWatchAsAuto`) — the strategy's watch reads as auto, so the
 * verdict says what would happen once it is raised. The per-entity count is a floor: the facts name the runs of one
 * entity only. Pure; the preview itself is not changed, and one without limit facts comes back as it is.
 */
export function asWatched(preview: unknown, opts: { watched: RuleRunLedger; strategyWatchAsAuto?: boolean }): unknown {
  const facts = limitFactsOf(preview)
  if (!facts || (!opts.watched.runs && !opts.strategyWatchAsAuto)) return preview
  const today = { ...facts.today }
  for (const market of facts.this.markets) {
    const add = opts.watched.byMarket[market]
    if (!add) continue
    const day = today[market] ?? NO_RUNS
    today[market] = { changes: day.changes + add.changes, writes: day.writes + add.writes, raises: day.raises + add.raises, budgetIncreaseCents: day.budgetIncreaseCents + add.budgetIncreaseCents }
  }
  let { maxChangesByRule, entity } = facts.perEntityToday
  for (const key of facts.this.entities ?? []) {
    const runs = (opts.watched.byEntity[key] ?? 0) + (key === facts.perEntityToday.entity ? facts.perEntityToday.maxChangesByRule : 0)
    if (runs > maxChangesByRule) ({ maxChangesByRule, entity } = { maxChangesByRule: runs, entity: key })
  }
  const scopes = opts.strategyWatchAsAuto
    ? Object.fromEntries(Object.entries(facts.scopes).map(([key, scope]) => [key, scope.limits.claudeLevel === 'watch' ? { ...scope, limits: { ...scope.limits, claudeLevel: 'auto' as const } } : scope]))
    : facts.scopes
  return { ...(preview as Record<string, unknown>), limitFacts: { ...facts, today, perEntityToday: { maxChangesByRule, entity }, scopes, ...(opts.watched.runs ? { watchedToday: true as const } : {}) } }
}

/** C6 — Claude changed none of its entities by rule as often as the tool's limits allow in 24 hours (no back and forth). */
export function perEntityRefusal(facts: LimitFacts, limits: Limits): string | null {
  const max = numberIn(limits, 'maxChangesPerEntityPerDay', 1)
  const { maxChangesByRule, entity } = facts.perEntityToday
  if (maxChangesByRule < max) return null
  if (max === 0) return `this tool's limits let no entity be changed by rule (maxChangesPerEntityPerDay 0); ${A_PERSON}`
  const label = (entity && facts.labels[entity]) || 'an item'
  const by = facts.watchedToday ? 'by rule (or would have, watched)' : 'by rule'
  return `Claude already changed ${label} ${plural(maxChangesByRule, 'time')} ${by} in the last 24 hours, and this tool's limits allow ${max} a day; ${A_PERSON}`
}

/** C7 — items in this request: at most the tool's limit and each market's most actions per run in the strategy. */
export function itemsRefusal(facts: LimitFacts, limits: Limits): string | null {
  const t = facts.this
  const max = numberIn(limits, 'maxItems', 0)
  if (t.items > max) return `it changes ${plural(t.items, 'item')}, more than the ${max} this tool's limits allow in one request run by rule; ${A_PERSON}`
  for (const market of t.markets) {
    const m = facts.markets[market]
    const items = t.byMarket[market]?.changes ?? 0
    if (m?.maxActionsPerRun != null && items > m.maxActionsPerRun) {
      return `it changes ${plural(items, 'item')} in ${market}, more than the ${m.maxActionsPerRun} actions per run the ads strategy allows${m.sources.maxActionsPerRun ? ` (${strategyWords(m.sources.maxActionsPerRun)})` : ''}; ${A_PERSON}`
    }
  }
  return null
}

/**
 * The tool's own raise and cut steps (STEP_PCT_LIMITS, STEP_POINT_LIMITS), when its limits hold them. AA-W2-7 — a raise
 * from 0 (no percent measures it) is outside any raise step unless the ads strategy's highest bid bounds it where it
 * lands, and outside a raise step of 0 either way.
 */
export function stepRefusal(facts: LimitFacts, limits: Limits): string | null {
  const t = facts.this
  if (typeof limits.maxRaisePct === 'number') {
    const max = limits.maxRaisePct
    const unbounded = t.unboundedRaises ?? 0
    const fromZero = t.raisesFromZero ?? 0
    if (unbounded) return `it raises ${plural(unbounded, 'bid or budget', 'bids or budgets')} from 0, which no percent measures, and the ads strategy sets no highest bid that bounds it: an unbounded raise, more than the ${max} % this tool's limits let run without a person`
    if (fromZero && max === 0) return `it raises ${plural(fromZero, 'bid', 'bids')} from 0, and this tool's limits let no raise run without a person (0: every raise waits for a person)`
  }
  const over = (moved: number, key: string, unit: string, what: string) =>
    typeof limits[key] === 'number' && moved > (limits[key] as number)
      ? `its largest ${what} is ${moved}${unit}, more than the ${limits[key]}${unit} this tool's limits let run without a person${limits[key] === 0 ? ` (0: every ${what} waits for a person)` : ''}`
      : null
  return over(t.largestRaisePct, 'maxRaisePct', ' %', 'raise')
    ?? over(t.largestCutPct, 'maxCutPct', ' %', 'cut')
    ?? over(t.largestRaisePoints, 'maxRaisePoints', ' points', 'raise')
    ?? over(t.largestCutPoints, 'maxCutPoints', ' points', 'cut')
}

/**
 * A change that can add spend keeps each market's month under its cap: the forecast from the run rate with its margin,
 * plus every cent of daily budget the change adds (spend data is a day or two late). The budget engine's cap stop stays
 * behind it.
 */
export function monthRefusal(facts: LimitFacts): string | null {
  for (const [market, p] of Object.entries(facts.monthProjection ?? {})) {
    if (p.capCents == null || p.afterCents <= p.capCents) continue
    return `${market}: this month could reach ${amountLabel(p.afterCents, p.currency)} with this change — ${monthWords(p)} — above the monthly cap ${amountLabel(p.capCents, p.currency)} (${p.capFrom}); ${A_PERSON}`
  }
  return null
}

function monthWords(p: MonthProjection): string {
  const spent = `${amountLabel(p.spentCents, p.currency)} spent${p.spendThrough ? ` through ${p.spendThrough}` : ' (no report this month yet)'}`
  const rate = p.rateThrough
    ? `${amountLabel(p.ratePerDayCents, p.currency)} a day (the average of the ${RATE_DAYS} reported days to ${p.rateThrough}) + ${p.marginPct} % for the ${plural(p.uncoveredDays, 'day')} not reported yet`
    : `no report in the last five weeks, so no run rate for the ${plural(p.uncoveredDays, 'day')} not reported yet`
  const added = p.addedDailyCents ? `, ${p.addedDailyCents > 0 ? '+' : '−'}${amountLabel(Math.abs(p.addedDailyCents), p.currency)} a day from today for ${plural(p.daysLeft, 'day')}` : ''
  return `${spent}, ${rate}${added}`
}

/**
 * Every common check, in order; null when the preview is inside them all. A preview without limit facts (or of another
 * version) is never inside: a person decides. The tool adds its own row checks after this one.
 */
export function commonRefusal(preview: unknown, limits: Limits): string | null {
  const facts = limitFactsOf(preview)
  if (!facts) return `there are no limit facts in this preview (the ads strategy was not read for it); ${A_PERSON}`
  return strategyRefusal(facts)
    ?? aloneRefusal(facts)
    ?? protectedRefusal(facts)
    ?? outsideRefusal(facts)
    ?? engineOwnedRefusal(facts, limits)
    ?? itemsRefusal(facts, limits)
    ?? perEntityRefusal(facts, limits)
    ?? dailyRefusal(facts)
    ?? stepRefusal(facts, limits)
    ?? monthRefusal(facts)
}

// ── The note a person and Claude read ─────────────────────────────────────────────────────────────

const LIMIT_WORDS: Array<[keyof ScopeLimits, string, 'cents' | 'pct']> = [
  ['minBidCents', 'lowest bid', 'cents'],
  ['maxBidCents', 'highest bid', 'cents'],
  ['maxChangePct', 'largest bid change', 'pct'],
  ['stopBidCents', 'stop bid', 'cents'],
]
const SOURCE_OF: Partial<Record<keyof ScopeLimits, keyof ScopeStrategy['sources']>> = { ...BID_SOURCE, stopBidCents: 'stop' }

/**
 * Each limit, its value, this change's value, and where the limit comes from (a strategy row, or "Claude's limits for
 * this tool" — the business's own, Settings › AI › Claude). One line per fact; the same limit from the same row on
 * several scopes is said once.
 */
export function limitsNote(facts: LimitFacts, limits?: Limits): string[] {
  const t = facts.this
  const lines: string[] = []
  const toolLimit = (key: string) => (limits && typeof limits[key] === 'number' ? `${limits[key]}, Claude's limits for this tool` : null)
  for (const market of t.markets) {
    const m = facts.markets[market]
    if (!m) continue
    lines.push(m.strategy ? `${market}: ads strategy version ${m.strategy.version}.` : `${market}: no ads strategy — nothing runs alone there.`)
    const today = facts.today[market] ?? NO_RUNS
    const mine = t.byMarket[market]
    const limit = (value: number | null, key: keyof typeof DAILY_SOURCE, unset: string, money = false) =>
      value == null ? unset : `${money ? amountLabel(value, m.currency) : value} a day (${m.sources[DAILY_SOURCE[key]] ? strategyWords(m.sources[DAILY_SOURCE[key]]!) : 'ads strategy'})`
    lines.push(
      `${market}, run by rule in the last 24 hours: ${plural(today.changes, 'change')}, ${plural(today.raises, 'raise')}, budgets +${amountLabel(today.budgetIncreaseCents, m.currency)}; `
      + `this change: ${plural(mine?.changes ?? 0, 'change')}, ${plural(mine?.raises ?? 0, 'raise')}, budgets +${amountLabel(mine?.budgetIncreaseCents ?? 0, m.currency)}. `
      + `Daily limits: changes ${limit(m.maxChangesPerDay, 'maxChangesPerDay', 'not set, so 0: no change runs by rule')}; raises ${limit(m.maxRaisesPerDay, 'maxRaisesPerDay', 'not set, so 0: no raise runs by rule')}; `
      + `budget increase ${limit(m.maxBudgetIncreasePerDayCents, 'maxBudgetIncreasePerDayCents', 'not set, so 0: no budget increase runs by rule', true)}.`,
    )
    if (m.maxActionsPerRun != null) lines.push(`${market}: most actions per run ${m.maxActionsPerRun} (${strategyWords(m.sources.maxActionsPerRun!)}); this change: ${mine?.changes ?? 0}.`)
  }
  // The strategy's limits where it lands, each value with its row, said once per row.
  const said = new Map<string, string[]>()
  for (const scope of Object.values(facts.scopes)) {
    const currency = facts.markets[scope.market]?.currency ?? 'EUR'
    for (const [key, words, unit] of LIMIT_WORDS) {
      const value = scope.limits[key] as number | undefined
      const source = scope.sources[SOURCE_OF[key] ?? (key as keyof ScopeStrategy['sources'])]
      if (value == null || !source) continue
      const line = `${words} ${unit === 'cents' ? amountLabel(value, currency) : `${value} %`} (${strategyWords(source)})`
      said.set(line, [...(said.get(line) ?? []), scope.label])
    }
    if (scope.limits.protect === true && scope.sources.protect) {
      const line = `protected (${strategyWords(scope.sources.protect)})`
      said.set(line, [...(said.get(line) ?? []), scope.label])
    }
    // AA-W2-8 — a target ACoS change: the ACoS target the engines use there (a raise by rule stays at or below it).
    if (facts.action === 'target' && scope.limits.strategyTargetAcosPct != null && scope.sources.target) {
      const line = `target ACoS the engines use ${scope.limits.strategyTargetAcosPct} % (${strategyWords(scope.sources.target)})`
      said.set(line, [...(said.get(line) ?? []), scope.label])
    }
    if (facts.action && scope.limits.claudeLevel && scope.sources.claudeLevel) {
      const line = `what Claude may do alone for ${ACTION_WORDS[facts.action]}: ${scope.limits.claudeLevel} (${strategyWords(scope.sources.claudeLevel)})`
      said.set(line, [...(said.get(line) ?? []), scope.label])
    }
  }
  for (const [line, where] of said) lines.push(`${line[0].toUpperCase()}${line.slice(1)} — at ${where.length > 3 ? `${where.slice(0, 3).join(', ')} and ${plural(where.length - 3, 'more scope')}` : where.join(', ')}.`)
  if (t.highestNewBidCents != null) {
    const currency = facts.markets[t.markets[0]]?.currency ?? 'EUR'
    lines.push(`This change: highest new bid ${amountLabel(t.highestNewBidCents, currency)}; largest raise ${t.largestRaisePct} %${toolLimit('maxRaisePct') ? ` (at most ${toolLimit('maxRaisePct')})` : ''}; largest cut ${t.largestCutPct} %${toolLimit('maxCutPct') ? ` (at most ${toolLimit('maxCutPct')})` : ''}.`)
  }
  if (t.largestRaisePoints || t.largestCutPoints) {
    lines.push(`This change: largest raise ${t.largestRaisePoints} points${toolLimit('maxRaisePoints') ? ` (at most ${toolLimit('maxRaisePoints')})` : ''}; largest cut ${t.largestCutPoints} points${toolLimit('maxCutPoints') ? ` (at most ${toolLimit('maxCutPoints')})` : ''}.`)
  }
  lines.push(`Items: ${t.items}${toolLimit('maxItems') ? ` (at most ${toolLimit('maxItems')})` : ''}; outside the ads strategy: ${t.rowsOutsideStrategy}${t.firstOutside ? ` — first: ${t.firstOutside.why}` : ''}.`)
  lines.push(`Changed by rule in the last 24 hours: ${facts.perEntityToday.entity ? `${facts.labels[facts.perEntityToday.entity] ?? 'an item'} ${plural(facts.perEntityToday.maxChangesByRule, 'time')}` : 'none of these'}${toolLimit('maxChangesPerEntityPerDay') ? ` (at most ${limits!.maxChangesPerEntityPerDay} per item, Claude's limits for this tool)` : ''}.`)
  for (const owned of facts.engineOwned) lines.push(`${owned.label[0].toUpperCase()}${owned.label.slice(1)} is also moved by ${owned.by.join(', ')}${limits ? ` (allowEngineOwned: ${limits.allowEngineOwned === true ? 'on' : 'off'})` : ''}.`)
  for (const hit of facts.protectedHit) lines.push(`Protected: ${hit.why}.`)
  for (const u of facts.unplaced) lines.push(`Not placed: ${u.why}.`)
  for (const [market, p] of Object.entries(facts.monthProjection ?? {})) {
    lines.push(`${market}, this month forecast ${amountLabel(p.afterCents, p.currency)} with this change (${monthWords(p)}); cap ${amountLabel(p.capCents, p.currency)} (${p.capFrom}).`)
  }
  return lines
}
