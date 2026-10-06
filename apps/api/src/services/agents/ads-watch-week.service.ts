/**
 * ADS AUTONOMY W4-5 — the watch-week comparison (agent-results/6 §7): each change Claude asked for at watch, against
 * what then happened to its entity. `ads-manager-runs` answers with it (`watchWeek`); the daily run's e-mail carries its
 * table while watch mode is on (tools/ads-manager.tools.ts).
 *
 *   steps     every watched step of the last N days that is an Amazon ad change (CLAUDE_ACTION_TOOLS): a request asked
 *             at watch (its verdict on AgentApproval.ruleVerdict, its preview there) or a watched step of a change plan
 *             (the plan's verdict per step, the step's own preview on AgentPlanStep). No new record: the door wrote
 *             these when Claude asked (AA-W2-4). Each with its verdict — would have run by rule, or which check would
 *             have held it and why; a plan step that would have run takes its plan's verdict when the plan as a whole
 *             would not — and what a person did with the request. A verdict is judged as if the connection had
 *             nexus.run (claude-trust.service.ts watchScopeOf); `scope` says when it had not.
 *   items     each entity of a step and the value it would have set, from the kit's stored facts (`limitFacts.wanted`,
 *             ads-autonomy-kit.ts). A preview stored before W4-5 names its entities only (`wanted` null).
 *   after     within 72 hours of the verdict: every write on the entity that reached Amazon or Nexus (AdvertisingActionLog;
 *             a write that failed, or that the write gate refused, skipped or cancelled, is left out) — an engine's, a
 *             person's, another approved request's — and every engine suggestion for it (AdsRuleSuggestion). The same
 *             way or the opposite way only on the SAME lever as Claude's change (the bid of that target or ad group,
 *             that campaign's budget, that placement, that target ACoS, that status, that negative, that harvest);
 *             any other write or suggestion on the entity is "other". A search term is followed through the keywords
 *             and negatives created for its words.
 *   observed  the entity's spend, sales, clicks, orders and ACoS in the 3 and 7 days after the verdict's day (UTC)
 *             against the same days before, next to comparable entities nothing wrote to in the whole span (the other
 *             targets, ad groups or ads of its campaign, up to PEERS_PER_CAMPAIGN; the other campaigns of its market
 *             in its currency; the other search terms of its campaign), their figures pooled. The outcome compares the
 *             entity's ACoS move with theirs (OUTCOME_BAND either way is flat). Observed, not proof of cause: a watched
 *             change never ran, so the entity went on without it (unless a person approved the request).
 *   table     per kind of ad action: would have run by rule, would have waited, agreed with an engine, conflicted with
 *             an engine, held by limits, the engines' suggestions, what people decided, and the outcome per item.
 *             The answer lists the newest steps only (SHOWN); the table counts every step read.
 *
 * Every figure is Nexus's own, read here. Money is in minor units of each campaign's own currency, never converted,
 * under the ad-money keys (spendCents, salesCents, acos, WATCH_WEEK_MONEY — a verdict's reason as the rule gave it, and
 * a suggestion's full key, may state an amount): a person without that permission gets the same answer without them.
 * Read only, in the business of the call (row-level security). Advertising's own tables (ad groups, rule suggestions)
 * are read through the advertising context (advertising/ads-watch-reads.service.ts). The figures are read in a few
 * queries per kind of entity, whatever the number of campaigns.
 */
import { Prisma } from '@nexus/database'
import type { RuleCheck, WatchStepVerdict, WatchVerdict } from '@nexus/shared/approval-queue'
import prisma from '../../db.js'
import { EXCLUDE_AMS_DAILY } from '../ads-core/ams-daily.js'
import { adGroupCampaigns, adGroupsOfCampaigns, suggestionsFor, type SuggestionRow } from '../advertising/ads-watch-reads.service.js'
import { normaliseTerm } from '../advertising/ads-negation-policy.js'
import { actionOfTool } from '../advertising/ads-strategy/claude.js'
import { CLAUDE_ACTION_TOOLS } from '../advertising/ads-strategy/fields.js'
import { adToolLevels, FATE_WORDS, fateOf, type ApprovalFate } from './ads-manager-run.service.js'
import { PLAN_TOOL } from './tool-types.js'
import { limitFactsOf, type Direction, type WantedItem } from './tools/ads-autonomy-kit.js'

// The tool registry loads every tool, this module's own reader among them: imported where used (load order).
const registry = () => import('./tool-registry.js')
// The change feed's actor reader; its module graph is wide, so it loads where used.
const changeFeed = () => import('../advertising/ads-changes.service.js')

/**
 * The keys of the answer that only a person who may see the ad money gets (a tool's `restrictedFields`): the value each
 * item would have set, a verdict's reason as the rule gave it, and a suggestion's full key (`bid_apply:setValue:0.42`).
 * Spend, sales and ACoS are restricted everywhere.
 */
export const WATCH_WEEK_MONEY = ['wantedFromCents', 'wantedToCents', 'wantedFromPct', 'wantedToPct', 'ruleWhy', 'proposedKey'] as const
/** The label every observed figure carries. */
export const OBSERVED_LABEL = 'observed, not proof of cause'
/** What "after" means for the writes and suggestions on an entity. */
export const AFTER_HOURS = 72
/** The two windows of figures, in days. */
export const WINDOW_DAYS = [3, 7] as const
/** The newest watched requests read (a plan counts once, with all its watched steps). */
export const MAX_REQUESTS = 200
/** The items of one step that are compared (a bulk step may hold up to 250). */
export const ITEMS_PER_STEP = 20
/** What the answer lists: the newest steps, the first items of each, the first writes and suggestions of each item. */
export const SHOWN = { steps: 30, items: 5, moves: 10, suggestions: 5 } as const
/** The comparable entities of one campaign read at most (deterministic: by id). */
export const PEERS_PER_CAMPAIGN = 200
/** The comparable entities of one kind read at most, all campaigns together. */
const MAX_PEERS = 5000
/** Within this fraction either way of the comparable entities' ACoS move, the outcome is flat. */
export const OUTCOME_BAND = 0.1
/** The newest writes on the entities read at most. */
export const MAX_WRITES = 5000
/** An outbound write in one of these states never reached Amazon (the write gate's refusal is SKIPPED). */
const NOT_SENT = ['FAILED', 'SKIPPED', 'CANCELLED'] as const

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

// ── Shapes ─────────────────────────────────────────────────────────────────────────────────────────

export type EntityKind = 'target' | 'adGroup' | 'campaign' | 'productAd' | 'searchTerm' | 'products'
/** How a write or a suggestion moved Claude's lever, against the way Claude's change would have; other: another lever. */
export type Relation = 'same' | 'opposite' | 'other'
/** An item's (or a step's) engines over the 72 hours. */
export type EngineRelation = 'same' | 'opposite' | 'mixed' | 'other' | 'none'
export type WatchOutcome = 'better' | 'worse' | 'flat' | 'no_sales' | 'no_spend' | 'no_peers' | 'not_yet' | 'no_data'
export const OUTCOMES: readonly WatchOutcome[] = ['better', 'worse', 'flat', 'no_sales', 'no_spend', 'no_peers', 'not_yet', 'no_data']
export const OUTCOME_WORDS: Record<WatchOutcome, string> = {
  better: 'its ACoS moved better than the comparable entities\'',
  worse: 'its ACoS moved worse than the comparable entities\'',
  flat: 'its ACoS moved as the comparable entities\' did',
  no_sales: 'no ad sales on one side of the window, so its ACoS cannot be compared',
  no_spend: 'no ad spend in the days before, so its ACoS move cannot be measured',
  no_peers: 'no comparable entity nothing wrote to, with ad spend and sales on both sides of the window',
  not_yet: 'the days after are not all in Nexus yet',
  no_data: 'Nexus has no figures for it on either side of the window',
}

export interface Period { spendCents: number; salesCents: number; clicks: number; orders: number; acos: number | null }

