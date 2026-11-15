import type { Prisma } from '@nexus/factory-db'
import { SECURITY_JOBS_RUN } from '@nexus/factory-domain/integration-health/permissions'
import { InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { jobStateOf, missedTickOf, nextRunOf, runNowHeldOf, type RunFacts, type RunNowHeld } from '@nexus/factory-domain/integration-health/jobs'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext, type RequestContext } from '../../../core/context'
import { askRunNow, waitingRunNow, type RunNowRequest } from '../../../core/cron-runs'
import { ApiError } from '../../../core/errors'
import { JOB_CATALOGUE, jobEntryOf, switchedOn, type JobEntry } from './catalogue'
import type { JobView, RunView } from './contract'
import { processHealthRedis } from './redis'

/**
 * Admin › Security › Jobs and integrations (B-W2b-415; PLT-221; design admin.security sec:jobs, pop:run-now): each
 * scheduled job of the catalogue (and any job with runs the catalogue does not know) with its last run, result, next run,
 * failures in 7 days, Run-now requests waiting, its state (ok, running, stuck, failing, missed, never), and whether Run now
 * may ask it. Tenant-wide (security.view to read, security.jobs.run to run): runs are rows of this tenant only.
 *
 * Run now: ONE command `jobs.runNow` (audited on the tenant, event jobs.run_requested) that puts the request on the
 * scheduler's Run-now list (core/cron-runs.ts) inside its transaction — Redis down: 503 in words, nothing asked. The
 * scheduler runs it once in the cluster for this tenant only and records the run (trigger RUN_NOW, who asked).
 */

type Client = Prisma.TransactionClient

const DAY_MS = 24 * 3_600_000

function contextOf(caller: CommandCaller): RequestContext {
  if (!caller.factoryContext) throw new ApiError('unauthenticated')
  return caller.factoryContext
}

/** The office session (these routes are office only). */
function officeOf(caller: CommandCaller): OfficeContext {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ApiError('forbidden')
  return context
}

interface RunRow {
  id: string
  jobKey: string
  trigger: 'SCHEDULE' | 'RUN_NOW'
  scheduledAt: Date
  startedAt: Date
  finishedAt: Date | null
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED'
  error: string | null
  ranOn: string
  requestedById: string | null
}

const RUN_SELECT = { id: true, jobKey: true, trigger: true, scheduledAt: true, startedAt: true, finishedAt: true, status: true, error: true, ranOn: true, requestedById: true } as const

function runView(row: RunRow): RunView {
  return {
    id: row.id,
    trigger: row.trigger,
    status: row.status,
    scheduledAt: toUtcIso(row.scheduledAt),
    startedAt: toUtcIso(row.startedAt),
    finishedAt: row.finishedAt ? toUtcIso(row.finishedAt) : null,
    durationMs: row.finishedAt ? Math.max(0, row.finishedAt.getTime() - row.startedAt.getTime()) : null,
    error: row.error,
    ranOn: row.ranOn,
    byPerson: row.requestedById !== null,
  }
}

const facts = (row: RunRow | undefined): RunFacts | null => (row ? { status: row.status, trigger: row.trigger, scheduledAt: row.scheduledAt, startedAt: row.startedAt } : null)

/** The latest run per job: of any trigger, finished, or scheduled (DISTINCT ON over the (tenant, job, tick) index). */
async function latestRuns(client: Client): Promise<{ any: Map<string, RunRow>; finished: Map<string, RunRow>; scheduled: Map<string, RunRow> }> {
  const [any, finished, scheduled] = await Promise.all([
    client.$queryRaw<RunRow[]>`SELECT DISTINCT ON ("jobKey") "id", "jobKey", "trigger"::text AS "trigger", "scheduledAt", "startedAt", "finishedAt", "status"::text AS "status", "error", "ranOn", "requestedById" FROM "CronRun" ORDER BY "jobKey", "startedAt" DESC, "id" DESC`,
    client.$queryRaw<RunRow[]>`SELECT DISTINCT ON ("jobKey") "id", "jobKey", "trigger"::text AS "trigger", "scheduledAt", "startedAt", "finishedAt", "status"::text AS "status", "error", "ranOn", "requestedById" FROM "CronRun" WHERE "status" <> 'RUNNING' ORDER BY "jobKey", "startedAt" DESC, "id" DESC`,
    client.$queryRaw<RunRow[]>`SELECT DISTINCT ON ("jobKey") "id", "jobKey", "trigger"::text AS "trigger", "scheduledAt", "startedAt", "finishedAt", "status"::text AS "status", "error", "ranOn", "requestedById" FROM "CronRun" WHERE "trigger" = 'SCHEDULE' ORDER BY "jobKey", "scheduledAt" DESC, "id" DESC`,
  ])
  const byKey = (rows: RunRow[]) => new Map(rows.map((row) => [row.jobKey, row]))
  return { any: byKey(any), finished: byKey(finished), scheduled: byKey(scheduled) }
}

