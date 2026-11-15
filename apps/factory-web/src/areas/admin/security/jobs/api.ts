import { z } from 'zod'
import { JOB_STATES, RUN_NOW_HELD } from '@nexus/factory-domain/integration-health/jobs'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'

/**
 * Jobs and integrations (B-W2b-415; PLT-221): the scheduled jobs with their runs and Run now. Mirrors apps/factory-api
 * platform/admin/jobs/contract.ts. A job is its cron key (the screen says it in words); a run's error is the job's own
 * message (data). Only containers call these.
 */

export const runSchema = z.object({
  id: z.string(),
  trigger: z.enum(['SCHEDULE', 'RUN_NOW']),
  status: z.enum(['RUNNING', 'SUCCEEDED', 'FAILED']),
  scheduledAt: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  error: z.string().nullable(),
  ranOn: z.string(),
  byPerson: z.boolean(),
})
export type JobRun = z.infer<typeof runSchema>

export const jobSchema = z.object({
  key: z.string(),
  known: z.boolean(),
  schedule: z.string().nullable(),
  timeZone: z.string().nullable(),
  policy: z.enum(['check', 'schedule']).nullable(),
  gate: z.enum(['ecbFeed']).nullable(),
  switchedOn: z.boolean().nullable(),
  state: z.enum(JOB_STATES),
  lastRun: runSchema.nullable(),
  lastFinished: runSchema.nullable(),
  nextRunAt: z.string().nullable(),
  missedAt: z.string().nullable(),
  failures7d: z.number(),
  runs7d: z.number(),
  waiting: z.number().nullable(),
  runNow: z.object({ held: z.enum(RUN_NOW_HELD).nullable() }),
})
export type Job = z.infer<typeof jobSchema>

const listAnswer = z.object({ jobs: z.array(jobSchema), outbox: z.object({ waiting: z.number(), dead: z.number() }), canRun: z.boolean(), waitingKnown: z.boolean(), asOf: z.string() })
export type JobList = z.infer<typeof listAnswer>

export const listJobs = (api: ApiClient) => api.get('/admin/jobs', { schema: listAnswer })

export const listRuns = (api: ApiClient, jobKey: string, before?: string | null) =>
  api.get(`/admin/jobs/${encodeURIComponent(jobKey)}/runs`, { query: { before: before ?? undefined, limit: 50 }, schema: z.object({ runs: z.array(runSchema), nextBefore: z.string().nullable() }) })

export const runNow = (api: ApiClient, jobKey: string, idempotencyKey: string = newIdempotencyKey()) =>
  api.post(`/admin/jobs/${encodeURIComponent(jobKey)}/run`, { body: {}, idempotencyKey, schema: z.object({ requestId: z.string(), jobKey: z.string() }) })
