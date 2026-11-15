import { AsyncLocalStorage } from 'node:async_hooks'
import { hostname } from 'node:os'
import type { Redis } from 'ioredis'
import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { runErrorOf, runNowKeyOf, tickKeyOf } from '@nexus/factory-domain/integration-health/jobs'
import { activeTenants, asSystem, systemContext } from '../platform/outbox/system'
import { callerFor, command } from './command'
import { defineCron, runTick, type CronJob, type CronTick } from './cron'
import type { Log } from './queue'

/**
 * Every cron writes its run (B-W2b-415; PLT-221): one CronRun per tick and tenant (factory-db privacy-ops.prisma), and Run
 * now — a person's request, run ONCE in the cluster by the scheduler, for that person's tenant only.
 *
 *   recordedCrons(jobs, …)   background.ts's scheduler: each job wrapped so its tick (after core/cron.ts's Redis claim, so
 *                            on one replica only) first writes a RUNNING run in every active tenant
 *                            (`<job>@<the tick's epoch seconds>`: unique per tenant, so a doubled tick cannot write twice),
 *                            then runs, then marks each run SUCCEEDED or FAILED with the error in one message. Bookkeeping:
 *                            a SUCCEEDED run is a plain update; a FAILED one is a system command (audited, with the event
 *                            jobs.run_finished, so the Security page sees it at once). A run that cannot be written never
 *                            stops the job. Plus the Run-now poller below (not recorded itself: it is the jobs page's own
 *                            machinery, every 10 seconds).
 *   askRunNow(redis, …)      the API's Run now (platform/admin/jobs): the request on the list `<prefix>:cron:run-now`.
 *   the poller `jobs.runNow` every 10 s, clustered like any cron: pops a request (LPOP: one replica gets it), writes its
 *                            RUNNING run (`<job>@now:<request>`: a second delivery is refused by the unique key), runs the
 *                            job through core/cron.ts runTick — the same Redis claim as its scheduled ticks, so it is never a
 *                            second copy — inside `withOnlyTenant`: activeTenants() (platform/outbox/system.ts) answers only
 *                            the asking tenant there, so a Run now never works for another business. Then one system
 *                            command finishes the run (audited, jobs.run_finished).
 *
 * The run's replica is `<host>:<pid>`. Its error is the thrown message (no secret or personal data is put in an Error on
 * purpose: B-W2a-42's rule), at most 4000 characters.
 */

const scope = new AsyncLocalStorage<{ readonly tenantId: string }>()

/** Inside a Run now: the only tenant the job may work for (activeTenants answers just it); else null. */
export function onlyTenant(): string | null {
  return scope.getStore()?.tenantId ?? null
}

/** Runs `work` for one tenant only (Run now). */
export function withOnlyTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
  return scope.run({ tenantId }, work)
}

/** This replica, as a run names it. */
export function replicaName(): string {
  return `${hostname()}:${process.pid}`.replace(/\s+/g, ' ').slice(0, 200)
}

const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'

export interface CronRunSettings {
  readonly database: FactoryDatabase
  readonly redis: Redis
  readonly prefix: string
  readonly log: Log
  /** The replica's name (tests). Default `<host>:<pid>`. */
  readonly ranOn?: string
}

interface Written {
  readonly tenantId: string
  readonly id: string
}

/** The FAILED end of a run: a system command (audited) with jobs.run_finished. */
async function finishFailed(settings: CronRunSettings, run: Written, input: { jobKey: string; trigger: 'SCHEDULE' | 'RUN_NOW'; error: string; requestId: string }): Promise<void> {
  const caller = callerFor(settings.database, systemContext(run.tenantId, input.requestId))
  await command(caller, { name: 'jobs.runFailed', input: { runId: run.id, jobKey: input.jobKey, trigger: input.trigger } }, async (tools) => {
    await tools.tx.cronRun.update({ where: { id: run.id }, data: { status: 'FAILED', finishedAt: tools.now, error: input.error }, select: { id: true } })
    tools.audit({ recordType: 'CronRun', recordId: run.id, companyId: null, before: { status: 'RUNNING' }, after: { jobKey: input.jobKey, trigger: input.trigger, status: 'FAILED' } })
    tools.emit({ type: 'jobs.run_finished', subject: run.id, companyId: null, payload: { runId: run.id, jobKey: input.jobKey, trigger: input.trigger, status: 'FAILED' } })
    return { runId: run.id }
  })
}

