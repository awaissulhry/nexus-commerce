import { createHash, randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase, type Prisma } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { SignatureVerifier } from '@nexus/factory-domain/ports/signature'
import { buildApp } from '../../core/app'
import { callerFor, command, type CommandCaller } from '../../core/command'
import type { RequestContext } from '../../core/context'
import { openQueues, type QueueKit } from '../../core/queue'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { startEventWorkers, type EventWorkers } from '../outbox/dispatch'
import { queuePublisher, relayOnce } from '../outbox/relay'
import { systemContext } from '../outbox/system'
import { eventually, testRedis, type TestRedis } from '../outbox/testing'
import { createSecretsService, type SecretsService } from '../secrets/envelope'
import { localKeyProvider } from '../secrets/local'
import { SECRET_PURPOSES, storeSecret } from '../secrets/store'
import { INBOUND_HANDLER, inboundHandler, processReceipt } from './process'
import { useInbound, type InboundProcessor, type InboundReceipt, type InboundRuntime } from './providers'
import inboundRoutes from './routes'
import { fakeSignatureHeaders } from './verifiers'

/**
 * The inbound webhook ledger on the local stack: a throwaway PostgreSQL 17 database from the migrations, the runtime
 * login factory_app, the route through buildApp (app.inject), and the worker's path (outbox relay → BullMQ → handler)
 * on the local Redis under this file's own prefix. Nothing reaches an outside service. Run with
 * `node scripts/factory/run-pg-tests.mjs inbound`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let redis: TestRedis
let connection: Redis
let secrets: SecretsService
let app: FastifyInstance
const tenantA = newId()
const tenantB = newId()
const companyA = newId()
const companyB = newId()
const user = newId()
const WEBHOOK_SECRET = 'whsec_made_up_for_tests_4b1d'
let nowMs = Date.parse('2026-10-28T09:00:00.000Z')
const clock = { now: () => new Date(nowMs) }
const silent = { info() {}, warn() {}, error() {} }

/** What the processors applied, by receipt id. */
const applied: string[] = []
const recording: InboundProcessor = {
  async process(receipt, tools) {
    applied.push(receipt.id)
    tools.audit({ recordType: 'InboundWebhook', recordId: receipt.id, action: 'test.applied', after: { body: JSON.parse(receipt.body) } })
  },
}
/** A LIVE provider's verifier for the tests: header `x-test-signature: valid`, event id in `x-test-event`. */
const liveVerifier: SignatureVerifier = {
  async verify({ headers }) {
    if (headers['x-test-signature'] !== 'valid') return { ok: false, reason: 'test_signature_missing' }
    return { ok: true, dedupeKey: headers['x-test-event'] ?? '', externalId: 'ext-1', eventType: 'live.event' }
  },
}
const runtime = (processor: InboundProcessor = recording, environment: InboundRuntime['environment'] = 'test'): InboundRuntime => ({
  environment,
  secrets,
  clock,
  providers: { SDI: { verifier: liveVerifier, processor } },
})

const admin = async <T = Record<string, any>>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const office = (tenantId = tenantA): RequestContext => ({ audience: 'office', tenantId, actorId: user, companyId: tenantId === tenantA ? companyA : companyB, grants: [], requestId: newId() })
const asSystem = (tenantId = tenantA): CommandCaller => callerFor(database, systemContext(tenantId, newId()))
const receipts = (accountId: string) => admin(`SELECT * FROM "InboundWebhook" WHERE "accountId" = $1 ORDER BY "receivedAt", id`, [accountId])
const events = (receiptId: string) => admin(`SELECT * FROM "OutboxEvent" WHERE subject = $1`, [receiptId])

async function account(fields: Partial<Prisma.IntegrationAccountUncheckedCreateInput>, tenantId = tenantA): Promise<string> {
  const id = newId()
  await command(callerFor(database, office(tenantId)), { name: 'integration.createAccount', input: { id } }, async (tools) => {
    const webhook = await storeSecret(tools, secrets, { purpose: SECRET_PURPOSES.webhook, plaintext: WEBHOOK_SECRET })
    await tools.tx.integrationAccount.create({
      data: { id, provider: 'SDI', code: `in-${id.slice(-12)}`, label: 'Inbound test', mode: 'FAKE', webhookSecretId: webhook.id, ...fields },
      select: { id: true },
    })
    tools.audit({ recordType: 'IntegrationAccount', recordId: id })
    return { id }
  })
  return id
}