export interface WatchMove {
  at: string
  /** engine: a rule, schedule, plan or job; person: someone's own edit; request: another approved request; this_request: this one, approved by a person. */
  by: 'engine' | 'person' | 'request' | 'this_request' | 'other'
  who: string
  what: string
  /** Which way it moved Claude's lever; null: it moved another one (or none Nexus can read). */
  direction: Direction | null
  relation: Relation
}

/** `what`: the suggestion's kind (bid_down, budget_apply …), for everyone; `proposedKey` its full key, an ad-money key. */
export interface WatchSuggestion { at: string; rule: string | null; what: string; proposedKey: string; status: string; direction: Direction | null; relation: Relation }

export interface WatchWindow {
  days: number
  before: { from: string; to: string }
  after: { from: string; to: string }
  /** Every day after is in Nexus (the newest day of its figures reaches the window's end). */
  complete: boolean
  entity: { before: Period; after: Period } | null
  /** The comparable entities, pooled; count null when they are not counted one by one (search terms). */
  peers: { count: number | null; before: Period; after: Period } | null
}

export interface WatchItem {
  entity: { key: string; kind: EntityKind; id: string | null; label: string; market: string | null; currency: string | null }
  /** What Claude's change would have set (the kit's stored item, without its entity); null: not stored (before W4-5). */
  wanted: Omit<WantedItem, 'entity'> | null
  /** `moreMoves`, `moreSuggestions`: those not listed (SHOWN); the engine relation counts them all. */
  after72h: { engine: EngineRelation; moves: WatchMove[]; moreMoves: number; suggestions: WatchSuggestion[]; moreSuggestions: number }
  observed: { label: string; dataAsOf: string | null; windows: WatchWindow[]; outcome: WatchOutcome; meaning: string }
}

export interface WatchStep {
  approvalId: string
  /** A change plan's step number; null for a request of its own. */
  step: number | null
  tool: string
  title: string
  /** The kind of ad action (the ads strategy's key). */
  action: string
  askedAt: string
  checkedAt: string
  /**
   * `meaning`: in its check's own words, for everyone. `ruleWhy`: the reason as the rule gave it — a limit's may state an
   * amount, so it sits under an ad-money key (a person without that permission gets the meaning only). `scope`: the
   * connection had no nexus.run, so it could not have run it itself (the verdict is judged as if it had).
   */
  verdict: { wouldRun: boolean; check: RuleCheck | null; meaning: string; ruleWhy: string | null; scope: 'no-run-by-rule' | null }
  request: { status: string; fate: ApprovalFate; meaning: string; ran: boolean }
  items: WatchItem[]
  /** Items of the step not listed (SHOWN.items); past ITEMS_PER_STEP they are not compared either. */
  moreItems: number
  engine: EngineRelation
}

export interface WatchTableRow {
  action: string
  tools: string[]
  steps: number
  wouldRun: number
  wouldWait: number
  /** Steps where an engine moved an item's lever the way Claude's change would have (a step may count in both). */
  agreedWithEngine: number
  /** Steps where an engine moved an item's lever the other way. */
  conflictedWithEngine: number
  /** Would have waited because of the kind's limits or the daily cap. */
  heldByLimits: number
  byCheck: Partial<Record<RuleCheck, number>>
  /** Steps asked on a connection without nexus.run (judged as if it had it). */
  withoutRunByRule: number
  /** Steps where an engine suggested the same (or the other) way on an item's lever. */
  suggestedSame: number
  suggestedOpposite: number
  /** What a person did with the requests: approved (it ran or runs), declined, expired, still waiting. */
  requests: { approved: number; declined: number; expired: number; waiting: number }
  /** Per item compared. */
  outcome: Record<WatchOutcome, number>
}

export interface WatchWeek {
  label: string
  /** The last N days (as the run history's window): the same answer for two calls a moment apart. */
  window: { days: number }
  /** The newest SHOWN.steps steps; the table counts every one (`totalSteps`). */
  steps: WatchStep[]
  totalSteps: number
  table: WatchTableRow[]
  totals: Omit<WatchTableRow, 'action' | 'tools'>
  notes: string[]
  empty?: string
}

// ── Pure readers ───────────────────────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const num = (v: unknown): number | null => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null)
const day = (at: Date | string) => new Date(at).toISOString().slice(0, 10)
const addDays = (d: string, n: number) => day(new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS))
const dirOf = (delta: number): Direction => (delta > 0 ? 'raise' : delta < 0 ? 'cut' : 'same')

/** An entity key of the kit (`entityKey`) read back: its kind and id, or a search term's campaign, ad group and words. */
export function parseEntityKey(key: string): { kind: EntityKind; id: string | null; term?: { ext: string; adGroupExt: string | null; query: string }; market?: string | null } {
  const at = key.indexOf(':')
  const kind = (at >= 0 ? key.slice(0, at) : key) as EntityKind
  const rest = at >= 0 ? key.slice(at + 1) : ''
  if (kind === 'searchTerm') {
    const [ext = '', group = '*', ...words] = rest.split(':')
    return { kind, id: null, term: { ext, adGroupExt: group === '*' ? null : group, query: words.join(':') } }
  }
  if (kind === 'products') return { kind, id: null, market: rest.split(':')[0] || null }
  return { kind, id: rest || null }
}

/** Which way a move goes against Claude's: a raise against a raise is the same; a raise against a cut the opposite. */
export function relationOf(wanted: Direction | null, moved: Direction | null): Relation {
  if (!wanted || !moved || wanted === 'same' || moved === 'same') return 'other'
  return wanted === moved ? 'same' : 'opposite'
}

/**
 * The lever Claude's change moves, by its entity and field: `bid` (a target's or an ad group's), `harvest` (a new
 * keyword for a search term), `negative`, `dailyBudget`, `placement:<code>`, `targetAcos`, `status`. Null: a change no
 * write or suggestion is compared with (the live-write switch, an automation, a placement whose code was not stored,
 * an item stored before W4-5).
 */
export function leverOf(kind: EntityKind, wanted: Pick<WantedItem, 'field' | 'wantedFromCents' | 'placement'> | null): string | null {
  if (!wanted) return null
  switch (wanted.field) {
    case 'bid':
      if (kind === 'searchTerm') return wanted.wantedFromCents == null ? 'harvest' : null
      return kind === 'target' || kind === 'adGroup' ? 'bid' : null
    case 'negative': return kind === 'searchTerm' ? 'negative' : null
    case 'dailyBudget': return kind === 'campaign' ? 'dailyBudget' : null
    case 'placementPct': return kind === 'campaign' && wanted.placement ? `placement:${wanted.placement}` : null
    case 'targetAcosPct': return kind === 'campaign' ? 'targetAcos' : null
    case 'status': return 'status'
    default: return null
  }
}

const statusDirection = (from: unknown, to: unknown): Direction | null => {
  if (typeof from !== 'string' || typeof to !== 'string' || from === to) return null
  if (to === 'ENABLED') return 'raise'
  return from === 'ENABLED' ? 'cut' : null
}
const numberMove = (before: Obj, after: Obj, key: string): Direction | null => {
  const from = num(before[key])
  const to = num(after[key])
  return from != null && to != null && from !== to ? dirOf(to - from) : null
}
const placementOf = (adjustments: unknown, code: string): number | null => {
  if (!Array.isArray(adjustments)) return null
  return num(obj(adjustments.find((a) => obj(a).placement === code)).percentage) ?? 0
}

/**
 * Pure — which way one write on the entity moved Claude's lever, from its stored before and after; null when it moved
 * another lever (or none Nexus can read): a budget change against a placement move is "other", never the same or the
 * opposite.
 */
