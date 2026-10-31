import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { fixedClock } from '@nexus/factory-domain/core/time'
import { createCatalogue } from '@nexus/factory-domain/events/catalogue'
import { defineEvent } from '@nexus/factory-domain/events/define'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { buildApp } from '../../core/app'
import { callerFor, command, COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandSettings, type CommandTools } from '../../core/command'
import { testAuthenticator, type RequestContext, type SessionContext } from '../../core/context'
import { openQueues, type DeadLetter, type QueueKit } from '../../core/queue'
import { defineManifest, defineRoutes } from '../../core/manifest'
import { LiveFeed, serveLiveStream, useLiveFeed } from '../../core/sse'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { defineHandler, startEventWorkers, type EventWorkers } from './dispatch'
import { outboxHealth, outboxLagCron } from './lag'
import { queuePublisher, relayOnce, relayTenant, RELAY_SETTINGS, type Publish, type RelaySettings } from './relay'
import { eventually, openEventStream, testRedis, type TestRedis } from './testing'
import { outboxWriter } from './writer'

/**
 * The outbox on the local stack: a throwaway PostgreSQL 17 database from the migrations, the runtime login factory_app
 * through the scoped clients, and the local Redis under this file's own prefix. command() writes the rows; the relay,
 * the dispatcher and the handler runner move them; the SSE endpoint shows them. Fixture rows are written by the admin
 * login (a superuser, which skips row-level security). Run with `node scripts/factory/run-pg-tests.mjs outbox`.
 */

const NOW = '2026-10-28T09:00:00.000Z'

const siteRenamed = defineEvent({
  type: 'site.renamed',
  context: 'sites',
  description: 'A site was renamed (test event).',
  payload: z.strictObject({ siteId: z.string(), name: z.string() }),
  live: { permission: 'sites.read', floor: 'floor.work', fields: ['name'] },
})
const quotePriced = defineEvent({
  type: 'quote.priced',
  context: 'sales',
  description: 'A quote was priced (test event with a money field).',
  payload: z.strictObject({ quoteId: z.string(), totalMinor: z.number().int() }),
  live: { permission: 'sites.read', floor: 'floor.work', fields: ['quoteId'] },
})
const CATALOGUE = createCatalogue([siteRenamed, quotePriced])
const SETTINGS: CommandSettings = { ...COMMAND_SETTINGS, clock: fixedClock(NOW), writeEvents: outboxWriter(CATALOGUE) }

let db: MigratedDatabase
let database: FactoryDatabase
let redis: TestRedis
let connection: Redis
let kit: QueueKit
const tenantA = newId()
const tenantB = newId()
const companyA = newId()
const companyB = newId()
const plantA = newId()
const plantA2 = newId()
const plantB = newId()
const user = newId()
const party = newId()

const admin = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const outboxRows = (where: string, values: unknown[] = []) => admin<Record<string, any>>(`SELECT * FROM "OutboxEvent" WHERE ${where} ORDER BY id`, values)

const office = (tenantId = tenantA): RequestContext => ({ audience: 'office', tenantId, actorId: user, companyId: tenantId === tenantA ? companyA : companyB, grants: [], requestId: newId() })
const floor = (siteId = plantA): RequestContext => ({ audience: 'floor', tenantId: tenantA, actorId: user, siteId, deviceId: newId(), grants: [], requestId: newId() })
const partner = (): RequestContext => ({ audience: 'partner', tenantId: tenantA, actorId: user, partyId: party, grants: [], requestId: newId() })
const as = (context: RequestContext): CommandCaller => callerFor(database, context)

/** A write that records one audit row and emits what `more` emits. */
const write = (caller: CommandCaller, more: (tools: CommandTools) => void | Promise<void>, settings: CommandSettings = SETTINGS, key?: string) =>
  runCommand(caller, { name: 'sites.rename', input: { n: 1 }, idempotencyKey: key ?? `key-${newId()}` }, async (tools) => {
    tools.audit({ recordType: 'Site', recordId: plantA })
    await more(tools)
    return { ok: true }
  }, settings)

