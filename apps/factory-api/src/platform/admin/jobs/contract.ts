import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { JOB_STATES, RUN_NOW_HELD } from '@nexus/factory-domain/integration-health/jobs'

/**
 * Admin › Security › Jobs and integrations (B-W2b-415; PLT-221; design admin.security sec:jobs, pop:run-now): the scheduled
 * jobs with their runs and Run now. A job is named by its cron key; the web says it in words. A run's error is the job's
 * own message (no secret, no personal data).
 */

const JOB_KEY = z.string().regex(/^[a-z][a-zA-Z0-9]*(?:[.-][a-zA-Z0-9]+)+$/).max(100)

export const runView = output({
  id: id(),
  trigger: z.enum(['SCHEDULE', 'RUN_NOW']),
  status: z.enum(['RUNNING', 'SUCCEEDED', 'FAILED']),
  /** The tick it was due at, or when a person asked. */
  scheduledAt: instant(),
  startedAt: instant(),
  finishedAt: instant().nullable(),
  durationMs: z.number().int().nullable(),
  error: z.string().nullable(),
  /** The replica that ran it (host:process). */
  ranOn: z.string(),
  /** A person asked for it (Run now); who is in the audit log, never on the list. */
  byPerson: z.boolean(),
})
export type RunView = z.infer<typeof runView>

export const jobView = output({
  key: JOB_KEY,
  /** In the catalogue (a job with runs but no line there: false, no schedule). */
  known: z.boolean(),
  schedule: z.string().nullable(),
  timeZone: z.string().nullable(),
  policy: z.enum(['check', 'schedule']).nullable(),
  gate: z.enum(['ecbFeed']).nullable(),
  /** Its switch, when it waits for one. */
  switchedOn: z.boolean().nullable(),
  state: z.enum(JOB_STATES),
  lastRun: runView.nullable(),
  /** The latest finished run (the result). */
  lastFinished: runView.nullable(),
  nextRunAt: instant().nullable(),
  /** The first tick after the latest scheduled run with no run, when it is late. */
  missedAt: instant().nullable(),
  failures7d: z.number().int(),
  runs7d: z.number().int(),
  /** Run-now requests waiting for the scheduler; null when the scheduler's list cannot be read. */
  waiting: z.number().int().nullable(),
  runNow: output({ held: z.enum(RUN_NOW_HELD).nullable() }),
})
export type JobView = z.infer<typeof jobView>

export const listJobsContract = defineContract({
  response: {
    200: output({
      jobs: z.array(jobView),
      /** The tenant's events waiting for the relay, and dead ones (the error queue holds those). */
      outbox: output({ waiting: z.number().int(), dead: z.number().int() }),
      /** The person may Run now (security.jobs.run). */
      canRun: z.boolean(),
      waitingKnown: z.boolean(),
      asOf: instant(),
    }),
  },
})

const jobParams = input({ jobKey: JOB_KEY })

export const listRunsContract = defineContract({
  params: jobParams,
  querystring: input({ before: id().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: { 200: output({ runs: z.array(runView), nextBefore: id().nullable() }) },
})

export const runNowContract = defineContract({
  params: jobParams,
  body: input({}).optional(),
  response: { 200: output({ requestId: id(), jobKey: JOB_KEY }) },
})
