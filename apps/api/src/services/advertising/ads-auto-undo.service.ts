/**
 * ADS AUTONOMY — auto-undo (automation A19): every AUTOMATIC Amazon ad change is checked once it has its settled days
 * after it, against what then happened, and when it made things clearly worse Nexus puts it back — inside its limits,
 * logged, visible. The safety that lets the ads run with no person in the loop.
 *
 *   which changes   AdvertisingActionLog rows that reached Amazon in the last `lookbackDays`, each a bid (a target's or
 *                   an ad group's default), a campaign's daily budget or its placements, written by
 *                     · an engine that decides by itself: auto-bid, the hourly bid plans (rank-defend), autopilot,
 *                       top-of-search defense, the coverage engine, budget pools (JUDGED_ENGINES)
 *                     · an Amazon ads rule at AUTO: its actor `automation:<ruleId>` AND a live (not dry-run) run of that
 *                       rule at that moment (AutomationRuleExecution) — a rule's suggestion a person applied writes as the
 *                       rule too, but no live run covers it: that is a person's decision, left alone
 *                     · a Claude request the business's rule ran: its change set is the request (`executionId`), whose
 *                       decision came from the rule (`AgentApproval.decisionVia = 'auto'`)
 *                   Never: a person's own change (`user:` with no request), a request a person approved (decisionVia
 *                   nexus, nexus-step-up or claude-confirm), a brake (budget enforcement), a person's time windows (classic
 *                   dayparting, budget schedules), a retry of another change, a status change (pause, enable, archive), a
 *                   create, a stop (a bid lowered to the floor, the no-pause floor's memory, a forced suppression or its
 *                   restore), auto-undo's own put-backs.
 *   when            only once `settledDaysAfter` days after the change's day are settled (each ended `settleHours` ago:
 *                   Amazon restates a day for 72 h), and again until its longest window is settled.
 *   superseded      a later write on the same entity (any writer), or a value that moved since: never undone — said so.
 *   judged          by the watch-week measurement (ads-watch-week.service.ts: placeEntities, figuresOf, windowsOf,
 *                   outcomeOf — one definition of better and worse): the entity's ACoS move against comparable entities
 *                   nothing wrote to. Clearly worse (ads-auto-undo-thresholds.ts, per market, conservative):
 *                     · ACoS: the shared outcome is `worse`, its ACoS rose by more than `acosPointsUp` points, and its
 *                       sales did not rise; or
 *                     · a RAISE that bought nothing: its spend rose by more than `spendUpPct` % and it sold nothing after.
 *                   Too little data after the change (`minClicks`, `minSpendCents`) is never worse.
 *   asymmetry       undoing a raise is a cut: always allowed. Undoing a CUT is a raise: only when the cut made things worse
 *                   by its ACoS (never "no sales": a raise cannot buy sales back) and inside the raise limits — `maxRaisePct`
 *                   and, for a bid, the ads strategy's largest change and highest bid; for a budget, the campaign's bound.
 *   caps            at most `maxUndosPerDay` undos (would undo, asked or done) per market per UTC day.
 *   levels          the engine switch `auto-undo` (engine-switch.service.ts), born OBSERVE, under the env (A19's env) and
 *                   the account dial (halted or OFF: OBSERVE at most; SUGGEST: PROPOSE at most):
 *                     OBSERVE  records each judgement and what it would undo; changes nothing
 *                     PROPOSE  asks a person: an undo-worse-ad-change request in the Approvals page
 *                     AUTO     undoes it itself (rollback.service.ts reverseJudgedWrite: the Undo's own path, its audit, the
 *                              5-minute window to cancel); a placement goes out at once with no such window, so at AUTO it is
 *                              held for a person
 *   record          one AdsAutoUndoJudgement per change judged (the numbers it stands on, the verdict, what was done and
 *                   why); superseded and waiting changes are counted in the run's summary, and a stored one is closed.
 *
 * In the business the call runs in (row-level security). `dryRun` (preview-automation) computes the same and writes
 * nothing: no judgement, no request, no undo.
 */
import { Prisma } from '@nexus/database'
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { normalizeMarketplaceCode } from '../../utils/marketplace-code.js'
import { LEVELS, lowest, type AutomationLevel } from '../automation/automation-levels.js'
import type { WatchOutcome, WatchWindow } from '../agents/ads-watch-week.service.js'
import { autoUndoThresholds, AUTO_UNDO_BY_MARKET, AUTO_UNDO_DEFAULTS, type AutoUndoThresholds } from './ads-auto-undo-thresholds.js'
import { classifyActor, engineLabel, NON_CHANGE_ACTION_TYPES, type EngineKey } from './ads-engine-actors.js'

// The watch-week measurement and the approval gate load where used: their module graphs are wide (load order).
const watchWeek = () => import('../agents/ads-watch-week.service.js')

/** The actor auto-undo writes as: never judged itself. */
export const AUTO_UNDO_ACTOR = 'automation:auto-undo' as const
/** The CronRun job (and the cron registry's Run now). */
export const AUTO_UNDO_JOB = 'ads-auto-undo'
/** The request a person decides at PROPOSE (ads-auto-undo.tools.ts). */
export const AUTO_UNDO_TOOL = 'undo-worse-ad-change'
/** The newest candidate writes read in one run. */
export const MAX_CANDIDATES = 2_000
/** The judgements a run's answer lists (the counts cover every one). */
export const SHOWN = 50
/** A bid lowered to this or below is a stop (the floor), never undone. */
export const STOP_BID_CENTS = 5

/** The engines whose changes are their own decisions: judged. */
export const JUDGED_ENGINES: ReadonlySet<EngineKey> = new Set<EngineKey>(['auto-bid', 'rank-defend', 'autopilot', 'tos-defense', 'coverage-engine', 'budget-pools'])

export type LeftAlone = 'person' | 'person-approved' | 'brake' | 'schedule' | 'retry' | 'own' | 'unknown' | 'not-a-lever' | 'stop'
export const LEFT_ALONE_WORDS: Record<LeftAlone, string> = {
  person: "a person's own change",
  'person-approved': 'a change a person approved (their decision)',
  brake: 'a brake (budget enforcement holds over-spend down)',
  schedule: "a person's time windows (classic dayparting, budget schedules)",
  retry: 'a retry of another change, not a decision of its own',
  own: "auto-undo's own put-back",
  unknown: 'no engine, rule or request Nexus knows wrote it',
  'not-a-lever': 'not a bid, budget or placement move auto-undo judges (a status change, a create, an archive)',
  stop: 'a stop or a suppression (a bid to the floor, the no-pause floor, its restore): never auto-undone',
}
const ENGINES_LEFT_ALONE: Partial<Record<EngineKey, LeftAlone>> = {
  'budget-enforce': 'brake', dayparting: 'schedule', 'budget-schedules': 'schedule', 'write-reconcile': 'retry',
}

export type ChangeOrigin = 'engine' | 'rule' | 'claude-rule'
export type JudgeVerdict = 'not_enough_data' | 'not_worse' | 'worse' | 'superseded'
export type UndoAction = 'none' | 'would_undo' | 'proposed' | 'undone' | 'held'
export const VERDICT_WORDS: Record<JudgeVerdict, string> = {
  not_enough_data: 'too little data after it to judge (never "worse")',
  not_worse: 'not clearly worse',
  worse: 'clearly worse',
  superseded: 'superseded by a later change on the same entity: never undone',
}
export const ACTION_WORDS: Record<UndoAction, string> = {
  none: 'nothing to do',
  would_undo: 'would undo it (OBSERVE: nothing changed)',
  proposed: 'asked a person to undo it (Approvals page)',
  undone: 'undone',
  held: 'not undone (see why)',
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const num = (v: unknown): number | null => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null)
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const day = (at: Date | string) => new Date(at).toISOString().slice(0, 10)
const addDays = (d: string, n: number) => day(new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS))
const rank = (level: AutomationLevel) => LEVELS.indexOf(level)
const marketOf = (m: string | null | undefined) => {
  const code = normalizeMarketplaceCode(m, '')
  return code ? code.toUpperCase() : null
}