interface Delivery {
  readonly body?: string | Buffer
  readonly eventId?: string
  readonly secret?: string
  readonly provider?: string
  readonly tenantId?: string
  readonly at?: Date
  readonly headers?: Record<string, string>
  readonly signed?: boolean
}
function deliver(accountId: string, delivery: Delivery = {}) {
  const body = delivery.body ?? JSON.stringify({ invoice: 'FT-2026-00001', outcome: 'RC' })
  const signed = delivery.signed === false ? {} : fakeSignatureHeaders(delivery.secret ?? WEBHOOK_SECRET, body, delivery.at ?? clock.now(), { id: delivery.eventId ?? `evt-${newId()}`, type: 'invoice.delivered' })
  return app.inject({
    method: 'POST',
    url: `/inbound/${delivery.provider ?? 'sdi'}/${delivery.tenantId ?? tenantA}/${accountId}`,
    payload: body,
    headers: { 'content-type': 'application/json', ...signed, ...delivery.headers },
  })
}

beforeAll(async () => {
  db = await migratedDatabase('inbound')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 10 } })
  redis = testRedis()
  connection = redis.connect()
  secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  for (const [tenantId, slug, companyId] of [
    [tenantA, 'in-a', companyA],
    [tenantB, 'in-b', companyB],
  ] as const) {
    await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenantId, slug])
    await admin('INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, $3, $3)', [companyId, tenantId, `${slug}-c`])
  }
  useInbound(runtime())
  app = await buildApp({ environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET }, { database, routes: [inboundRoutes] })
}, 60_000)

afterAll(async () => {
  await app?.close()
  useInbound(undefined)
  await redis?.cleanup()
  await database?.close()
  await db?.close()
}, 60_000)

