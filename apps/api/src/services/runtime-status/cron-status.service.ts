/**
 * Cron status as the API can honestly know it.
 *
 * The job modules keep `scheduledTask` / `lastRunAt` / `lastSummary` in memory, and since the process split
 * that memory belongs to the scheduler. The API's copy of those modules never scheduled or ran anything, so
 * their getters answered "not scheduled, never ran" for every cron. Two shared sources replace them:
 *
 * - Runs: the CronRun table that `recordCronRun` writes for every tick, scoped to the caller's business
 *   (the in-memory value held whichever business ran last).
 * - Scheduled: the list of cron modules the scheduler publishes in its runtime snapshot. With no live
 *   scheduler snapshot the answer is null plus an UnknownValue, never `false`.
 *
 * Values only the scheduler's memory ever held (a job's structured last summary) are returned as null with
 * an UnknownValue; `lastRun.outputSummary` carries the text summary the same run recorded.
 */
import prisma from '../../db.js'
import {
  readFlag, readLiveProcesses, snapshotsOf, unknownFor,
  type LiveProcesses, type ProcessRole, type UnknownValue,
} from '../../lib/runtime-status/process-snapshot.js'
import { flagValueEnabled } from '../../utils/env-flag.js'

export interface CronRunView {
  id: string
  status: string
  startedAt: Date
  finishedAt: Date | null
  outputSummary: string | null
  errorMessage: string | null
  triggeredBy: string
}

export interface CronJobSpec {
  /** CronRun.jobName, as passed to recordCronRun. */
  jobName: string
  /** The module that calls cron.schedule, relative to src and without extension (e.g. 'jobs/auto-po-replenishment.job'). */
  module: string
  /** The process that schedules it. */
  owner?: ProcessRole
}

export interface CronJobStatus {
  /** Registered in a live owner process; null when that cannot be known (see `unknown`). */
  scheduled: boolean | null
  /** When the last SUCCESSFUL run finished (the in-memory value only ever recorded successes). */
  lastRunAt: Date | null
  /** The latest run of any outcome, so a failure after the last success is visible. */
  lastRun: CronRunView | null
  lastSuccess: CronRunView | null
  unknown: UnknownValue[]
}

const RUN_SELECT = { id: true, status: true, startedAt: true, finishedAt: true, outputSummary: true, errorMessage: true, triggeredBy: true } as const

export function resolveScheduled(live: LiveProcesses, module: string, owner: ProcessRole = 'scheduler', field = 'scheduled'): { value: boolean | null; unknown?: UnknownValue } {
  const owners = snapshotsOf(live, owner).filter(snapshot => Array.isArray(snapshot.sections.scheduledJobs))
  if (!owners.length) return { value: null, unknown: unknownFor(live, owner, field) }
  if (owners.some(snapshot => (snapshot.sections.scheduledJobs as string[]).includes(module))) return { value: true }
  if (owners.some(snapshot => !snapshot.ready)) {
    return { value: null, unknown: unknownFor(live, owner, field, `the ${owner} process is still registering its crons`) }
  }
  return { value: false }
}

export interface CronStatusOptions {
  live?: LiveProcesses
  /** Prefix for UnknownValue.field when the status is nested in a response (e.g. 'cron.'). */
  fieldPrefix?: string
}

export async function readCronJobStatus(spec: CronJobSpec, options: CronStatusOptions = {}): Promise<CronJobStatus> {
  const owner = spec.owner ?? 'scheduler'
  const [processes, lastRun, lastSuccess] = await Promise.all([
    options.live ?? readLiveProcesses(),
    prisma.cronRun.findFirst({ where: { jobName: spec.jobName }, orderBy: { startedAt: 'desc' }, select: RUN_SELECT }),
    prisma.cronRun.findFirst({ where: { jobName: spec.jobName, status: 'SUCCESS' }, orderBy: { startedAt: 'desc' }, select: RUN_SELECT }),
  ])
  const scheduled = resolveScheduled(processes, spec.module, owner, `${options.fieldPrefix ?? ''}scheduled`)
  return {
    scheduled: scheduled.value,
    lastRunAt: lastSuccess ? lastSuccess.finishedAt ?? lastSuccess.startedAt : null,
    lastRun,
    lastSuccess,
    unknown: scheduled.unknown ? [scheduled.unknown] : [],
  }
}

