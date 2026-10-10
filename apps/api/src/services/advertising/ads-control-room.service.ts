/**
 * ACR.1.2 — the Levers view: every automation that can change this account, in one list.
 *
 * The autonomy board it replaces listed `AutomationRule` rows only. That is a minority of
 * what actually moves money here: rank-defend applied 5,311 mutations in 90 days and never
 * appeared on it, and neither did dayparting, budget enforcement, pool rebalancing or the
 * anomaly breaker. An operator reading that board saw a handful of dials and reasonably
 * concluded the machine was small; the machine was not small, it was mostly off-screen.
 *
 * So this service describes the ENGINES — the crons and services with their own gates and
 * their own governed sets — and the route joins them to the rules that already had a board.
 * One list, one vocabulary, no second place to look.
 *
 * Read-only. It reports posture; it never changes it.
 */
import prisma from '../../db.js'
import { envEnabled } from '../../utils/env-flag.js'
import { getAutomationState } from './ads-automation-state.service.js'
import { lowest } from '../automation/automation-levels.js'
import { ENGINES, engineEnv, readEngineSwitch, type EngineSwitchRow } from '../automation/engine-switch.service.js'
import { breakerLimitsText, engineForActor } from './ads-engine-actors.js'
import { engineCapsText } from './ads-engine-guard.js'
import { campaignCensus } from './ads-census.service.js'
import { serverPortfolioCapLimitCents } from './brain/portfolio-cap-limit.js'
import type { AutomationEntry } from '../automation/automation-catalog.service.js'

/**
 * Engines are gated by env flags and apply-switches, not by `AutomationRule.autonomyLevel`.
 * They are mapped onto the SAME four words the rules use, because an operator should not
 * have to hold two vocabularies to answer "what is allowed to act tonight".
 *
 *   OFF      — gated off; does not run at all
 *   OBSERVE  — runs and computes, but is structurally incapable of writing (dry-run flag off)
 *   PROPOSE  — runs and writes suggestions for approval
 *   AUTO     — runs and writes to Amazon
 */
export type LeverMode = 'OFF' | 'OBSERVE' | 'PROPOSE' | 'AUTO'

export interface EngineLever {
  key: string
  name: string
  /** One line an operator can act on, not a description of the code. */
  what: string
  mode: LeverMode
  /** Why it is in this mode — always populated, because "why can't I turn this on" needs an answer on-screen. */
  modeReason: string
  /** What it governs right now, e.g. "33 schedules". null when the concept does not apply. */
  scope: string | null
  cron: string | null
  schedule: string | null
  lastRunAt: Date | null
  lastRunStatus: string | null
  lastRunSummary: string | null
  /** Failure rate over the recent window — the signal that would have exposed the 693k-failure silence. */
  runs7d: number
  failures7d: number
  /** Set when something is wrong enough to belong on the exception board. */
  warning: string | null
  /**
   * Whether this engine actually consults the account halt / autonomy dial.
   *
   * Measured, not assumed: `ads-auto-bid` checks `state.effectivelyStopped`
   * (`ads-auto-harvest` did too, until HP5 retired it 2026-08-21), and since 1c / 1d
   * rank-defend, dayparting, budget enforcement, pools, top-of-search defense and the coverage
   * engine read the dial through ads-engine-guard.ts; the delivery drain contains no such check.
   *
   * This distinction is the difference between a control surface and a decorative one. On
   * 2026-08-05 the breaker was tripped ("264 actions in the last hour") and rank-defend's
   * very next tick still reported `evaluated=33 applied=21`, budget enforcement still ran
   * `(LIVE)`, and the drain kept delivering. A page that painted those as OFF because the
   * account said "halted" would be lying in the most expensive possible direction.
   */
  haltBehaviour: HaltBehaviour
  /**
   * R16 (decision D-R2) — the two things that decide it, side by side: what the server env lets it do (`env`, before the
   * account dial) and what this business set with its own switch (`switch`; null = not set, the env alone decides).
   * `switchable` is false for engines that have no per-business switch.
   */
  control: {
    env: { mode: LeverMode; reason: string }
    switch: { mode: LeverMode; setBy: string; setAt: string; reason: string | null } | null
    switchable: boolean
    /** The levels its switch can be at, lowest first (empty when it has none). */
    levels: LeverMode[]
    /** The highest a person may turn the switch up to: what the server env allows (engine-switch.service.ts). */
    ceiling: LeverMode | null
  }
  /** 7a — its entry in the automation catalog (MCP list-automations), whose env and rows decide it; null = none. */
  catalogId: string | null
  /** 7a — whether it can change Amazon by itself. The breaker, write delivery, the reconcile and the analyst fleet never do. */
  writesOnOwn: boolean
  /** 7a — what it does now, in one of the plain groups below, and (when it is ready) what would start it. */
  exposure: { group: ExposureGroup; label: string; start: string | null }
  /** 7a — changes it made in the last 7 days (its actor strings, ads-engine-actors.ts). */
  writes7d: number
  /** 7a — never ran · ran and changed nothing in 7 days · changed something in 7 days. */
  activity: EngineActivity
  /** Ads brain page A4 — 'brain' for a row of one of the brain's writers (brain/engine-levers.ts); absent for an engine. */
  family?: 'brain'
}

