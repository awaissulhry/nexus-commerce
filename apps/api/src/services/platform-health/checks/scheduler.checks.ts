/**
 * Platform health — the scheduler: did every scheduled job run and finish, and did a process restart without a deploy.
 *
 * Why (2026-10-07): the scheduler ran out of memory at 03:20 UTC every night and every cron due after it was skipped —
 * node-cron does not replay a missed time. "Critical cron stopped" fired days later and named neither the jobs nor the
 * cause. These checks name both, within a day:
 *
 *   cron-runs   from CronRun's own history (14 days, scheduled runs only): each job's usual cadence (the median gap
 *               between its starts), the ticks it missed in the last 24 h (a gap past its cadence + grace), the runs that
 *               started and never ended (left RUNNING, or swept "stale" by cron-orphan-sweeper: the process died during
 *               the run), the jobs whose last run failed and the runs far slower than usual. Several jobs that went
 *               silent at the same time = the scheduler stopped then.
 *   processes   the scheduler's and the worker's heartbeat (lib/runtime-status): which instance is up, since when, under
 *               which deployment. Started again under the SAME deployment as the last watchdog run saw = a crash or an
 *               out-of-memory kill, not a deploy. Only the newest restart of a day is visible (a heartbeat keeps no
 *               history), and the evidence says so.
 */
import prisma from '../../../db.js'
import { HOUR, MINUTE, clockUtc, plural, withoutNumbers, type HealthCheck, type Verdict } from '../types.js'

// ── cron-runs ─────────────────────────────────────────────────────────────────────────────────────────

/** One job's 14 days of scheduled runs, as the database aggregates them. */
export interface CronJobStats {
  job: string
  runs: number
  lastAt: Date
  medianGapMs: number | null
  p80GapMs: number | null
  medianDurationMs: number | null
  runs24h: number
  failed24h: number
  lastStatus: string | null
  lastError: string | null
  /** Gaps in the last 24 h noticeably longer than the job's cadence: `at` is the start that ended the gap. */
  longGaps: Array<{ at: Date; gapMs: number }>
  /** Runs in the last 24 h far slower than the job's usual duration. */
  slow: Array<{ at: Date; durationMs: number }>
}

export interface CronFacts {
  jobs: CronJobStats[]
  /** Runs started in the last 26 h that never ended: still RUNNING after 2 h, or swept as stale. */
  unfinished: Array<{ job: string; startedAt: Date; swept: boolean }>
}

/** Fewer runs than this in 14 days: the cadence is not known well enough to call a gap a miss. */
const MIN_RUNS = 4
/** Only jobs that run at least weekly are judged on missed ticks. */
const MAX_CADENCE_MS = 8 * 24 * HOUR
/** How late a tick may be before it counts as missed: half the cadence, at least 15 minutes (a deploy's restart), at most 1 hour. */
export function graceFor(medianGapMs: number): number {
  return Math.min(Math.max(medianGapMs * 0.5, 15 * MINUTE), HOUR)
}
/** A job whose gaps vary too much (it records a run only when it had work) has no cadence to miss. */
export function isRegular(job: Pick<CronJobStats, 'runs' | 'medianGapMs' | 'p80GapMs'>): boolean {
  return job.runs >= MIN_RUNS && job.medianGapMs != null && job.medianGapMs > 0 && job.medianGapMs <= MAX_CADENCE_MS
    && job.p80GapMs != null && job.p80GapMs <= job.medianGapMs * 1.5
}

const STALE_SWEPT = 'stale (auto-swept'