describe('receiving a webhook: verify, store FIRST, answer (PLT-194)', () => {
  it('stores a verified delivery with its event in one transaction and answers at once, before any processing', async () => {
    const id = await account({ companyId: companyA })
    const body = JSON.stringify({ invoice: 'FT-2026-00007', outcome: 'RC' })
    const answer = await deliver(id, { body, eventId: 'evt-0001' })
    expect(answer.statusCode).toBe(200)
    const { status, receiptId } = answer.json() as { status: string; receiptId: string }
    expect(status).toBe('received')
    const [row] = await receipts(id)
    expect(row).toMatchObject({
      id: receiptId,
      tenantId: tenantA,
      companyId: companyA,
      provider: 'SDI',
      verified: true,
      dedupeKey: 'evt-0001',
      eventType: 'invoice.delivered',
      body,
      bodySha256: createHash('sha256').update(body).digest('hex'),
      bodyBytes: Buffer.byteLength(body),
      contentType: 'application/json',
      status: 'RECEIVED',
      attempts: 0,
      processedAt: null,
      rejectReason: null,
    })
    expect(row!.receivedAt.toISOString()).toBe(clock.now().toISOString())
    expect(await events(receiptId)).toEqual([
      expect.objectContaining({ type: 'integration.inbound_received', status: 'PENDING', companyId: companyA, payload: { receiptId, accountId: id, provider: 'SDI' } }),
    ])
    const [audit] = await admin(`SELECT audience::text, action, "actorId" FROM "AuditLog" WHERE "recordId" = $1`, [receiptId])
    expect(audit).toEqual({ audience: 'SYSTEM', action: 'integration.receiveInbound', actorId: '00000000-0000-7000-8000-000000000000' })
    expect(applied).not.toContain(receiptId)
  })

  it('stores a repeated delivery once (one receipt, one event), one after the other and all at once', async () => {
    const id = await account({})
    const first = (await deliver(id, { eventId: 'evt-repeat' })).json() as { receiptId: string }
    const again = await deliver(id, { eventId: 'evt-repeat' })
    expect(again.statusCode).toBe(200)
    expect(again.json()).toEqual({ status: 'duplicate', receiptId: first.receiptId })
    const together = await Promise.all(Array.from({ length: 6 }, () => deliver(id, { eventId: 'evt-burst' })))
    expect(together.map((answer) => answer.statusCode)).toEqual([200, 200, 200, 200, 200, 200])
    const ids = new Set(together.map((answer) => (answer.json() as { receiptId: string }).receiptId))
    expect(ids.size).toBe(1)
    expect(together.filter((answer) => (answer.json() as { status: string }).status === 'received')).toHaveLength(1)
    expect((await receipts(id)).map((row) => row.dedupeKey)).toEqual(['evt-repeat', 'evt-burst'])
    expect(await events([...ids][0]!)).toHaveLength(1)
  })

  it('refuses a bad signature with 401 and keeps it as REJECTED (no key, no body): the real delivery still passes', async () => {
    const id = await account({})
    const forged = await deliver(id, { eventId: 'evt-target', secret: 'not-the-secret', body: '{"forged":true}' })
    expect(forged.statusCode).toBe(401)
    expect(forged.json()).toMatchObject({ error: { code: 'unauthenticated', message: 'The webhook signature is not valid.' } })
    const [rejected] = await receipts(id)
    expect(rejected).toMatchObject({
      verified: false,
      status: 'REJECTED',
      dedupeKey: null,
      body: null,
      rejectReason: 'signature_mismatch',
      bodySha256: createHash('sha256').update('{"forged":true}').digest('hex'),
    })
    expect(await events(rejected!.id)).toEqual([])
    const [audit] = await admin(`SELECT action, after FROM "AuditLog" WHERE "recordId" = $1`, [rejected!.id])
    expect(audit).toMatchObject({ action: 'integration.rejectInbound', after: { status: 'REJECTED', reason: 'signature_mismatch' } })
    const real = await deliver(id, { eventId: 'evt-target' })
    expect(real.json()).toMatchObject({ status: 'received' })
  })

  it.each<[string, Delivery, string]>([
    ['a stale timestamp', { at: new Date(Date.parse('2026-10-28T08:50:00.000Z')) }, 'stale_timestamp'],
    ['no signature', { signed: false }, 'missing_signature'],
    ['a signature over another event id', { headers: { 'x-factory-event-id': 'evt-swapped' } }, 'signature_mismatch'],
    ['a body that is not UTF-8 (signed, but not storable as text)', { body: Buffer.from([0x7b, 0xff, 0x7d]) }, 'body_not_utf8'],
  ])('refuses %s', async (_label, delivery, reason) => {
    const id = await account({})
    const answer = await deliver(id, delivery)
    expect(answer.statusCode).toBe(401)
    expect(await receipts(id)).toEqual([expect.objectContaining({ status: 'REJECTED', rejectReason: reason })])
  })

  it('answers 404 and stores nothing for an unknown account, another provider, another tenant, or a FAKE account in production', async () => {
    const id = await account({})
    const count = async () => (await admin('SELECT count(*)::int AS n FROM "InboundWebhook"'))[0]!.n as number
    const before = await count()
    expect((await deliver(newId())).statusCode).toBe(404)
    expect((await deliver(id, { provider: 'sendcloud' })).statusCode).toBe(404)
    expect((await deliver(id, { tenantId: tenantB })).statusCode).toBe(404)
    expect((await deliver(id, { provider: 'carrier-pigeon' })).statusCode).toBe(400)
    useInbound(runtime(recording, 'production'))
    try {
      expect((await deliver(id)).statusCode).toBe(404)
    } finally {
      useInbound(runtime())
    }
    expect(await count()).toBe(before)
  })

  it("verifies a LIVE account with its provider's verifier; a provider without one gets 404", async () => {
    const live = await account({ mode: 'LIVE' })
    const answer = await deliver(live, { signed: false, headers: { 'x-test-signature': 'valid', 'x-test-event': 'live-1' } })
    expect(answer.json()).toMatchObject({ status: 'received' })
    expect((await deliver(live, { signed: false, headers: { 'x-test-event': 'live-2' } })).statusCode).toBe(401)
    expect(await receipts(live)).toEqual([
      expect.objectContaining({ verified: true, dedupeKey: 'live-1', externalId: 'ext-1', eventType: 'live.event' }),
      expect.objectContaining({ verified: false, rejectReason: 'test_signature_missing' }),
    ])
    const sendcloud = await account({ mode: 'LIVE', provider: 'SENDCLOUD' })
    expect((await deliver(sendcloud, { provider: 'sendcloud', signed: false, headers: { 'x-test-signature': 'valid', 'x-test-event': 'x' } })).statusCode).toBe(404)
  })
})