// ── Pure: the lever a write moved ───────────────────────────────────────────────────────────────────

export interface LeverChange {
  /** bid | dailyBudget | placement:<code> */
  lever: string
  direction: 'raise' | 'cut'
  /** The value before and after: cents for a bid or a budget, percent for a placement. */
  from: number
  to: number
}

const placementsOf = (v: unknown): Map<string, number> | null => {
  if (!Array.isArray(v)) return null
  return new Map(v.map((a) => [String(obj(a).placement ?? ''), num(obj(a).percentage) ?? 0] as const).filter(([k]) => !!k))
}

/** Pure — the lever one logged write moved, which way and from what to what; or why auto-undo does not judge it. */
export function leverChangeOf(row: { entityType: string; actionType: string; payloadBefore: unknown; payloadAfter: unknown }): LeverChange | { excluded: Extract<LeftAlone, 'not-a-lever' | 'stop'>; why: string } {
  const before = obj(row.payloadBefore)
  const after = obj(row.payloadAfter)
  if (/^(bulksheet_)?create_/.test(row.actionType)) return { excluded: 'not-a-lever', why: 'a create has nothing before it to put back' }
  if (typeof before.status === 'string' && typeof after.status === 'string' && before.status !== after.status) {
    return { excluded: 'not-a-lever', why: 'a status change (pause, enable or archive) is never auto-undone' }
  }
  if ('suppressedFromBidCents' in before || 'suppressedFromBidCents' in after) {
    return { excluded: 'stop', why: "the no-pause floor's memory moved: a stop or its restore" }
  }
  if (row.actionType === 'update_placement_bidding') {
    const b = placementsOf(before.adjustments)
    const a = placementsOf(after.adjustments)
    if (!b || !a) return { excluded: 'not-a-lever', why: 'no record of the placements before it' }
    const moved = [...new Set([...a.keys(), ...b.keys()])].map((code) => ({ code, from: b.get(code) ?? 0, to: a.get(code) ?? 0 })).filter((m) => m.from !== m.to)
    if (!moved.length) return { excluded: 'not-a-lever', why: 'it moved no placement' }
    if (moved.some((m) => m.to > m.from) && moved.some((m) => m.to < m.from)) return { excluded: 'not-a-lever', why: 'it moved placements both ways at once' }
    const largest = [...moved].sort((x, y) => Math.abs(y.to - y.from) - Math.abs(x.to - x.from) || x.code.localeCompare(y.code))[0]
    return { lever: `placement:${largest.code}`, direction: largest.to > largest.from ? 'raise' : 'cut', from: largest.from, to: largest.to }
  }
  const bid = (key: string): LeverChange | null => {
    const from = num(before[key])
    const to = num(after[key])
    return from != null && to != null && from !== to ? { lever: 'bid', direction: to > from ? 'raise' : 'cut', from, to } : null
  }
  let change: LeverChange | null = null
  if (row.entityType === 'AD_TARGET') change = bid('bidCents')
  else if (row.entityType === 'AD_GROUP') change = bid('defaultBidCents')
  else if (row.entityType === 'CAMPAIGN') {
    const from = num(before.dailyBudget)
    const to = num(after.dailyBudget)
    if (from != null && to != null && from !== to) change = { lever: 'dailyBudget', direction: to > from ? 'raise' : 'cut', from: Math.round(from * 100), to: Math.round(to * 100) }
  }
  if (!change) return { excluded: 'not-a-lever', why: 'it moved no bid, budget or placement' }
  if (change.lever === 'bid' && change.direction === 'cut' && change.to <= STOP_BID_CENTS) {
    return { excluded: 'stop', why: `a bid lowered to the floor (${change.to}¢) is a stop: never auto-undone` }
  }
  return change
}

// ── Pure: who made it ───────────────────────────────────────────────────────────────────────────────

export interface OriginFacts {
  /** The requests change sets name, with who decided each (AgentApproval.decisionVia). */
  approvals: ReadonlyMap<string, { decisionVia: string | null }>
  /** The Amazon ads rules of this business, id → name. */
  rules: ReadonlyMap<string, string>
  /** Did a live (not dry-run) run of this rule write at this moment? */
  ruleRanLive: (ruleId: string, at: Date) => boolean
}

export type Origin = { origin: ChangeOrigin; label: string; approvalId: string | null } | { leftAlone: LeftAlone; why: string }

/**
 * Pure — who made a write, and whether auto-undo may judge it. How a Claude change that ran by rule is told from one a
 * person approved: its change set (`executionId`) is the request, and the request's decision says who took it —
 * `decisionVia = 'auto'` is the business's rule; nexus / nexus-step-up / claude-confirm is a person.
 */
export function originOf(row: { userId: string | null; executionId: string | null; createdAt: Date; queuedForce?: boolean }, facts: OriginFacts): Origin {
  if (row.userId === AUTO_UNDO_ACTOR) return { leftAlone: 'own', why: LEFT_ALONE_WORDS.own }
  const request = row.executionId ? facts.approvals.get(row.executionId) : undefined
  if (request) {
    if (request.decisionVia === 'auto') return { origin: 'claude-rule', label: 'a Claude request the business\'s rule ran', approvalId: row.executionId }
    return { leftAlone: 'person-approved', why: `request ${row.executionId} was approved by a person: that is their decision` }
  }
  if (row.queuedForce) return { leftAlone: 'stop', why: 'a forced write (a suppression, a stop or its restore): never auto-undone' }
  const actor = classifyActor(row.userId)
  if (actor.kind === 'engine') {
    if (JUDGED_ENGINES.has(actor.engine)) return { origin: 'engine', label: engineLabel(actor.engine), approvalId: null }
    const kind = ENGINES_LEFT_ALONE[actor.engine] ?? 'unknown'
    return { leftAlone: kind, why: `${engineLabel(actor.engine)}: ${LEFT_ALONE_WORDS[kind]}` }
  }
  if (actor.kind === 'person') return { leftAlone: 'person', why: LEFT_ALONE_WORDS.person }
  if (actor.kind === 'rule-candidate') {
    const name = facts.rules.get(actor.ruleId)
    if (!name) return { leftAlone: 'unknown', why: LEFT_ALONE_WORDS.unknown }
    if (!facts.ruleRanLive(actor.ruleId, row.createdAt)) {
      return { leftAlone: 'person-approved', why: `rule "${name}" proposed it and a person applied it (no run of the rule at AUTO wrote it)` }
    }
    return { origin: 'rule', label: `rule "${name}"`, approvalId: null }
  }
  return { leftAlone: 'unknown', why: LEFT_ALONE_WORDS.unknown }
}

// ── Pure: settled days and the verdict ──────────────────────────────────────────────────────────────

/** The newest settled day (UTC): every day up to it ended at least `settleHours` ago. */
export function settledThroughOf(now: Date, settleHours: number): string {
  return addDays(day(new Date(now.getTime() - settleHours * HOUR_MS)), -1)
}

/** Pure — the windows with `complete` meaning "every day after is in Nexus AND settled". */
export function settledWindows(windows: readonly WatchWindow[], settledThrough: string): WatchWindow[] {
  return windows.map((w) => ({ ...w, complete: w.complete && w.after.to <= settledThrough }))
}