/** The Run-now requests of this tenant waiting on the scheduler's list, per job; null when Redis does not answer. */
async function waitingOf(tenantId: string): Promise<Map<string, number> | null> {
  try {
    const { redis, prefix } = processHealthRedis()
    const requests = await waitingRunNow(redis, prefix, tenantId)
    const out = new Map<string, number>()
    for (const request of requests) out.set(request.jobKey, (out.get(request.jobKey) ?? 0) + 1)
    return out
  } catch {
    return null
  }
}

function viewOf(input: {
  key: string
  entry: JobEntry | null
  latest: RunRow | undefined
  finished: RunRow | undefined
  scheduled: RunRow | undefined
  failures: number
  runs: number
  waiting: number | null
  switched: boolean | null
  now: Date
}): JobView {
  const { entry, now } = input
  const asked = (input.waiting ?? 0) > 0 || (input.latest?.trigger === 'RUN_NOW' && input.latest.status === 'RUNNING')
  const held: RunNowHeld | null = runNowHeldOf({ known: entry !== null, policy: entry?.policy ?? null, switchedOn: input.switched, asked })
  const state = entry
    ? jobStateOf({ schedule: entry.schedule, timeZone: entry.timeZone, last: facts(input.latest), lastFinished: facts(input.finished), lastScheduled: facts(input.scheduled), now })
    : input.latest
      ? input.latest.status === 'RUNNING'
        ? 'running'
        : input.finished?.status === 'FAILED'
          ? 'failing'
          : 'ok'
      : 'never'
  const missed = entry ? missedTickOf({ schedule: entry.schedule, timeZone: entry.timeZone, lastScheduled: facts(input.scheduled), now }) : null
  const next = entry ? nextRunOf(entry.schedule, entry.timeZone, now) : null
  return {
    key: input.key,
    known: entry !== null,
    schedule: entry?.schedule ?? null,
    timeZone: entry?.timeZone ?? null,
    policy: entry?.policy ?? null,
    gate: entry?.gate ?? null,
    switchedOn: input.switched,
    state,
    lastRun: input.latest ? runView(input.latest) : null,
    lastFinished: input.finished ? runView(input.finished) : null,
    nextRunAt: next ? toUtcIso(next) : null,
    missedAt: missed ? toUtcIso(missed) : null,
    failures7d: input.failures,
    runs7d: input.runs,
    waiting: input.waiting,
    runNow: { held },
  }
}

/** GET /admin/jobs: every job, its runs summed up; the tenant's outbox (waiting, dead) for the queue line. */
export async function listJobs(caller: CommandCaller, now: Date = new Date()): Promise<{ jobs: JobView[]; outbox: { waiting: number; dead: number }; canRun: boolean; asOf: string; waitingKnown: boolean }> {
  const context = officeOf(caller)
  const waiting = await waitingOf(context.tenantId)
  return caller.withClient(async (client) => {
    const since = new Date(now.getTime() - 7 * DAY_MS)
    const [latest, failures, runs, waitingOutbox, dead, ecb] = await Promise.all([
      latestRuns(client),
      client.cronRun.groupBy({ by: ['jobKey'], where: { status: 'FAILED', startedAt: { gte: since } }, _count: { _all: true } }),
      client.cronRun.groupBy({ by: ['jobKey'], where: { startedAt: { gte: since } }, _count: { _all: true } }),
      client.outboxEvent.count({ where: { status: 'PENDING' } }),
      client.outboxEvent.count({ where: { status: 'DEAD' } }),
      Promise.all(JOB_CATALOGUE.filter((entry) => entry.gate !== null).map(async (entry) => [entry.key, await switchedOn(client, entry)] as const)),
    ])
    const failed = new Map(failures.map((row) => [row.jobKey, row._count._all]))
    const counted = new Map(runs.map((row) => [row.jobKey, row._count._all]))
    const gates = new Map(ecb)
    const keys = [...JOB_CATALOGUE.map((entry) => entry.key), ...[...latest.any.keys()].filter((key) => !jobEntryOf(key)).sort()]
    const jobs = keys.map((key) =>
      viewOf({
        key,
        entry: jobEntryOf(key),
        latest: latest.any.get(key),
        finished: latest.finished.get(key),
        scheduled: latest.scheduled.get(key),
        failures: failed.get(key) ?? 0,
        runs: counted.get(key) ?? 0,
        waiting: waiting ? (waiting.get(key) ?? 0) : null,
        switched: gates.get(key) ?? null,
        now,
      }),
    )
    return { jobs, outbox: { waiting: waitingOutbox, dead }, canRun: can(actorOf(context), SECURITY_JOBS_RUN, {}), asOf: toUtcIso(now), waitingKnown: waiting !== null }
  })
}