/**
 * The cron card a status endpoint returns: the fields the job's in-memory getter used to return (same names),
 * now from shared sources, plus `lastRun` and `unknown`.
 *
 * - `memoryOnly`: structured values only the scheduler's memory held. Returned as null; once a run exists they
 *   are listed in `unknown` (before any run, null is simply the truth).
 * - `fields`: values derived from the recorded runs (e.g. a count from the run's summary). A null there while a
 *   successful run exists is listed in `unknown` too.
 */
export async function readCronCard(
  spec: CronJobSpec,
  options: CronStatusOptions & { memoryOnly?: string[]; fields?: (status: CronJobStatus) => Record<string, unknown> } = {},
) {
  const status = await readCronJobStatus(spec, options)
  const prefix = options.fieldPrefix ?? ''
  const fields = options.fields?.(status) ?? {}
  const unknown = [...status.unknown]
  if (status.lastSuccess) {
    for (const field of options.memoryOnly ?? []) unknown.push(schedulerMemoryOnly(prefix + field))
    for (const [field, value] of Object.entries(fields)) {
      if (value === null) unknown.push({ field: prefix + field, owner: 'scheduler', reason: 'the last successful run did not record it in its summary' })
    }
  }
  return {
    scheduled: status.scheduled,
    lastRunAt: status.lastRunAt,
    ...Object.fromEntries((options.memoryOnly ?? []).map(field => [field, null])),
    ...fields,
    lastRun: status.lastRun,
    unknown,
  }
}

/** The leading count of a summary such as "3 POs from 12 eligible recs (errors=0)". */
export function leadingCount(summary: string | null | undefined, pattern: RegExp): number | null {
  const match = summary ? pattern.exec(summary) : null
  return match ? Number(match[1]) : null
}

/** A structured value the scheduler kept only in memory. */
export function schedulerMemoryOnly(field: string): UnknownValue {
  return {
    field,
    owner: 'scheduler',
    reason: 'held only in the scheduler process memory, which the API cannot read; lastRun.outputSummary is the text summary that run recorded',
  }
}

/** A count the job writes into its recorded summary, e.g. 'released' from "released=3". Null when absent. */
export function summaryCount(summary: string | null | undefined, key: string): number | null {
  if (!summary) return null
  const match = new RegExp(`(?:^|\\s)${key}=(\\d+)(?:\\s|$)`).exec(summary)
  return match ? Number(match[1]) : null
}

/** A flag as the scheduler sees it: enabled / disabled, or null with the reason it cannot be known. */
export function schedulerFlagEnabled(live: LiveProcesses, name: string, isEnabled: (raw: string | null) => boolean, field = name): { value: boolean | null; unknown?: UnknownValue } {
  const flag = readFlag(live, 'scheduler', name, field)
  return flag.known ? { value: isEnabled(flag.raw) } : { value: null, unknown: flag.unknown }
}

/**
 * The crons whose status the API reports. `module` must be the file that calls cron.schedule, exactly as
 * lib/cron/clustered.ts records it; runtime-status.vitest.test.ts starts each one to prove it.
 */
export const CRON_JOBS = {
  leadTimeStats: { jobName: 'lead-time-stats', module: 'jobs/lead-time-stats.job' },
  stockoutDetector: { jobName: 'stockout-detector', module: 'jobs/stockout-detector.job' },
  fbaRestock: { jobName: 'fba-restock-ingestion', module: 'jobs/fba-restock-ingestion.job' },
  autoPo: { jobName: 'auto-po', module: 'jobs/auto-po-replenishment.job' },
  forecastAccuracy: { jobName: 'forecast-accuracy', module: 'jobs/forecast-accuracy.job' },
  abcClassification: { jobName: 'abc-classification', module: 'jobs/abc-classification.job' },
  automationRuleEvaluator: { jobName: 'automation-rule-evaluator', module: 'jobs/automation-rule-evaluator.job' },
  fbaStatusPoll: { jobName: 'fba-status-poll', module: 'jobs/fba-status-poll.job' },
  syncDriftDetection: { jobName: 'sync-drift-detection', module: 'jobs/sync-drift-detection.job' },
  reservationSweep: { jobName: 'reservation-sweep', module: 'jobs/reservation-sweep.job' },
  advertisingRuleEvaluator: { jobName: 'advertising-rule-evaluator', module: 'jobs/advertising-rule-evaluator.job' },
} as const satisfies Record<string, CronJobSpec>

/** The parsers the scheduler itself applies to its gates, so the answer matches what it did. */
export const flagIs = {
  one: (raw: string | null) => raw === '1',
  notZero: (raw: string | null) => raw !== '0',
  tolerant: (raw: string | null) => flagValueEnabled(raw),
}