async function gatherCronFacts(now: Date): Promise<CronFacts> {
  const since14d = new Date(now.getTime() - 14 * 24 * HOUR)
  const since24h = new Date(now.getTime() - 24 * HOUR)
  // One statement (the workspace adapter allows one): each job's cadence and duration over 14 days, its runs and
  // failures in the last 24 h, its last status, and only the gaps and durations of the last 24 h worth a look.
  const rows = await prisma.$queryRawUnsafe<Array<{
    job: string; runs: number; last_at: Date; med_gap: number | null; p80_gap: number | null; med_dur: number | null
    runs_24h: number; failed_24h: number; last_status: string | null; last_error: string | null
    long_gaps: Array<{ at: string; gapMs: number }> | null; slow: Array<{ at: string; durationMs: number }> | null
  }>>(`
    WITH r AS (
      SELECT "jobName" AS job, "startedAt" AS at, "status" AS status, "errorMessage" AS err,
             EXTRACT(EPOCH FROM ("startedAt" - LAG("startedAt") OVER (PARTITION BY "jobName" ORDER BY "startedAt"))) * 1000 AS gap,
             EXTRACT(EPOCH FROM ("finishedAt" - "startedAt")) * 1000 AS dur,
             ROW_NUMBER() OVER (PARTITION BY "jobName" ORDER BY "startedAt" DESC) AS rn
      FROM "CronRun"
      WHERE "startedAt" > $1 AND "triggeredBy" = 'cron'
    ),
    s AS (
      SELECT job, COUNT(*)::int AS runs, MAX(at) AS last_at,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) AS med_gap,
             percentile_cont(0.8) WITHIN GROUP (ORDER BY gap) AS p80_gap,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY dur) AS med_dur,
             COUNT(*) FILTER (WHERE at > $2)::int AS runs_24h,
             COUNT(*) FILTER (WHERE at > $2 AND status = 'FAILED' AND COALESCE(err, '') NOT LIKE '${STALE_SWEPT}%')::int AS failed_24h,
             MAX(status) FILTER (WHERE rn = 1) AS last_status,
             MAX(LEFT(err, 300)) FILTER (WHERE rn = 1) AS last_error
      FROM r GROUP BY job
    ),
    g AS (
      SELECT r.job, json_agg(json_build_object('at', r.at, 'gapMs', r.gap) ORDER BY r.at) AS long_gaps
      FROM r JOIN s ON s.job = r.job
      WHERE r.at > $2 AND s.med_gap IS NOT NULL AND r.gap > s.med_gap * 1.2 + 60000
      GROUP BY r.job
    ),
    d AS (
      SELECT r.job, json_agg(json_build_object('at', r.at, 'durationMs', r.dur) ORDER BY r.at) AS slow
      FROM r JOIN s ON s.job = r.job
      WHERE r.at > $2 AND s.med_dur IS NOT NULL AND r.dur > GREATEST(s.med_dur * 5, s.med_dur + 1800000)
      GROUP BY r.job
    )
    SELECT s.*, g.long_gaps, d.slow FROM s LEFT JOIN g ON g.job = s.job LEFT JOIN d ON d.job = s.job`, since14d, since24h)

  const unfinished = await prisma.cronRun.findMany({
    where: {
      startedAt: { gte: new Date(now.getTime() - 26 * HOUR) },
      OR: [
        { status: 'RUNNING', finishedAt: null, startedAt: { lt: new Date(now.getTime() - 2 * HOUR) } },
        { status: 'FAILED', errorMessage: { startsWith: STALE_SWEPT } },
      ],
    },
    select: { jobName: true, startedAt: true, status: true },
    orderBy: { startedAt: 'asc' },
    take: 300,
  })

  const num = (v: unknown) => (v == null ? null : Number(v))
  return {
    jobs: rows.map((r) => ({
      job: r.job,
      runs: Number(r.runs),
      lastAt: new Date(r.last_at),
      medianGapMs: num(r.med_gap),
      p80GapMs: num(r.p80_gap),
      medianDurationMs: num(r.med_dur),
      runs24h: Number(r.runs_24h),
      failed24h: Number(r.failed_24h),
      lastStatus: r.last_status,
      lastError: r.last_error,
      longGaps: (r.long_gaps ?? []).map((g) => ({ at: new Date(g.at), gapMs: Number(g.gapMs) })),
      slow: (r.slow ?? []).map((s) => ({ at: new Date(s.at), durationMs: Number(s.durationMs) })),
    })),
    unfinished: unfinished.map((u) => ({ job: u.jobName, startedAt: u.startedAt, swept: u.status === 'FAILED' })),
  }
}

/** One stretch in which a job did not start: from its first missed tick to the start that ended it (null: still silent). */
export interface MissedStretch {
  job: string
  /** The first tick that should have started and did not. */
  firstMissedAt: Date
  endedAt: Date | null
  missed: number
  cadenceMinutes: number
}

/** PURE. The ticks each regular job missed in the last 24 h (and a silence still running now, whatever its age). */
export function missedStretches(jobs: readonly CronJobStats[], now: Date): MissedStretch[] {
  const out: MissedStretch[] = []
  const windowStart = now.getTime() - 24 * HOUR
  for (const job of jobs) {
    if (!isRegular(job)) continue
    const cadence = job.medianGapMs!
    const grace = graceFor(cadence)
    for (const gap of job.longGaps) {
      if (gap.gapMs <= cadence + grace || gap.at.getTime() <= windowStart) continue
      const previous = gap.at.getTime() - gap.gapMs
      out.push({
        job: job.job, firstMissedAt: new Date(previous + cadence), endedAt: gap.at,
        missed: Math.max(1, Math.round(gap.gapMs / cadence) - 1), cadenceMinutes: Math.round(cadence / MINUTE),
      })
    }
    const silentFor = now.getTime() - job.lastAt.getTime()
    if (silentFor > cadence + grace) {
      out.push({
        job: job.job, firstMissedAt: new Date(job.lastAt.getTime() + cadence), endedAt: null,
        missed: Math.max(1, Math.floor((silentFor - grace) / cadence)), cadenceMinutes: Math.round(cadence / MINUTE),
      })
    }
  }
  return out.sort((a, b) => a.firstMissedAt.getTime() - b.firstMissedAt.getTime())
}