/** One tick of a recorded job: the runs written, the job run, the runs finished. The job's own error is thrown again. */
export async function recordTick(job: CronJob, tick: CronTick, settings: CronRunSettings): Promise<void> {
  const requestId = `cron-${job.name}-${Math.floor(tick.scheduledAt.getTime() / 1000)}`
  const ranOn = settings.ranOn ?? replicaName()
  const written: Written[] = []
  let tenants: string[] = []
  try {
    tenants = await activeTenants(settings.database)
  } catch (error) {
    settings.log.warn({ cron: job.name, err: error }, 'the runs of a cron tick could not be written: the tenants were not read')
  }
  const startedAt = new Date()
  for (const tenantId of tenants) {
    const id = newId()
    try {
      await asSystem(settings.database, tenantId, requestId, (client) =>
        client.cronRun.create({
          data: { id, jobKey: job.name, trigger: 'SCHEDULE', key: tickKeyOf(job.name, tick.scheduledAt), scheduledAt: tick.scheduledAt, startedAt, status: 'RUNNING', ranOn },
          select: { id: true },
        }),
      )
      written.push({ tenantId, id })
    } catch (error) {
      if (!isUniqueViolation(error)) settings.log.warn({ cron: job.name, tenantId, err: error }, 'the run of a cron tick was not written')
    }
  }
  try {
    await job.run(tick)
  } catch (error) {
    const message = runErrorOf(error)
    for (const run of written) {
      await finishFailed(settings, run, { jobKey: job.name, trigger: 'SCHEDULE', error: message, requestId }).catch((failure) =>
        settings.log.warn({ cron: job.name, tenantId: run.tenantId, err: failure }, 'the failed run of a cron tick was not recorded'),
      )
    }
    throw error
  }
  for (const run of written) {
    await asSystem(settings.database, run.tenantId, requestId, (client) =>
      client.cronRun.update({ where: { id: run.id }, data: { status: 'SUCCEEDED', finishedAt: new Date() }, select: { id: true } }),
    ).catch((error) => settings.log.warn({ cron: job.name, tenantId: run.tenantId, err: error }, 'the run of a cron tick was not finished'))
  }
}

/** A job whose ticks write their runs. */
export function recordedCron(job: CronJob, settings: CronRunSettings): CronJob {
  return Object.freeze({ ...job, run: (tick: CronTick) => recordTick(job, tick, settings) })
}

/** What the API puts on the Run-now list. */
export interface RunNowRequest {
  readonly tenantId: string
  readonly jobKey: string
  /** The asking request's id (the run's key: `<job>@now:<requestId>`). */
  readonly requestId: string
  readonly requestedById: string
  /** ISO time it was asked. */
  readonly askedAt: string
}

export const RUN_NOW_JOB = 'jobs.runNow'
export const RUN_NOW_SCHEDULE = '*/10 * * * * *'
/** Requests one poller tick takes at most (the next tick takes the rest). */
export const RUN_NOW_BATCH = 5
/** Requests kept on the list at most (older ones fall off: a person asks again). */
export const RUN_NOW_LIST_MAX = 200

export function runNowListKey(prefix: string): string {
  return `${prefix}:cron:run-now`
}

/** The API's Run now: the request on the list, the list kept short. Throws when Redis does not answer. */
export async function askRunNow(redis: Redis, prefix: string, request: RunNowRequest): Promise<void> {
  const key = runNowListKey(prefix)
  await redis.rpush(key, JSON.stringify(request))
  await redis.ltrim(key, -RUN_NOW_LIST_MAX, -1)
}

/** The requests of one tenant still waiting on the list (the jobs page's "waiting"). */
export async function waitingRunNow(redis: Redis, prefix: string, tenantId: string): Promise<RunNowRequest[]> {
  const rows = await redis.lrange(runNowListKey(prefix), 0, RUN_NOW_LIST_MAX - 1)
  return rows.flatMap((text) => {
    const request = parseRequest(text)
    return request && request.tenantId === tenantId ? [request] : []
  })
}

function parseRequest(text: string): RunNowRequest | null {
  try {
    const value = JSON.parse(text) as Partial<RunNowRequest>
    if (typeof value.tenantId !== 'string' || typeof value.jobKey !== 'string' || typeof value.requestId !== 'string' || typeof value.requestedById !== 'string' || typeof value.askedAt !== 'string') return null
    return value as RunNowRequest
  } catch {
    return null
  }
}