export interface Judged {
  verdict: Exclude<JudgeVerdict, 'superseded'>
  outcome: WatchOutcome
  /** Which kind of "clearly worse": its ACoS, or a raise that bought nothing. */
  case: 'acos' | 'no_sales' | null
  /** The window the verdict read (the longest settled one). */
  window: WatchWindow | null
  why: string
}

const pts = (fraction: number) => Math.round(fraction * 1000) / 10

/**
 * Pure — the verdict on one change from its settled windows: the shared outcome first (outcomeOf), then clearly worse
 * by the market's thresholds, never on too little data. Null while no window is settled yet (it waits).
 */
export function judgeChange(direction: 'raise' | 'cut', windows: readonly WatchWindow[], outcome: WatchOutcome, t: AutoUndoThresholds): Judged | null {
  const w = [...windows].sort((a, b) => b.days - a.days).find((x) => x.complete) ?? null
  if (!w || outcome === 'not_yet') return null
  const e = w.entity
  if (!e || e.after.clicks < t.minClicks || e.after.spendCents < t.minSpendCents) {
    const had = e ? `${e.after.clicks} clicks and ${e.after.spendCents} of spend (minor units) in the ${w.days} days after` : 'no figures after it'
    return { verdict: 'not_enough_data', outcome, case: null, window: w, why: `too little data to judge: ${had}; it needs ${t.minClicks} clicks and ${t.minSpendCents}` }
  }
  if (outcome === 'worse' && e.before.acos != null && e.after.acos != null) {
    const up = pts(e.after.acos - e.before.acos)
    if (up > t.acosPointsUp && e.after.salesCents <= e.before.salesCents) {
      return { verdict: 'worse', outcome, case: 'acos', window: w, why: `its ACoS rose ${up} points (more than ${t.acosPointsUp}) and worse than comparable entities', and its sales did not rise` }
    }
    return { verdict: 'not_worse', outcome, case: null, window: w, why: up <= t.acosPointsUp ? `its ACoS moved worse than comparable entities' but only ${up} points (the bar is ${t.acosPointsUp})` : 'its ACoS rose, but so did its sales' }
  }
  if (direction === 'raise' && e.after.salesCents === 0 && e.after.spendCents > e.before.spendCents * (1 + t.spendUpPct / 100)) {
    return { verdict: 'worse', outcome, case: 'no_sales', window: w, why: `after the raise its spend rose by more than ${t.spendUpPct} % and it sold nothing in the ${w.days} days after` }
  }
  return { verdict: 'not_worse', outcome, case: null, window: w, why: `not clearly worse (outcome ${outcome})` }
}

// ── Pure: what may be done ──────────────────────────────────────────────────────────────────────────

/** The limits a put-back that RAISES must stay inside (the undo of a cut). */
export interface RaiseLimits {
  /** The ads strategy's largest change per action, percent (bids). */
  maxChangePct: number | null
  /** The ads strategy's highest bid, cents (bids). */
  maxBidCents: number | null
  /** The campaign's own budget bound, cents (budgets). */
  maxBudgetCents: number | null
}

/**
 * Pure — undoing a cut raises: only inside `maxRaisePct` and, for a bid, the strategy's largest change and highest bid,
 * for a budget, the campaign's bound. Null when the raise is allowed (or the undo is a cut, always allowed).
 */
export function raiseRefusal(change: LeverChange, t: AutoUndoThresholds, limits: RaiseLimits): string | null {
  if (change.direction !== 'cut') return null
  // The undo puts `from` back over `to`: a raise.
  const placement = change.lever.startsWith('placement:')
  const up = placement ? change.from - change.to : change.to > 0 ? ((change.from - change.to) / change.to) * 100 : Infinity
  const unit = placement ? ' points' : ' %'
  const cap = placement ? t.maxRaisePct : Math.min(t.maxRaisePct, limits.maxChangePct ?? Infinity)
  if (up > cap) {
    const by = !placement && limits.maxChangePct != null && limits.maxChangePct < t.maxRaisePct ? "the ads strategy's largest change" : "auto-undo's largest raise"
    return `undoing this cut raises it by ${Math.round(up)}${unit}, more than ${cap}${unit} (${by}): a person decides`
  }
  if (change.lever === 'bid' && limits.maxBidCents != null && change.from > limits.maxBidCents) return `undoing this cut puts the bid above the ads strategy's highest bid (${limits.maxBidCents}): a person decides`
  if (change.lever === 'dailyBudget' && limits.maxBudgetCents != null && change.from > limits.maxBudgetCents) return "undoing this cut puts the budget above the campaign's own bound: a person decides"
  return null
}

/** Pure — what auto-undo does with one judgement at its level, inside its cap and the raise limits. */
export function decideAction(input: { verdict: JudgeVerdict; change: LeverChange; level: AutomationLevel; capLeft: number; cap: number; market: string | null; raise: string | null; case: Judged['case'] }): { action: UndoAction; reason: string } {
  if (input.verdict !== 'worse') return { action: 'none', reason: VERDICT_WORDS[input.verdict] }
  // Undoing a cut is a raise: only when the cut made its ACoS worse — a raise cannot buy back sales that never came.
  if (input.change.direction === 'cut' && input.case !== 'acos') return { action: 'held', reason: 'undoing this cut would raise it, and a raise is put back only when the cut made its ACoS worse: a person decides' }
  if (input.raise) return { action: 'held', reason: input.raise }
  if (input.capLeft <= 0) return { action: 'held', reason: `past the daily cap of ${input.cap} undos in ${input.market ?? 'this market'}: tomorrow's run looks again` }
  if (input.level === 'OBSERVE') return { action: 'would_undo', reason: 'OBSERVE: it would undo this; nothing was changed' }
  if (input.level === 'PROPOSE') return { action: 'proposed', reason: 'PROPOSE: a person decides the undo in the Approvals page' }
  if (input.level === 'AUTO') {
    if (input.change.lever.startsWith('placement:')) return { action: 'held', reason: 'a placement put-back goes to Amazon at once, with no 5-minute window to cancel it: at AUTO it is held; at PROPOSE a person decides it' }
    return { action: 'undone', reason: 'AUTO: put back by auto-undo, inside its caps' }
  }
  return { action: 'none', reason: 'auto-undo is off' }
}

// ── The level ───────────────────────────────────────────────────────────────────────────────────────

/** What auto-undo may do in this business now: the env, this business's switch (born OBSERVE) and the account dial. */
export async function autoUndoLevel(): Promise<{ level: AutomationLevel; why: string }> {
  const { engineEnv, engineMode } = await import('../automation/engine-switch.service.js')
  const env = await engineEnv('auto-undo')
  const gate = await engineMode('auto-undo', env.ceiling)
  let level = gate.mode
  let why = gate.note ?? (rank(env.ceiling) <= rank(level) && env.reason ? env.reason : `this business set it to ${level}`)
  const dial = await prisma.adsAutomationState.findUnique({ where: { id: 'singleton' }, select: { autonomy: true, halted: true } })
  if ((dial?.halted || dial?.autonomy === 'OFF') && rank(level) > rank('OBSERVE')) {
    level = 'OBSERVE'
    why = `${dial?.halted ? 'ads automation is halted' : 'the account ads dial is OFF'}: it only records`
  } else if ((dial?.autonomy ?? 'SUGGEST') === 'SUGGEST' && rank(level) > rank('PROPOSE')) {
    level = 'PROPOSE'
    why = `the account ads dial is SUGGEST${dial ? '' : ' (never set)'}: it asks a person`
  }
  return { level, why }
}

// ── The run ─────────────────────────────────────────────────────────────────────────────────────────