/**
 * 7a (review 8.1, 8.2) — what an engine does now, in one of five plain groups. `mode` says what the server env, this
 * business's switch and the account dial let it do; the group adds what it has to act on, so an engine on Auto with
 * nothing set up is never counted as changing Amazon.
 *
 *   acts        changes Amazon on its own: allowed to act, writes by itself, and has something to act on
 *   ready       allowed, but no plan, schedule or pool of its own is switched on, so it does nothing
 *   server-off  a server switch (env) holds it off or below Auto
 *   held        this business's switch, the account dial or a halt holds it back
 *   never       runs, and never changes Amazon by itself (the breaker, write delivery, the reconcile)
 *   unknown     its own settings could not be read
 */
export type ExposureGroup = 'acts' | 'ready' | 'server-off' | 'held' | 'never' | 'unknown'
export type EngineActivity = 'never-ran' | 'idle' | 'acted'

export interface ExposureInput {
  writesOnOwn: boolean
  /** What the server env allows (the catalog's reading for an engine in the catalog). */
  env: LeverMode
  /** This business's switch holds it below the env. */
  switchedDown: boolean
  /** The account dial or a halt holds it. */
  dialHolds: boolean
  /** Its own plans, schedules or pools as the catalog counts them; null = it has none to set up. */
  rows: { total: number; auto: number } | null | 'unreadable'
  mode: LeverMode
  /** Its catalog entry is missing, so neither its env nor its rows can be said. */
  unknown?: boolean
}

export function engineExposure(i: ExposureInput): { group: ExposureGroup; label: string } {
  const group = ((): ExposureGroup => {
    if (i.unknown) return 'unknown'
    if (i.writesOnOwn ? i.env !== 'AUTO' : i.env === 'OFF') return 'server-off'
    if (i.switchedDown || i.dialHolds) return 'held'
    if (!i.writesOnOwn) return i.mode === 'OFF' ? 'ready' : 'never'
    if (i.rows === 'unreadable') return 'unknown'
    if (i.rows && i.rows.auto === 0) return 'ready'
    return 'acts'
  })()
  const someRows = !!i.rows && i.rows !== 'unreadable' && i.rows.total > 0
  const label: Record<ExposureGroup, string> = {
    acts: 'Changes Amazon on its own',
    ready: someRows ? 'Ready — nothing switched on' : 'Ready — nothing set up',
    'server-off': 'Off by a server switch',
    held: 'Held back in Nexus',
    never: 'Always on — never changes Amazon by itself',
    unknown: 'Its settings could not be read',
  }
  return { group, label: label[group] }
}

/** Changes in the window come first: an engine started by hand can write without a run of its cron. */
export function engineActivity(lastRunAt: Date | null, writes7d: number): EngineActivity {
  if (writes7d > 0) return 'acted'
  return lastRunAt ? 'idle' : 'never-ran'
}

/**
 * How an engine relates to the account halt / autonomy dial.
 *
 *   honours  — reads the dial itself before it writes (ads-engine-guard.ts), and keeps its
 *              own per-run and per-day caps. Under SUGGEST it writes nothing new; while
 *              stopped only bid floors may land (rank-defend, dayparting, budget
 *              enforcement) and restores wait for Resume. `ads-auto-bid` stands down when
 *              stopped (1c, 1d).
 *   gated    — still evaluates while halted, but every write it produces is refused by
 *              `ads-write-gate` (ACR.0.7). Nothing reaches Amazon; the engine merely
 *              wastes a tick. Only the delivery drain is in this state now.
 *   exempt   — runs regardless, correctly: the anomaly breaker must keep evaluating
 *              (it is what would clear the halt) and the reconcile is read-only.
 *
 * Before ACR.0.7 the `gated` engines were UNGUARDED — measured on prod with the breaker
 * tripped, rank-defend's next tick still applied 21 bid changes and budget enforcement
 * ran LIVE. The distinction is kept rather than collapsed because "stands down" and
 * "runs but cannot land a write" are different operational facts, and an operator
 * debugging a quiet account needs to know which one they are looking at.
 */