export function leverDirection(row: { entityType: string; actionType: string; payloadBefore: unknown; payloadAfter: unknown }, lever: string | null): Direction | null {
  if (!lever) return null
  const before = obj(row.payloadBefore)
  const after = obj(row.payloadAfter)
  if (lever === 'bid') return row.entityType === 'AD_GROUP' ? numberMove(before, after, 'defaultBidCents') : row.entityType === 'AD_TARGET' ? numberMove(before, after, 'bidCents') : null
  if (lever === 'dailyBudget') return row.entityType === 'CAMPAIGN' ? numberMove(before, after, 'dailyBudget') : null
  if (lever === 'targetAcos') return row.entityType === 'CAMPAIGN' ? numberMove(before, after, 'targetAcos') : null
  if (lever === 'status') return statusDirection(before.status, after.status)
  if (lever.startsWith('placement:')) {
    if (row.actionType !== 'update_placement_bidding') return null
    const code = lever.slice('placement:'.length)
    const from = placementOf(before.adjustments, code)
    const to = placementOf(after.adjustments, code)
    return from != null && to != null && from !== to ? dirOf(to - from) : null
  }
  return null
}

/** Pure — the lever an engine's suggestion moves, and which way; null lever when it moves none Claude's changes do. */
export function suggestionLever(proposedAction: unknown, proposedKey = ''): { lever: string | null; direction: Direction | null } {
  const a = obj(proposedAction)
  const type = String(a.type ?? proposedKey.split(':')[0] ?? '')
  const op = String(a.op ?? '')
  const byOp: Direction | null = /^inc/.test(op) ? 'raise' : /^dec/.test(op) ? 'cut' : null
  if (type === 'bid_down' || type === 'lower_bid_to_floor') return { lever: 'bid', direction: 'cut' }
  if (type === 'bid_up') return { lever: 'bid', direction: 'raise' }
  if (type === 'bid_apply') return { lever: 'bid', direction: byOp }
  if (type === 'budget_apply') return { lever: 'dailyBudget', direction: byOp }
  if (type === 'adjust_ad_budget') {
    const pct = num(a.percent)
    return { lever: 'dailyBudget', direction: pct ? (pct > 0 ? 'raise' : 'cut') : null }
  }
  if (type === 'set_daily_budget') return { lever: 'dailyBudget', direction: null }
  if (type === 'placement_apply' || type === 'set_placement_multiplier') {
    return { lever: `placement:${typeof a.placement === 'string' && a.placement ? a.placement : 'PLACEMENT_TOP'}`, direction: type === 'placement_apply' ? byOp : null }
  }
  if (/negat/i.test(type)) return { lever: 'negative', direction: 'cut' }
  if (type === 'promote_to_exact') return { lever: 'harvest', direction: 'raise' }
  if (/^pause/.test(type)) return { lever: 'status', direction: 'cut' }
  if (/^enable/.test(type)) return { lever: 'status', direction: 'raise' }
  return { lever: null, direction: null }
}

/** Pure — the engines of an item (or a step) over the 72 hours, from the relations of their moves. */
export function engineRelation(relations: readonly Relation[]): EngineRelation {
  if (!relations.length) return 'none'
  const same = relations.includes('same')
  const opposite = relations.includes('opposite')
  if (same && opposite) return 'mixed'
  return same ? 'same' : opposite ? 'opposite' : 'other'
}

export const period = (t: { spendCents: number; salesCents: number; clicks: number; orders: number }): Period => ({
  spendCents: t.spendCents, salesCents: t.salesCents, clicks: t.clicks, orders: t.orders, acos: t.salesCents > 0 ? t.spendCents / t.salesCents : null,
})
const ZERO = { spendCents: 0, salesCents: 0, clicks: 0, orders: 0 }
type Sums = typeof ZERO

/**
 * Pure — the outcome of one item from its windows: the 7 days when they are all in, else the 3, else not yet. Better or
 * worse: the entity's ACoS moved (after over before) more than OUTCOME_BAND better or worse than the comparable
 * entities' pooled ACoS did. An ACoS of 0 before (sales without spend) is no base to measure a move from.
 */
export function outcomeOf(windows: readonly WatchWindow[]): WatchOutcome {
  if (!windows.length) return 'no_data'
  const w = [...windows].sort((a, b) => b.days - a.days).find((x) => x.complete)
  if (!w) return 'not_yet'
  const e = w.entity
  if (!e || (e.before.spendCents === 0 && e.before.clicks === 0 && e.after.spendCents === 0 && e.after.clicks === 0)) return 'no_data'
  if (e.before.acos == null || e.after.acos == null) return 'no_sales'
  if (e.before.acos === 0) return 'no_spend'
  const p = w.peers
  if (!p || p.before.acos == null || p.after.acos == null || p.before.acos === 0 || p.after.acos === 0) return 'no_peers'
  const rel = (e.after.acos / e.before.acos) / (p.after.acos / p.before.acos)
  if (!Number.isFinite(rel)) return 'no_peers'
  return rel < 1 - OUTCOME_BAND ? 'better' : rel > 1 + OUTCOME_BAND ? 'worse' : 'flat'
}

const CHECK_WORDS: Record<RuleCheck, string> = {
  level: 'its kind waits for a person',
  strategy: 'the ads strategy holds it where it lands',
  scope: 'the Claude connection may not run changes by rule (no nexus.run)',
  pause: 'Claude\'s rule-runs were paused',
  limits: 'outside the kind\'s limits',
  cap: 'past the daily cap of changes run by rule',
  error: 'Nexus could not apply the business\'s rule to it',
}

/** The verdict in its check's own words (never the rule's reason, which may state an amount). */
export function verdictMeaning(v: { wouldRun: boolean; check: RuleCheck | null }): string {
  if (v.wouldRun) return 'would have run by rule'
  return `would have waited for a person${v.check ? ` — ${CHECK_WORDS[v.check]}` : ''}`
}

/**
 * Pure — a plan step's verdict: its own, but a step that would have run takes the plan's when the plan as a whole
 * would not have (a plan runs by rule only when every step may — the verdict Claude's report names, approvals[].watch).
 */
export function stepVerdictOf(step: Pick<WatchStepVerdict, 'wouldRun' | 'check' | 'why'>, plan: Pick<WatchVerdict, 'wouldRun' | 'check' | 'why'>) {
  if (step.wouldRun && !plan.wouldRun) return { wouldRun: false, check: plan.check, why: plan.why }
  return { wouldRun: step.wouldRun, check: step.check, why: step.why }
}

// ── Reading the watched steps ──────────────────────────────────────────────────────────────────────

/** Every Amazon ad change tool the ads strategy knows by kind (fields.ts), once. Read at call time (load order). */
const adChangeTools = () => new Set<string>(Object.values(CLAUDE_ACTION_TOOLS).flat())

const verdictOf = (value: unknown): WatchVerdict | null => {
  const v = obj(value)
  return typeof v.wouldRun === 'boolean' ? (v as unknown as WatchVerdict) : null
}

interface RawStep {
  approvalId: string
  step: number | null
  tool: string
  askedAt: Date
  checkedAt: Date
  verdict: { wouldRun: boolean; check: RuleCheck | null; why: string | null; scope: 'no-run-by-rule' | null }
  status: string
  reason: string | null
  preview: unknown
}