beforeAll(async () => {
  db = await migratedDatabase('outbox')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 10 } })
  redis = testRedis()
  connection = redis.connect()
  kit = openQueues({ connection, prefix: redis.prefix })
  for (const [tenantId, slug, companyId, sites] of [
    [tenantA, 'obx-a', companyA, [plantA, plantA2]],
    [tenantB, 'obx-b', companyB, [plantB]],
  ] as const) {
    await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenantId, slug])
    await admin('INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, $3, $3)', [companyId, tenantId, `${slug}-c`])
    for (const siteId of sites) {
      await admin(`INSERT INTO "Site" (id, "tenantId", "companyId", code, name, kind) VALUES ($1, $2, $3, $4, $4, 'PLANT')`, [siteId, tenantId, companyId, `S-${siteId.slice(-8)}`])
    }
  }
}, 60_000)

afterAll(async () => {
  await kit?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
}, 60_000)

describe('the outbox writer in command() (PLT-191)', () => {
  it('writes the outbox row in the command\'s transaction, with the envelope, pending', async () => {
    const context = office()
    await write(as(context), ({ emit }) => emit({ type: 'site.renamed', subject: plantA, payload: { siteId: plantA, name: 'North' } }))
    const [row] = await outboxRows('"correlationId" = $1', [context.requestId])
    expect(row).toMatchObject({
      tenantId: tenantA,
      companyId: companyA,
      siteId: null,
      partyId: null,
      type: 'site.renamed',
      version: 1,
      context: 'sites',
      subject: plantA,
      causationId: null,
      source: 'sites.rename',
      payload: { siteId: plantA, name: 'North' },
      status: 'PENDING',
      attempts: 0,
      publishedAt: null,
      lastError: null,
    })
    expect(row!.occurredAt.toISOString()).toBe(NOW)
    expect(await admin('SELECT 1 FROM "AuditLog" WHERE "requestId" = $1', [context.requestId])).toHaveLength(1)
  })

  it('leaves no outbox row when the command fails after writing it (one transaction)', async () => {
    const context = office()
    const failing: CommandSettings = {
      ...SETTINGS,
      async writeEvents(tx, events) {
        await outboxWriter(CATALOGUE)(tx, events)
        expect(await tx.outboxEvent.count({ where: { correlationId: context.requestId } })).toBe(1)
        throw new Error('the receipt store is down')
      },
    }
    await expect(write(as(context), ({ emit }) => emit({ type: 'site.renamed', subject: plantA, payload: { siteId: plantA, name: 'Lost' } }), failing)).rejects.toThrow('the receipt store is down')
    expect(await outboxRows('"correlationId" = $1', [context.requestId])).toHaveLength(0)
    expect(await admin('SELECT 1 FROM "AuditLog" WHERE "requestId" = $1', [context.requestId])).toHaveLength(0)
  })

  it.each<[string, (tools: CommandTools) => void, RegExp, CommandSettings]>([
    ['an undeclared type (the real catalogue)', ({ emit }) => emit({ type: 'site.renamed', subject: plantA, payload: { siteId: plantA, name: 'x' } }), /"site.renamed" version 1 is not declared/, { ...SETTINGS, writeEvents: COMMAND_SETTINGS.writeEvents }],
    ['an undeclared version', ({ emit }) => emit({ type: 'site.renamed', version: 2, subject: plantA, payload: { siteId: plantA, name: 'x' } }), /version 2 is not declared/, SETTINGS],
    ['a payload with an unknown key', ({ emit }) => emit({ type: 'site.renamed', subject: plantA, payload: { siteId: plantA, name: 'x', extra: 1 } }), /does not match its schema/, SETTINGS],
    ['a payload without a required key', ({ emit }) => emit({ type: 'site.renamed', subject: plantA, payload: { siteId: plantA } }), /name/, SETTINGS],
  ])('refuses %s and rolls the whole command back', async (_name, emits, message, settings) => {
    const context = office()
    const key = `key-${newId()}`
    await expect(write(as(context), emits, settings, key)).rejects.toThrow(message)
    expect(await outboxRows('"correlationId" = $1', [context.requestId])).toHaveLength(0)
    expect(await admin('SELECT 1 FROM "AuditLog" WHERE "requestId" = $1', [context.requestId])).toHaveLength(0)
    expect(await admin('SELECT 1 FROM "IdempotencyReceipt" WHERE key = $1', [key])).toHaveLength(0)
  })

  it('writes floor and partner rows in their own scope; a floor event about another site is refused', async () => {
    const onFloor = floor()
    await write(as(onFloor), ({ emit }) => emit({ type: 'site.renamed', subject: plantA, payload: { siteId: plantA, name: 'Floor' } }))
    expect(await outboxRows('"correlationId" = $1', [onFloor.requestId])).toMatchObject([{ siteId: plantA, partyId: null }])
    const portal = partner()
    await write(as(portal), ({ emit }) => emit({ type: 'site.renamed', subject: plantA, payload: { siteId: plantA, name: 'Portal' } }))
    expect(await outboxRows('"correlationId" = $1', [portal.requestId])).toMatchObject([{ partyId: party, siteId: null, companyId: null }])
    const elsewhere = floor()
    await expect(write(as(elsewhere), ({ emit }) => emit({ type: 'site.renamed', subject: plantA2, siteId: plantA2, payload: { siteId: plantA2, name: 'Other' } }))).rejects.toThrow(/row-level security/)
    expect(await outboxRows('"correlationId" = $1', [elsewhere.requestId])).toHaveLength(0)
  })
})