export type HaltBehaviour = 'honours' | 'gated' | 'exempt'

const DAY = 86_400_000

/** Last run + 7-day health for a set of cron names, in one query each. */
async function cronFacts(names: string[]) {
  const since = new Date(Date.now() - 7 * DAY)
  const [last, grouped] = await Promise.all([
    prisma.cronRun.findMany({
      where: { jobName: { in: names } },
      orderBy: { startedAt: 'desc' },
      distinct: ['jobName'],
      select: { jobName: true, startedAt: true, status: true, outputSummary: true, errorMessage: true },
    }),
    prisma.cronRun.groupBy({
      by: ['jobName', 'status'],
      where: { jobName: { in: names }, startedAt: { gte: since } },
      _count: { _all: true },
    }),
  ])
  const lastBy = new Map(last.map((r) => [r.jobName, r]))
  const health = new Map<string, { runs: number; failures: number }>()
  for (const g of grouped) {
    const h = health.get(g.jobName) ?? { runs: 0, failures: 0 }
    h.runs += g._count._all
    if (g.status === 'FAILED') h.failures += g._count._all
    health.set(g.jobName, h)
  }
  return { lastBy, health }
}

/**
 * ACR.1.3 — the account-level bounds, in one read.
 *
 * These are the numbers that bind EVERY engine and rule, and until now each lived somewhere
 * different: two in a DB row, one in an env var, one implied by a column's default-deny, one
 * only countable by query. Setting the breaker threshold required running a script — which is
 * a strange thing to say about the control that stops the account.
 *
 * `effective` vs `set` is the important distinction. A null threshold is not "no limit", it is
 * "the code's default", and showing a blank field would read as unbounded. So both are
 * returned and the UI can say "250 (default)" rather than nothing.
 */
export interface AccountGuardrails {
  /** The breaker's limit on RULE actions. Each engine's changes have their own hourly limit (ads-engine-actors.ts). */
  actionsPerHour: { effective: number; set: number | null; default: number }
  spendPerHourCents: { effective: number; set: number | null; default: number }
  /** Per-payload write ceiling, from env. Read-only here — it needs a deploy to change. */
  maxWriteValueCents: number
  /** Owner decision 2A — the server's monthly limit of a portfolio's cap (a product's brain may hold its own). */
  maxPortfolioCapCents: number
  /** Quartile's counted boundary of authority: what automation may touch at all. */
  campaigns: { total: number; managed: number; unmanaged: number }
  /** Entity bid bounds (ADX A1) — a column, so it cannot be bypassed by a future engine. */
  bounds: { withMinBid: number; withMaxBid: number }
  protectedTerms: number
  adsMode: string
  envKill: boolean
}

const DEFAULT_MAX_ACTIONS_PER_HOUR = 250
const DEFAULT_MAX_HOURLY_SPEND_CENTS = 50_000

export async function getAccountGuardrails(): Promise<AccountGuardrails> {
  // 7b — campaign counts from the census every screen reads (ads-census.service.ts).
  const [state, census, protectedTerms] = await Promise.all([
    getAutomationState(),
    campaignCensus(),
    prisma.adKeywordProtection.count({ where: { mode: 'WHITELIST' } }).catch(() => 0),
  ])
  const { total, allowlisted: managed, withMinBid: withMin, withMaxBid: withMax } = census
  const { adsMode } = await import('./ads-api-client.js')
  return {
    actionsPerHour: {
      effective: state.maxActionsPerHour ?? DEFAULT_MAX_ACTIONS_PER_HOUR,
      set: state.maxActionsPerHour, default: DEFAULT_MAX_ACTIONS_PER_HOUR,
    },
    spendPerHourCents: {
      effective: state.maxHourlySpendCentsEur ?? DEFAULT_MAX_HOURLY_SPEND_CENTS,
      set: state.maxHourlySpendCentsEur, default: DEFAULT_MAX_HOURLY_SPEND_CENTS,
    },
    maxWriteValueCents: Number(process.env.NEXUS_AMAZON_ADS_MAX_WRITE_VALUE_CENTS ?? 50_000),
    maxPortfolioCapCents: serverPortfolioCapLimitCents(),
    campaigns: { total, managed, unmanaged: total - managed },
    bounds: { withMinBid: withMin, withMaxBid: withMax },
    protectedTerms,
    adsMode: adsMode(),
    envKill: process.env.NEXUS_ADS_AUTOMATION_KILL === '1',
  }
}

