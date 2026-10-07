/**
 * ADS AUTONOMY W4-8 — "Run now" for an ads engine, asked by Claude (run-ad-engine-now): the SAME start the Ads Control
 * Room's drawer and the Sync Logs hub use (POST /sync-logs/cron/:jobName/trigger → startCronByHand: the registry's own
 * entry, one CronRun row marked manual), in the business of the call. Nothing of the engine changes: its writes keep its
 * own level, limits, actor and Amazon's write gate, exactly as a scheduled tick's — and a live run of a locked engine
 * passes its switch, the scheduler's arm flags and the engine lock (ads-engine-lock.ts guardLiveRun) as the tick does.
 *
 * What the plan says (Owner 10-07: Run now stays his own control; one press cut bids a second time): when the engine
 * last ran and how often it runs (the Control Room's own words), and what a second run on the same data does, per engine
 * (STEP): the bid optimiser and top-of-search defense take one more step; the hourly bid plans, dayparting and budget
 * enforcement set the same values again; a pool inside its cool-down is skipped; a rule acts again within its own caps.
 * It is refused while the engine runs — its run row is still open, or (rank-defend, budget-enforce, auto-bid, tos-defense)
 * its lock is held — with when that run should end, and wherever the Control Room would not offer the button (the engine
 * is off, or a live run would be refused). Pools, rules and dayparting have no lock: the check is re-made just before the
 * start, and a scheduled run that starts in that same moment can still overlap (said in the plan, with what holds then).
 *
 * Harvesting is not an engine of its own any more (HP5): Keyword Harvesting rules run in the rules evaluator (`rules`).
 * Budget pacing is budget enforcement (`budget-enforce`).
 */
import prisma from '../../db.js'
import { currentWorkspaceId, engineLockHeld, type LockedEngine } from './ads-engine-lock.js'

/**
 * The engines Claude may ask to run now: the Control Room lever (null: the rules evaluator has none), its job, its lock,
 * and what a second run on the same data does (each engine's own code: ads-auto-bid.service.ts, rank-controller.ts 2e,
 * ad-dayparting.job.ts, ads-budget-enforce.service.ts, budget-pool-rebalance.job.ts, the rules evaluator,
 * ads-top-of-search.service.ts).
 */
