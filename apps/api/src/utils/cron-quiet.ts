/**
 * C2 (2026-10-10) — the scheduled jobs that are quiet BY DESIGN, for the two detectors that judge a job by its silence:
 * the minute alert "Critical cron stopped" (`detectOverdueCrons`, services/alert-evaluator.service.ts) and the platform
 * health check "Scheduled jobs" (`missedStretches`, services/platform-health/checks/scheduler.checks.ts). Both infer a
 * job's cadence from its CronRun history; these jobs leave gaps in that history that are not misses:
 *
 *   work-only       the job records a run only when its DATA holds work (a conversion waiting for Amazon's report) —
 *                   never because a switch is off. Its silence is never a miss. A failed, stuck or slow run is still
 *                   judged: those checks read the runs it did record.
 *   covered         a brain step whose work the product cycle took over: while the cycle runs, the step records nothing
 *                   (its products' step runs inside the cycle). Its silence is excused only while the cycle itself
 *                   recorded a run in the last COVER_FRESH_MS; the cycle is not on this list, so a real stop of the cycle
 *                   alarms, and from then on the steps are judged again. A lever switched off is not excused.
 *   expected-ticks  the job runs only at some ticks of its cadence — a window of UTC hours, or slots it records under
 *                   another job's name. A tick it does not expect is not a miss; an expected one still is.
 * A job that runs on a fixed clock while it is switched on or something is enrolled (the cycle, the retirement tick, the
 * lag-curve fit, the native-rules read) is NOT here: a real stop of it must alarm (review 2026-10-10).
 *
 * Keep the list short, each entry with its reason: a dead scheduler still shows through every other job. An env override
 * can move a job's schedule; `assumes` states the default the entry is written for. Pure: no database, no job module is
 * loaded (the names are strings; cron-quiet.vitest.test.ts holds them equal to the jobs' own constants).
 */

export type CronQuietRule =
  | { kind: 'work-only'; reason: string }
  | { kind: 'covered'; by: string; reason: string }
  | { kind: 'expected-ticks'; reason: string; assumes: string; expects: (at: Date) => boolean }

/** The product cycle's job (jobs/ads-brain-cycle.job.ts BRAIN_CYCLE_JOB): hourly at :55 while it is on. */
export const CYCLE_JOB = 'ads-brain-cycle'
/** How recent the covering job's last run must be for a covered job's silence to be excused: two of the cycle's hours. */
export const COVER_FRESH_MS = 2 * 3_600_000

const cycleStep = (what: string): CronQuietRule => ({
  kind: 'covered', by: CYCLE_JOB,
  reason: `while the product cycle runs, each enrolled product's ${what} runs inside the cycle and this job records nothing; excused only while the cycle itself runs`,
})
/** The bid brain's full run: the :45 tick of 00, 06, 12 and 18 UTC (jobs/ads-bid-brain.job.ts isFullSlot). */
const fullSlot = (at: Date): boolean => at.getUTCHours() % 6 === 0 && at.getUTCMinutes() >= 45

export const CRON_QUIET: Readonly<Record<string, CronQuietRule>> = {
  'fulfilment-conversion-confirm': { kind: 'work-only', reason: 'records a run only while an FBA ⇄ FBM change waits for Amazon\'s listings report' },
  'ads-brain-state': cycleStep('state step'),
  'ads-brain-terms-shadow': cycleStep('term ledger step'),
  'ads-brain-negatives': cycleStep('negatives step'),
  'ads-brain-harvest': cycleStep('harvest step'),
  'ads-brain-hours': cycleStep('hours step'),
  'ads-brain-structure': cycleStep('structure step'),
  'ads-brain-money-shadow': cycleStep('money step'),
  'ads-report-settle': {
    kind: 'expected-ticks', assumes: "'20 3-9 * * *' (NEXUS_ADS_REPORT_SETTLE_SCHEDULE moves it)",
    reason: 'runs hourly from 03:20 to 09:20 UTC only: the night between is not a miss',
    expects: (at) => at.getUTCHours() >= 3 && at.getUTCHours() <= 9,
  },
  'ads-bid-brain-live': {
    kind: 'expected-ticks', assumes: "'*/15 * * * *' with the full run at :45 of 00, 06, 12 and 18 UTC",
    reason: 'the :45 tick of 00, 06, 12 and 18 UTC is the full run, recorded as ads-bid-brain-shadow',
    expects: (at) => !fullSlot(at),
  },
  'ads-brain-money-live': {
    kind: 'expected-ticks', assumes: "'*/15 * * * *' with the full run at :45 of 00, 06, 12 and 18 UTC",
    reason: 'the :45 tick of 00, 06, 12 and 18 UTC is the money shadow\'s full run, recorded as ads-brain-money-shadow (or not at all)',
    expects: (at) => !fullSlot(at),
  },
}

export function cronQuietRule(job: string): CronQuietRule | null {
  return Object.prototype.hasOwnProperty.call(CRON_QUIET, job) ? CRON_QUIET[job] : null
}

export const isWorkOnly = (job: string): boolean => cronQuietRule(job)?.kind === 'work-only'

/**
 * Whether `job`'s silence now is by design: a work-only job always; a covered one while its covering job ran within
 * COVER_FRESH_MS of `nowMs` (`lastRunOf`: a job's last recorded run, ms; null when none in the history read).
 */
export function silenceExcused(job: string, nowMs: number, lastRunOf: (job: string) => number | null): boolean {
  const rule = cronQuietRule(job)
  if (rule?.kind === 'work-only') return true
  if (rule?.kind !== 'covered') return false
  const last = lastRunOf(rule.by)
  return last != null && nowMs - last <= COVER_FRESH_MS
}

/** Whether `job` records a run of its own at a tick at `at` (true for every job without an expected-ticks rule). */
export function expectsTick(job: string, at: Date): boolean {
  const rule = cronQuietRule(job)
  return rule?.kind === 'expected-ticks' ? rule.expects(at) : true
}

/** More ticks than this are never enumerated (a minute job silent for weeks); the count stops there. */
const MAX_TICKS = 50_000

/**
 * The ticks `job` was due at in (fromMs, toMs]: every `cadenceMs` after its last start `fromMs`, only those it expects.
 * For a job without an expected-ticks rule that is every tick.
 */
export function dueTicks(job: string, fromMs: number, toMs: number, cadenceMs: number): number[] {
  const out: number[] = []
  if (!(cadenceMs > 0) || toMs <= fromMs) return out
  for (let k = 1, t = fromMs + cadenceMs; t <= toMs && k <= MAX_TICKS; k++, t = fromMs + k * cadenceMs) {
    if (expectsTick(job, new Date(t))) out.push(t)
  }
  return out
}