/**
 * Part 06 fix (lead review of R5) — an engine switch read EXACTLY as its job reads it. Budget enforcement applies only
 * with NEXUS_BUDGET_ENFORCE_APPLY === '1' and rank-defend runs only with NEXUS_ENABLE_RANK_DEFEND === '1'; reading them
 * with `envEnabled` (which also takes 'true', 'yes', 'on') showed AUTO while the job stayed dry or off.
 */
export const jobSwitchOn = (flag: 'NEXUS_BUDGET_ENFORCE_APPLY' | 'NEXUS_ENABLE_RANK_DEFEND'): boolean => process.env[flag] === '1'

/**
 * 7a (review 8.1) — the engines the automation catalog (MCP list-automations) describes, by lever key. Their env, own
 * rows and scope are read there, so this board and the catalog cannot disagree. The breaker's entry (A3) is the dial,
 * not the breaker's own run, so it is linked and not read.
 */
const CATALOG_OF: Record<string, string> = {
  'rank-defend': 'A10', dayparting: 'A6', 'budget-enforce': 'A8', 'budget-schedules': 'A7', 'budget-pools': 'A9',
  'auto-bid': 'A4', autopilot: 'A5', 'anomaly-guard': 'A3', 'tos-defense': 'A11', 'coverage-engine': 'A12',
}

