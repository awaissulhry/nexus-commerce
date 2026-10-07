/**
 * ADS AUTONOMY W4-8 — "Run now" for an ads engine, asked by Claude (run-ad-engine-now): the SAME start the Ads Control
 * Room's drawer and the Sync Logs hub use (POST /sync-logs/cron/:jobName/trigger → startCronByHand: the registry's own
 * entry, one CronRun row marked manual), in the business of the call. Nothing of the engine changes: its writes keep its
 * own level, limits, actor and Amazon's write gate, exactly as a scheduled tick's — and a live run of a locked engine
 * passes its switch, the scheduler's arm flags and the engine lock (ads-engine-lock.ts guardLiveRun) as the tick does.
 *
 * What the plan says (Owner 10-07: Run now stays his own control; one press cut bids a second time): when the engine
 * last ran and how often it runs, and that a run on the same data as the last one takes one more step — an engine does
 * not remember that it just moved a bid or a budget, so what it moved then it may move again now. It is refused while
 * the engine runs (its lock is held, or its run row is still open) — with when that run should end — and wherever the
 * Control Room would not offer the button (the engine is off, or a live run would be refused).
 *
 * Harvesting is not an engine of its own any more (HP5): Keyword Harvesting rules run in the rules evaluator (`rules`).
 * Budget pacing is budget enforcement (`budget-enforce`).
 */
import prisma from '../../db.js'
import { currentWorkspaceId, engineLockHeld, type LockedEngine } from './ads-engine-lock.js'

/** The engines Claude may ask to run now: the Control Room lever (null: the rules evaluator has none), its job, its lock. */
export const RUN_NOW_ENGINES = {
  'auto-bid': { lever: 'auto-bid', job: 'ads-auto-bid', locked: 'auto-bid', name: 'Bid optimiser (auto-bid)', everyMinutes: 360 },
  'rank-defend': { lever: 'rank-defend', job: 'ad-rank-defend', locked: 'rank-defend', name: 'Hourly bid plans (rank-defend)', everyMinutes: 15 },
  'budget-enforce': { lever: 'budget-enforce', job: 'ad-budget-enforce', locked: 'budget-enforce', name: 'Budget enforcement (pacing and the over-spend stop)', everyMinutes: 30 },
  pool: { lever: 'budget-pools', job: 'budget-pool-rebalance', locked: null, name: 'Budget pools (rebalance)', everyMinutes: 15 },
  rules: { lever: null, job: 'advertising-rule-evaluator', locked: null, name: 'Amazon ads rules (the rules evaluator, harvesting included)', everyMinutes: 15 },
  dayparting: { lever: 'dayparting', job: 'ad-dayparting', locked: null, name: 'Classic dayparting', everyMinutes: 15 },
  'tos-defense': { lever: 'tos-defense', job: 'top-of-search-defense', locked: 'tos-defense', name: 'Top-of-search defense', everyMinutes: 30 },
} as const satisfies Record<string, { lever: string | null; job: string; locked: LockedEngine | null; name: string; everyMinutes: number }>
export type RunNowEngine = keyof typeof RUN_NOW_ENGINES
export const RUN_NOW_ENGINE_KEYS = Object.keys(RUN_NOW_ENGINES) as [RunNowEngine, ...RunNowEngine[]]

/** A run row older than this and still open is a run that died before it could close its row: not a run in progress. */
const OPEN_RUN_MAX_MS = 6 * 3600_000
/** An engine that runs this often or less is frozen at its last run: a tick in between makes the approved run another one. */
const SLOW_ENGINE_MINUTES = 60

const at = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000))
const ago = (d: Date, now: Date) => {
  const m = minutes(now.getTime() - d.getTime())
  return m < 120 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`
}
const every = (m: number) => (m >= 60 ? `every ${m / 60} h` : `every ${m} min`)

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
  warning: string
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

/** Why a run may not start now because one is in progress, with when it should end; null when none runs. */
async function inProgress(engine: RunNowEngine, open: { startedAt: Date } | null, usualMs: number | null, now: Date): Promise<string | null> {
  const def = RUN_NOW_ENGINES[engine]
  const lock = def.locked ? await engineLockHeld(currentWorkspaceId(), def.locked) : null
  const locked = !!lock && 'held' in lock && lock.held
  if (!open && !locked) return null
  const end = open && usualMs != null ? new Date(open.startedAt.getTime() + usualMs) : null
  const started = open ? `It started at ${at(open.startedAt)}` : 'Its lock is held by a run in progress'
  const ends = end
    ? end.getTime() > now.getTime()
      ? `; its runs usually take about ${minutes(usualMs!)} min, so it should end around ${at(end)}`
      : `; it has run longer than its usual ${minutes(usualMs!)} min, and its lock lets go within 90 seconds of a run that died`
    : '; its lock lets go when the run ends, or within 90 seconds of a run that died'
  return `${def.name} is running now, and two runs never overlap. ${started}${ends}. Ask again after that.`
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
  } else {
    const rules = await rulesLevel()
    if (rules.refusal) return { error: `Not queued: ${rules.refusal}.` }
    level = rules.level
    levelWhy = rules.why
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
  const schedule = every(def.everyMinutes)
  const lastWords = last
    ? `It last ran ${ago(last.startedAt, now)}, at ${at(last.startedAt)} (${last.triggeredBy === 'manual' ? 'by hand' : 'on its schedule'}, ${last.status.toLowerCase()}${lastRun?.summary ? `: ${lastRun.summary}` : ''}). It runs on its own ${schedule}.`
    : `Nexus has no record of a run of it in this business. It runs on its own ${schedule}.`
  const warning = 'A second run on the same data takes one more step: the engine does not remember that it just moved a bid or a budget, so what it moved on its last run it may move again now — a cut of up to its largest step again, or a raise — until new report data arrives.'
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
      warnings: [warning, ...(level === 'AUTO' ? ['It changes Amazon at once, at the engine\'s own level: a run cannot be called back. Each change it makes is in the Change Log under the engine\'s name.'] : [])],
      reach: { engine: true, note: `the engine's own writes, through Amazon's write gate (live or sandbox as the gate decides for each one), at its own level ${level}` },
      basis: { lastRunAt: def.everyMinutes >= SLOW_ENGINE_MINUTES && last ? last.startedAt.toISOString() : null },
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
  const startedAt = new Date().toISOString()
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