describe('the outbox guard trigger', () => {
  const runtime = (sql: string, ...values: unknown[]) => database.withScope({ audience: 'office', tenantId: tenantA, actorId: user }, (client) => client.$executeRawUnsafe(sql, ...values))
  let eventId: string

  beforeAll(async () => {
    const context = office()
    await write(as(context), ({ emit }) => emit({ type: 'site.renamed', subject: plantA, payload: { siteId: plantA, name: 'Fixed' } }))
    eventId = (await outboxRows('"correlationId" = $1', [context.requestId]))[0]!.id
  })

  it('keeps the event fixed: the relay\'s role may change only the delivery state, forward', async () => {
    await expect(runtime(`UPDATE "OutboxEvent" SET payload = '{"name":"Rewritten"}' WHERE id = $1::uuid`, eventId)).rejects.toThrow(/fixed once written/)
    await expect(runtime(`UPDATE "OutboxEvent" SET type = 'site.moved' WHERE id = $1::uuid`, eventId)).rejects.toThrow(/fixed once written/)
    await expect(runtime(`UPDATE "OutboxEvent" SET status = 'PUBLISHED' WHERE id = $1::uuid`, eventId)).rejects.toThrow(/without publishedAt/)
    expect(await runtime(`UPDATE "OutboxEvent" SET attempts = 2, "lastError" = 'x' WHERE id = $1::uuid`, eventId)).toBe(1)
    await expect(runtime(`UPDATE "OutboxEvent" SET attempts = 1 WHERE id = $1::uuid`, eventId)).rejects.toThrow(/cannot go down/)
    expect(await runtime(`UPDATE "OutboxEvent" SET status = 'PUBLISHED', "publishedAt" = now() WHERE id = $1::uuid`, eventId)).toBe(1)
    await expect(runtime(`UPDATE "OutboxEvent" SET status = 'PENDING' WHERE id = $1::uuid`, eventId)).rejects.toThrow(/final/)
    await expect(runtime(`DELETE FROM "OutboxEvent" WHERE id = $1::uuid`, eventId)).rejects.toThrow(/permission denied/)
  })

  it('refuses a row born published, a delete of a pending row and a truncate, for every login', async () => {
    await expect(
      runtime(
        `INSERT INTO "OutboxEvent" (id, type, version, context, subject, "correlationId", source, "occurredAt", payload, status, "publishedAt") VALUES ($1::uuid, 'site.renamed', 1, 'sites', 's', 'r', 'sites.rename', now(), '{}', 'PUBLISHED', now())`,
        newId(),
      ),
    ).rejects.toThrow(/a new event is PENDING/)
    const context = office()
    await write(as(context), ({ emit }) => emit({ type: 'site.renamed', subject: plantA, payload: { siteId: plantA, name: 'Pending' } }))
    const [pending] = await outboxRows('"correlationId" = $1', [context.requestId])
    await expect(admin('DELETE FROM "OutboxEvent" WHERE id = $1', [pending!.id])).rejects.toThrow(/cannot be deleted/)
    await expect(admin('TRUNCATE "OutboxEvent"')).rejects.toThrow(/TRUNCATE on "OutboxEvent" is refused/)
    // A published row may be purged (a later retention job, as the owner).
    expect((await db.admin.query('DELETE FROM "OutboxEvent" WHERE id = $1', [eventId])).rowCount).toBe(1)
  })
})