describe('processing a receipt later, once', () => {
  it('applies a receipt once, in one transaction with its PROCESSED mark; a repeat is a no-op', async () => {
    const id = await account({ companyId: companyA })
    const { receiptId } = (await deliver(id, { body: '{"n":1}' })).json() as { receiptId: string }
    expect(await processReceipt(asSystem(), receiptId, newId(), runtime())).toBe('processed')
    expect(await processReceipt(asSystem(), receiptId, newId(), runtime())).toBe('settled')
    expect(applied.filter((entry) => entry === receiptId)).toHaveLength(1)
    const [row] = await receipts(id)
    expect(row).toMatchObject({ status: 'PROCESSED', attempts: 1, lastError: null })
    // The processing command's own server time (command()'s clock).
    expect(row!.processedAt).toBeInstanceOf(Date)
    const actions = await admin(`SELECT action FROM "AuditLog" WHERE "recordId" = $1 ORDER BY at, action`, [receiptId])
    expect(actions.map((entry) => entry.action).sort()).toEqual(['integration.processInbound', 'integration.receiveInbound', 'test.applied'])
  })

  it('records a failed attempt (FAILED, attempts, lastError) and rolls back what the processor did; a retry then applies it', async () => {
    const id = await account({})
    const { receiptId } = (await deliver(id)).json() as { receiptId: string }
    const failing: InboundProcessor = {
      async process(receipt: InboundReceipt, tools) {
        tools.audit({ recordType: 'InboundWebhook', recordId: receipt.id, action: 'test.halfway' })
        throw new Error('the invoice is not known yet')
      },
    }
    await expect(processReceipt(asSystem(), receiptId, newId(), runtime(failing))).rejects.toThrow('the invoice is not known yet')
    expect(await receipts(id)).toEqual([expect.objectContaining({ status: 'FAILED', attempts: 1, lastError: 'Error: the invoice is not known yet' })])
    expect(await admin(`SELECT 1 FROM "AuditLog" WHERE action = 'test.halfway' AND "recordId" = $1`, [receiptId])).toEqual([])
    expect(await processReceipt(asSystem(), receiptId, newId(), runtime())).toBe('processed')
    expect(await receipts(id)).toEqual([expect.objectContaining({ status: 'PROCESSED', attempts: 2 })])
  })

  it('marks a receipt without a processor FAILED for a person, and leaves a rejected one alone', async () => {
    const id = await account({})
    const { receiptId } = (await deliver(id)).json() as { receiptId: string }
    expect(await processReceipt(asSystem(), receiptId, newId(), { ...runtime(), providers: {} })).toBe('no_processor')
    expect(await receipts(id)).toEqual([expect.objectContaining({ status: 'FAILED', attempts: 1, lastError: 'no processor for provider SDI' })])
    await deliver(id, { secret: 'wrong' })
    const [, rejected] = await receipts(id)
    expect(await processReceipt(asSystem(), rejected!.id, newId(), runtime())).toBe('settled')
    expect(await processReceipt(asSystem(tenantB), receiptId, newId(), runtime())).toBe('settled')
  })

  it('the worker processes it from the outbox through BullMQ, and a replayed job does not apply it twice', async () => {
    const kit: QueueKit = openQueues({ connection, prefix: redis.prefix })
    const workers: EventWorkers = startEventWorkers({ kit, handlers: [inboundHandler(() => runtime())], database, handlerBackoffMs: 10, log: silent })
    try {
      const id = await account({})
      const { receiptId } = (await deliver(id, { body: '{"via":"worker"}' })).json() as { receiptId: string }
      const [event] = await events(receiptId)
      await relayOnce(database, queuePublisher(kit))
      await eventually(async () => (await receipts(id))[0]!.status === 'PROCESSED')
      const job = await kit.queue('event-handlers').getJob(`${INBOUND_HANDLER}.${event!.id}`)
      await eventually(async () => (await job!.getState()) === 'completed')
      await kit.add('event-handlers', INBOUND_HANDLER, job!.data, { jobId: `replay.${event!.id}` })
      await eventually(async () => (await (await kit.queue('event-handlers').getJob(`replay.${event!.id}`))!.getState()) === 'completed')
      expect(applied.filter((entry) => entry === receiptId)).toHaveLength(1)
      expect(await receipts(id)).toEqual([expect.objectContaining({ status: 'PROCESSED', attempts: 1 })])
    } finally {
      await workers.close()
      await kit.close()
    }
  })
})