async function watchedSteps(from: Date, to: Date): Promise<{ steps: RawStep[]; truncated: boolean }> {
  const tools = adChangeTools()
  const rows = await prisma.agentApproval.findMany({
    where: {
      requestedAt: { gte: from, lte: to },
      ruleVerdict: { not: Prisma.DbNull },
      agentRun: { via: 'claude' },
      toolName: { in: [...tools, PLAN_TOOL] },
    },
    orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
    take: MAX_REQUESTS + 1,
    select: { id: true, toolName: true, status: true, reason: true, requestedAt: true, preview: true, ruleVerdict: true },
  })
  const truncated = rows.length > MAX_REQUESTS
  const kept = rows.slice(0, MAX_REQUESTS)
  // A plan's watched ad steps, and only their previews.
  const wanted = kept.flatMap((r) => (r.toolName === PLAN_TOOL ? ((verdictOf(r.ruleVerdict)?.steps ?? []) as WatchStepVerdict[])
    .filter((s) => s.watched && tools.has(s.tool)).map((s) => ({ approvalId: r.id, position: s.step })) : []))
  const byPlan = new Map<string, number[]>()
  for (const w of wanted) byPlan.set(w.approvalId, [...(byPlan.get(w.approvalId) ?? []), w.position])
  const planSteps = byPlan.size
    ? await prisma.agentPlanStep.findMany({
      where: { OR: [...byPlan].map(([approvalId, positions]) => ({ approvalId, position: { in: positions } })) },
      select: { approvalId: true, position: true, preview: true },
    })
    : []
  const stepPreview = new Map(planSteps.map((s) => [`${s.approvalId}#${s.position}`, s.preview]))
  const steps: RawStep[] = []
  for (const row of kept) {
    const verdict = verdictOf(row.ruleVerdict)
    if (!verdict) continue
    const checkedAt = verdict.checkedAt && !Number.isNaN(Date.parse(verdict.checkedAt)) ? new Date(verdict.checkedAt) : row.requestedAt
    const scope = verdict.scope === 'no-run-by-rule' ? verdict.scope : null
    const common = { approvalId: row.id, askedAt: row.requestedAt, checkedAt, status: row.status, reason: row.reason }
    if (row.toolName !== PLAN_TOOL) {
      steps.push({ ...common, step: null, tool: row.toolName, verdict: { wouldRun: verdict.wouldRun, check: verdict.check, why: verdict.why, scope }, preview: row.preview })
      continue
    }
    for (const s of (verdict.steps ?? []) as WatchStepVerdict[]) {
      if (!s.watched || !tools.has(s.tool)) continue
      steps.push({ ...common, step: s.step, tool: s.tool, verdict: { ...stepVerdictOf(s, verdict), scope }, preview: stepPreview.get(`${row.id}#${s.step}`) ?? null })
    }
  }
  return { steps, truncated }
}

// ── Entities, their campaigns, their writes ────────────────────────────────────────────────────────

interface Placed {
  key: string
  kind: EntityKind
  id: string | null
  term?: { ext: string; adGroupExt: string | null; query: string }
  label: string
  /** The campaign it belongs to (Nexus id), its market and currency; for a search term the campaign of its Amazon id. */
  campaignId: string | null
  market: string | null
  currency: string | null
}

type Grain = 'AD_TARGET' | 'AD_GROUP' | 'CAMPAIGN' | 'PRODUCT_AD'
const PERF_TYPE: Partial<Record<EntityKind, Grain>> = {
  target: 'AD_TARGET', adGroup: 'AD_GROUP', campaign: 'CAMPAIGN', productAd: 'PRODUCT_AD',
}
const currencyOf = (c: { dailyBudgetCurrency: string | null }) => c.dailyBudgetCurrency?.trim() || 'EUR'

async function placeEntities(keys: Map<string, string>): Promise<Map<string, Placed>> {
  const parsed = [...keys].map(([key, label]) => ({ key, label, ...parseEntityKey(key) }))
  const idsOf = (kind: EntityKind) => [...new Set(parsed.filter((p) => p.kind === kind && p.id).map((p) => p.id!))]
  const exts = [...new Set(parsed.filter((p) => p.term).map((p) => p.term!.ext))]
  const camp = { select: { id: true, marketplace: true, dailyBudgetCurrency: true } } as const
  const [targets, groups, ads, campaigns, termCampaigns] = await Promise.all([
    idsOf('target').length ? prisma.adTarget.findMany({ where: { id: { in: idsOf('target') } }, select: { id: true, adGroup: { select: { campaign: camp } } } }) : [],
    adGroupCampaigns(idsOf('adGroup')),
    idsOf('productAd').length ? prisma.adProductAd.findMany({ where: { id: { in: idsOf('productAd') } }, select: { id: true, adGroup: { select: { campaign: camp } } } }) : [],
    idsOf('campaign').length ? prisma.campaign.findMany({ where: { id: { in: idsOf('campaign') } }, ...camp }) : [],
    exts.length ? prisma.campaign.findMany({ where: { externalCampaignId: { in: exts } }, select: { externalCampaignId: true, ...camp.select }, orderBy: { id: 'asc' } }) : [],
  ])
  const campaignOf = new Map<string, { id: string; marketplace: string | null; dailyBudgetCurrency: string | null }>()
  for (const t of targets) if (t.adGroup?.campaign) campaignOf.set(`target:${t.id}`, t.adGroup.campaign)
  for (const g of groups) if (g.campaign) campaignOf.set(`adGroup:${g.id}`, g.campaign)
  for (const a of ads) if (a.adGroup?.campaign) campaignOf.set(`productAd:${a.id}`, a.adGroup.campaign)
  for (const c of campaigns) campaignOf.set(`campaign:${c.id}`, c)
  const byExt = new Map<string, (typeof termCampaigns)[number]>()
  for (const c of termCampaigns) if (c.externalCampaignId && !byExt.has(c.externalCampaignId)) byExt.set(c.externalCampaignId, c)
  const out = new Map<string, Placed>()
  for (const p of parsed) {
    const c = p.term ? byExt.get(p.term.ext) : campaignOf.get(p.key)
    out.set(p.key, {
      key: p.key, kind: p.kind, id: p.id, ...(p.term ? { term: p.term } : {}), label: p.label,
      campaignId: c?.id ?? null, market: c?.marketplace ?? p.market ?? null, currency: c ? currencyOf(c) : null,
    })
  }
  return out
}

interface WriteRow { id: string; entityType: string; entityId: string; actionType: string; userId: string | null; executionId: string | null; payloadBefore: unknown; payloadAfter: unknown; createdAt: Date }

/**
 * The writes on these entities in a span — the newest MAX_WRITES, then in time order — and the keywords and negatives
 * created for these search terms. A write that never reached Amazon (it failed, or the write gate refused it, or it was
 * skipped or cancelled before it went) is left out and counted.
 */