/** Writes `count` pending events for a tenant through command(), one command each. */
async function emitMany(tenantId: string, count: number): Promise<string[]> {
  const context = office(tenantId)
  await write(as(context), ({ emit }) => {
    for (let index = 0; index < count; index++) emit({ type: 'site.renamed', subject: `s-${index}`, payload: { siteId: plantA, name: `n-${index}` } })
  })
  return (await outboxRows('"correlationId" = $1', [context.requestId])).map((row) => row.id as string)
}

/** Marks every pending row of earlier tests published, so a test sees only its own rows. */
async function settleOutbox(): Promise<void> {
  await admin(`UPDATE "OutboxEvent" SET status = 'PUBLISHED', "publishedAt" = now(), attempts = attempts + 1 WHERE status = 'PENDING'`)
}

describe('the relay (FOR UPDATE SKIP LOCKED, job id = event id)', () => {
  it('publishes each event exactly once with two relays running at the same time', async () => {
    await settleOutbox()
    const ids = [...(await emitMany(tenantA, 60)), ...(await emitMany(tenantB, 15))]
    const calls = new Map<string, number>()
    const publish = queuePublisher(kit)
    const slow: Publish = async (event) => {
      calls.set(event.eventId, (calls.get(event.eventId) ?? 0) + 1)
      await new Promise((resolve) => setTimeout(resolve, 3))
      await publish(event)
    }
    const settings: RelaySettings = { ...RELAY_SETTINGS, batchSize: 7 }
    const drain = async () => {
      for (;;) if ((await relayOnce(database, slow, settings)).published === 0 && (await outboxRows(`status = 'PENDING'`)).length === 0) return
    }
    await Promise.all([drain(), drain()])
    expect([...calls.keys()].sort()).toEqual([...ids].sort())
    expect([...calls.values()].every((count) => count === 1)).toBe(true)
    const rows = await outboxRows('id = ANY($1::uuid[])', [ids])
    expect(rows.every((row) => row.status === 'PUBLISHED' && row.attempts === 1 && row.publishedAt !== null)).toBe(true)
    const jobs = await kit.queue('events').getJobs(['waiting', 'prioritized', 'delayed', 'active', 'completed'])
    const jobIds = jobs.map((job) => job.id)
    for (const id of ids) expect(jobIds.filter((jobId) => jobId === id)).toHaveLength(1)
    const job = jobs.find((entry) => entry.id === ids[0])!
    expect(job.name).toBe('site.renamed')
    expect(job.data).toMatchObject({ eventId: ids[0], tenantId: tenantA, type: 'site.renamed', version: 1, context: 'sites', source: 'sites.rename', occurredAt: NOW })
  })

  it('a second publish of one event is not a second job', async () => {
    await settleOutbox()
    const [id] = await emitMany(tenantA, 1)
    const [row] = await outboxRows('id = $1', [id])
    const envelope = { eventId: id!, type: 'site.renamed', version: 1, context: 'sites', tenantId: tenantA, companyId: companyA, siteId: null, subject: row!.subject, correlationId: row!.correlationId, causationId: null, source: 'sites.rename', occurredAt: NOW, payload: row!.payload } satisfies EventEnvelope
    await queuePublisher(kit)(envelope)
    await queuePublisher(kit)(envelope)
    expect((await kit.queue('events').getJobs(['waiting', 'prioritized', 'completed', 'active'])).filter((job) => job.id === id)).toHaveLength(1)
  })

  it('retries a failed publish with backoff, then gives the row up as DEAD', async () => {
    await settleOutbox()
    const [id] = await emitMany(tenantA, 1)
    const start = Date.now() + 1_000
    const at = (ms: number): RelaySettings => ({ ...RELAY_SETTINGS, maxAttempts: 3, backoffBaseMs: 1_000, clock: fixedClock(new Date(start + ms)) })
    const failing: Publish = async () => {
      throw new Error('redis is down')
    }
    const row = async () => (await outboxRows('id = $1', [id]))[0]!
    expect(await relayTenant(database, tenantA, failing, at(0))).toMatchObject({ published: 0, failed: 1, dead: 0 })
    expect(await row()).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'redis is down' })
    expect((await row()).nextAttemptAt.getTime()).toBe(start + 1_000)
    expect(await relayTenant(database, tenantA, failing, at(999))).toMatchObject({ published: 0, failed: 0 })
    expect(await relayTenant(database, tenantA, failing, at(1_000))).toMatchObject({ failed: 1, dead: 0 })
    expect((await row()).nextAttemptAt.getTime()).toBe(start + 1_000 + 2_000)
    expect(await relayTenant(database, tenantA, failing, at(3_000))).toMatchObject({ failed: 1, dead: 1 })
    expect(await row()).toMatchObject({ status: 'DEAD', attempts: 3 })
    expect(await relayTenant(database, tenantA, failing, at(60_000))).toMatchObject({ failed: 0, dead: 0 })
  })

  it('times a hanging publish out, so one outage costs one timeout per pass', async () => {
    await settleOutbox()
    await emitMany(tenantA, 3)
    const hanging: Publish = () => new Promise(() => {})
    const begun = Date.now()
    expect(await relayTenant(database, tenantA, hanging, { ...RELAY_SETTINGS, publishTimeoutMs: 200 })).toMatchObject({ failed: 3 })
    expect(Date.now() - begun).toBeLessThan(2_000)
    expect((await outboxRows(`status = 'PENDING' AND "tenantId" = $1`, [tenantA])).every((row) => row.lastError === 'no answer within 200 ms')).toBe(true)
  })
})