export const RUN_NOW_ENGINES = {
  'auto-bid': {
    lever: 'auto-bid', job: 'ads-auto-bid', locked: 'auto-bid', name: 'Bid optimiser (auto-bid)', steps: true,
    again: 'A second run on the same data takes one more step: it moves each bid one step toward its target from where the bid is now and does not remember that it just moved it, so a bid it cut on its last run may be cut again by up to its largest step (or raised again) until new report data arrives.',
  },
  'rank-defend': {
    lever: 'rank-defend', job: 'ad-rank-defend', locked: 'rank-defend', name: 'Hourly bid plans (rank-defend)', steps: false,
    again: 'A second run in the same hour sets the same values again: it sets each campaign to its plan\'s fixed values for the current hour (placement %, floor, base bid), with no climb step, so it takes no extra step.',
  },
  'budget-enforce': {
    lever: 'budget-enforce', job: 'ad-budget-enforce', locked: 'budget-enforce', name: 'Budget enforcement (pacing and the over-spend stop)', steps: false,
    again: 'A second run on the same data sets the same budgets and floors again: it paces each plan\'s remaining month from month-to-date spend and floors what is over a cap, so it takes no extra step until new spend data arrives.',
  },
  pool: {
    lever: 'budget-pools', job: 'budget-pool-rebalance', locked: null, name: 'Budget pools (rebalance)', steps: true,
    again: 'A pool inside its cool-down is skipped. A pool past it rebalances again on the same data: one more shift, up to its largest shift per rebalance.',
    overlap: 'it has no lock: a scheduled run that starts in the same moment can overlap it; a pool rebalanced by one of them is then inside its cool-down for the other',
  },
  rules: {
    lever: null, job: 'advertising-rule-evaluator', locked: null, name: 'Amazon ads rules (the rules evaluator, harvesting included)', steps: true,
    again: 'A second run on the same data acts again: each rule acts on what matches it now, so a rule whose action steps a bid or a budget by a percent takes one more step, as far as its own daily caps allow.',
    overlap: 'it has no lock: a scheduled run that starts in the same moment can overlap it; each rule\'s own daily caps still hold across both',
  },
  dayparting: {
    lever: 'dayparting', job: 'ad-dayparting', locked: null, name: 'Classic dayparting', steps: false,
    again: 'A second run in the same window changes nothing new: it applies the window that is open now (a floor while closed, the window\'s multiplier while open) and remembers what it applied.',
    overlap: 'it has no lock: a scheduled run that starts in the same moment can overlap it; what it applies is remembered, so the second applies the same values',
  },
  'tos-defense': {
    lever: 'tos-defense', job: 'top-of-search-defense', locked: 'tos-defense', name: 'Top-of-search defense', steps: true,
    again: 'A second run on the same data takes one more step: it nudges each campaign\'s top-of-search adjustment one step toward its target per run.',
  },
  // ADS AUTONOMY — auto-undo (A19): no Control Room lever; its level is its own switch (born OBSERVE) under the dial.
  'auto-undo': {
    lever: null, job: 'ads-auto-undo', locked: null, name: 'Auto-undo of automatic ad changes', steps: false,
    again: 'A second run on the same data changes nothing new: a change it already undid or asked a person about stands, and each market\'s daily cap of undos counts both runs.',
    overlap: 'it has no lock: a scheduled run that starts in the same moment can overlap it; one judgement per change is kept, and the undo itself refuses a change that was already put back',
  },
} as const satisfies Record<string, { lever: string | null; job: string; locked: LockedEngine | null; name: string; steps: boolean; again: string; overlap?: string }>
export type RunNowEngine = keyof typeof RUN_NOW_ENGINES
export const RUN_NOW_ENGINE_KEYS = Object.keys(RUN_NOW_ENGINES) as [RunNowEngine, ...RunNowEngine[]]

/**
 * A run row still open this long is a run that died before it could close its row (the stale-run sweep,
 * cron-orphan-sweeper.job.ts, closes one 2 h after it started, at its next half-hourly pass): not a run in progress, if
 * that sweep did not run.
 */
const OPEN_RUN_MAX_MS = 6 * 3600_000
/** The stale-run sweep closes an open row after 2 h, on a pass every 30 min: at the latest 2.5 h after it started. */
const SWEPT_BY_MS = 2.5 * 3600_000
/** An engine that runs this often or less is frozen at its last run: a tick in between makes the approved run another one. */
const SLOW_ENGINE_MINUTES = 60
/** The rules evaluator has no Control Room lever: its schedule is NEXUS_ADVERTISING_RULE_SCHEDULE, every 15 min by default. */
const RULES_SCHEDULE = 'every 15 min'
/** Auto-undo runs once a day (NEXUS_ADS_AUTO_UNDO_SCHEDULE, 06:15 UTC by default). */
const AUTO_UNDO_SCHEDULE_WORDS = 'daily 06:15 UTC'

/** Minutes between two runs, from the Control Room's schedule words ("every 15 min", "every 6 h", "daily 07:10"); null when unknown. */
export function scheduleMinutes(words: string | null | undefined): number | null {
  const w = (words ?? '').trim().toLowerCase()
  if (w === 'every minute') return 1
  const m = /^every (\d+) (min|h)$/.exec(w)
  if (m) return Number(m[1]) * (m[2] === 'h' ? 60 : 1)
  if (/^(daily|nightly)\b/.test(w)) return 1440
  return null
}