export interface AutoUndoItem {
  judgementId: string | null
  actionLogId: string
  at: string
  origin: ChangeOrigin
  by: string
  approvalId: string | null
  entity: { type: string; id: string; label: string; market: string | null }
  lever: string
  direction: 'raise' | 'cut'
  /** The lever's value before and after the change (cents; percent for a placement). Ad money. */
  fromValue: number
  toValue: number
  verdict: JudgeVerdict
  outcome: WatchOutcome | null
  action: UndoAction
  reason: string
  undoApprovalId: string | null
  undoActionLogId: string | null
}

export interface AutoUndoRun {
  level: AutomationLevel
  levelWhy: string
  dryRun: boolean
  /** The newest settled day, and the window of changes read. */
  settledThrough: string
  window: { from: string; until: string }
  counts: {
    read: number
    leftAlone: number
    superseded: number
    waiting: number
    judged: number
    notEnoughData: number
    notWorse: number
    worse: number
    wouldUndo: number
    proposed: number
    undone: number
    held: number
  }
  leftAlone: Partial<Record<LeftAlone, number>>
  /** The judgements of this run, the clearly worse first (SHOWN). */
  items: AutoUndoItem[]
  notes: string[]
}

interface Candidate {
  id: string
  entityType: string
  entityId: string
  actionType: string
  userId: string | null
  executionId: string | null
  outboundQueueId: string | null
  payloadBefore: unknown
  payloadAfter: unknown
  createdAt: Date
}

const entityKey = (entityType: string, id: string) => (entityType === 'AD_TARGET' ? `target:${id}` : entityType === 'AD_GROUP' ? `adGroup:${id}` : `campaign:${id}`)

/** The widest bounds any market's thresholds need (the per-market ones are applied to each change). */
function widest(): { lookbackDays: number; settleHours: number; settledDaysAfter: number } {
  const all = [AUTO_UNDO_DEFAULTS, ...Object.keys(AUTO_UNDO_BY_MARKET).map((m) => autoUndoThresholds(m))]
  return {
    lookbackDays: Math.max(...all.map((t) => t.lookbackDays)),
    settleHours: Math.min(...all.map((t) => t.settleHours)),
    settledDaysAfter: Math.min(...all.map((t) => t.settledDaysAfter)),
  }
}

/** The facts originOf needs for these writes, in a few queries. */
async function originFacts(rows: Candidate[]): Promise<OriginFacts & { forced: Set<string> }> {
  const executionIds = [...new Set(rows.map((r) => r.executionId).filter((x): x is string => !!x))]
  const ruleIds = [...new Set(rows.map((r) => classifyActor(r.userId)).filter((c) => c.kind === 'rule-candidate').map((c) => (c as { ruleId: string }).ruleId))]
  const queued = [...new Set(rows.map((r) => r.outboundQueueId).filter((x): x is string => !!x))]
  const from = rows.length ? new Date(Math.min(...rows.map((r) => r.createdAt.getTime())) - DAY_MS) : new Date()
  const [approvals, rules, runs, queue] = await Promise.all([
    executionIds.length ? prisma.agentApproval.findMany({ where: { id: { in: executionIds } }, select: { id: true, decisionVia: true } }) : [],
    ruleIds.length ? prisma.automationRule.findMany({ where: { id: { in: ruleIds }, domain: 'advertising' }, select: { id: true, name: true } }) : [],
    ruleIds.length ? prisma.automationRuleExecution.findMany({ where: { ruleId: { in: ruleIds }, dryRun: false, startedAt: { gte: from } }, select: { ruleId: true, startedAt: true, finishedAt: true, durationMs: true } }) : [],
    queued.length ? prisma.outboundSyncQueue.findMany({ where: { id: { in: queued } }, select: { id: true, payload: true } }) : [],
  ])
  const byRule = new Map<string, Array<{ from: number; to: number }>>()
  for (const r of runs) {
    // A run's row is written when it ends (startedAt is its end): it covers from its start, a minute either way.
    const end = (r.finishedAt ?? r.startedAt).getTime()
    const start = r.startedAt.getTime() - (r.durationMs ?? 0)
    byRule.set(r.ruleId, [...(byRule.get(r.ruleId) ?? []), { from: Math.min(start, end) - 60_000, to: end + 60_000 }])
  }
  return {
    approvals: new Map<string, { decisionVia: string | null }>((approvals as Array<{ id: string; decisionVia: string | null }>).map((a) => [a.id, { decisionVia: a.decisionVia }])),
    rules: new Map<string, string>((rules as Array<{ id: string; name: string }>).map((r) => [r.id, r.name])),
    ruleRanLive: (ruleId, at) => (byRule.get(ruleId) ?? []).some((w) => at.getTime() >= w.from && at.getTime() <= w.to),
    forced: new Set(queue.filter((q) => obj(q.payload).force === true || obj(q.payload).stop === true).map((q) => q.id)),
  }
}

/** The newest write per entity in the span (any writer that did not fail), to tell a superseded change. */
async function newestWrites(rows: Candidate[], since: Date): Promise<Map<string, number>> {
  const byType = new Map<string, string[]>()
  for (const r of rows) byType.set(r.entityType, [...(byType.get(r.entityType) ?? []), r.entityId])
  if (!byType.size) return new Map()
  const grouped = await prisma.advertisingActionLog.groupBy({
    by: ['entityType', 'entityId'],
    where: {
      createdAt: { gte: since },
      actionType: { notIn: [...NON_CHANGE_ACTION_TYPES] },
      AND: [
        { OR: [...byType].map(([entityType, ids]) => ({ entityType, entityId: { in: [...new Set(ids)] } })) },
        { OR: [{ amazonResponseStatus: null }, { amazonResponseStatus: { not: 'FAILED' } }] },
      ],
    },
    _max: { createdAt: true },
  })
  return new Map(grouped.map((g) => [`${g.entityType}:${g.entityId}`, g._max.createdAt?.getTime() ?? 0]))
}

/** What the entities hold now, the label of each, and the raise limits that bind an undo of a cut. */
async function entitiesNow(rows: Array<{ entityType: string; entityId: string }>) {
  const ids = (type: string) => [...new Set(rows.filter((r) => r.entityType === type).map((r) => r.entityId))]
  const camp = { select: { id: true, name: true, marketplace: true } } as const
  const [targets, groups, campaigns] = await Promise.all([
    ids('AD_TARGET').length ? prisma.adTarget.findMany({ where: { id: { in: ids('AD_TARGET') } }, select: { id: true, bidCents: true, expressionValue: true, adGroupId: true, adGroup: { select: { campaign: camp } } } }) : [],
    ids('AD_GROUP').length ? prisma.adGroup.findMany({ where: { id: { in: ids('AD_GROUP') } }, select: { id: true, name: true, defaultBidCents: true, campaign: camp } }) : [],
    ids('CAMPAIGN').length ? prisma.campaign.findMany({ where: { id: { in: ids('CAMPAIGN') } }, select: { id: true, name: true, marketplace: true, dailyBudget: true, dynamicBidding: true, maxBudgetCents: true } }) : [],
  ])
  const out = new Map<string, { label: string; market: string | null; campaignId: string | null; adGroupId: string | null; value: (lever: string) => number | null; maxBudgetCents: number | null }>()
  for (const t of targets) {
    out.set(`AD_TARGET:${t.id}`, { label: `"${t.expressionValue}" in ${t.adGroup?.campaign?.name ?? 'its campaign'}`, market: t.adGroup?.campaign?.marketplace ?? null, campaignId: t.adGroup?.campaign?.id ?? null, adGroupId: t.adGroupId, value: (l) => (l === 'bid' ? t.bidCents : null), maxBudgetCents: null })
  }
  for (const g of groups) {
    out.set(`AD_GROUP:${g.id}`, { label: `ad group "${g.name}" in ${g.campaign?.name ?? 'its campaign'}`, market: g.campaign?.marketplace ?? null, campaignId: g.campaign?.id ?? null, adGroupId: g.id, value: (l) => (l === 'bid' ? g.defaultBidCents : null), maxBudgetCents: null })
  }
  for (const c of campaigns) {
    const placements = placementsOf(obj(c.dynamicBidding).placementBidding) ?? new Map<string, number>()
    out.set(`CAMPAIGN:${c.id}`, {
      label: `campaign "${c.name}"`, market: c.marketplace ?? null, campaignId: c.id, adGroupId: null, maxBudgetCents: c.maxBudgetCents ?? null,
      value: (l) => (l === 'dailyBudget' ? Math.round(Number(c.dailyBudget) * 100) : l.startsWith('placement:') ? placements.get(l.slice('placement:'.length)) ?? 0 : null),
    })
  }
  return out
}

