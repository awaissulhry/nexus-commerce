import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { defineCron } from '../../../core/cron'
import { recordedCron, runNowCron, runNowListKey, runRequested, type CronRunSettings, type RunNowRequest } from '../../../core/cron-runs'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { activeTenants } from '../../outbox/system'
import { testRedis, type TestRedis } from '../../outbox/testing'
import { useHealthRedis } from './redis'

/**
 * Jobs and integrations on the local stack (B-W2b-415; PLT-221), with the app's real routes and the local Redis under this
 * file's own prefix: every recorded tick writes one run per active tenant (a doubled tick none), a failed tick its error,
 * audited with its event; the page reads last run, result, next run, failures in 7 days and its state; Run now puts one
 * request on the scheduler's list (held jobs refused in words, Redis down 503), and the poller runs it once for the asking
 * tenant only, recorded RUN_NOW with who asked.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let settings: CronRunSettings
const tenantA = newId()
const tenantB = newId()
const user = newId()

const grant = (permissions: Grant['permissions']): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  admin: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['security.view', 'security.jobs.run'])] },
  viewer: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['security.view'])] },
  nobody: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['audit.read'])] },
}
const LOG = { info() {}, warn() {}, error() {} }
const call = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
const admin = async (sql: string, params: unknown[] = []) => (await db.admin.query(sql, params)).rows as Array<Record<string, unknown>>

type JobView = { key: string; state: string; failures7d: number; runs7d: number; waiting: number | null; lastRun: { status: string; error: string | null } | null; nextRunAt: string | null; runNow: { held: string | null } }
const jobsOf = async (session = 'admin') => (await call(session, 'GET', '/admin/jobs')).json() as { jobs: JobView[]; canRun: boolean; outbox: { waiting: number; dead: number }; waitingKnown: boolean }
const jobOf = async (key: string, session = 'admin') => (await jobsOf(session)).jobs.find((job) => job.key === key)!

beforeAll(async () => {
  db = await migratedDatabase('admin_jobs')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  redis = testRedis()
  connection = redis.connect()
  useHealthRedis({ redis: connection, prefix: redis.prefix })
  settings = { database, redis: connection, prefix: redis.prefix, log: LOG, ranOn: 'scheduler-test:1' }
  for (const [tenantId, slug] of [
    [tenantA, 'jb-a'],
    [tenantB, 'jb-b'],
  ] as const) {
    await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenantId, slug])
  }
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status, locale) VALUES ($1, $2, 'ada@example.com', 'Ada Esempio', 'ACTIVE', 'en')`, [user, tenantA])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 120_000)

afterAll(async () => {
  useHealthRedis(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
}, 60_000)

describe('every cron writes its run', () => {
  it('writes one run per active tenant and tick, SUCCEEDED; the same tick again writes none', async () => {
    let ran = 0
    const job = recordedCron(defineCron({ name: 'outbox.lag', schedule: '* * * * *', run: async () => void ran++ }), settings)
    const tick = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60_000)
    await job.run({ name: 'outbox.lag', scheduledAt: tick })
    await job.run({ name: 'outbox.lag', scheduledAt: tick })
    expect(ran).toBe(2)
    const rows = await admin(`SELECT "tenantId", status, trigger, key, "ranOn" FROM "CronRun" WHERE "jobKey" = 'outbox.lag' ORDER BY "tenantId"`)
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.tenantId))).toEqual(new Set([tenantA, tenantB]))
    expect(rows.every((row) => row.status === 'SUCCEEDED' && row.trigger === 'SCHEDULE' && row.ranOn === 'scheduler-test:1' && row.key === `outbox.lag@${tick.getTime() / 1000}`)).toBe(true)
  })

  it('a failed tick keeps its error in one message, audited with jobs.run_finished, and still throws', async () => {
    const job = recordedCron(
      defineCron({
        name: 'invoicing.sdiPoll',
        schedule: '*/5 * * * *',
        run: async () => {
          throw new Error('the database did not answer in time (made up)')
        },
      }),
      settings,
    )
    await expect(job.run({ name: 'invoicing.sdiPoll', scheduledAt: new Date(Date.now() - 30_000) })).rejects.toThrow('did not answer')
    const [row] = await admin(`SELECT id, status, error FROM "CronRun" WHERE "jobKey" = 'invoicing.sdiPoll' AND "tenantId" = $1`, [tenantA])
    expect(row).toMatchObject({ status: 'FAILED', error: 'Error: the database did not answer in time (made up)' })
    const [audit] = await admin(`SELECT action FROM "AuditLog" WHERE "recordId" = $1`, [row!.id])
    expect(audit!.action).toBe('jobs.runFailed')
    const [emitted] = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'jobs.run_finished' AND subject = $1`, [row!.id])
    expect(emitted!.payload).toEqual({ runId: row!.id, jobKey: 'invoicing.sdiPoll', trigger: 'SCHEDULE', status: 'FAILED' })
  })
})

describe('GET /admin/jobs', () => {
  it('lists every job with its last run, result, next run, failures and state; the tenant only', async () => {
    const answer = await jobsOf()
    expect(answer.canRun).toBe(true)
    expect(answer.waitingKnown).toBe(true)
    expect(answer.jobs.length).toBeGreaterThan(40)
    expect(answer.jobs.find((job) => job.key === 'outbox.lag')).toMatchObject({ state: 'ok', runs7d: 1, failures7d: 0, lastRun: { status: 'SUCCEEDED' } })
    expect(answer.jobs.find((job) => job.key === 'invoicing.sdiPoll')).toMatchObject({ state: 'failing', failures7d: 1, lastRun: { status: 'FAILED', error: 'Error: the database did not answer in time (made up)' } })
    expect(answer.jobs.find((job) => job.key === 'compliance.certificateExpiry')).toMatchObject({ state: 'never', lastRun: null, runNow: { held: null } })
    expect(answer.jobs.find((job) => job.key === 'notifications.digest')?.runNow.held).toBe('SCHEDULE_ONLY')
    expect(answer.jobs.find((job) => job.key === 'currency.ecbDaily')?.runNow.held).toBe('SWITCHED_OFF')
    expect(answer.jobs.every((job) => job.nextRunAt !== null)).toBe(true)
    expect((await jobsOf('viewer')).canRun).toBe(false)
    expect((await call('nobody', 'GET', '/admin/jobs')).statusCode).toBe(403)
  })

  it('lists a job runs newest first, page by page', async () => {
    const first = (await call('viewer', 'GET', '/admin/jobs/outbox.lag/runs?limit=1')).json() as { runs: Array<{ id: string; trigger: string; byPerson: boolean }>; nextBefore: string | null }
    expect(first.runs).toHaveLength(1)
    expect(first.runs[0]).toMatchObject({ trigger: 'SCHEDULE', byPerson: false })
    expect(first.nextBefore).toBeNull()
    expect((await call('viewer', 'GET', '/admin/jobs/no.suchJob/runs')).statusCode).toBe(404)
  })
})

describe('Run now', () => {
  it('asks once on the scheduler list (audited, jobs.run_requested); a second ask, a held job or no right is refused in words', async () => {
    const asked = await call('admin', 'POST', '/admin/jobs/compliance.certificateExpiry/run', {})
    expect(asked.statusCode).toBe(200)
    const listed = await connection.lrange(runNowListKey(redis.prefix), 0, -1)
    expect(listed).toHaveLength(1)
    expect(JSON.parse(listed[0]!)).toMatchObject({ tenantId: tenantA, jobKey: 'compliance.certificateExpiry', requestedById: user })
    expect(await jobOf('compliance.certificateExpiry')).toMatchObject({ waiting: 1, runNow: { held: 'ASKED' } })
    expect((await call('admin', 'POST', '/admin/jobs/compliance.certificateExpiry/run', {})).statusCode).toBe(409)
    const schedule = await call('admin', 'POST', '/admin/jobs/notifications.digest/run', {})
    expect(schedule.statusCode).toBe(409)
    expect((schedule.json() as { error: { message: string } }).error.message).toMatch(/runs only on its schedule/)
    expect((await call('admin', 'POST', '/admin/jobs/currency.ecbDaily/run', {})).statusCode).toBe(409)
    expect((await call('admin', 'POST', '/admin/jobs/no.suchJob/run', {})).statusCode).toBe(404)
    expect((await call('viewer', 'POST', '/admin/jobs/outbox.lag/run', {})).statusCode).toBe(403)
    const [audit] = await admin(`SELECT after FROM "AuditLog" WHERE action = 'jobs.runNow' AND "tenantId" = $1`, [tenantA])
    expect(audit!.after).toMatchObject({ jobKey: 'compliance.certificateExpiry' })
  })

  it('the poller runs it once in the cluster for the asking tenant only, recorded RUN_NOW with who asked', async () => {
    const seen: string[][] = []
    const job = defineCron({ name: 'compliance.certificateExpiry', schedule: '20 0 * * *', run: async () => void seen.push(await activeTenants(database)) })
    await runNowCron([job], settings).run({ name: 'jobs.runNow', scheduledAt: new Date() })
    expect(seen).toEqual([[tenantA]])
    expect(await connection.llen(runNowListKey(redis.prefix))).toBe(0)
    const rows = await admin(`SELECT id, "tenantId", trigger, status, "requestedById" FROM "CronRun" WHERE "jobKey" = 'compliance.certificateExpiry'`)
    expect(rows).toEqual([expect.objectContaining({ tenantId: tenantA, trigger: 'RUN_NOW', status: 'SUCCEEDED', requestedById: user })])
    const [emitted] = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'jobs.run_finished' AND subject = $1`, [rows[0]!.id])
    expect(emitted!.payload).toMatchObject({ trigger: 'RUN_NOW', status: 'SUCCEEDED' })
    expect(await jobOf('compliance.certificateExpiry')).toMatchObject({ waiting: 0, runNow: { held: null }, lastRun: { status: 'SUCCEEDED' } })
    // A second delivery of the same request is not a second run.
    const [audit] = await admin(`SELECT after FROM "AuditLog" WHERE action = 'jobs.runNow' AND "tenantId" = $1`, [tenantA])
    const request: RunNowRequest = { tenantId: tenantA, jobKey: 'compliance.certificateExpiry', requestId: (audit!.after as { requestId: string }).requestId, requestedById: user, askedAt: new Date().toISOString() }
    expect(await runRequested([job], request, settings)).toBe('taken')
    expect(seen).toHaveLength(1)
  })

  it('a Run now that fails is recorded FAILED with its error; Redis down asks nothing (503)', async () => {
    const job = defineCron({
      name: 'outbox.lag',
      schedule: '* * * * *',
      run: async () => {
        throw new Error('no connection (made up)')
      },
    })
    const outcome = await runRequested([job], { tenantId: tenantA, jobKey: 'outbox.lag', requestId: newId(), requestedById: user, askedAt: new Date().toISOString() }, settings)
    expect(outcome).toBe('failed')
    const [row] = await admin(`SELECT status, error FROM "CronRun" WHERE "jobKey" = 'outbox.lag' AND trigger = 'RUN_NOW'`)
    expect(row).toEqual({ status: 'FAILED', error: 'Error: no connection (made up)' })
    useHealthRedis({ redis: { lrange: async () => Promise.reject(new Error('down')) } as unknown as Redis, prefix: redis.prefix })
    try {
      const down = await call('admin', 'POST', '/admin/jobs/outbox.lag/run', {})
      expect(down.statusCode).toBe(503)
      expect((await jobsOf()).waitingKnown).toBe(false)
    } finally {
      useHealthRedis({ redis: connection, prefix: redis.prefix })
    }
  })
})