/** PURE. Moments when at least `min` different jobs did something at once (within 30 minutes): a process stopped then. */
export function clusters<T>(items: readonly T[], at: (item: T) => Date, job: (item: T) => string, min = 3): Array<{ at: Date; jobs: string[] }> {
  const sorted = [...items].sort((a, b) => at(a).getTime() - at(b).getTime())
  const out: Array<{ at: Date; jobs: string[] }> = []
  let i = 0
  while (i < sorted.length) {
    const start = at(sorted[i]).getTime()
    const jobs = new Set<string>()
    let j = i
    while (j < sorted.length && at(sorted[j]).getTime() - start <= 30 * MINUTE) jobs.add(job(sorted[j++]))
    if (jobs.size >= min) {
      out.push({ at: new Date(start), jobs: [...jobs] })
      i = j
    } else i++
  }
  return out
}

const names = (list: readonly string[], max = 8) => `${list.slice(0, max).join(', ')}${list.length > max ? ` and ${list.length - max} more` : ''}`

/** PURE. The verdict on the scheduled jobs. */
export function judgeCronRuns(facts: CronFacts, now: Date): Verdict {
  if (facts.jobs.length === 0) {
    return {
      status: 'unknown',
      message: 'Could not measure: no scheduled job recorded a run in this business in 14 days, so there is no cadence to check against.',
      likelyCause: 'The scheduler is not running for this business, or no job here records its runs.',
      nextStep: 'Open the Sync Logs hub (cron status): if it is empty too, check the scheduler service on Railway.',
      evidence: { jobsSeen: 0 },
    }
  }
  const stretches = missedStretches(facts.jobs, now)
  const missedJobs = [...new Set(stretches.map((s) => s.job))]
  const stillSilent = stretches.filter((s) => s.endedAt == null)
  const stopped = clusters(stretches, (s) => s.firstMissedAt, (s) => s.job)
  const died = clusters(facts.unfinished, (u) => u.startedAt, (u) => u.job, 2)
  const failing = facts.jobs.filter((j) => j.lastStatus === 'FAILED' && !(j.lastError ?? '').startsWith(STALE_SWEPT))
  const slow = facts.jobs.filter((j) => j.slow.length > 0)
  const judged = facts.jobs.filter(isRegular).length

  const fail = missedJobs.length >= 2 || stillSilent.some((s) => s.missed >= 2) || facts.unfinished.length >= 3 || stopped.length > 0
  const warn = missedJobs.length >= 1 || facts.unfinished.length >= 1 || failing.length >= 1 || slow.length >= 1

  const parts: string[] = []
  if (stopped.length) {
    parts.push(stopped.map((c) => `${plural(c.jobs.length, 'scheduled job')} stopped at about ${clockUtc(c.at)} (${names(c.jobs)})`).join('; '))
  }
  if (missedJobs.length) {
    const ticks = stretches.reduce((n, s) => n + s.missed, 0)
    parts.push(`${plural(missedJobs.length, 'job')} missed ${plural(ticks, 'run')} in the last 24 h (${names(missedJobs)})`
      + (stillSilent.length ? `; ${plural(stillSilent.length, 'job')} ${stillSilent.length === 1 ? 'is' : 'are'} still silent (${names(stillSilent.map((s) => s.job))})` : ''))
  }
  if (facts.unfinished.length) {
    parts.push(`${plural(facts.unfinished.length, 'run')} started and never finished${died.length ? `, ${died.map((c) => `${plural(c.jobs.length, 'job')} at about ${clockUtc(c.at)}`).join(' and ')}` : ''} (${names([...new Set(facts.unfinished.map((u) => u.job))])})`)
  }
  if (failing.length) parts.push(`${plural(failing.length, 'job')} failed on ${failing.length === 1 ? 'its' : 'their'} last run (${names(failing.map((j) => j.job))})`)
  if (slow.length) parts.push(`${plural(slow.length, 'job')} ran far slower than usual (${names(slow.map((j) => j.job))})`)

  let likelyCause: string | null = null
  let nextStep: string | null = null
  if (stopped.length || died.length) {
    const when = (stopped[0] ?? died[0]).at
    likelyCause = `The scheduler process stopped at about ${clockUtc(when)} — a crash, an out-of-memory kill or a long restart — so every job due after it was skipped (node-cron does not replay a missed time) and the runs in flight never ended.`
    nextStep = `Read the scheduler service's logs on Railway around ${clockUtc(when)} (look for "out of memory" or a restart), then press Run now on the Sync Logs hub for the jobs today needs.`
  } else if (missedJobs.length) {
    likelyCause = 'The job was not started at its usual time: a restart at that moment, its switch turned off, or its schedule changed. A job switched off on purpose stops showing here once its runs leave the 14-day history.'
    nextStep = 'Check the job on the Sync Logs hub (cron status) and press Run now if it should have run.'
  } else if (facts.unfinished.length) {
    likelyCause = 'A process stopped while the run was working (a crash, an out-of-memory kill or a deploy mid-run).'
    nextStep = 'Read the process logs on Railway at that time, and run the job again if its work did not complete.'
  } else if (failing.length) {
    likelyCause = 'The job threw on its last run: its error is in the evidence.'
    nextStep = 'Open the job on the Sync Logs hub to read the error, fix the cause, then press Run now.'
  } else if (slow.length) {
    likelyCause = 'A run took several times its usual duration: a slow channel, a large backlog or a database under load.'
    nextStep = 'Watch the next run: if it stays slow, look at what it waits on.'
  }

  return {
    status: fail ? 'fail' : warn ? 'warn' : 'ok',
    message: parts.length
      ? `${parts.join('. ')}.`
      : `All ${plural(judged, 'scheduled job')} with a steady cadence ran on time in the last 24 h, and every run finished.`,
    likelyCause,
    nextStep,
    evidence: {
      jobsSeen: facts.jobs.length,
      jobsJudged: judged,
      missed: stretches.slice(0, 40).map((s) => ({
        job: s.job, firstMissedAt: s.firstMissedAt.toISOString(), endedAt: s.endedAt?.toISOString() ?? null, missedRuns: s.missed, everyMinutes: s.cadenceMinutes,
      })),
      stoppedTogether: stopped.map((c) => ({ at: c.at.toISOString(), jobs: c.jobs.slice(0, 30) })),
      unfinished: facts.unfinished.slice(0, 30).map((u) => ({ job: u.job, startedAt: u.startedAt.toISOString(), how: u.swept ? 'swept as stale' : 'still RUNNING' })),
      lastRunFailed: failing.slice(0, 20).map((j) => ({ job: j.job, error: withoutNumbers(j.lastError, 200) || null, failedIn24h: j.failed24h })),
      slow: slow.slice(0, 20).map((j) => ({ job: j.job, usualMinutes: Math.round((j.medianDurationMs ?? 0) / MINUTE), runs: j.slow.slice(0, 3).map((s) => ({ at: s.at.toISOString(), minutes: Math.round(s.durationMs / MINUTE) })) })),
    },
  }
}