async function writesOn(placed: Placed[], span: { gte: Date; lte: Date }) {
  const byType = new Map<string, string[]>()
  for (const p of placed) {
    const type = PERF_TYPE[p.kind]
    if (type && p.id) byType.set(type, [...(byType.get(type) ?? []), p.id])
  }
  const terms = placed.filter((p) => p.term)
  const queries = [...new Set(terms.map((p) => normaliseTerm(p.term!.query)))].filter(Boolean)
  const markets = [...new Set(terms.map((p) => p.market).filter((m): m is string => !!m))]
  // A keyword or a negative created in the span with a search term's words, in its market (a harvest may land in
  // another campaign of the market; a negative in the term's own).
  const created = queries.length && markets.length
    ? await prisma.adTarget.findMany({
      where: {
        createdAt: span,
        OR: queries.map((q) => ({ expressionValue: { equals: q, mode: 'insensitive' as const } })),
        adGroup: { campaign: { marketplace: { in: markets } } },
      },
      select: { id: true, isNegative: true, expressionValue: true, createdAt: true, adGroup: { select: { campaign: { select: { externalCampaignId: true, marketplace: true } } } } },
      take: MAX_WRITES,
    })
    : []
  const createdIds = created.map((t) => t.id)
  const where = [...byType].map(([entityType, ids]) => ({ entityType, entityId: { in: [...new Set(ids)] } }))
  if (createdIds.length) where.push({ entityType: 'AD_TARGET', entityId: { in: createdIds } })
  // A Nexus-only write (a target ACoS) has no Amazon status: it is kept. `not` alone would drop it with the nulls.
  const reached = { OR: [{ amazonResponseStatus: null }, { amazonResponseStatus: { not: 'FAILED' } }] }
  const newest = where.length
    ? await prisma.advertisingActionLog.findMany({
      where: { createdAt: span, AND: [{ OR: where }, reached] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_WRITES + 1,
      select: { id: true, entityType: true, entityId: true, actionType: true, userId: true, executionId: true, outboundQueueId: true, payloadBefore: true, payloadAfter: true, createdAt: true },
    })
    : []
  const read = newest.slice(0, MAX_WRITES)
  const queued = [...new Set(read.map((w) => w.outboundQueueId).filter((x): x is string => !!x))]
  const notSent = queued.length
    ? new Set((await prisma.outboundSyncQueue.findMany({ where: { id: { in: queued }, syncStatus: { in: [...NOT_SENT] } }, select: { id: true } })).map((q) => q.id))
    : new Set<string>()
  const writes: WriteRow[] = read.filter((w) => !(w.outboundQueueId && notSent.has(w.outboundQueueId))).reverse()
  const failed = where.length ? await prisma.advertisingActionLog.count({ where: { createdAt: span, OR: where, amazonResponseStatus: 'FAILED' } }) : 0
  return { writes, truncated: newest.length > MAX_WRITES, created, unsent: failed + (read.length - writes.length) }
}

/** Who wrote a row, in plain words: an engine by its rule name, a person, an approved request, or this request. */
async function writersOf(writes: WriteRow[]) {
  const { parseActor } = await changeFeed()
  const executionIds = [...new Set(writes.map((w) => w.executionId).filter((x): x is string => !!x))]
  const parsed = new Map(writes.map((w) => [w.id, parseActor(w.userId)]))
  const ruleIds = [...new Set([...parsed.values()].filter((p) => p.origin.kind === 'rule' && p.origin.id).map((p) => p.origin.id!))]
  const [requests, rules] = await Promise.all([
    executionIds.length ? prisma.agentApproval.findMany({ where: { id: { in: executionIds } }, select: { id: true } }) : Promise.resolve([] as Array<{ id: string }>),
    ruleIds.length ? prisma.automationRule.findMany({ where: { id: { in: ruleIds } }, select: { id: true, name: true } }) : Promise.resolve([] as Array<{ id: string; name: string }>),
  ])
  const isRequest = new Set(requests.map((r) => r.id))
  const ruleName = new Map(rules.map((r) => [r.id, r.name]))
  return (w: WriteRow, approvalId: string): Pick<WatchMove, 'by' | 'who'> => {
    if (w.executionId && w.executionId === approvalId) return { by: 'this_request', who: 'this request, approved by a person' }
    if (w.executionId && isRequest.has(w.executionId)) return { by: 'request', who: `approved request ${w.executionId}` }
    const { source, origin } = parsed.get(w.id)!
    if (source === 'automation') {
      const name = origin.kind === 'rule' && origin.id ? ruleName.get(origin.id) ?? 'a rule' : origin.kind === 'job' ? origin.name : `a ${origin.kind}`
      return { by: 'engine', who: name }
    }
    if (source === 'operator') return { by: 'person', who: 'a person' }
    return { by: 'other', who: source === 'external' ? 'outside Nexus' : 'the system' }
  }
}

// ── Figures ────────────────────────────────────────────────────────────────────────────────────────

type DaySums = Map<string, Sums>
const add = (into: Sums, s: Partial<Sums>) => {
  into.spendCents += s.spendCents ?? 0
  into.salesCents += s.salesCents ?? 0
  into.clicks += s.clicks ?? 0
  into.orders += s.orders ?? 0
}
const sumRange = (days: DaySums | undefined, from: string, to: string): Sums => {
  const out = { ...ZERO }
  for (const [d, s] of days ?? []) if (d >= from && d <= to) add(out, s)
  return out
}
const minus = (a: Sums, b: Sums): Sums => ({
  spendCents: Math.max(0, a.spendCents - b.spendCents), salesCents: Math.max(0, a.salesCents - b.salesCents),
  clicks: Math.max(0, a.clicks - b.clicks), orders: Math.max(0, a.orders - b.orders),
})
const m2c = (v: unknown) => Math.round(Number(v ?? 0) / 10_000)
const rowSums = (s: { costMicros?: unknown; sales7dCents?: number | null; clicks?: number | null; orders7d?: number | null } | null | undefined): Sums => ({
  spendCents: m2c(s?.costMicros), salesCents: s?.sales7dCents ?? 0, clicks: s?.clicks ?? 0, orders: s?.orders7d ?? 0,
})
/** Rows of a daily table, each into its key's days (`key` null: one series). */
function intoDays<R extends { date: Date; _sum: Parameters<typeof rowSums>[0] }>(rows: readonly R[], key: (r: R) => string | null): Map<string, DaySums> {
  const out = new Map<string, DaySums>()
  for (const r of rows) {
    const k = key(r)
    if (k == null) continue
    const days = out.get(k) ?? new Map<string, Sums>()
    const d = day(r.date)
    const s = days.get(d) ?? { ...ZERO }
    add(s, rowSums(r._sum))
    days.set(d, s)
    out.set(k, days)
  }
  return out
}
/** Several entities' days pooled into one series. */
function pooled(series: Array<DaySums | undefined>): DaySums {
  const out: DaySums = new Map()
  for (const days of series) {
    for (const [d, s] of days ?? []) {
      const into = out.get(d) ?? { ...ZERO }
      add(into, s)
      out.set(d, into)
    }
  }
  return out
}

interface Figures {
  /** Per entity key, per day. */
  own: Map<string, DaySums>
  /** Per entity key, its comparable entities pooled per day, and how many (null: not counted one by one). */
  peers: Map<string, { count: number | null; days: DaySums }>
  /** The newest day of figures per market and grain. */
  asOf: Map<string, string>
}

const asOfKey = (market: string | null, grain: string) => `${market ?? '?'}|${grain}`
const SUM = { costMicros: true, sales7dCents: true, clicks: true, orders7d: true } as const

/**
 * The comparable candidates of every group of one kind at once, by group (a campaign id; for campaigns, a market and
 * currency), each at most PEERS_PER_CAMPAIGN, by id.
 */
async function peerCandidates(grain: Grain, groups: string[]): Promise<Map<string, string[]>> {
  const orderBy = { id: 'asc' as const }
  let rows: Array<{ id: string; group: string | null }>
  if (grain === 'AD_TARGET') {
    rows = (await prisma.adTarget.findMany({ where: { isNegative: false, adGroup: { campaignId: { in: groups } } }, select: { id: true, adGroup: { select: { campaignId: true } } }, orderBy, take: MAX_PEERS }))
      .map((r) => ({ id: r.id, group: r.adGroup?.campaignId ?? null }))
  } else if (grain === 'AD_GROUP') {
    rows = (await adGroupsOfCampaigns(groups, MAX_PEERS)).map((r) => ({ id: r.id, group: r.campaignId }))
  } else if (grain === 'PRODUCT_AD') {
    rows = (await prisma.adProductAd.findMany({ where: { adGroup: { campaignId: { in: groups } } }, select: { id: true, adGroup: { select: { campaignId: true } } }, orderBy, take: MAX_PEERS }))
      .map((r) => ({ id: r.id, group: r.adGroup?.campaignId ?? null }))
  } else {
    const markets = [...new Set(groups.map((g) => g.split('|')[0]))]
    rows = (await prisma.campaign.findMany({ where: { marketplace: { in: markets } }, select: { id: true, marketplace: true, dailyBudgetCurrency: true }, orderBy, take: MAX_PEERS }))
      .map((c) => ({ id: c.id, group: `${c.marketplace}|${currencyOf(c)}` }))
  }
  const out = new Map<string, string[]>()
  for (const r of rows) {
    if (!r.group || !groups.includes(r.group)) continue
    const list = out.get(r.group) ?? []
    if (list.length < PEERS_PER_CAMPAIGN) list.push(r.id)
    out.set(r.group, list)
  }
  return out
}

async function figuresOf(placed: Placed[], watchedKeys: Set<string>, span: { from: string; to: string }): Promise<Figures> {
  const date = { gte: new Date(`${span.from}T00:00:00Z`), lte: new Date(`${span.to}T00:00:00Z`) }
  const writeSpan = { gte: date.gte, lte: new Date(date.lte.getTime() + DAY_MS) }
  const own = new Map<string, DaySums>()
  const peers = new Map<string, { count: number | null; days: DaySums }>()
  const asOf = new Map<string, string>()

  // The newest day per market and grain (the figures summed below).
  const grains = [...new Set(placed.map((p) => PERF_TYPE[p.kind]).filter((g): g is Grain => !!g))]
  const [fresh, termFresh] = await Promise.all([
    grains.length
      ? prisma.amazonAdsDailyPerformance.groupBy({ by: ['marketplace', 'entityType'], where: { entityType: { in: grains }, date: { gte: date.gte }, ...EXCLUDE_AMS_DAILY }, _max: { date: true } })
      : [],
    placed.some((p) => p.term) ? prisma.amazonAdsSearchTerm.groupBy({ by: ['marketplace'], where: { date: { gte: date.gte } }, _max: { date: true } }) : [],
  ])
  for (const f of fresh) if (f._max.date) asOf.set(asOfKey(f.marketplace, f.entityType), day(f._max.date))
  for (const f of termFresh) if (f._max.date) asOf.set(asOfKey(f.marketplace, 'SEARCH_TERM'), day(f._max.date))

  // Targets, ad groups, ads, campaigns — per kind: the candidates of every group, the ones written to in the span, and
  // the daily rows of the entities and of their untouched candidates, one query each.
  for (const grain of grains) {
    const mine = placed.filter((p) => PERF_TYPE[p.kind] === grain && p.id)
    const watchedIds = new Set([...watchedKeys].map(parseEntityKey).filter((e) => PERF_TYPE[e.kind] === grain && e.id).map((e) => e.id!))
    const groupOf = (p: Placed) => (grain === 'CAMPAIGN' ? (p.market ? `${p.market}|${p.currency}` : null) : p.campaignId)
    const groups = [...new Set(mine.map(groupOf).filter((g): g is string => !!g))]
    const candidates = groups.length ? await peerCandidates(grain, groups) : new Map<string, string[]>()
    const peerIds = [...new Set([...candidates.values()].flat())].filter((id) => !watchedIds.has(id))
    const touched = peerIds.length
      ? new Set((await prisma.advertisingActionLog.groupBy({ by: ['entityId'], where: { entityType: grain, entityId: { in: peerIds }, createdAt: writeSpan } })).map((r) => r.entityId))
      : new Set<string>()
    const untouched = new Set(peerIds.filter((id) => !touched.has(id)))
    const ids = [...new Set([...mine.map((p) => p.id!), ...untouched])]
    const rows = await prisma.amazonAdsDailyPerformance.groupBy({ by: ['localEntityId', 'date'], where: { entityType: grain, localEntityId: { in: ids }, date, ...EXCLUDE_AMS_DAILY }, _sum: SUM })
    const byId = intoDays(rows, (r) => r.localEntityId)
    for (const p of mine) own.set(p.key, byId.get(p.id!) ?? new Map())
    for (const p of mine) {
      const group = groupOf(p)
      const members = group ? (candidates.get(group) ?? []).filter((id) => untouched.has(id)) : []
      peers.set(p.key, { count: members.length, days: pooled(members.map((id) => byId.get(id))) })
    }
  }

  // Search terms: their own rows; the comparable ones are the campaign's other search terms (all watched ones left out).
  const terms = placed.filter((p) => p.term)
  if (terms.length) {
    const exts = [...new Set(terms.map((p) => p.term!.ext))]
    const queries = [...new Set([...watchedKeys].map(parseEntityKey).filter((e) => e.term && exts.includes(e.term.ext)).map((e) => e.term!.query))]
    const [termRows, campaignRows] = await Promise.all([
      prisma.amazonAdsSearchTerm.groupBy({
        by: ['campaignId', 'adGroupId', 'query', 'date'],
        where: { campaignId: { in: exts }, OR: queries.map((q) => ({ query: { equals: q, mode: 'insensitive' as const } })), date },
        _sum: SUM,
      }),
      prisma.amazonAdsSearchTerm.groupBy({ by: ['campaignId', 'date'], where: { campaignId: { in: exts }, date }, _sum: SUM }),
    ])
    const matches = (e: { ext: string; adGroupExt: string | null; query: string }, r: { campaignId: string; adGroupId: string; query: string }) =>
      r.campaignId === e.ext && normaliseTerm(r.query) === normaliseTerm(e.query) && (!e.adGroupExt || r.adGroupId === e.adGroupExt)
    const watchedTerms = [...watchedKeys].map(parseEntityKey).filter((e) => e.term).map((e) => e.term!)
    const totals = intoDays(campaignRows, (r) => r.campaignId)
    for (const ext of exts) {
      const watched = intoDays(termRows.filter((r) => r.campaignId === ext && watchedTerms.some((e) => matches(e, r))), () => ext).get(ext) ?? new Map()
      const others: DaySums = new Map()
      for (const [d, s] of totals.get(ext) ?? []) others.set(d, minus(s, watched.get(d) ?? ZERO))
      for (const p of terms.filter((t) => t.term!.ext === ext)) {
        own.set(p.key, intoDays(termRows.filter((r) => matches(p.term!, r)), () => p.key).get(p.key) ?? new Map())
        peers.set(p.key, { count: null, days: others })
      }
    }
  }
  return { own, peers, asOf }
}

function windowsOf(p: Placed, d: string, figures: Figures): { windows: WatchWindow[]; dataAsOf: string | null } {
  const grain = p.term ? 'SEARCH_TERM' : PERF_TYPE[p.kind]
  const dataAsOf = grain ? figures.asOf.get(asOfKey(p.market, grain)) ?? null : null
  if (!grain) return { windows: [], dataAsOf }
  const own = figures.own.get(p.key)
  const peers = figures.peers.get(p.key)
  const windows = WINDOW_DAYS.map((n): WatchWindow => {
    const before = { from: addDays(d, -n), to: addDays(d, -1) }
    const after = { from: addDays(d, 1), to: addDays(d, n) }
    const any = (x: Sums) => x.spendCents > 0 || x.clicks > 0 || x.salesCents > 0 || x.orders > 0
    const eb = sumRange(own, before.from, before.to)
    const ea = sumRange(own, after.from, after.to)
    const pb = sumRange(peers?.days, before.from, before.to)
    const pa = sumRange(peers?.days, after.from, after.to)
    return {
      days: n,
      before,
      after,
      complete: !!dataAsOf && dataAsOf >= after.to,
      entity: any(eb) || any(ea) ? { before: period(eb), after: period(ea) } : null,
      peers: peers && (peers.count == null || peers.count > 0) && (any(pb) || any(pa)) ? { count: peers.count, before: period(pb), after: period(pa) } : null,
    }
  })
  return { windows, dataAsOf }
}

// ── The comparison ─────────────────────────────────────────────────────────────────────────────────

const emptyRow = (): Omit<WatchTableRow, 'action' | 'tools'> => ({
  steps: 0, wouldRun: 0, wouldWait: 0, agreedWithEngine: 0, conflictedWithEngine: 0, heldByLimits: 0, byCheck: {}, withoutRunByRule: 0,
  suggestedSame: 0, suggestedOpposite: 0, requests: { approved: 0, declined: 0, expired: 0, waiting: 0 },
  outcome: Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<WatchOutcome, number>,
})

/** Pure — one step into its kind's row of the table (and the totals). */
export function tally(row: Omit<WatchTableRow, 'action' | 'tools'>, s: WatchStep): void {
  row.steps++
  if (s.verdict.wouldRun) row.wouldRun++
  else row.wouldWait++
  if (s.verdict.check) row.byCheck[s.verdict.check] = (row.byCheck[s.verdict.check] ?? 0) + 1
  if (s.verdict.check === 'limits' || s.verdict.check === 'cap') row.heldByLimits++
  if (s.verdict.scope) row.withoutRunByRule++
  if (s.engine === 'same' || s.engine === 'mixed') row.agreedWithEngine++
  if (s.engine === 'opposite' || s.engine === 'mixed') row.conflictedWithEngine++
  const suggested = s.items.flatMap((i) => i.after72h.suggestions.map((x) => x.relation))
  if (suggested.includes('same')) row.suggestedSame++
  if (suggested.includes('opposite')) row.suggestedOpposite++
  const fate = s.request.fate
  if (fate === 'ran' || fate === 'approved') row.requests.approved++
  else if (fate === 'declined') row.requests.declined++
  else if (fate === 'expired') row.requests.expired++
  else if (fate === 'waiting' || fate === 'handed_back') row.requests.waiting++
  for (const item of s.items) row.outcome[item.observed.outcome]++
}

/**
 * The watch-week comparison of the last `days` days in this business: each watched ad step, what then happened to its
 * entities, and the table per kind. The same answer for everyone: the door strips the ad-money keys for a person
 * without that permission (`WATCH_WEEK_MONEY`).
 */
export async function watchWeek(opts: { days: number; now?: Date }): Promise<WatchWeek> {
  const now = opts.now ?? new Date()
  const from = new Date(now.getTime() - opts.days * DAY_MS)
  const notes: string[] = []
  const { steps: raw, truncated } = await watchedSteps(from, now)
  if (truncated) notes.push(`Only the newest ${MAX_REQUESTS} watched requests are compared.`)

  // Each step's items: the kit's stored facts (what it would have set), or its entities alone (stored before W4-5).
  const labels = new Map<string, string>()
  const itemsOf = raw.map((s) => {
    const facts = limitFactsOf(s.preview)
    if (!facts) return { wanted: [] as Array<{ key: string; wanted: WantedItem | null }>, more: 0, unread: true }
    const all = facts.wanted?.length
      ? facts.wanted.map((w) => ({ key: w.entity, wanted: w as WantedItem | null }))
      : (facts.this.entities ?? []).map((key) => ({ key, wanted: null }))
    const compared = all.slice(0, ITEMS_PER_STEP)
    for (const { key } of compared) labels.set(key, facts.labels?.[key] ?? key)
    return { wanted: compared, more: all.length - compared.length, unread: false }
  })
  if (itemsOf.some((i) => i.unread)) notes.push('A watched step whose preview holds no ad facts names no entity: it is counted, with nothing to compare.')
  if (itemsOf.some((i) => i.more > 0)) notes.push(`The first ${ITEMS_PER_STEP} items of a step are compared.`)
  if (itemsOf.some((i) => i.wanted.some((w) => !w.wanted))) notes.push('A request asked before Nexus kept each item\'s value names its entities only: no write or suggestion is compared with it.')

  const placed = await placeEntities(labels)
  const keys = [...placed.keys()]
  const first = raw.length ? new Date(Math.min(...raw.map((s) => s.checkedAt.getTime()))) : now
  const last = raw.length ? new Date(Math.max(...raw.map((s) => s.checkedAt.getTime()))) : now
  const writeSpan = { gte: first, lte: new Date(last.getTime() + AFTER_HOURS * HOUR_MS) }
  const span = { from: addDays(day(first), -Math.max(...WINDOW_DAYS)), to: addDays(day(last), Math.max(...WINDOW_DAYS)) }

  const [{ writes, truncated: manyWrites, created, unsent }, figures, suggestions] = await Promise.all([
    writesOn([...placed.values()], writeSpan),
    keys.length ? figuresOf([...placed.values()], new Set(keys), span) : Promise.resolve<Figures>({ own: new Map(), peers: new Map(), asOf: new Map() }),
    suggestionsOn([...placed.values()], writeSpan),
  ])
  if (manyWrites) notes.push(`Only the newest ${MAX_WRITES} writes on these entities are read.`)
  if (unsent) notes.push(`${unsent === 1 ? 'A write' : `${unsent} writes`} on these entities never reached Amazon (failed, refused by the write gate, skipped or cancelled): left out.`)
  const writer = await writersOf(writes)
  const { getTool } = await registry()

  // Writes by entity key (a created keyword or negative under the search term whose words it has).
  const writesOf = new Map<string, Array<{ w: WriteRow; created: { isNegative: boolean } | null }>>()
  const keyOfWrite = new Map<string, string>()
  for (const p of placed.values()) if (p.id && PERF_TYPE[p.kind]) keyOfWrite.set(`${PERF_TYPE[p.kind]}:${p.id}`, p.key)
  const createdOf = new Map(created.map((t) => [t.id, t]))
  const seenCreated = new Set<string>()
  for (const w of writes) {
    // A keyword or negative created for a search term's words: its first write is its creation (later ones move it).
    const target = w.entityType === 'AD_TARGET' && !seenCreated.has(w.entityId) ? createdOf.get(w.entityId) : undefined
    if (target) seenCreated.add(w.entityId)
    const keysHit = target
      ? [...placed.values()].filter((p) => p.term && p.market === target.adGroup?.campaign?.marketplace && normaliseTerm(p.term.query) === normaliseTerm(target.expressionValue)
        && (target.isNegative ? target.adGroup?.campaign?.externalCampaignId === p.term.ext : true)).map((p) => p.key)
      : []
    const own = keyOfWrite.get(`${w.entityType}:${w.entityId}`)
    if (own) writesOf.set(own, [...(writesOf.get(own) ?? []), { w, created: null }])
    for (const key of keysHit) writesOf.set(key, [...(writesOf.get(key) ?? []), { w, created: { isNegative: target!.isNegative } }])
  }

  const steps: WatchStep[] = raw.map((s, index) => {
    const checked = s.checkedAt.getTime()
    const until = checked + AFTER_HOURS * HOUR_MS
    const d = day(s.checkedAt)
    const fate = fateOf({ status: s.status, reason: s.reason })
    const items: WatchItem[] = itemsOf[index].wanted.map(({ key, wanted }) => {
      const p = placed.get(key)!
      const direction = wanted?.direction ?? null
      const lever = leverOf(p.kind, wanted)
      const moves: WatchMove[] = (writesOf.get(key) ?? [])
        .filter(({ w }) => w.createdAt.getTime() >= checked && w.createdAt.getTime() <= until)
        .map(({ w, created: made }) => {
          // A keyword made for the term is the harvest lever; a negative made for it the negative lever.
          const moved = made ? (made.isNegative ? (lever === 'negative' ? 'cut' : null) : (lever === 'harvest' ? 'raise' : null)) : leverDirection(w, lever)
          return { at: w.createdAt.toISOString(), ...writer(w, s.approvalId), what: w.actionType, direction: moved, relation: relationOf(direction, moved) }
        })
      const suggested: WatchSuggestion[] = (suggestions.get(key) ?? [])
        .filter((x) => x.lastSeenAt.getTime() >= checked && x.createdAt.getTime() <= until)
        .map((x) => {
          const sug = suggestionLever(x.proposedAction, x.proposedKey)
          const moved = lever && sug.lever === lever ? sug.direction : null
          return { at: x.createdAt.toISOString(), rule: x.ruleName, what: x.proposedKey.split(':')[0], proposedKey: x.proposedKey, status: x.status, direction: moved, relation: relationOf(direction, moved) }
        })
      const { windows, dataAsOf } = windowsOf(p, d, figures)
      const outcome = p.kind === 'products' ? 'no_data' : outcomeOf(windows)
      const { entity: _entity, ...value } = wanted ?? ({} as WantedItem)
      return {
        entity: { key, kind: p.kind, id: p.id, label: p.label, market: p.market, currency: p.currency },
        wanted: wanted ? value : null,
        after72h: { engine: engineRelation(moves.filter((m) => m.by === 'engine').map((m) => m.relation)), moves, moreMoves: 0, suggestions: suggested, moreSuggestions: 0 },
        observed: {
          label: OBSERVED_LABEL,
          dataAsOf,
          windows,
          outcome,
          meaning: `${OUTCOME_WORDS[outcome]}${fate === 'ran' ? '; a person approved the request, so the change ran' : '; the change never ran (watch), so the entity went on without it'}`,
        },
      }
    })
    const relations = items.flatMap((i) => i.after72h.moves.filter((m) => m.by === 'engine').map((m) => m.relation))
    return {
      approvalId: s.approvalId,
      step: s.step,
      tool: s.tool,
      title: getTool(s.tool)?.title ?? s.tool,
      action: actionOfTool(s.tool) ?? s.tool,
      askedAt: s.askedAt.toISOString(),
      checkedAt: s.checkedAt.toISOString(),
      verdict: { wouldRun: s.verdict.wouldRun, check: s.verdict.check, meaning: verdictMeaning(s.verdict), ruleWhy: s.verdict.why, scope: s.verdict.scope },
      request: { status: s.status, fate, meaning: FATE_WORDS[fate], ran: fate === 'ran' },
      items,
      moreItems: itemsOf[index].more,
      engine: engineRelation(relations),
    }
  })

  const rows = new Map<string, WatchTableRow>()
  const totals = emptyRow()
  for (const s of steps) {
    const row = rows.get(s.action) ?? { action: s.action, tools: [], ...emptyRow() }
    if (!row.tools.includes(s.tool)) row.tools.push(s.tool)
    tally(row, s)
    tally(totals, s)
    rows.set(s.action, row)
  }
  const table = [...rows.values()].sort((a, b) => b.steps - a.steps || a.action.localeCompare(b.action))
  if (steps.length > SHOWN.steps) notes.push(`The newest ${SHOWN.steps} steps are listed; the table counts all ${steps.length}.`)
  return {
    label: OBSERVED_LABEL,
    window: { days: opts.days },
    steps: steps.slice(0, SHOWN.steps).map(shownStep),
    totalSteps: steps.length,
    table,
    totals,
    notes,
    ...(steps.length ? {} : { empty: `No ad change was asked at watch in the last ${opts.days} days.` }),
  }
}

/** Pure — a step as the answer lists it (SHOWN): its first items, each with its first writes and suggestions. */
export function shownStep(s: WatchStep): WatchStep {
  return {
    ...s,
    items: s.items.slice(0, SHOWN.items).map((i) => ({
      ...i,
      after72h: {
        ...i.after72h,
        moves: i.after72h.moves.slice(0, SHOWN.moves),
        moreMoves: i.after72h.moreMoves + Math.max(0, i.after72h.moves.length - SHOWN.moves),
        suggestions: i.after72h.suggestions.slice(0, SHOWN.suggestions),
        moreSuggestions: i.after72h.moreSuggestions + Math.max(0, i.after72h.suggestions.length - SHOWN.suggestions),
      },
    })),
    moreItems: s.moreItems + Math.max(0, s.items.length - SHOWN.items),
  }
}

/** The engines' suggestions for these entities in a span, by entity key (a search term by its campaign and words). */
async function suggestionsOn(placed: Placed[], span: { gte: Date; lte: Date }): Promise<Map<string, SuggestionRow[]>> {
  const out = new Map<string, SuggestionRow[]>()
  const ids = (kind: EntityKind) => placed.filter((p) => p.kind === kind && p.id).map((p) => p.id!)
  const terms = placed.filter((p) => p.term)
  const rows = await suggestionsFor({
    targetIds: ids('target'), campaignIds: ids('campaign'), termCampaignExts: terms.map((t) => t.term!.ext),
    seenSince: span.gte, createdBy: span.lte, take: MAX_WRITES,
  })
  for (const r of rows) {
    const keysHit = r.entityType === 'AD_TARGET' ? [`target:${r.entityId}`]
      : r.entityType === 'CAMPAIGN' ? [`campaign:${r.entityId}`]
        : terms.filter((t) => r.entityId.startsWith(`${t.term!.ext}:`) && normaliseTerm(r.entityId.slice(t.term!.ext.length + 1)) === normaliseTerm(t.term!.query)).map((t) => t.key)
    for (const key of keysHit) out.set(key, [...(out.get(key) ?? []), r])
  }
  return out
}

// ── The e-mail's summary ───────────────────────────────────────────────────────────────────────────

/**
 * Whether watch mode is on in this business now: an ad change kind is at watch, or an ad change (or a change plan) Claude
 * asked for in the last 24 hours was watched (the ads strategy may hold a kind at watch where it lands while its tool is
 * at auto).
 */
export async function watchModeOn(now = new Date()): Promise<boolean> {
  if ((await adToolLevels()).watch.length) return true
  const recent = await prisma.agentApproval.count({
    where: {
      requestedAt: { gte: new Date(now.getTime() - DAY_MS) },
      ruleVerdict: { not: Prisma.DbNull },
      agentRun: { via: 'claude' },
      toolName: { in: [...adChangeTools(), PLAN_TOOL] },
    },
  })
  return recent > 0
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const outcomeCell = (o: Record<WatchOutcome, number>) => {
  const parts = [`${o.better} better`, `${o.worse} worse`, `${o.flat} flat`]
  const open = o.not_yet + o.no_sales + o.no_spend + o.no_peers + o.no_data
  return `${parts.join(' · ')}${open ? ` · ${open} not comparable yet` : ''}`
}

/** The daily e-mail's short summary of the comparison: the table per kind, counts only (no amounts), and its label. */
export function watchWeekSummary(week: WatchWeek): { html: string; text: string } {
  const head = `Watch week so far (last ${week.window.days} days): ${week.totals.steps} watched ${week.totals.steps === 1 ? 'step' : 'steps'} — ${OBSERVED_LABEL}`
  if (!week.totals.steps) {
    const none = `${head}. ${week.empty ?? 'Nothing was asked at watch.'}`
    return { html: `<p style="margin:16px 0 0;color:#5b6573;font-size:13px">${esc(none)}</p>`, text: none }
  }
  const cell = 'padding:4px 8px;border-bottom:1px solid #e3e7ec;text-align:left;font-size:13px'
  const cols = ['Kind', 'Would run by rule', 'Would wait', 'Agreed with an engine', 'Conflicted with an engine', 'Held by limits', 'Outcome (items)']
  const line = (label: string, r: Omit<WatchTableRow, 'action' | 'tools'>) => [label, r.wouldRun, r.wouldWait, r.agreedWithEngine, r.conflictedWithEngine, r.heldByLimits, outcomeCell(r.outcome)]
  const rows = [...week.table.map((r) => line(r.action, r)), line('All', week.totals)]
  const scoped = week.totals.withoutRunByRule
  const scopeNote = scoped ? ` ${scoped === 1 ? 'One step was' : `${scoped} steps were`} asked on a connection without "run by rule": judged as if it had it.` : ''
  const html = `<h3 style="margin:20px 0 4px;font-size:14px">${esc(head)}</h3>
  <table style="border-collapse:collapse;margin:4px 0 0">
    <tr>${cols.map((c) => `<th style="${cell};color:#5b6573;font-weight:600">${esc(c)}</th>`).join('')}</tr>
    ${rows.map((r) => `<tr>${r.map((v) => `<td style="${cell}">${esc(String(v))}</td>`).join('')}</tr>`).join('')}
  </table>
  <p style="margin:6px 0 0;color:#8a93a1;font-size:12px">A watched change never ran: the outcome is how each entity went without it, next to comparable entities nothing changed. Agreed and conflicted count only an engine that moved the same lever.${esc(scopeNote)} ads-manager-runs has every step.</p>`
  const text = [
    head,
    ...rows.map((r) => `  ${r[0]}: would run ${r[1]}, would wait ${r[2]}, agreed with an engine ${r[3]}, conflicted ${r[4]}, held by limits ${r[5]}; outcome ${r[6]}`),
    ...(scopeNote ? [scopeNote.trim()] : []),
  ].join('\n')
  return { html, text }
}