describe('handlers, retries and the dead-letter queue; live screens end to end', () => {
  let workers: EventWorkers
  let feed: LiveFeed
  let app: FastifyInstance
  let base: string
  const okCalls: string[] = []
  const failingCalls: string[] = []
  const all: Grant = { permissions: ['sites.read'], companies: 'all', sites: 'all', parties: 'all' }
  const SESSIONS: Record<string, SessionContext> = {
    'office-a': { audience: 'office', tenantId: tenantA, actorId: user, grants: [all] },
    'office-b': { audience: 'office', tenantId: tenantB, actorId: user, grants: [all] },
  }

  beforeAll(async () => {
    await settleOutbox()
    // The earlier tests' jobs are not this describe's business.
    await kit.queue('events').obliterate({ force: true })
    const ok = defineHandler({
      name: 'sites.audited',
      events: ['site.renamed'],
      async handle(event, { caller }) {
        okCalls.push(event.eventId)
        await command(caller, { name: 'sites.touch', input: { event: event.eventId }, causationId: event.eventId }, async ({ audit }) => {
          audit({ recordType: 'Site', recordId: plantA, after: { from: event.eventId } })
          return null
        })
      },
    })
    const failing = defineHandler({
      name: 'sites.failing',
      events: ['site.renamed'],
      attempts: 3,
      async handle(event) {
        failingCalls.push(event.eventId)
        throw new Error('the mail server refused')
      },
    })
    workers = startEventWorkers({ kit, handlers: [ok, failing], catalogue: CATALOGUE, database, live: connection, handlerBackoffMs: 10, log: { info() {}, warn() {}, error() {} } })
    feed = new LiveFeed({ connect: () => redis.connect(), prefix: redis.prefix })
    useLiveFeed(feed)
    app = await buildApp(
      { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
      {
        routesRoot: fileURLToPath(new URL('../..', import.meta.url)),
        authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
        // GET /live with this file's catalogue (the real one declares no event yet).
        routes: [defineRoutes('test-live', defineManifest({ 'GET /test-live': { audiences: ['office'], permission: 'signed-in', scope: 'tenant' } }), async (routes) => {
          routes.get('/test-live', async (request, reply) => serveLiveStream(request, reply, { feed, catalogue: CATALOGUE }))
        })],
      },
    )
    base = await app.listen({ host: '127.0.0.1', port: 0 })
  }, 60_000)

  afterAll(async () => {
    await app?.close()
    useLiveFeed(undefined)
    await feed?.close()
    await workers?.close()
  }, 60_000)

  it('runs each handler of an event; a failing one is retried, then copied to the dead-letter queue', async () => {
    const [id] = await emitMany(tenantA, 1)
    await relayOnce(database, queuePublisher(kit))
    await eventually(async () => (await kit.queue('dead-letter').getJob(`event-handlers.sites.failing.${id}`)) !== undefined)
    expect(failingCalls.filter((call) => call === id)).toHaveLength(3)
    expect(okCalls.filter((call) => call === id)).toHaveLength(1)
    const letter = (await kit.queue('dead-letter').getJob(`event-handlers.sites.failing.${id}`))!.data as DeadLetter
    expect(letter).toMatchObject({ queue: 'event-handlers', jobId: `sites.failing.${id}`, name: 'sites.failing', attemptsMade: 3, error: 'Error: the mail server refused' })
    const failed = await kit.queue('event-handlers').getJob(`sites.failing.${id}`)
    expect(await failed!.getState()).toBe('failed')
    // The ok handler wrote through command() as the tenant's system context, chained to the event.
    const [audit] = await admin<{ audience: string; tenantId: string }>(`SELECT audience::text, "tenantId" FROM "AuditLog" WHERE action = 'sites.touch' AND after->>'from' = $1`, [id])
    expect(audit).toEqual({ audience: 'SYSTEM', tenantId: tenantA })
  })

  it('the lag check reports pending and dead events and the dead letters, as a warning', async () => {
    await emitMany(tenantB, 1)
    // The commands ran at NOW (the fixed clock): ten minutes later the event is late.
    const later = fixedClock(new Date(Date.parse(NOW) + 10 * 60_000))
    const health = await outboxHealth(database, kit, later)
    expect(health.pending).toBe(1)
    expect(health.dead).toBeGreaterThanOrEqual(1)
    expect(health.deadLetters).toBeGreaterThanOrEqual(1)
    expect(health.oldestPendingMs).toBe(10 * 60_000)
    const lines: Array<[string, Record<string, unknown>]> = []
    const log = { info: (fields: Record<string, unknown>) => void lines.push(['info', fields]), warn: (fields: Record<string, unknown>) => void lines.push(['warn', fields]), error() {} }
    await outboxLagCron({ database, kit, log, clock: later }).run({ name: 'outbox.lag', scheduledAt: new Date() })
    expect(lines).toEqual([['warn', expect.objectContaining({ pending: 1 })]])
    await settleOutbox()
  })

  it('streams a published event to the screens of its tenant only', async () => {
    const open = async (session: string) => {
      const { status, headers, stream } = await openEventStream(`${base}/test-live`, { 'x-test-session': session })
      expect(status).toBe(200)
      expect(headers['content-type']).toMatch(/^text\/event-stream/)
      await stream.next((event) => event.event === 'ready')
      return stream
    }
    const screenA = await open('office-a')
    const screenB = await open('office-b')
    try {
      const context = office()
      await write(as(context), ({ emit }) => emit({ type: 'site.renamed', subject: plantA, payload: { siteId: plantA, name: 'Live' } }))
      const [row] = await outboxRows('"correlationId" = $1', [context.requestId])
      await relayOnce(database, queuePublisher(kit))
      const change = await screenA.next((event) => event.event === 'change')
      expect(change).toMatchObject({ id: row!.id, data: { eventId: row!.id, type: 'site.renamed', subject: plantA, companyId: companyA, fields: { name: 'Live' } } })
      expect(change.data).not.toHaveProperty('tenantId')
      expect(change.data).not.toHaveProperty('payload')
      // Tenant B's screen gets tenant B's events, never A's.
      await emitMany(tenantB, 1)
      await relayOnce(database, queuePublisher(kit))
      const forB = await screenB.next((event) => event.event === 'change')
      expect((forB.data as { eventId: string }).eventId).not.toBe(row!.id)
      expect(screenB.events.some((event) => (event.data as { eventId?: string }).eventId === row!.id)).toBe(false)
    } finally {
      await screenA.close()
      await screenB.close()
    }
  })
})