describe('the webhook ledger keeps every receipt (the guard trigger)', () => {
  it('refuses a change to a receipt, a delete and a truncate for every login; only the processing state moves forward', async () => {
    const id = await account({})
    const { receiptId } = (await deliver(id)).json() as { receiptId: string }
    await expect(admin(`UPDATE "InboundWebhook" SET body = '{}' WHERE id = $1`, [receiptId])).rejects.toThrow(/fixed once received/)
    await expect(admin(`UPDATE "InboundWebhook" SET "dedupeKey" = 'other' WHERE id = $1`, [receiptId])).rejects.toThrow(/fixed once received/)
    await expect(admin(`UPDATE "InboundWebhook" SET status = 'REJECTED' WHERE id = $1`, [receiptId])).rejects.toThrow(/cannot become REJECTED/)
    await expect(admin(`UPDATE "InboundWebhook" SET status = 'PROCESSED' WHERE id = $1`, [receiptId])).rejects.toThrow(/without processedAt/)
    await expect(admin(`DELETE FROM "InboundWebhook" WHERE id = $1`, [receiptId])).rejects.toThrow(/never deleted/)
    await expect(admin('TRUNCATE "InboundWebhook"')).rejects.toThrow(/TRUNCATE .* is refused|cannot truncate/)
    await admin(`UPDATE "InboundWebhook" SET status = 'FAILED', attempts = 2, "lastError" = 'x' WHERE id = $1`, [receiptId])
    await expect(admin(`UPDATE "InboundWebhook" SET attempts = 1 WHERE id = $1`, [receiptId])).rejects.toThrow(/cannot go down/)
    await admin(`UPDATE "InboundWebhook" SET status = 'RECEIVED' WHERE id = $1`, [receiptId])
    await admin(`UPDATE "InboundWebhook" SET status = 'PROCESSED', "processedAt" = now() WHERE id = $1`, [receiptId])
    await expect(admin(`UPDATE "InboundWebhook" SET status = 'FAILED' WHERE id = $1`, [receiptId])).rejects.toThrow(/its state is final/)
    await expect(admin(`INSERT INTO "InboundWebhook" (id, "tenantId", "accountId", provider, verified, "bodySha256", "bodyBytes", body, "receivedAt", "requestId", status) VALUES ($1, $2, $3, 'SDI', false, 'x', 1, 'kept', now(), 'r', 'REJECTED')`, [newId(), tenantA, id])).rejects.toThrow(
      /REJECTED, with no dedupe key and no body/,
    )
    await expect(runtimeRoleCannotDelete()).resolves.toBeUndefined()
  })
})

/** The runtime role has no DELETE grant on the ledger at all. */
async function runtimeRoleCannotDelete(): Promise<void> {
  await expect(callerFor(database, office()).withClient((client) => client.$executeRawUnsafe('DELETE FROM "InboundWebhook" WHERE false'))).rejects.toThrow(/permission denied/)
}