/** GET /admin/jobs/:jobKey/runs: the job's runs, newest first, 50 a page (`before` = the last run id read). */
export async function listRuns(caller: CommandCaller, jobKey: string, query: { before?: string | undefined; limit: number }): Promise<{ runs: RunView[]; nextBefore: string | null }> {
  return caller.withClient(async (client) => {
    let page: Prisma.CronRunWhereInput = {}
    if (query.before) {
      const anchor = await client.cronRun.findFirst({ where: { id: query.before, jobKey }, select: { id: true, startedAt: true } })
      if (!anchor) throw new ValidationError('No such run to page from.', [{ path: 'querystring/before', message: 'Not a run of this job.' }])
      page = { OR: [{ startedAt: { lt: anchor.startedAt } }, { startedAt: anchor.startedAt, id: { lt: anchor.id } }] }
    }
    const rows = await client.cronRun.findMany({ where: { AND: [{ jobKey }, page] }, select: RUN_SELECT, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: query.limit + 1 })
    if (rows.length === 0 && !query.before && !jobEntryOf(jobKey)) throw new NotFoundError('No such scheduled job.')
    const more = rows.length > query.limit
    const shown = (more ? rows.slice(0, query.limit) : rows) as RunRow[]
    return { runs: shown.map(runView), nextBefore: more ? shown[shown.length - 1]!.id : null }
  })
}

/** The words of a held Run now in the API's English (the web says its own words from the code). */
export const RUN_NOW_HELD_WORDS: Readonly<Record<RunNowHeld, string>> = Object.freeze({
  UNKNOWN_JOB: 'There is no such scheduled job.',
  SCHEDULE_ONLY: 'This job sends at its set time (or deletes under a switch): it runs only on its schedule.',
  SWITCHED_OFF: 'This job waits for a switch that is off: switch it on first.',
  ASKED: 'A Run now of this job is waiting or running already.',
})

/** POST /admin/jobs/:jobKey/run: the request on the scheduler's list, audited; the run is recorded when it starts. */
export async function runNow(caller: CommandCaller, jobKey: string, idempotencyKey?: string): Promise<{ requestId: string; jobKey: string }> {
  const context = officeOf(caller)
  const entry = jobEntryOf(jobKey)
  if (!entry) throw new NotFoundError(RUN_NOW_HELD_WORDS.UNKNOWN_JOB)
  const waiting = await waitingOf(context.tenantId)
  if (waiting === null) throw new ApiError('not_ready', 'The scheduler cannot be reached right now: nothing was asked. Try again in a moment.')
  const { result } = await command(caller, { name: 'jobs.runNow', idempotencyKey, input: { jobKey } }, async (tools) => {
    const running = await tools.tx.cronRun.findFirst({ where: { jobKey, trigger: 'RUN_NOW', status: 'RUNNING' }, select: { id: true } })
    const held = runNowHeldOf({ known: true, policy: entry.policy, switchedOn: await switchedOn(tools.tx, entry), asked: (waiting.get(jobKey) ?? 0) > 0 || running !== null })
    if (held) throw new InvalidStateError(RUN_NOW_HELD_WORDS[held])
    const requestId = newId()
    const actorId = context.actorId
    tools.audit({ recordType: 'Tenant', recordId: context.tenantId, companyId: null, after: { jobKey, requestId } })
    tools.emit({ type: 'jobs.run_requested', subject: context.tenantId, companyId: null, payload: { jobKey, requestId } })
    const request: RunNowRequest = { tenantId: context.tenantId, jobKey, requestId, requestedById: actorId, askedAt: toUtcIso(tools.now) }
    const { redis, prefix } = processHealthRedis()
    try {
      await askRunNow(redis, prefix, request)
    } catch {
      throw new ApiError('not_ready', 'The scheduler cannot be reached right now: nothing was asked. Try again in a moment.')
    }
    return { requestId, jobKey }
  })
  return result
}

/**
 * Security & health › Is everything working? › Scheduled jobs (B-W2b-415): failing (a job whose latest finished run
 * FAILED), warning (a missed tick or a stuck run: the count of such jobs), ok, or unknown while no run was ever recorded
 * (the scheduler has not written one yet: never "ok" without proof).
 */
export async function scheduledStatus(client: Client, now: Date): Promise<{ state: 'ok' | 'warning' | 'failing' | 'unknown'; count: number }> {
  const latest = await latestRuns(client)
  if (latest.any.size === 0) return { state: 'unknown', count: 0 }
  let failing = 0
  let late = 0
  for (const entry of JOB_CATALOGUE) {
    const state = jobStateOf({ schedule: entry.schedule, timeZone: entry.timeZone, last: facts(latest.any.get(entry.key)), lastFinished: facts(latest.finished.get(entry.key)), lastScheduled: facts(latest.scheduled.get(entry.key)), now })
    if (state === 'failing') failing++
    else if (state === 'missed' || state === 'stuck') late++
  }
  if (failing > 0) return { state: 'failing', count: failing }
  if (late > 0) return { state: 'warning', count: late }
  return { state: 'ok', count: 0 }
}