export const cronRunsCheck: HealthCheck<CronFacts> = {
  id: 'cron-runs',
  subsystem: 'scheduler',
  title: 'Scheduled jobs',
  watches: 'Every scheduled job ran at its usual cadence in the last 24 h and every run finished (missed runs, runs that never ended, failures, runs far slower than usual).',
  gather: (ctx) => ctx.memo('cron-facts', () => gatherCronFacts(ctx.now)),
  judge: judgeCronRuns,
}

// ── processes ─────────────────────────────────────────────────────────────────────────────────────────

export interface ProcessInstance {
  instanceId: string
  startedAt: string
  build: { sha: string | null; deployment: string | null } | null
}

export interface ProcessFacts {
  /** Why other processes could not be read at all (Redis), or null. */
  unreadable: string | null
  scheduler: ProcessInstance[]
  worker: ProcessInstance[]
  /** What the previous watchdog run saw, per role (its evidence). */
  previous: Partial<Record<'scheduler' | 'worker', { startedAt: string; deployment: string | null }>> | null
}

async function gatherProcessFacts(): Promise<ProcessFacts> {
  const { readLiveProcesses, snapshotsOf } = await import('../../../lib/runtime-status/process-snapshot.js')
  const live = await readLiveProcesses()
  const of = (role: 'scheduler' | 'worker') => snapshotsOf(live, role).map((s) => {
    const build = s.sections.build as { sha?: unknown; deployment?: unknown } | undefined
    return {
      instanceId: s.instanceId,
      startedAt: s.startedAt,
      build: build && typeof build === 'object'
        ? { sha: typeof build.sha === 'string' ? build.sha : null, deployment: typeof build.deployment === 'string' ? build.deployment : null }
        : null,
    }
  })
  const last = await prisma.platformHealthCheck.findFirst({
    where: { checkId: 'processes', status: { not: 'unknown' } },
    orderBy: { measuredAt: 'desc' },
    select: { evidence: true },
  })
  const seen = (last?.evidence as { seen?: ProcessFacts['previous'] } | null)?.seen ?? null
  return { unreadable: live.redisUnavailable, scheduler: of('scheduler'), worker: of('worker'), previous: seen }
}

