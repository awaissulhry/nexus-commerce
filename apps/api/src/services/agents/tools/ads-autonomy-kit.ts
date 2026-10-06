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
 *            also move it; the protected terms and products it meets; and, for a change that can add spend, the month's
 *            upper bound. The preview stores them as `limitFacts`, so `withinLimits` stays pure (it reads nothing) and a
 *            stored preview can be judged again (the commit's re-check, the watch week, the history test).
 *   ledger   no new table: the business's approvals run by rule (decisionVia auto) decided in the last 24 hours, and the
 *            steps of plans run by rule, each counted from the `this` block its own preview stored. A request handed
 *            back (stale, refused, failed) clears its decisionVia and no longer counts — the business cap's rows and
 *            window (claude-trust.service.ts autoRunsInLastDay). A bulk request is one run with many writes.
 *   checks   C1–C7 of the design (§2.4), plus every row inside its own scope's strategy and, for a change that can add
 *            spend, the month: pure, each null or the sentence a person reads. `commonRefusal` runs them in order.
 *   limits   the Claude limits every strategy-bound tool shares (`adKitLimits`: items per run, changes of one entity by
 *            rule a day, engine-owned) and the raise / cut steps (`STEP_PCT_LIMITS`, `STEP_POINT_LIMITS`). A limit that
 *            can add spend defaults to 0: until a person types a number, only lowering changes run alone.
 *   note     `limitsNote`: each limit, its value, this change's value, and where the limit comes from.
 *
 * Live and sandbox are judged the same. The existing brakes stay in front of every check here: nexus.run, Pause, the
 * business's cap of runs by rule and the write gate (a gate refusal is refused at preview and never queued).
 */
import { z } from 'zod'
import { FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import {
  bidLimitsOfScope,
  enginesOnCampaigns,
  entityKey,
  monthProjections,
  protectedNegativeWhy,
  resolveEntityScopes,
  strategyForScopes,
  type AdEntityRef,
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
 *   negative     a new negative keyword or target (it only lowers spend).
 */
export type KitChange =
  | { field: 'bid'; fromCents: number | null; toCents: number; forced?: boolean }
  | { field: 'dailyBudget'; fromCents: number | null; toCents: number }
  | { field: 'placementPct' | 'targetAcosPct'; fromPct: number | null; toPct: number }
  | { field: 'status'; from: string | null; to: 'ENABLED' | 'PAUSED' | 'ARCHIVED'; dailyBudgetCents?: number }
  | { field: 'negative'; term: string; matchType?: string | null }

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
  }
}

// ── The facts a preview stores ────────────────────────────────────────────────────────────────────

export interface DayCounts {
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
  byMarket: Record<string, DayCounts & { items: number; addedDailyCents: number }>
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
  maxWritesPerDay: number | null
  maxRaisesPerDay: number | null
  maxBudgetIncreasePerDayCents: number | null
  sources: Partial<Record<'maxActionsPerRun' | 'maxWritesPerDay' | 'maxRaisesPerDay' | 'maxBudgetIncreasePerDayCents', StrategySource>>
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
  /** For a change that can add spend: each market's month. */
  monthProjection?: Record<string, MonthProjection>
}

/**
 * The money keys of the facts, each with the permission that reveals it, for a tool's `restrictedFields`: the
 * strategy's own (STRATEGY_MONEY) and the kit's. A money value always sits under one of these, never under a generic key.
 */
export const LIMIT_FACTS_MONEY: Readonly<Record<string, string>> = {
  ...STRATEGY_MONEY,
  ...Object.fromEntries(
    ['highestNewBidCents', 'budgetIncreaseCents', 'addedDailyCents', 'maxBudgetIncreasePerDayCents', 'spentCents', 'budgetsCents', 'projectedCents', 'afterCents', 'capCents']
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

/** Pure: the ledger of stored previews, each one run; a preview without limit facts adds nothing. */
export function ledgerOf(previews: readonly unknown[]): RuleRunLedger {
  const out: RuleRunLedger = { byMarket: {}, byEntity: {}, runs: 0 }
  for (const preview of previews) {
    const facts = limitFactsOf(preview)
    if (!facts) continue
    out.runs++
    for (const [market, c] of Object.entries(facts.this.byMarket ?? {})) {
      const day = (out.byMarket[market] ??= { writes: 0, raises: 0, budgetIncreaseCents: 0 })
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
}

/**
 * The facts of one change, read in the business of the call, for its preview. `approvalId`: the request a dry run
 * re-checks (not counted in today's ledger). `projectMonth`: the change can add spend without adding a budget (a
 * restore puts bids back) — a change that adds a daily budget is always projected.
 */
export async function buildLimitFacts(input: {
  tool: string
  items: readonly KitItem[]
  approvalId?: string | null
  projectMonth?: boolean
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
      maxWritesPerDay: s.daily.maxWritesPerDay,
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
    const day = scope.market ? (t.byMarket[scope.market] ??= { items: 0, writes: 0, raises: 0, budgetIncreaseCents: 0, addedDailyCents: 0 }) : null
    if (day) day.items++
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
  for (const [campaignId, by] of await enginesOnCampaigns(campaigns.keys())) facts.engineOwned.push({ campaignId, label: campaigns.get(campaignId)!, by })

  // C5, C6 — what already ran by rule.
  const ledger = await ruleRunLedger({ excludeApprovalId: input.approvalId, now: input.now })
  for (const market of t.markets) facts.today[market] = ledger.byMarket[market] ?? { writes: 0, raises: 0, budgetIncreaseCents: 0 }
  for (const entity of t.entities) {
    const runs = ledger.byEntity[entity] ?? 0
    if (runs > facts.perEntityToday.maxChangesByRule) facts.perEntityToday = { maxChangesByRule: runs, entity }
  }

  // The month, for a change that can add spend.
  const projected = t.markets.filter((m) => t.byMarket[m].addedDailyCents > 0 || (input.projectMonth === true && t.byMarket[m].raises > 0))
  if (projected.length) {
    const months = await monthProjections(projected.map((market) => ({ market, view: strategies.get(market)?.view ?? null, addedDailyCents: t.byMarket[market].addedDailyCents })), input.now)
    facts.monthProjection = Object.fromEntries(months)
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
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const A_PERSON = 'a person decides'

const ACTION_WORDS: Record<ClaudeActionType, string> = {
  bid: 'bid changes',
  negative: 'negative keywords',
  harvest: 'new exact keywords from search terms',
  placement: 'placement adjustments',
  budget: 'budget changes',
  target: 'target ACoS changes',
  suggestion: 'decisions on rule suggestions',
  stop: 'stopping a campaign with low bids',
  restore: "restoring a campaign's bids",
  create: 'new campaigns',
  rule: 'ads rules',
  undo: 'undoing ad changes',
}
/** What a strategy level below auto allows, in W1-8's words (claude-trust.service.ts narrowedWhy). */
const ALLOWS: Record<Exclude<ClaudeTrust, 'auto'>, (what: string) => string> = {
  off: (what) => `turns ${what} off for Claude`,
  ask: (what) => `lets Claude only ask for ${what}`,
  confirm: (what) => `lets Claude go no further than confirm in Claude for ${what}`,
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

/** C5 — per market: what ran by rule today and this change, within Claude's daily limits in the strategy. */
export function dailyRefusal(facts: LimitFacts): string | null {
  for (const market of facts.this.markets) {
    const mine = facts.this.byMarket[market]
    const today = facts.today[market] ?? { writes: 0, raises: 0, budgetIncreaseCents: 0 }
    const m = facts.markets[market]
    if (!mine || !m) continue
    const from = (key: keyof MarketFacts['sources']) => (m.sources[key] ? ` (${strategyWords(m.sources[key]!)})` : '')
    if (m.maxWritesPerDay != null && today.writes + mine.writes > m.maxWritesPerDay) {
      return `${market}: ${plural(today.writes, 'write')} ran by rule in the last 24 hours and this adds ${mine.writes}, more than the ${m.maxWritesPerDay} a day the ads strategy allows${from('maxWritesPerDay')}; ${A_PERSON}`
    }
    if (mine.raises > 0) {
      if (m.maxRaisesPerDay == null) return `${market}: the ads strategy sets no number of raises Claude may run by rule in a day, so a raise waits for a person`
      if (today.raises + mine.raises > m.maxRaisesPerDay) {
        return `${market}: ${plural(today.raises, 'raise')} ran by rule in the last 24 hours and this adds ${mine.raises}, more than the ${m.maxRaisesPerDay} a day the ads strategy allows${from('maxRaisesPerDay')}; ${A_PERSON}`
      }
    }
    if (mine.budgetIncreaseCents > 0) {
      if (m.maxBudgetIncreasePerDayCents == null) return `${market}: the ads strategy sets no daily budget increase Claude may run by rule, so a budget increase waits for a person`
      if (today.budgetIncreaseCents + mine.budgetIncreaseCents > m.maxBudgetIncreasePerDayCents) {
        return `${market}: budgets rose ${amountLabel(today.budgetIncreaseCents, m.currency)} by rule in the last 24 hours and this adds ${amountLabel(mine.budgetIncreaseCents, m.currency)}, more than the ${amountLabel(m.maxBudgetIncreasePerDayCents, m.currency)} a day the ads strategy allows${from('maxBudgetIncreasePerDayCents')}; ${A_PERSON}`
      }
    }
  }
  return null
}

/** C6 — Claude changed none of its entities by rule as often as the tool's limits allow in 24 hours (no back and forth). */
export function perEntityRefusal(facts: LimitFacts, limits: Limits): string | null {
  const max = numberIn(limits, 'maxChangesPerEntityPerDay', 1)
  const { maxChangesByRule, entity } = facts.perEntityToday
  if (maxChangesByRule < max) return null
  if (max === 0) return `this tool's limits let no entity be changed by rule (maxChangesPerEntityPerDay 0); ${A_PERSON}`
  const label = (entity && facts.labels[entity]) || 'an item'
  return `Claude already changed ${label} ${plural(maxChangesByRule, 'time')} by rule in the last 24 hours, and this tool's limits allow ${max} a day; ${A_PERSON}`
}

/** C7 — items in this request: at most the tool's limit and each market's most actions per run in the strategy. */
export function itemsRefusal(facts: LimitFacts, limits: Limits): string | null {
  const t = facts.this
  const max = numberIn(limits, 'maxItems', 0)
  if (t.items > max) return `it changes ${plural(t.items, 'item')}, more than the ${max} this tool's limits allow in one request run by rule; ${A_PERSON}`
  for (const market of t.markets) {
    const m = facts.markets[market]
    const items = t.byMarket[market]?.items ?? 0
    if (m?.maxActionsPerRun != null && items > m.maxActionsPerRun) {
      return `it changes ${plural(items, 'item')} in ${market}, more than the ${m.maxActionsPerRun} actions per run the ads strategy allows${m.sources.maxActionsPerRun ? ` (${strategyWords(m.sources.maxActionsPerRun)})` : ''}; ${A_PERSON}`
    }
  }
  return null
}

/** The tool's own raise and cut steps (STEP_PCT_LIMITS, STEP_POINT_LIMITS), when its limits hold them. */
export function stepRefusal(facts: LimitFacts, limits: Limits): string | null {
  const t = facts.this
  const over = (moved: number, key: string, unit: string, what: string) =>
    typeof limits[key] === 'number' && moved > (limits[key] as number)
      ? `its largest ${what} is ${moved}${unit}, more than the ${limits[key]}${unit} this tool's limits let run without a person${limits[key] === 0 ? ` (0: every ${what} waits for a person)` : ''}`
      : null
  return over(t.largestRaisePct, 'maxRaisePct', ' %', 'raise')
    ?? over(t.largestCutPct, 'maxCutPct', ' %', 'cut')
    ?? over(t.largestRaisePoints, 'maxRaisePoints', ' points', 'raise')
    ?? over(t.largestCutPoints, 'maxCutPoints', ' points', 'cut')
}

/** A change that can add spend keeps each market's month under its cap (an upper bound: spend data is a day or two late). */
export function monthRefusal(facts: LimitFacts): string | null {
  for (const [market, p] of Object.entries(facts.monthProjection ?? {})) {
    if (p.capCents == null || p.afterCents <= p.capCents) continue
    return `${market}: this month could reach ${amountLabel(p.afterCents, p.currency)} with this change — ${monthWords(p)} — above the monthly cap ${amountLabel(p.capCents, p.currency)} (${p.capFrom}); ${A_PERSON}`
  }
  return null
}

function monthWords(p: MonthProjection): string {
  const spent = `${amountLabel(p.spentCents, p.currency)} spent${p.spendThrough ? ` through ${p.spendThrough}` : ' (no report this month yet)'}`
  const budgets = `every enabled campaign's daily budget (${amountLabel(p.budgetsCents, p.currency)} together) for the ${plural(p.uncoveredDays, 'day')} not reported yet`
  const added = p.addedDailyCents ? `, ${p.addedDailyCents > 0 ? '+' : '−'}${amountLabel(Math.abs(p.addedDailyCents), p.currency)} a day from today for ${plural(p.daysLeft, 'day')}` : ''
  return `${spent}, ${budgets}${added}`
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
const SOURCE_OF: Partial<Record<keyof ScopeLimits, keyof ScopeStrategy['sources']>> = { stopBidCents: 'stop' }

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
    const today = facts.today[market] ?? { writes: 0, raises: 0, budgetIncreaseCents: 0 }
    const mine = t.byMarket[market]
    const limit = (value: number | null, key: keyof MarketFacts['sources'], unset: string, money = false) =>
      value == null ? unset : `${money ? amountLabel(value, m.currency) : value} a day (${m.sources[key] ? strategyWords(m.sources[key]!) : 'ads strategy'})`
    lines.push(
      `${market}, run by rule in the last 24 hours: ${plural(today.writes, 'write')}, ${plural(today.raises, 'raise')}, budgets +${amountLabel(today.budgetIncreaseCents, m.currency)}; `
      + `this change: ${plural(mine?.writes ?? 0, 'write')}, ${plural(mine?.raises ?? 0, 'raise')}, budgets +${amountLabel(mine?.budgetIncreaseCents ?? 0, m.currency)}. `
      + `Daily limits: writes ${limit(m.maxWritesPerDay, 'maxWritesPerDay', "not set (the business's cap of runs by rule applies)")}; raises ${limit(m.maxRaisesPerDay, 'maxRaisesPerDay', 'not set in the ads strategy (a raise waits for a person)')}; `
      + `budget increase ${limit(m.maxBudgetIncreasePerDayCents, 'maxBudgetIncreasePerDayCents', 'not set in the ads strategy (an increase waits for a person)', true)}.`,
    )
    if (m.maxActionsPerRun != null) lines.push(`${market}: most actions per run ${m.maxActionsPerRun} (${strategyWords(m.sources.maxActionsPerRun!)}); this change: ${mine?.items ?? 0}.`)
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
    lines.push(`${market}, this month at most ${amountLabel(p.afterCents, p.currency)} with this change (${monthWords(p)}); cap ${p.capCents == null ? 'none' : `${amountLabel(p.capCents, p.currency)} (${p.capFrom})`}.`)
  }
  return lines
}