/** The raise limits of one bid's ad group (the ads strategy's largest change and highest bid). */
async function strategyLimits(market: string | null, adGroupId: string | null, campaignId: string | null): Promise<Pick<RaiseLimits, 'maxChangePct' | 'maxBidCents'>> {
  const { bidLimitsFor } = await import('./ads-strategy/bids.js')
  const l = await bidLimitsFor({ marketplace: market, adGroupId, campaignId })
  return { maxChangePct: l.maxChangePct?.value ?? null, maxBidCents: l.maxBidCents?.value ?? null }
}

/** Undos already taken today (UTC) per market: would undo, asked or done. */
async function undosToday(now: Date): Promise<Map<string, number>> {
  const start = new Date(`${day(now)}T00:00:00Z`)
  const rows = await prisma.adsAutoUndoJudgement.groupBy({ by: ['marketplace'], where: { action: { in: ['would_undo', 'proposed', 'undone'] }, actionAt: { gte: start } }, _count: { _all: true } })
  return new Map(rows.map((r) => [r.marketplace ?? '?', r._count._all]))
}

/** A request to undo this judgement still waiting for a person (or about to run), other than `except`; null when none. */
async function waitingRequestFor(judgementId: string, except?: string | null): Promise<{ id: string; status: string } | null> {
  return prisma.agentApproval.findFirst({
    where: { toolName: AUTO_UNDO_TOOL, status: { in: ['pending', 'scheduled', 'executing'] }, args: { path: ['judgementId'], equals: judgementId }, ...(except ? { id: { not: except } } : {}) },
    orderBy: { requestedAt: 'desc' },
    select: { id: true, status: true },
  })
}

/** PROPOSE: the undo as a request a person decides (undo-worse-ad-change), through the normal approval gate. */
async function proposeUndo(judgementId: string, why: string): Promise<{ approvalId: string } | { error: string }> {
  // One request per judgement: one already waiting (Claude may have asked for it) is the request.
  const waiting = await waitingRequestFor(judgementId)
  if (waiting) return { approvalId: waiting.id }
  const { runOrQueueTool } = await import('../agents/approval-gate.service.js')
  const { systemPrincipal } = await import('../agents/call-tool.js')
  const args = { judgementId, why }
  const run = await prisma.agentRun.create({ data: { agentKey: 'ads-auto-undo', trigger: 'schedule', status: 'running', input: { tool: AUTO_UNDO_TOOL, args } as Prisma.InputJsonValue } })
  const asked = await runOrQueueTool(AUTO_UNDO_TOOL, args, systemPrincipal('Nexus auto-undo'), run.id, { forceAsk: true })
  const queued = asked.mode === 'queued' && !!asked.approvalId
  await prisma.agentRun.update({
    where: { id: run.id },
    data: queued ? { status: 'done', ok: true, endedAt: new Date(), output: { mode: 'queued', approvalId: asked.approvalId ?? null } } : { status: 'failed', ok: false, endedAt: new Date(), errorMessage: asked.error ?? null },
  })
  return queued ? { approvalId: asked.approvalId! } : { error: asked.error ?? 'the request was not queued' }
}

/** AUTO: put the value back through the Undo's own path (reverseJudgedWrite), as auto-undo. */
async function undoNow(actionLogId: string, judgementId: string, why: string) {
  const { reverseJudgedWrite } = await import('./rollback.service.js')
  return reverseJudgedWrite({ actionLogId, actor: AUTO_UNDO_ACTOR, reason: `Auto-undo ${judgementId}: ${why}` })
}

/**
 * One auto-undo run in this business: read the automatic changes due a judgement, judge each, record it, and act at the
 * level (OBSERVE records, PROPOSE asks a person, AUTO undoes) inside the caps. `dryRun` writes nothing at all.
 */