export async function getEngineLevers(): Promise<{ levers: EngineLever[]; global: { autonomy: string; halted: boolean; degraded: boolean; envKill: boolean } }> {
  const CRONS = [
    'ad-rank-defend', 'ad-dayparting', 'ad-budget-enforce', 'ad-budget-schedule', 'budget-pool-rebalance',
    'ads-auto-bid', 'ad-autopilot', 'ads-anomaly-guard', 'top-of-search-defense',
    'tos-is-ingest', 'sqp-ingest', 'ads-structural-reconcile', 'drain-ads-sync',
    'ads-coverage-engine', 'fleet-sweep', 'fleet-council',
    // A4 — the brain's writers' runs (brain/engine-levers.ts BRAIN_WRITERS).
    'ads-bid-brain-shadow', 'ads-brain-money-shadow', 'ads-brain-state', 'ads-brain-negatives', 'ads-brain-harvest', 'ads-brain-cycle',
    'ads-brain-hours', 'ads-brain-structure',
  ]
  const { getAutomationCatalog } = await import('../automation/automation-catalog.service.js')
  const catalogIds = new Set(Object.values(CATALOG_OF).filter((id) => id !== 'A3'))

  const { brainEngineFacts } = await import('./brain/engine-levers.js')
  const [state, facts, catalog, writeGroups, census, enabledAnalysts, brainRows] = await Promise.all([
    getAutomationState(),
    cronFacts(CRONS),
    getAutomationCatalog((a) => catalogIds.has(a.id)),
    prisma.advertisingActionLog.groupBy({ by: ['userId'], where: { createdAt: { gte: new Date(Date.now() - 7 * DAY) } }, _count: { _all: true } }),
    campaignCensus(),
    prisma.agentCharter.count({ where: { enabled: true, tier: 'analyst', key: { not: 'fleet-selftest' } } }),
    // A4 — a brain that cannot be read never hides the engines: its rows are left out and the board says so in a warning row.
    brainEngineFacts().catch((err: unknown) => (err instanceof Error ? err : new Error(String(err)))),
  ])
  // 7b — the census every screen reads, so "82 of 220 allowlisted" is one number everywhere.
  const { allowlisted, total: totalCampaigns } = census
  const entries = new Map(catalog.map((e) => [e.id as string, e]))
  // 7a — each engine's changes in 7 days, by the one actor map (ads-engine-actors.ts).
  const writesBy = new Map<string, number>()
  for (const g of writeGroups) {
    const engine = engineForActor(g.userId)
    if (engine) writesBy.set(engine, (writesBy.get(engine) ?? 0) + g._count._all)
  }

  const adsCron = envEnabled('NEXUS_ENABLE_AMAZON_ADS_CRON')
  const envKill = process.env.NEXUS_ADS_AUTOMATION_KILL === '1'
  // R16 — each switchable engine's switch in this business (no row = the env alone decides).
  const switchKeys = ['rank-defend', 'budget-enforce', 'auto-bid', 'tos-defense', 'coverage-engine', 'fleet-analysts'] as const
  const switches = new Map<string, EngineSwitchRow | null>(await Promise.all(switchKeys.map(async (k) => [k, await readEngineSwitch(k)] as const)))
  const ceilings = new Map<string, LeverMode>(await Promise.all(switchKeys.map(async (k) => [k, (await engineEnv(k)).ceiling as LeverMode] as const)))

  /**
   * The account-wide dial is a CEILING over every lever, not a peer of them. SUGGEST forces
   * every rule to dry-run; OFF and the halt stop everything. Presenting a lever as AUTO while
   * the account dial says SUGGEST would be the single most misleading thing this page could do.
   */
  const accountStopped = envKill || state.halted || state.autonomy === 'OFF'
  const capped = (m: LeverMode, hb: HaltBehaviour): LeverMode => {
    // 'gated' engines cannot land a write while stopped (ACR.0.7), so their effective
    // mode is OFF exactly like an engine that stood down on its own.
    if (hb === 'exempt') return m
    if (accountStopped) return 'OFF'
    if (state.autonomy === 'SUGGEST' && m === 'AUTO') return 'PROPOSE'
    return m
  }
  /**
   * 1c / 1d — what an engine that honours the dial still does under it, for the engines that read it through
   * ads-engine-guard.ts. Under SUGGEST it is said beside the dial; while stopped it is the warning, because the
   * lever reads OFF and yet floors may still land. Said only when the engine is armed to write (AUTO): an engine
   * in OBSERVE writes nothing under any dial.
   */
  const DIAL_WORDS: Record<string, { suggest: string; stopped: string }> = {
    'rank-defend': {
      suggest: 'computes each run and writes nothing new (the run summary counts what it would change); it still restores bids it floored',
      stopped: 'Stopped: it only lowers bids to their Min-bid floors; restores and placement moves wait for Resume',
    },
    dayparting: {
      suggest: 'computes each run and writes nothing new (the run summary counts what it would change); it still lifts its own floors and multipliers',
      stopped: 'Stopped: it only floors bids when a window closes; restores and multipliers wait for Resume',
    },
    'budget-enforce': {
      suggest: 'computes each run and writes no pacing and no new floors (the run summary counts what it would change); it still restores bids it floored over the cap',
      stopped: 'Stopped: it only floors bids when a cap is reached; restores and budget pacing wait for Resume',
    },
    'budget-schedules': {
      suggest: 'enters no window and writes nothing new; it still gives back a budget it set when that window closes',
      stopped: 'Stopped: it writes nothing; windows and give-backs wait for Resume',
    },
    'budget-pools': {
      suggest: 'records each due rebalance as a dry run and writes nothing',
      stopped: 'Stopped: it writes nothing; rebalances wait for Resume',
    },
    autopilot: {
      suggest: 'records the proposals of its Auto plans and writes nothing',
      stopped: 'Stopped: its Auto plans record proposals and write nothing until Resume',
    },
    'tos-defense': {
      suggest: 'computes each run and writes nothing (the run summary counts what it would move)',
      stopped: 'Stopped: it writes nothing; placement moves wait for Resume',
    },
    'coverage-engine': {
      suggest: 'logs the bids it would set, as in observe mode, and writes nothing',
      stopped: 'Stopped: it logs the bids it would set and writes nothing until Resume',
    },
    // A4 — the brain's writers that read the dial (brain/engine-levers.ts, measured): they hold every change.
    'bid-brain': {
      suggest: 'decides each run and writes no bid (the why names what it would set)',
      stopped: 'Stopped: it decides and logs, and writes no bid until Resume',
    },
    'brain-money': {
      suggest: 'plans each run and writes no budget or cap (each held change says would-apply)',
      stopped: 'Stopped: it plans and logs, and writes no budget or cap until Resume',
    },
    'brain-state': {
      suggest: 'decides each pause and resume and writes none (held)',
      stopped: 'Stopped: it decides and logs, and pauses or resumes nothing until Resume',
    },
    'brain-strategy': {
      suggest: 'decides each switch and writes none (held)',
      stopped: 'Stopped: it decides and logs, and switches nothing until Resume',
    },
  }
  const capReason = (): string | null => {
    if (envKill) return 'NEXUS_ADS_AUTOMATION_KILL is set — nothing runs until it is cleared'
    if (state.halted) return `Halted${state.haltReason ? `: ${state.haltReason}` : ''}`
    if (state.autonomy === 'OFF') return 'Account autonomy is OFF'
    if (state.autonomy === 'SUGGEST') return 'Account autonomy is SUGGEST — writes are demoted to proposals'
    return null
  }

  /** 7a — what decides an engine besides its env and dial: whether it writes by itself, its catalog entry, its rows. */
  interface LeverExtra {
    writesOnOwn: boolean
    catalogId?: string
    /** The server env in words, for the drawer; defaults to the mode reason. */
    envWords?: string
    rows?: ExposureInput['rows']
    /** What would start it, said when it is ready with nothing to act on. */
    start?: string
    /** What the server env allows, when the mode it leaves is lower for another reason (the fleet with no charter on). */
    env?: LeverMode
    /** Its catalog entry is missing: its group cannot be said. */
    unknown?: boolean
    /**
     * A4 — a brain writer: what the brain really does with its levers across the enrolled products (already bounded by the
     * env), which the row's mode follows below the env. Its own switch is the Owner's lever levels, not an engine switch.
     */
    effective?: { mode: LeverMode; reason: string }
    family?: 'brain'
  }

  const mk = (
    key: string, name: string, what: string, cron: string | null,
    schedule: string | null, envMode: LeverMode, envReason: string,
    scope: string | null, haltBehaviour: HaltBehaviour, extra: LeverExtra,
  ): EngineLever => {
    // R16 — this business's switch only lowers what the env allows; the env (and the account dial below) still win.
    const set = switches.get(key) ?? null
    const switched: LeverMode = set ? lowest(envMode, set.mode as LeverMode) : envMode
    const rawMode: LeverMode = extra.effective ? lowest(switched, extra.effective.mode) : switched
    const rawReason = set && switched !== envMode ? `Switched to ${set.mode} for this business (${set.setBy})` : extra.effective ? extra.effective.reason : envReason
    const control = {
      env: { mode: envMode, reason: extra.envWords ?? envReason },
      switch: set ? { mode: set.mode as LeverMode, setBy: set.setBy, setAt: set.setAt, reason: set.reason } : null,
      switchable: key in ENGINES,
      levels: key in ENGINES ? [...ENGINES[key as keyof typeof ENGINES].levels] as LeverMode[] : [],
      ceiling: ceilings.get(key) ?? null,
    }
    const f = cron ? facts.lastBy.get(cron) : undefined
    const h = (cron ? facts.health.get(cron) : undefined) ?? { runs: 0, failures: 0 }
    const cap = capReason()
    const mode = capped(rawMode, haltBehaviour)
    const dialWords = haltBehaviour === 'honours' ? DIAL_WORDS[key] : undefined
    // A gate that is already OFF is not "overridden" by the account dial — say the local reason.
    let modeReason = rawMode === 'OFF' ? rawReason : (haltBehaviour === 'exempt' ? rawReason : (cap ?? rawReason))
    if (rawMode === 'AUTO' && dialWords && !accountStopped && state.autonomy === 'SUGGEST') modeReason = `Account autonomy is SUGGEST — it ${dialWords.suggest}`

    let warning: string | null = null
    // The loudest thing this page can say: the account is stopped and this engine is not.
    if (accountStopped && haltBehaviour === 'gated' && rawMode !== 'OFF') {
      // Not a defect since ACR.0.7 — but worth saying, because the cron will keep
      // logging activity and an operator should not read that as writes landing.
      warning = 'Still evaluating while stopped — its writes are refused at the gate'
    } else if (accountStopped && dialWords && rawMode === 'AUTO') {
      warning = dialWords.stopped
    } else if (cron && adsCron && h.runs === 0 && rawMode !== 'OFF') {
      warning = 'Enabled but has not run in 7 days'
    } else if (h.runs > 0 && h.failures / h.runs > 0.2) {
      warning = `${h.failures} of ${h.runs} runs failed in 7 days`
    }

    const lastRunAt = f?.startedAt ?? null
    const writes7d = writesBy.get(key) ?? 0
    const exposure = engineExposure({
      writesOnOwn: extra.writesOnOwn, env: extra.env ?? envMode, switchedDown: switched !== envMode, unknown: extra.unknown,
      dialHolds: haltBehaviour !== 'exempt' && (accountStopped || (extra.writesOnOwn && state.autonomy === 'SUGGEST')),
      rows: extra.rows ?? null, mode,
    })
    return {
      key, name, what, mode, modeReason, scope, cron, schedule,
      lastRunAt,
      lastRunStatus: f?.status ?? null,
      lastRunSummary: f?.outputSummary ?? f?.errorMessage ?? null,
      runs7d: h.runs, failures7d: h.failures, warning, haltBehaviour, control,
      catalogId: extra.catalogId ?? null,
      writesOnOwn: extra.writesOnOwn,
      exposure: { ...exposure, start: exposure.group === 'ready' ? extra.start ?? null : null },
      writes7d,
      activity: engineActivity(lastRunAt, writes7d),
      ...(extra.family ? { family: extra.family } : {}),
    }
  }

  /**
   * 7a — an engine the catalog describes: its env as the catalog reads it, why (the env that holds it, or what its own
   * rows say), its scope and its rows. Replaces the sentences this file used to fix in code ("every live schedule is
   * rank-goal mode", "this one acts"), which stayed true only until the data moved.
   */
  const fromCatalog = (key: string, noun?: string, start?: string) => {
    const id = CATALOG_OF[key]
    const e: AutomationEntry | undefined = entries.get(id)
    if (!e) {
      const why = `Its entry in the automation catalog (${id}) could not be read`
      return { envMode: 'OFF' as LeverMode, envReason: why, scope: null, extra: { writesOnOwn: true, catalogId: id, envWords: why, unknown: true } as LeverExtra }
    }
    const blocking = e.env.flags.filter((x) => !x.allows)
    const envWords = (blocking.length ? blocking : e.env.flags).map((x) => x.says).join(' ') || 'No server setting holds it.'
    const envMode = e.env.ceiling as LeverMode
    const rows: ExposureInput['rows'] = e.rows ? { total: e.rows.total, auto: e.rows.byLevel.AUTO ?? 0 } : e.business.level == null ? 'unreadable' : null
    const rowsScope = e.rows && noun ? (e.rows.total ? `${e.rows.byLevel.AUTO ?? 0} of ${e.rows.total} ${noun} switched on` : `No ${noun}`) : null
    return {
      envMode,
      envReason: envMode === 'AUTO' ? e.business.reason : envWords,
      scope: rowsScope ?? e.scope,
      extra: { writesOnOwn: true, catalogId: id, envWords, rows, start } as LeverExtra,
    }
  }
  const lever = (
    key: string, name: string, what: string, cron: string, schedule: string, haltBehaviour: HaltBehaviour,
    c: ReturnType<typeof fromCatalog>,
  ) => mk(key, name, what, cron, schedule, c.envMode, c.envReason, c.scope, haltBehaviour, c.extra)

  const off = (why: string) => ({ mode: 'OFF' as LeverMode, why })
  const masterOff = !adsCron ? off('NEXUS_ENABLE_AMAZON_ADS_CRON is off — the whole ads fleet is dormant') : null

  const levers: EngineLever[] = [
    lever('rank-defend', 'Hourly bid plans', 'Sets each campaign to its hour-of-week plan: placement percentages, a Min-bid floor and a base bid. Reads no rank or share signal',
      'ad-rank-defend', 'every 15 min', 'honours',
      fromCatalog('rank-defend', 'schedules and product plans', 'Switch on an hourly bid plan (a schedule or a product plan) to start it.')),

    lever('dayparting', 'Classic dayparting', 'Suppresses bids while an hour window is closed and multiplies them while it is open',
      'ad-dayparting', 'every 15 min', 'honours',
      fromCatalog('dayparting', 'classic schedules', 'Add a classic dayparting schedule and switch it on to start it.')),

    lever('budget-enforce', 'Budget enforcement', 'Paces a monthly budget and suppresses over-spending campaigns',
      'ad-budget-enforce', 'every 30 min', 'honours',
      fromCatalog('budget-enforce', 'budget plans for this month', 'Set a budget plan for this month with pacing or the over-spend stop on to start it.')),

    lever('budget-schedules', 'Budget schedules', 'Sets a campaign\'s daily budget for each time window, and gives the base budget back after',
      'ad-budget-schedule', 'every 15 min', 'honours',
      fromCatalog('budget-schedules', 'budget schedules', 'Add a budget schedule and switch it on to start it.')),

    lever('budget-pools', 'Budget pools', 'Moves daily budget between campaigns inside a pool',
      'budget-pool-rebalance', 'every 15 min', 'honours',
      fromCatalog('budget-pools', 'pools', 'Create a budget pool and set it to Auto to start it.')),

    lever('auto-bid', 'Bid optimiser', 'Moves target bids toward a target ACOS',
      'ads-auto-bid', 'every 6 h', 'honours', fromCatalog('auto-bid')),

    lever('autopilot', 'Autopilot plans', 'Per plan: bids, budgets and placements toward a goal',
      'ad-autopilot', 'every 15 min', 'honours',
      fromCatalog('autopilot', 'autopilot plans', 'Set an autopilot plan to Auto to start it.')),

    mk('anomaly-guard', 'Anomaly breaker', 'Stops ads automation account-wide when rule actions, one engine\'s changes or hourly ad spend pass their limits',
      'ads-anomaly-guard', 'every 10 min',
      masterOff ? 'OFF' : 'AUTO',
      masterOff?.why ?? `Trips at ${state.maxActionsPerHour ?? DEFAULT_MAX_ACTIONS_PER_HOUR} rule actions an hour, €${((state.maxHourlySpendCentsEur ?? DEFAULT_MAX_HOURLY_SPEND_CENTS) / 100).toFixed(0)} of ad spend in one hour, or when one engine passes its own hourly limit of changes (${breakerLimitsText()})`,
      null, 'exempt', { writesOnOwn: false, catalogId: 'A3' }),

    lever('tos-defense', 'Top-of-Search defense', 'Nudges the top-of-search multiplier toward a target impression share',
      'top-of-search-defense', 'every 30 min', 'honours', fromCatalog('tos-defense')),

    mk('write-delivery', 'Write delivery', 'Sends to Amazon the changes people, rules and engines already made, and retries failures',
      'drain-ads-sync', 'every minute',
      masterOff ? 'OFF' : 'AUTO',
      masterOff?.why ?? 'The only path a change reaches Amazon by',
      `${allowlisted} of ${totalCampaigns} campaigns allowlisted`, 'gated', { writesOnOwn: false }),

    lever('coverage-engine', 'Coverage engine', 'Holds each term of an enabled coverage set at its target share, inside its caps',
      'ads-coverage-engine', 'daily 07:10', 'honours',
      fromCatalog('coverage-engine', 'coverage sets', 'Switch on a coverage set to start it.')),

    mk('structural-reconcile', 'Account reconcile', 'Compares the whole account against Amazon and records disagreement',
      'ads-structural-reconcile', 'every 6 h',
      masterOff ? 'OFF' : 'OBSERVE',
      masterOff?.why ?? 'Read-only — records drift, never repairs bids',
      null, 'exempt', { writesOnOwn: false }),

    // NAF.B — the analyst fleet's nightly sweep. Read-only (findings only,
    // no write path); honours ITS OWN halt (AgentFleetState + the AI kill
    // switch), not the ads write halt — hence 'exempt' here, per the
    // structural-reconcile precedent.
    mk('fleet-analysts', 'Analyst fleet (LLM)', 'Nightly LLM analysts read engine evidence and write findings — no writes to Amazon',
      'fleet-sweep', 'nightly 04:45 UTC',
      process.env.NEXUS_ENABLE_FLEET_SWEEP_CRON !== '1' ? 'OFF'
        : enabledAnalysts > 0 ? 'OBSERVE' : 'OFF',
      process.env.NEXUS_ENABLE_FLEET_SWEEP_CRON !== '1'
        ? 'NEXUS_ENABLE_FLEET_SWEEP_CRON is not set'
        : enabledAnalysts > 0
          ? `${enabledAnalysts} analyst charter(s) enabled — findings only, honours the fleet halt`
          : 'Sweep scheduled but every analyst charter is OFF (dark)',
      null, 'exempt', {
        writesOnOwn: false,
        // Its env is the sweep flag alone: with the flag on and no charter enabled it is ready, not server-off.
        env: process.env.NEXUS_ENABLE_FLEET_SWEEP_CRON !== '1' ? 'OFF' : 'OBSERVE',
        start: 'Switch on an analyst charter to start it.',
      }),
  ]

  // A4 — one row per brain writer (family 'brain'): its env from its own reader, its mode what the brain really does now.
  const BRAIN_START = 'Enroll a product in the brain and give it this lever at PROPOSE or AUTO (set-ads-brain) to start it.'
  if (brainRows instanceof Error) {
    levers.push(mk('brain', 'Ads brain', 'The brain\'s writers', null, null, 'OFF', `The brain's writers could not be read: ${brainRows.message.slice(0, 200)}`, null, 'gated', { writesOnOwn: true, unknown: true, family: 'brain' }))
  } else {
    for (const b of brainRows) {
      levers.push(mk(
        b.def.key, b.def.name, b.def.what, b.healthCron, b.def.schedule, b.env.mode, b.env.why,
        b.rows.total ? `${b.rows.auto} of ${b.rows.total} ${b.def.key === 'bid-brain' ? 'LIVE / HELD campaigns' : 'enrolled products'} acting now` : null,
        b.def.haltBehaviour,
        { writesOnOwn: b.def.writesOnOwn, rows: b.def.writesOnOwn ? b.rows : null, effective: { mode: b.effective.mode, reason: b.effective.why }, start: BRAIN_START, family: 'brain' },
      ))
    }
  }

  return {
    levers,
    global: { autonomy: state.autonomy, halted: state.halted, degraded: state.degraded, envKill },
  }
}