/** PURE. The verdict on the scheduler's and the worker's processes. */
export function judgeProcesses(facts: ProcessFacts, now: Date): Verdict {
  const roles = ['scheduler', 'worker'] as const
  const seen: NonNullable<ProcessFacts['previous']> = {}
  const notes: string[] = []
  const crashes: string[] = []
  const missing: string[] = []
  for (const role of roles) {
    const instances = facts[role]
    if (!instances.length) {
      if (!facts.unreadable) missing.push(role)
      continue
    }
    const newest = instances.reduce((a, b) => (a.startedAt >= b.startedAt ? a : b))
    seen[role] = { startedAt: newest.startedAt, deployment: newest.build?.deployment ?? null }
    const started = Date.parse(newest.startedAt)
    if (now.getTime() - started > 24 * HOUR) continue
    const before = facts.previous?.[role]
    const sameDeployment = before?.deployment != null && newest.build?.deployment != null && before.deployment === newest.build.deployment
    if (before && sameDeployment && Date.parse(before.startedAt) < started) {
      crashes.push(`the ${role} started again at ${clockUtc(newest.startedAt)} under the same deployment as before — not a deploy`)
    } else if (before && before.deployment && newest.build?.deployment && before.deployment !== newest.build.deployment) {
      notes.push(`the ${role} restarted at ${clockUtc(newest.startedAt)} with a new deploy`)
    } else {
      notes.push(`the ${role} started at ${clockUtc(newest.startedAt)} (whether by a deploy cannot be told${newest.build?.deployment ? ' yet: no earlier reading to compare' : ': it does not report its deployment'})`)
    }
  }
  const evidence = {
    seen,
    scheduler: facts.scheduler.map((i) => ({ startedAt: i.startedAt, deployment: i.build?.deployment ?? null, sha: i.build?.sha ?? null })),
    worker: facts.worker.map((i) => ({ startedAt: i.startedAt, deployment: i.build?.deployment ?? null, sha: i.build?.sha ?? null })),
    previous: facts.previous,
    note: 'A heartbeat keeps no history: only the newest start of each process is visible, not every restart of the day.',
  }
  if (facts.unreadable && !facts.scheduler.length && !facts.worker.length) {
    return { status: 'unknown', message: `Could not measure: ${facts.unreadable}.`, likelyCause: null, nextStep: 'Check that Redis is reachable from the scheduler.', evidence }
  }
  if (missing.length) {
    return {
      status: 'fail',
      message: `No heartbeat from the ${missing.join(' or the ')} process: it is not running, or cannot reach Redis.${crashes.length ? ` Also: ${crashes.join('; ')}.` : ''}`,
      likelyCause: missing.includes('worker') ? 'The worker service is down, so queued channel writes and jobs wait for the drain crons.' : 'The scheduler service is down, so no scheduled job runs.',
      nextStep: `Open the ${missing.join(' and ')} service on Railway: its status and its latest logs.`,
      evidence,
    }
  }
  if (crashes.length) {
    return {
      status: 'warn',
      message: `${crashes.join('; ')}.`,
      likelyCause: 'A crash or an out-of-memory kill: Railway restarted the process. Every job due while it was down was skipped (see Scheduled jobs).',
      nextStep: 'Read that service\'s logs on Railway just before the restart (look for "out of memory" or "heap").',
      evidence,
    }
  }
  return {
    status: 'ok',
    message: notes.length ? `Both processes report. ${notes.join('; ')}.` : 'The scheduler and the worker report, and neither restarted in the last 24 h.',
    likelyCause: null,
    nextStep: null,
    evidence,
  }
}

export const processesCheck: HealthCheck<ProcessFacts> = {
  id: 'processes',
  subsystem: 'scheduler',
  title: 'Scheduler and worker processes',
  watches: 'The scheduler and the worker are up, and neither restarted in the last 24 h without a deploy (a crash or an out-of-memory kill).',
  gather: () => gatherProcessFacts(),
  judge: judgeProcesses,
}