export async function runAutoUndo(opts: { now?: Date; dryRun?: boolean } = {}): Promise<AutoUndoRun> {
  const now = opts.now ?? new Date()
  const dryRun = opts.dryRun === true
  const { level, why: levelWhy } = await autoUndoLevel()
  const bounds = widest()
  const settledThrough = settledThroughOf(now, bounds.settleHours)
  const from = new Date(now.getTime() - bounds.lookbackDays * DAY_MS)
  // A change of day D is due once D + settledDaysAfter is settled: written before the start of the day after that.
  const until = new Date(`${addDays(settledThrough, 1 - bounds.settledDaysAfter)}T00:00:00Z`)
  const counts: AutoUndoRun['counts'] = { read: 0, leftAlone: 0, superseded: 0, waiting: 0, judged: 0, notEnoughData: 0, notWorse: 0, worse: 0, wouldUndo: 0, proposed: 0, undone: 0, held: 0 }
  const leftAlone: Partial<Record<LeftAlone, number>> = {}
  const notes: string[] = []
  const answer = (items: AutoUndoItem[]): AutoUndoRun => ({ level, levelWhy, dryRun, settledThrough, window: { from: from.toISOString(), until: until.toISOString() }, counts, leftAlone, items, notes })
  if (level === 'OFF') {
    notes.push(`Auto-undo is OFF here: ${levelWhy}.`)
    return answer([])
  }
  if (until <= from) return answer([])

  // The automatic writes of the span that reached Amazon: an automation's (engines, rules) or a request's change set.
  const rows: Candidate[] = await prisma.advertisingActionLog.findMany({
    where: {
      createdAt: { gte: from, lt: until },
      entityType: { in: ['AD_TARGET', 'AD_GROUP', 'CAMPAIGN'] },
      amazonResponseStatus: 'SUCCESS',
      rolledBackAt: null,
      actionType: { notIn: [...NON_CHANGE_ACTION_TYPES] },
      OR: [{ userId: { startsWith: 'automation:' } }, { executionId: { not: null } }],
      NOT: [{ userId: AUTO_UNDO_ACTOR }],
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: MAX_CANDIDATES + 1,
    select: { id: true, entityType: true, entityId: true, actionType: true, userId: true, executionId: true, outboundQueueId: true, payloadBefore: true, payloadAfter: true, createdAt: true },
  })
  if (rows.length > MAX_CANDIDATES) notes.push(`Only the newest ${MAX_CANDIDATES} automatic changes of the span were read.`)
  const read = rows.slice(0, MAX_CANDIDATES)
  counts.read = read.length
  const stored = read.length
    ? await prisma.adsAutoUndoJudgement.findMany({ where: { actionLogId: { in: read.map((r) => r.id) } } })
    : []
  const storedOf = new Map(stored.map((s) => [s.actionLogId, s]))
  const open = read.filter((r) => !storedOf.get(r.id)?.final)

  const facts = await originFacts(open)
  const leave = (kind: LeftAlone) => {
    counts.leftAlone++
    leftAlone[kind] = (leftAlone[kind] ?? 0) + 1
  }
  type Due = Candidate & { origin: Exclude<Origin, { leftAlone: LeftAlone }>; change: LeverChange }
  const due: Due[] = []
  for (const r of open) {
    const origin = originOf({ ...r, queuedForce: !!r.outboundQueueId && facts.forced.has(r.outboundQueueId) }, facts)
    if ('leftAlone' in origin) { leave(origin.leftAlone); continue }
    const change = leverChangeOf(r)
    if ('excluded' in change) { leave(change.excluded); continue }
    due.push({ ...r, origin, change })
  }

  // Superseded: a later write on the same entity (newest per entity), or a value that moved since.
  const newest = await newestWrites(due, due.length ? new Date(Math.min(...due.map((d) => d.createdAt.getTime()))) : now)
  const held = await entitiesNow(due)
  const standing: Due[] = []
  const closeSuperseded: Array<{ id: string; why: string }> = []
  for (const d of due) {
    const later = (newest.get(`${d.entityType}:${d.entityId}`) ?? 0) > d.createdAt.getTime()
    const entity = held.get(`${d.entityType}:${d.entityId}`)
    const valueNow = entity?.value(d.change.lever) ?? null
    const moved = valueNow == null || Math.abs(valueNow - d.change.to) > 0.5
    if (later || moved) {
      counts.superseded++
      const s = storedOf.get(d.id)
      if (s) closeSuperseded.push({ id: s.id, why: later ? 'a later change on the same entity superseded it' : 'its value moved since, outside a recorded change' })
      continue
    }
    standing.push(d)
  }

  // The watch-week measurement: the entities placed, their figures and their comparable entities', once.
  const { placeEntities, figuresOf, windowsOf, outcomeOf, OBSERVED_LABEL } = await watchWeek()
  const labels = new Map(standing.map((d) => [entityKey(d.entityType, d.entityId), held.get(`${d.entityType}:${d.entityId}`)?.label ?? d.entityId]))
  const placed = await placeEntities(labels)
  const span = standing.length
    ? { from: addDays(day(new Date(Math.min(...standing.map((d) => d.createdAt.getTime())))), -7), to: addDays(day(new Date(Math.max(...standing.map((d) => d.createdAt.getTime())))), 7) }
    : null
  const figures = span ? await figuresOf([...placed.values()], new Set(placed.keys()), span) : null

  // Today's undos so far (a dry run reads them too: it says what the run would do now, cap included).
  const today = await undosToday(now)
  const items: AutoUndoItem[] = []
  // The oldest first: each market's cap goes to the changes nearest the end of their window.
  for (const d of [...standing].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const key = entityKey(d.entityType, d.entityId)
    const p = placed.get(key)!
    const entity = held.get(`${d.entityType}:${d.entityId}`)
    const market = marketOf(entity?.market ?? p.market)
    const t = autoUndoThresholds(market)
    if (d.createdAt.getTime() < now.getTime() - t.lookbackDays * DAY_MS) continue
    const marketSettled = settledThroughOf(now, t.settleHours)
    if (addDays(day(d.createdAt), t.settledDaysAfter) > marketSettled) { counts.waiting++; continue }
    const { windows: raw, dataAsOf } = windowsOf(p, day(d.createdAt), figures!)
    const windows = settledWindows(raw, marketSettled)
    const outcome = outcomeOf(windows)
    const judged = judgeChange(d.change.direction, windows, outcome, t)
    if (!judged) { counts.waiting++; continue }
    counts.judged++
    if (judged.verdict === 'not_enough_data') counts.notEnoughData++
    else if (judged.verdict === 'not_worse') counts.notWorse++
    else counts.worse++

    const prior = storedOf.get(d.id)
    // Act once: a request asked, or an undo done, stands. Anything else is decided again (a would-undo is taken up once
    // the level is higher; a held one once the cap or the limits let it).
    const acted = !!prior && (prior.action === 'proposed' || prior.action === 'undone')
    let action: UndoAction = (prior?.action as UndoAction | undefined) ?? 'none'
    let reason = prior?.actionReason ?? ''
    let undoApprovalId = prior?.undoApprovalId ?? null
    let undoActionLogId = prior?.undoActionLogId ?? null
    if (!acted) {
      const capKey = market ?? '?'
      const used = today.get(capKey) ?? 0
      // A would-undo still at OBSERVE was counted on the day it was first recorded.
      const counted = prior?.action === 'would_undo' && level === 'OBSERVE'
      const limits: RaiseLimits = d.change.direction === 'cut' && judged.verdict === 'worse'
        ? { ...(d.change.lever === 'bid' ? await strategyLimits(entity?.market ?? null, entity?.adGroupId ?? null, entity?.campaignId ?? null) : { maxChangePct: null, maxBidCents: null }), maxBudgetCents: entity?.maxBudgetCents ?? null }
        : { maxChangePct: null, maxBidCents: null, maxBudgetCents: null }
      const decided = decideAction({ verdict: judged.verdict, change: d.change, level, capLeft: counted ? 1 : t.maxUndosPerDay - used, cap: t.maxUndosPerDay, market, raise: raiseRefusal(d.change, t, limits), case: judged.case })
      action = decided.action
      reason = decided.reason
      if (!counted && (action === 'would_undo' || action === 'proposed' || action === 'undone')) today.set(capKey, used + 1)
    }

    const longest = windows.find((w) => w.days === Math.max(...windows.map((x) => x.days)))
    const evidence = {
      v: 1,
      label: OBSERVED_LABEL,
      dataAsOf,
      settledThrough: marketSettled,
      window: judged.window ? { days: judged.window.days, before: judged.window.before, after: judged.window.after, entity: judged.window.entity, peers: judged.window.peers } : null,
      outcome,
      case: judged.case,
      why: judged.why,
      thresholds: t,
      origin: { kind: d.origin.origin, by: d.origin.label, approvalId: d.origin.approvalId },
    }
    const final = action === 'proposed' || action === 'undone' || !!longest?.complete
    let judgementId = prior?.id ?? null
    if (!dryRun) {
      const data = {
        actor: d.userId ?? 'unknown', origin: d.origin.origin, originLabel: d.origin.label, approvalId: d.origin.approvalId,
        entityType: d.entityType, entityId: d.entityId, entityLabel: labels.get(key) ?? null, marketplace: market,
        lever: d.change.lever, direction: d.change.direction, fromValue: d.change.from, toValue: d.change.to, changedAt: d.createdAt,
        verdict: judged.verdict, outcome, evidence: evidence as unknown as Prisma.InputJsonValue, level, checkedAt: now,
        action, actionReason: reason, ...(action !== (prior?.action ?? 'none') ? { actionAt: now } : {}), final,
      }
      // One row per change: the stored one is updated (row-level security keeps it this business's), else created.
      const row = prior
        ? await prisma.adsAutoUndoJudgement.update({ where: { id: prior.id }, data, select: { id: true } })
        : await prisma.adsAutoUndoJudgement.upsert({ where: { workspace_actionLogId: workspaceKey({ actionLogId: d.id }) }, create: { actionLogId: d.id, ...data }, update: data, select: { id: true } })
      judgementId = row.id
      if (!acted && action === 'proposed') {
        const asked = await proposeUndo(row.id, judged.why)
        if ('approvalId' in asked) undoApprovalId = asked.approvalId
        else { action = 'held'; reason = `the request to undo it could not be queued: ${asked.error}` }
      } else if (!acted && action === 'undone') {
        const done = await undoNow(d.id, row.id, judged.why)
        if ('reason' in done) { action = 'held'; reason = done.reason }
        else undoActionLogId = done.actionLogId
      }
      if (!acted && (undoApprovalId !== (prior?.undoApprovalId ?? null) || undoActionLogId !== (prior?.undoActionLogId ?? null) || action !== data.action)) {
        await prisma.adsAutoUndoJudgement.update({ where: { id: row.id }, data: { action, actionReason: reason, undoApprovalId, undoActionLogId, final: action === 'held' ? !!longest?.complete : final } })
      }
    }
    if (action === 'would_undo') counts.wouldUndo++
    else if (action === 'proposed') counts.proposed++
    else if (action === 'undone') counts.undone++
    else if (action === 'held') counts.held++
    items.push({
      judgementId, actionLogId: d.id, at: d.createdAt.toISOString(), origin: d.origin.origin, by: d.origin.label, approvalId: d.origin.approvalId,
      entity: { type: d.entityType, id: d.entityId, label: labels.get(key) ?? d.entityId, market }, lever: d.change.lever, direction: d.change.direction,
      fromValue: d.change.from, toValue: d.change.to, verdict: judged.verdict, outcome, action, reason, undoApprovalId, undoActionLogId,
    })
  }

  if (!dryRun && closeSuperseded.length) {
    for (const s of closeSuperseded) {
      await prisma.adsAutoUndoJudgement.update({ where: { id: s.id }, data: { verdict: 'superseded', final: true, checkedAt: now, actionReason: s.why } }).catch((error) => {
        logger.warn('[ads-auto-undo] could not close a superseded judgement', { id: s.id, error: String(error).slice(0, 140) })
      })
    }
  }
  if (counts.superseded) notes.push(`${counts.superseded} automatic ${counts.superseded === 1 ? 'change was' : 'changes were'} superseded by a later change on the same entity (or its value moved since): never undone.`)
  const order: Record<UndoAction, number> = { undone: 0, proposed: 1, would_undo: 2, held: 3, none: 4 }
  items.sort((a, b) => order[a.action] - order[b.action] || (a.verdict === 'worse' ? 0 : 1) - (b.verdict === 'worse' ? 0 : 1) || b.at.localeCompare(a.at))
  if (items.length > SHOWN) notes.push(`The first ${SHOWN} of ${items.length} judgements are listed; the counts cover all of them.`)
  return answer(items.slice(0, SHOWN))
}

/** The run's one line (CronRun summary). */
export function autoUndoSummaryLine(run: AutoUndoRun): string {
  const c = run.counts
  if (run.level === 'OFF') return `skipped: ${run.levelWhy}`
  return `level=${run.level} read=${c.read} judged=${c.judged} worse=${c.worse} would_undo=${c.wouldUndo} proposed=${c.proposed} undone=${c.undone} held=${c.held} superseded=${c.superseded} waiting=${c.waiting} not_enough_data=${c.notEnoughData} left_alone=${c.leftAlone}`
}

// ── Reads (automation-detail, automation-activity, the daily report) ───────────────────────────────

const JUDGEMENT_SELECT = {
  id: true, actionLogId: true, actor: true, origin: true, originLabel: true, approvalId: true, entityType: true, entityId: true, entityLabel: true,
  marketplace: true, lever: true, direction: true, fromValue: true, toValue: true, changedAt: true, verdict: true, outcome: true, action: true,
  actionReason: true, actionAt: true, level: true, undoApprovalId: true, undoActionLogId: true, final: true, judgedAt: true, checkedAt: true,
} as const

export type JudgementRow = Prisma.AdsAutoUndoJudgementGetPayload<{ select: typeof JUDGEMENT_SELECT }>

/** One judgement in the words a person reads (no evidence; `judgement` adds it). */
export function judgementOut(j: JudgementRow) {
  return {
    id: j.id, actionLogId: j.actionLogId, changedAt: j.changedAt.toISOString(), by: j.originLabel ?? j.actor, origin: j.origin, approvalId: j.approvalId,
    entity: { type: j.entityType, id: j.entityId, label: j.entityLabel ?? j.entityId, market: j.marketplace }, lever: j.lever, direction: j.direction,
    fromValue: j.fromValue, toValue: j.toValue, verdict: j.verdict, verdictWords: VERDICT_WORDS[j.verdict as JudgeVerdict] ?? j.verdict, outcome: j.outcome,
    action: j.action, actionWords: ACTION_WORDS[j.action as UndoAction] ?? j.action, reason: j.actionReason, actionAt: j.actionAt?.toISOString() ?? null,
    level: j.level, undoApprovalId: j.undoApprovalId, undoActionLogId: j.undoActionLogId, final: j.final, checkedAt: j.checkedAt.toISOString(),
  }
}

/** The newest judgements (the clearly worse and acted on first), for automation-detail's rows. */
export async function recentJudgements(take = 100): Promise<JudgementRow[]> {
  const [acted, rest] = await Promise.all([
    prisma.adsAutoUndoJudgement.findMany({ where: { OR: [{ verdict: 'worse' }, { action: { not: 'none' } }] }, orderBy: [{ checkedAt: 'desc' }, { id: 'desc' }], take, select: JUDGEMENT_SELECT }),
    prisma.adsAutoUndoJudgement.findMany({ where: { verdict: { not: 'worse' }, action: 'none' }, orderBy: [{ checkedAt: 'desc' }, { id: 'desc' }], take, select: JUDGEMENT_SELECT }),
  ])
  return [...acted, ...rest].slice(0, take)
}

/** One judgement in full, its evidence included; null when it is not one of this business. */
export async function judgementDetail(id: string) {
  const j = await prisma.adsAutoUndoJudgement.findUnique({ where: { id }, select: { ...JUDGEMENT_SELECT, evidence: true } })
  return j ? { ...judgementOut(j), evidence: j.evidence } : null
}

export interface JudgementTally { since: string; judged: number; worse: number; wouldUndo: number; proposed: number; undone: number; held: number; superseded: number; notEnoughData: number; notWorse: number }

/** The judgements checked since a moment, counted (automation-activity, the daily report's line). */
export async function judgementTally(since: Date): Promise<JudgementTally> {
  const [verdicts, actions] = await Promise.all([
    prisma.adsAutoUndoJudgement.groupBy({ by: ['verdict'], where: { checkedAt: { gte: since } }, _count: { _all: true } }),
    prisma.adsAutoUndoJudgement.groupBy({ by: ['action'], where: { actionAt: { gte: since } }, _count: { _all: true } }),
  ])
  const v = Object.fromEntries(verdicts.map((g) => [g.verdict, g._count._all]))
  const a = Object.fromEntries(actions.map((g) => [g.action, g._count._all]))
  return {
    since: since.toISOString(),
    judged: verdicts.reduce((n, g) => n + (g.verdict === 'superseded' ? 0 : g._count._all), 0),
    worse: v.worse ?? 0, notWorse: v.not_worse ?? 0, notEnoughData: v.not_enough_data ?? 0, superseded: v.superseded ?? 0,
    wouldUndo: a.would_undo ?? 0, proposed: a.proposed ?? 0, undone: a.undone ?? 0, held: a.held ?? 0,
  }
}

/** The daily report's one line: what auto-undo judged and did in the last day, at its level now. Counts only, no amounts. */
export function autoUndoReportLine(level: AutomationLevel, t: JudgementTally): string {
  const acted = [t.undone ? `${t.undone} undone` : '', t.proposed ? `${t.proposed} asked of a person` : '', t.wouldUndo ? `${t.wouldUndo} it would undo` : '', t.held ? `${t.held} held` : ''].filter(Boolean)
  return `Auto-undo (${level}) in the last 24 hours: ${t.judged} automatic ${t.judged === 1 ? 'change' : 'changes'} judged, ${t.worse} clearly worse${acted.length ? ` — ${acted.join(', ')}` : ''}${t.superseded ? `; ${t.superseded} superseded` : ''}. automation-activity A19 has each one.`
}

/** The business's own state of auto-undo, for the automation catalog: its switch (born OBSERVE) under the dial. */
export async function autoUndoBusinessState(): Promise<{ level: AutomationLevel; reason: string; tally: JudgementTally; caps: Record<string, unknown> }> {
  const { readEngineSwitch } = await import('../automation/engine-switch.service.js')
  const [row, dial, tally] = await Promise.all([
    readEngineSwitch('auto-undo'),
    prisma.adsAutomationState.findUnique({ where: { id: 'singleton' }, select: { autonomy: true, halted: true } }),
    judgementTally(new Date(Date.now() - 7 * DAY_MS)),
  ])
  const set: AutomationLevel = row?.mode ?? 'OBSERVE'
  let level = set
  let reason = row ? `This business set it to ${set} (${row.setBy}).` : 'Born OBSERVE: it records what it would undo; a person turns it up.'
  if ((dial?.halted || dial?.autonomy === 'OFF') && rank(level) > rank('OBSERVE')) {
    level = lowest(level, 'OBSERVE')
    reason += ` ${dial?.halted ? 'Ads automation is halted' : 'The account ads dial is OFF'}: it only records.`
  } else if ((dial?.autonomy ?? 'SUGGEST') === 'SUGGEST' && rank(level) > rank('PROPOSE')) {
    level = 'PROPOSE'
    reason += ` The account ads dial is SUGGEST${dial ? '' : ' (never set)'}: it asks a person.`
  }
  return { level, reason, tally, caps: { ...AUTO_UNDO_DEFAULTS, byMarket: AUTO_UNDO_BY_MARKET } }
}

// ── undo-worse-ad-change: a person decides one undo (ads-auto-undo.tools.ts) ───────────────────────

export interface JudgedUndoPlan {
  judgement: { id: string; actionLogId: string; verdict: string; outcome: string | null; why: string | null; changedAt: string; by: string; origin: string }
  /** What is put back: the lever goes from what it holds now (the change's after) to what it held before the change. */
  restore: { entityType: string; entityId: string; label: string; market: string | null; lever: string; fromValue: number; toValue: number }
  /** The write as the gate judges it (ads-tool-guards.ts checkLiveReach). */
  intent: { campaignId: string; adGroupId: string | null; marketplace: string | null; changes: Array<{ field: string; valueCents: number | null }> }
  /** A put-back that raises (the undo of a cut), in words; empty for the undo of a raise. */
  raises: string[]
}

const LEVER_WORDS = (lever: string) => (lever === 'bid' ? 'bid' : lever === 'dailyBudget' ? 'daily budget' : `${lever.slice('placement:'.length)} placement adjustment`)

/**
 * What undoing one judgement puts back, read now; or why it is not asked for. Only a change auto-undo judged clearly
 * worse, not undone already, not waiting in another request, still standing (no later write, the same value), and one
 * auto-undo puts back. `approvalId`: the request being carried out (its own request is not "another").
 */
export async function planJudgedUndo(judgementId: string, approvalId?: string | null): Promise<{ ok: true; plan: JudgedUndoPlan } | { ok: false; error: string }> {
  const j = await prisma.adsAutoUndoJudgement.findUnique({ where: { id: judgementId }, select: { ...JUDGEMENT_SELECT, evidence: true } })
  if (!j) return { ok: false, error: 'That auto-undo judgement is not found in this business (automation-detail A19 lists them).' }
  if (j.verdict !== 'worse') return { ok: false, error: `Not queued: auto-undo judged this change ${VERDICT_WORDS[j.verdict as JudgeVerdict] ?? j.verdict} — only a change judged clearly worse is put back here (undo-ad-change puts back a change you name).` }
  if (j.action === 'undone') return { ok: false, error: `Not queued: it was undone already${j.undoActionLogId ? ` (write ${j.undoActionLogId})` : ''}.` }
  const waiting = await waitingRequestFor(j.id, approvalId)
  if (waiting) return { ok: false, error: `Not queued: its undo is already asked for (approval ${waiting.id}, ${waiting.status}).` }
  const log = await prisma.advertisingActionLog.findUnique({ where: { id: j.actionLogId } })
  if (!log) return { ok: false, error: 'Not queued: the change it judged is no longer in the ads log.' }
  if (log.rolledBackAt) return { ok: false, error: 'Not queued: that change was undone already.' }
  const { judgedWriteStands } = await import('./rollback.service.js')
  const moved = await judgedWriteStands(log)
  if (moved) return { ok: false, error: `Not queued: ${moved} — a superseded change is never undone.` }
  const change = leverChangeOf(log)
  if ('excluded' in change) return { ok: false, error: `Not queued: ${change.why}.` }
  const entity = (await entitiesNow([log])).get(`${log.entityType}:${log.entityId}`)
  if (!entity?.campaignId) return { ok: false, error: 'Not queued: Nexus cannot find the campaign of that change.' }
  const market = marketOf(entity.market)
  const t = autoUndoThresholds(market)
  const field = change.lever === 'bid' ? (log.entityType === 'AD_GROUP' ? 'defaultBid' : 'bid') : change.lever === 'dailyBudget' ? 'dailyBudget' : 'placementBidding'
  const raises: string[] = []
  if (change.direction === 'cut') {
    const limits: RaiseLimits = { ...(change.lever === 'bid' ? await strategyLimits(entity.market, entity.adGroupId, entity.campaignId) : { maxChangePct: null, maxBidCents: null }), maxBudgetCents: entity.maxBudgetCents }
    const past = raiseRefusal(change, t, limits)
    raises.push(`it raises the ${LEVER_WORDS(change.lever)} back to where it was before the cut${past ? ` — ${past.replace(/: a person decides$/, '')}; approving it sends it anyway` : ''}`)
  }
  const evidence = obj(j.evidence)
  return {
    ok: true,
    plan: {
      judgement: { id: j.id, actionLogId: j.actionLogId, verdict: j.verdict, outcome: j.outcome, why: typeof evidence.why === 'string' ? evidence.why : null, changedAt: j.changedAt.toISOString(), by: j.originLabel ?? j.actor, origin: j.origin },
      restore: { entityType: log.entityType, entityId: log.entityId, label: entity.label, market, lever: change.lever, fromValue: change.to, toValue: change.from },
      intent: { campaignId: entity.campaignId, adGroupId: entity.adGroupId, marketplace: entity.market, changes: [{ field, valueCents: field === 'placementBidding' ? null : change.from }] },
      raises,
    },
  }
}

/** A person approved it: put the value back as the approved request (its change set), and record it on the judgement. */
export async function runJudgedUndo(judgementId: string, run: { actor: `user:${string}` | `automation:${string}`; reason: string; manual: boolean; changeSetId: string }): Promise<{ ok: true; actionLogId: string | null } | { ok: false; error: string }> {
  const j = await prisma.adsAutoUndoJudgement.findUnique({ where: { id: judgementId }, select: { actionLogId: true } })
  if (!j) return { ok: false, error: 'That auto-undo judgement is not found in this business.' }
  const { reverseJudgedWrite } = await import('./rollback.service.js')
  const out = await reverseJudgedWrite({ actionLogId: j.actionLogId, actor: run.actor, reason: run.reason, manual: run.manual, changeSetId: run.changeSetId })
  if ('reason' in out) return { ok: false, error: out.reason }
  await prisma.adsAutoUndoJudgement.update({
    where: { id: judgementId },
    data: { action: 'undone', actionAt: new Date(), actionReason: `a person approved request ${run.changeSetId}`, undoApprovalId: run.changeSetId, undoActionLogId: out.actionLogId, final: true },
  })
  return { ok: true, actionLogId: out.actionLogId }
}

/** The writes of a change set still standing (not reversed since): what undo-ad-change of it would put back. */
export async function changeSetStanding(changeSetId: string): Promise<{ changeSetId: string; standing: number }> {
  return { changeSetId, standing: await prisma.advertisingActionLog.count({ where: { executionId: changeSetId, rolledBackAt: null } }) }
}