const at = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000))
const ago = (d: Date, now: Date) => {
  const m = minutes(now.getTime() - d.getTime())
  return m < 120 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`
}

export interface LastRun { at: string; status: string; by: 'schedule' | 'hand'; summary: string | null; minutes: number | null }

export interface EnginePlan {
  action: 'run-ad-engine-now'
  engine: RunNowEngine
  name: string
  job: string
  /** What the engine may do now, in the Control Room's words (its level after the server, the switch and the dial). */
  level: string
  levelWhy: string
  schedule: string
  lastRun: LastRun | null
  summary: string
  effect: string
  /** What a second run on the same data does (RUN_NOW_ENGINES.again). */
  warning: string
  /** Whether a second run on the same data takes one more step (true) or sets the same values again (false). */
  steps: boolean
  warnings: string[]
  reach: { engine: true; note: string }
  /** A slow engine's last run start (null for one that runs every 30 min or more often): a tick since is a different run. */
  basis: { lastRunAt: string | null }
}

/** The engine's last runs (newest first), its open run if any, and how long a run usually takes. */
async function runsOf(job: string, now: Date) {
  const rows = await prisma.cronRun.findMany({
    where: { jobName: job },
    orderBy: { startedAt: 'desc' },
    take: 12,
    select: { startedAt: true, finishedAt: true, status: true, triggeredBy: true, outputSummary: true, errorMessage: true },
  })
  const open = rows.find((r) => r.status === 'RUNNING' && !r.finishedAt && now.getTime() - r.startedAt.getTime() < OPEN_RUN_MAX_MS) ?? null
  const durations = rows.filter((r) => r.finishedAt).map((r) => r.finishedAt!.getTime() - r.startedAt.getTime()).sort((a, b) => a - b)
  const usualMs = durations.length ? durations[Math.floor(durations.length / 2)] : null
  const last = rows[0] ?? null
  return { last, open, usualMs }
}

/** Why a run may not start now because one is in progress, with when it should end (the real wait, per case); null when none runs. */
async function inProgress(engine: RunNowEngine, open: { startedAt: Date } | null, usualMs: number | null, now: Date): Promise<string | null> {
  const def = RUN_NOW_ENGINES[engine]
  const lock = def.locked ? await engineLockHeld(currentWorkspaceId(), def.locked) : null
  const locked = !!lock && 'held' in lock && lock.held
  if (!open && !locked) return null
  if (!open) {
    // Only the lock says so (its run row is not written yet, or another business's tick): it is renewed while the run lives.
    return `${def.name} is running now: its lock is held by a run in progress. The lock lets go when that run ends — or, if the run died, about 90 seconds after it stopped renewing it. Ask again after that.`
  }
  const swept = new Date(open.startedAt.getTime() + SWEPT_BY_MS)
  const end = usualMs != null ? new Date(open.startedAt.getTime() + usualMs) : null
  const usual = end && end.getTime() > now.getTime()
    ? ` Its runs usually take about ${minutes(usualMs!)} min, so it should end around ${at(end)}.`
    : end ? ` It has run longer than its usual ${minutes(usualMs!)} min.` : ''
  return `${def.name} is running now: a run started at ${at(open.startedAt)} and its record is still open.${usual} If that run died, its record stays open until the stale-run sweep closes it, by ${at(swept)} at the latest${def.locked ? ` (its lock lets go about 90 seconds after the run stopped; the record decides here)` : ''}. Ask again after that.`
}

/** The rules evaluator has no Control Room lever: what its rules may do now, and whether the account lets them. */
async function rulesLevel(): Promise<{ level: string; why: string; refusal: string | null }> {
  if (process.env.NEXUS_ADS_AUTOMATION_KILL === '1') return { level: 'OFF', why: 'NEXUS_ADS_AUTOMATION_KILL is set', refusal: 'NEXUS_ADS_AUTOMATION_KILL is set on the server: no rule runs until it is cleared' }
  const { resolveAutonomy } = await import('./ads-autonomy.js')
  const { getAutomationState } = await import('./ads-automation-state.service.js')
  const [rules, state] = await Promise.all([
    prisma.automationRule.findMany({ where: { domain: 'advertising', enabled: true }, select: { enabled: true, dryRun: true, autonomyLevel: true } }),
    getAutomationState(),
  ])
  const counts: Record<string, number> = {}
  for (const r of rules) { const l = resolveAutonomy(r as never); counts[l] = (counts[l] ?? 0) + 1 }
  const said = ['AUTO', 'PROPOSE', 'OBSERVE'].filter((l) => counts[l]).map((l) => `${counts[l]} at ${l === 'AUTO' ? 'Auto (they write)' : l === 'PROPOSE' ? 'Propose (they suggest)' : 'Observe (they record)'}`).join(', ')
  if (state.halted || state.autonomy === 'OFF') return { level: 'OFF', why: state.halted ? 'Ads automation is halted' : 'Account autonomy is OFF', refusal: `${state.halted ? 'Ads automation is halted' : 'Account autonomy is OFF'}: a run would write nothing. It is resumed in the Ads Control Room` }
  const capped = state.autonomy === 'SUGGEST' ? ' — account autonomy is SUGGEST, so every rule only suggests this run' : ''
  return { level: state.autonomy === 'SUGGEST' ? 'PROPOSE' : counts.AUTO ? 'AUTO' : counts.PROPOSE ? 'PROPOSE' : counts.OBSERVE ? 'OBSERVE' : 'OFF', why: `${rules.length ? `${rules.length} enabled rules: ${said}` : 'no rule is switched on'}${capped}`, refusal: rules.length ? null : 'no Amazon ads rule is switched on, so a run would do nothing' }
}

/** A request decided: the plan, or why it is refused (not queued). Reads only; `now` for tests. */
export async function planEngineRun(engine: RunNowEngine, now = new Date()): Promise<{ plan: EnginePlan } | { error: string }> {
  const def = RUN_NOW_ENGINES[engine]
  if (!def) return { error: `There is no engine "${String(engine)}" to run now (${RUN_NOW_ENGINE_KEYS.join(', ')}).` }
  let level: string
  let levelWhy: string
  let schedule: string
  if (def.lever) {
    // The Control Room's own answer: its level, and whether its drawer offers Run now (registry, off, a live run refused).
    const { getEngineLevers } = await import('./ads-control-room.service.js')
    const { getEngineDetail } = await import('./ads-control-room-detail.service.js')
    const [{ levers }, detail] = await Promise.all([getEngineLevers(), getEngineDetail(def.lever)])
    const lever = levers.find((l) => l.key === def.lever)
    if (!lever || !detail) return { error: `Not queued: the Ads Control Room does not list ${def.name} here.` }
    if (!detail.run.available) return { error: `Not queued: the Ads Control Room does not offer Run now for ${def.name} — ${(detail.run.why ?? 'it is not offered').replace(/^Not offered:?\s*/i, '')}.` }
    level = lever.mode
    levelWhy = lever.modeReason
    schedule = lever.schedule ?? 'on its own schedule'
  } else if (engine === 'auto-undo') {
    // Its own switch (born OBSERVE) under the env and the account dial; OFF runs nothing.
    const { autoUndoLevel } = await import('./ads-auto-undo.service.js')
    const own = await autoUndoLevel()
    if (own.level === 'OFF') return { error: `Not queued: auto-undo is OFF here — ${own.why}.` }
    level = own.level
    levelWhy = own.why
    schedule = AUTO_UNDO_SCHEDULE_WORDS
  } else {
    const rules = await rulesLevel()
    if (rules.refusal) return { error: `Not queued: ${rules.refusal}.` }
    level = rules.level
    levelWhy = rules.why
    schedule = RULES_SCHEDULE
  }

  const { last, open, usualMs } = await runsOf(def.job, now)
  const running = await inProgress(engine, open, usualMs, now)
  if (running) return { error: `Not queued: ${running}` }

  const lastRun: LastRun | null = last
    ? {
        at: last.startedAt.toISOString(),
        status: last.status,
        by: last.triggeredBy === 'manual' ? 'hand' : 'schedule',
        summary: last.outputSummary ?? last.errorMessage ?? null,
        minutes: last.finishedAt ? minutes(last.finishedAt.getTime() - last.startedAt.getTime()) : null,
      }
    : null
  const lastWords = last
    ? `It last ran ${ago(last.startedAt, now)}, at ${at(last.startedAt)} (${last.triggeredBy === 'manual' ? 'by hand' : 'on its schedule'}, ${last.status.toLowerCase()}${lastRun?.summary ? `: ${lastRun.summary}` : ''}). It runs on its own ${schedule}.`
    : `Nexus has no record of a run of it in this business. It runs on its own ${schedule}.`
  const warning: string = def.again
  const overlap = 'overlap' in def ? `${def.name}: ${def.overlap}.` : null
  const acts = level === 'AUTO'
    ? 'At Auto its changes reach Amazon through the write gate, as on any run'
    : level === 'PROPOSE' ? 'Below Auto: it only suggests or records, and nothing reaches Amazon without a person' : level === 'OBSERVE' ? 'At Observe it computes and records, and writes nothing' : 'It is off: a run does nothing'
  const effect = `Runs ${def.name} once now, the Control Room's Run now, for this business. ${lastWords} ${acts}: its own level (${level}), limits and Amazon's write gate decide every change, as on its scheduled run. ${warning}`
  return {
    plan: {
      action: 'run-ad-engine-now',
      engine,
      name: def.name,
      job: def.job,
      level,
      levelWhy,
      schedule,
      lastRun,
      summary: effect,
      effect,
      warning,
      steps: def.steps,
      warnings: [warning, ...(overlap ? [overlap] : []), ...(level === 'AUTO' ? ['It changes Amazon at once, at the engine\'s own level: a run cannot be called back. Each change it makes is in the Change Log under the engine\'s name.'] : [])],
      reach: { engine: true, note: `the engine's own writes, through Amazon's write gate (live or sandbox as the gate decides for each one), at its own level ${level}` },
      basis: { lastRunAt: (scheduleMinutes(schedule) ?? 0) >= SLOW_ENGINE_MINUTES && last ? last.startedAt.toISOString() : null },
    },
  }
}

/**
 * Start an approved run: decided again (not while it runs, not where the Control Room would not offer it), then the
 * Control Room's own start. Returns at once; the run's row says how it went (approval-status reads it).
 */
export async function startEngineRun(engine: RunNowEngine): Promise<{ plan: EnginePlan; startedAt: string } | { error: string }> {
  const planned = await planEngineRun(engine)
  if ('error' in planned) return planned
  // The check again just before the start (the Control Room reads above take a moment): a run begun meanwhile refuses.
  const now = new Date()
  const { open, usualMs } = await runsOf(planned.plan.job, now)
  const running = await inProgress(engine, open, usualMs, now)
  if (running) return { error: `Not run: ${running}` }
  const startedAt = now.toISOString()
  const { startCronByHand } = await import('../sync-logs/cron-trigger.service.js')
  const { logger } = await import('../../utils/logger.js')
  const { outsideDatabaseTransaction } = await import('../../lib/database-context.js')
  // The run outlives this request: it never joins a database transaction the caller may hold (the business stays).
  const started = await outsideDatabaseTransaction(async () =>
    startCronByHand(planned.plan.job, (err) => logger.error('[run-ad-engine-now] the run threw', { job: planned.plan.job, error: String(err) })))
  if (!started) return { error: `Not run: ${planned.plan.job} is not in the registry of jobs that can run by hand.` }
  return { plan: planned.plan, startedAt }
}

/** The run a request started: the first hand-run of its job from when it started (approval-status). */
export async function engineRunOf(job: string, startedAt: string): Promise<{ status: string; startedAt: string; finishedAt: string | null; runSummary: string | null } | null> {
  const from = new Date(new Date(startedAt).getTime() - 5_000)
  const row = await prisma.cronRun.findFirst({
    where: { jobName: job, triggeredBy: 'manual', startedAt: { gte: from } },
    orderBy: { startedAt: 'asc' },
    select: { status: true, startedAt: true, finishedAt: true, outputSummary: true, errorMessage: true },
  })
  return row ? { status: row.status, startedAt: row.startedAt.toISOString(), finishedAt: row.finishedAt?.toISOString() ?? null, runSummary: row.outputSummary ?? row.errorMessage ?? null } : null
}