/** One Run-now request: its run written, the job run for that tenant only through the clustered claim, the run finished. */
export async function runRequested(jobs: readonly CronJob[], request: RunNowRequest, settings: CronRunSettings): Promise<'ran' | 'failed' | 'unknown' | 'taken'> {
  const job = jobs.find((entry) => entry.name === request.jobKey)
  if (!job) {
    settings.log.warn({ cron: request.jobKey }, 'a Run now names no scheduled job; dropped')
    return 'unknown'
  }
  const requestId = `run-now-${request.requestId}`.slice(0, 200)
  const asked = new Date(request.askedAt)
  const startedAt = new Date()
  const run: Written = { tenantId: request.tenantId, id: newId() }
  try {
    await asSystem(settings.database, request.tenantId, requestId, (client) =>
      client.cronRun.create({
        data: {
          id: run.id,
          jobKey: job.name,
          trigger: 'RUN_NOW',
          key: runNowKeyOf(job.name, request.requestId),
          scheduledAt: Number.isNaN(asked.getTime()) || asked > startedAt ? startedAt : asked,
          requestedById: request.requestedById,
          startedAt,
          status: 'RUNNING',
          ranOn: settings.ranOn ?? replicaName(),
        },
        select: { id: true },
      }),
    )
  } catch (error) {
    if (isUniqueViolation(error)) return 'taken'
    throw error
  }
  let thrown: unknown = null
  const once: CronJob = { ...job, run: (tick) => withOnlyTenant(request.tenantId, () => job.run(tick)).catch((error: unknown) => {
    thrown = error
    throw error
  }) }
  // The same claim as a scheduled tick (core/cron.ts); the scheduled tick of that very second holds it: try the next.
  let outcome = await runTick(once, new Date(Math.floor(Date.now() / 1000) * 1000), settings)
  for (let attempt = 0; outcome === 'taken' && attempt < 3; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    outcome = await runTick(once, new Date(Math.floor(Date.now() / 1000) * 1000), settings)
  }
  if (outcome === 'ran') {
    const caller = callerFor(settings.database, systemContext(request.tenantId, requestId))
    await command(caller, { name: 'jobs.runFinished', input: { runId: run.id, jobKey: job.name } }, async (tools) => {
      await tools.tx.cronRun.update({ where: { id: run.id }, data: { status: 'SUCCEEDED', finishedAt: tools.now }, select: { id: true } })
      tools.audit({ recordType: 'CronRun', recordId: run.id, companyId: null, before: { status: 'RUNNING' }, after: { jobKey: job.name, trigger: 'RUN_NOW', status: 'SUCCEEDED' } })
      tools.emit({ type: 'jobs.run_finished', subject: run.id, companyId: null, payload: { runId: run.id, jobKey: job.name, trigger: 'RUN_NOW', status: 'SUCCEEDED' } })
      return { runId: run.id }
    })
    return 'ran'
  }
  const error =
    outcome === 'failed'
      ? runErrorOf(thrown)
      : outcome === 'no_lock'
        ? 'The cluster lock (Redis) did not answer: nothing ran.'
        : 'The scheduled runs of the same seconds held the claim: nothing ran.'
  await finishFailed(settings, run, { jobKey: job.name, trigger: 'RUN_NOW', error, requestId })
  return 'failed'
}

/** The Run-now poller: every 10 seconds, up to RUN_NOW_BATCH requests popped and run one after the other. */
export function runNowCron(jobs: readonly CronJob[], settings: CronRunSettings): CronJob {
  return defineCron({
    name: RUN_NOW_JOB,
    schedule: RUN_NOW_SCHEDULE,
    lockTtlMs: 9_000,
    async run() {
      for (let taken = 0; taken < RUN_NOW_BATCH; taken++) {
        const text = await settings.redis.lpop(runNowListKey(settings.prefix))
        if (text === null) return
        const request = parseRequest(text)
        if (!request) {
          settings.log.warn({}, 'a Run now request could not be read; dropped')
          continue
        }
        await runRequested(jobs, request, settings).catch((error) => settings.log.error({ cron: request.jobKey, err: error }, 'a Run now could not be recorded'))
      }
    },
  })
}

/** background.ts's scheduler: every job recorded, plus the Run-now poller (which runs the jobs as they are). */
export function recordedCrons(jobs: readonly CronJob[], settings: CronRunSettings): CronJob[] {
  return [...jobs.map((job) => recordedCron(job, settings)), runNowCron(jobs, settings)]
}
