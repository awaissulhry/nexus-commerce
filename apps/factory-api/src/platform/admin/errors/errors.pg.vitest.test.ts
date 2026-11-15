import { randomBytes } from 'node:crypto'
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
import type { DeadLetter } from '../../../core/queue'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { createGateway } from '../../gateway/gateway'
import { useGateway } from '../../gateway/service'
import { testRedis, type TestRedis } from '../../outbox/testing'
import { createSecretsService } from '../../secrets/envelope'
import { localKeyProvider } from '../../secrets/local'
import { useHealthRedis } from '../jobs/redis'
import { collectErrors, type JobsReader } from './collect'
import { useJobRetrier, type JobRetrier } from './errors'

/**
 * The error queue and a connection's Test and Reconnect on the local stack (B-W2b-415; PLT-196, PLT-201), with the app's real
 * routes: the collector turns failed rows into items once (a key's later failures add a try; a key that went through opens
 * none; transient refusals and tests are never errors); the queue keeps to the caller's companies; Retry sends a message again
 * once (a dead event to its relay, a failed webhook to processing, a background job through its queue) and holds a call and a
 * rejected signature with why; Dismiss keeps who and why; a retry that fails again comes back OPEN with one more try. Test is
 * one call through the gateway (FAKE here), Reconnect closes the circuit first. The local Redis under this file's own prefix.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
const tenantA = newId()
const tenantB = newId()
const companyOne = newId()
const companyTwo = newId()
const companyB = newId()
const user = newId()
const sdiOne = newId()
const ses = newId()
const vies = newId()
const paused = newId()
const live = newId()
const otherSdi = newId()

const grant = (permissions: Grant['permissions'], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  admin: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['integrations.view', 'integrations.manage', 'integrations.errors.manage'])] },
  'admin-one': { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['integrations.view', 'integrations.manage', 'integrations.errors.manage'], [companyOne])] },
  viewer: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['integrations.view'])] },
  nobody: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['audit.read'])] },
  'admin-b': { audience: 'office', tenantId: tenantB, actorId: user, grants: [grant(['integrations.view', 'integrations.errors.manage'])] },
}
const LOG = { info() {}, warn() {}, error() {} }

const call = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
const admin = async (sql: string, params: unknown[] = []) => (await db.admin.query(sql, params)).rows as Array<Record<string, unknown>>

type Item = { id: string; source: string; operation: string; reasonCode: string; reasonText: string | null; tries: number; state: string; version: number; companyId: string | null; retry: { held: string | null }; retriedBySystem: boolean | null }
const list = async (session = 'admin', query = 'view=all') => (await call(session, 'GET', `/integrations/errors?${query}&limit=200`)).json() as { items: Item[]; counts: Record<string, number>; canManage: boolean }
const byOperation = (items: Item[], operation: string) => items.find((item) => item.operation === operation)!

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000)

async function event(type: string, status: 'DEAD' | 'PUBLISHED', companyId: string | null = null): Promise<string> {
  const id = newId()
  await admin(
    `INSERT INTO "OutboxEvent" (id, "tenantId", "companyId", type, version, context, subject, "correlationId", source, "occurredAt", payload) VALUES ($1, $2, $3, $4, 1, 'test', $5, 'req-e', 'test.emit', now(), '{}')`,
    [id, tenantA, companyId, type, id],
  )
  if (status === 'DEAD') await admin(`UPDATE "OutboxEvent" SET status = 'DEAD', attempts = 8, "lastError" = 'Redis did not answer (made up)' WHERE id = $1`, [id])
  else await admin(`UPDATE "OutboxEvent" SET status = 'PUBLISHED', attempts = 1, "publishedAt" = now() WHERE id = $1`, [id])
  return id
}

async function failedCall(accountId: string, provider: string, companyId: string | null, operation: string, status: string, options: { key?: string; reason?: string; at?: Date; error?: string } = {}): Promise<string> {
  const id = newId()
  const at = options.at ?? ago(5)
  await admin(
    `INSERT INTO "IntegrationCall" (id, "tenantId", "companyId", "accountId", provider, mode, operation, "requestId", "idempotencyKey", "startedAt", "finishedAt", "durationMs", attempts, status, reason, error, "requestSummary")
     VALUES ($1, $2, $3, $4, $5, 'FAKE', $6, 'req-c', $7, $8, $8, 40, 1, $9, $10, $11, '{"sendId":"made-up-41","bytes":1842}')`,
    [id, tenantA, companyId, accountId, provider, operation, options.key ?? null, at, status, options.reason ?? null, options.error ?? null],
  )
  return id
}

const deadLetters: DeadLetter[] = []
const jobs: JobsReader = {
  deadLetters: async () => deadLetters,
  failedSince: async (_queue, jobId, since) => (failedAgain.has(jobId) ? { at: new Date(since.getTime() + 1), reason: 'failed again (made up)' } : null),
}
const failedAgain = new Set<string>()
let retrier: JobRetrier['retry'] = async () => 'retried'

let deadEvent = ''
let publishedEvent = ''
let failedHook = ''
let keyedFirst = ''

beforeAll(async () => {
  db = await migratedDatabase('admin_errors')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  redis = testRedis()
  connection = redis.connect()
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  useGateway(createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {} }))
  useHealthRedis({ redis: connection, prefix: redis.prefix })
  useJobRetrier({ retry: (queue, jobId) => retrier(queue, jobId) })
  for (const [tenantId, slug, companies] of [
    [tenantA, 'er-a', [companyOne, companyTwo]],
    [tenantB, 'er-b', [companyB]],
  ] as const) {
    await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenantId, slug])
    for (const [index, companyId] of companies.entries()) await admin('INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, $3, $3)', [companyId, tenantId, `${slug}-${index}`])
  }
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, 'ada@example.com', 'Ada Esempio', 'ACTIVE')`, [user, tenantA])
  const account = (id: string, tenantId: string, companyId: string | null, provider: string, code: string, mode = 'FAKE', status = 'ACTIVE') =>
    admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", "companyId", provider, code, label, mode, status) VALUES ($1, $2, $3, $4, $5, $5, $6, $7)`, [id, tenantId, companyId, provider, code, mode, status])
  await account(sdiOne, tenantA, companyOne, 'SDI', 'sdi-one')
  await account(ses, tenantA, null, 'SES', 'ses')
  await account(vies, tenantA, null, 'VIES', 'vies')
  await account(paused, tenantA, companyTwo, 'SENDCLOUD', 'sendcloud-two', 'FAKE', 'PAUSED')
  await account(live, tenantA, companyOne, 'SENDCLOUD', 'sendcloud-live', 'LIVE')
  await account(otherSdi, tenantB, companyB, 'SDI', 'sdi-b')

  deadEvent = await event('quote.sent', 'DEAD')
  publishedEvent = await event('email.queued', 'PUBLISHED', companyOne)
  deadLetters.push({ queue: 'event-handlers', jobId: `email.send.${publishedEvent}`, name: 'email.send', data: { tenantId: tenantA, eventId: publishedEvent, companyId: companyOne }, attemptsMade: 5, error: 'ProviderError: buyer@example.com bounced', failedAt: ago(3).toISOString() })
  failedHook = newId()
  await admin(
    `INSERT INTO "InboundWebhook" (id, "tenantId", "companyId", "accountId", provider, verified, "dedupeKey", "eventType", "bodySha256", "bodyBytes", body, "receivedAt", "requestId", status) VALUES ($1, $2, $3, $4, 'SDI', true, 'k-1', 'RC', 'abc', 120, '{"x":"never shown"}', now(), 'req-in', 'RECEIVED')`,
    [failedHook, tenantA, companyOne, sdiOne],
  )
  await admin(`UPDATE "InboundWebhook" SET status = 'FAILED', attempts = 5, "lastError" = 'Unknown invoice (made up)' WHERE id = $1`, [failedHook])
  await admin(
    `INSERT INTO "InboundWebhook" (id, "tenantId", "companyId", "accountId", provider, verified, "bodySha256", "bodyBytes", "receivedAt", "requestId", status, "rejectReason") VALUES ($1, $2, $3, $4, 'SDI', false, 'def', 80, now(), 'req-bad', 'REJECTED', 'signature mismatch')`,
    [newId(), tenantA, companyOne, sdiOne],
  )
  await failedCall(sdiOne, 'SDI', companyOne, 'sdi.send_invoice', 'FAILED', { reason: 'provider_error', error: '00404 recipient code not valid (made up)' })
  keyedFirst = await failedCall(ses, 'SES', null, 'mail.send', 'TIMED_OUT', { key: 'mail-k1', reason: 'timeout', at: ago(20) })
  await failedCall(ses, 'SES', null, 'mail.send', 'FAILED', { key: 'mail-k1', reason: 'network_error', at: ago(10) })
  await failedCall(vies, 'VIES', null, 'vat.check', 'REFUSED', { reason: 'account_paused' })
  await failedCall(vies, 'VIES', null, 'vat.check', 'REFUSED', { reason: 'rate_limited' })
  await failedCall(sdiOne, 'SDI', companyOne, 'connection.test', 'FAILED', { reason: 'provider_error' })
  await failedCall(ses, 'SES', null, 'mail.send', 'FAILED', { key: 'mail-k2', reason: 'timeout', at: ago(30) })
  await admin(
    `INSERT INTO "IntegrationCall" (id, "tenantId", "accountId", provider, mode, operation, "requestId", "idempotencyKey", "startedAt", "finishedAt", "durationMs", attempts, status) VALUES ($1, $2, $3, 'SES', 'FAKE', 'mail.send', 'req-ok', 'mail-k2', $4, $4, 30, 1, 'SUCCEEDED')`,
    [newId(), tenantA, ses, ago(25)],
  )
  // Another tenant's failure stays in its own queue.
  await admin(
    `INSERT INTO "IntegrationCall" (id, "tenantId", "companyId", "accountId", provider, mode, operation, "requestId", "startedAt", "finishedAt", "durationMs", attempts, status, reason) VALUES ($1, $2, $3, $4, 'SDI', 'FAKE', 'sdi.send_invoice', 'req-b', now(), now(), 10, 1, 'FAILED', 'provider_error')`,
    [newId(), tenantB, companyB, otherSdi],
  )
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 120_000)

afterAll(async () => {
  useGateway(undefined)
  useHealthRedis(undefined)
  useJobRetrier(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
}, 60_000)

describe('the collector', () => {
  it('opens one item per failed message, a key once with its tries; never a transient refusal, a test or a key that went through', async () => {
    const first = await collectErrors({ database, log: LOG, jobs })
    // Seven in tenant A, one (its failed SDI call) in tenant B.
    expect(first.opened).toBe(8)
    const { items, counts } = await list()
    expect(counts).toEqual({ open: 7, retried: 0, dismissed: 0 })
    expect(items.map((item) => `${item.source}:${item.operation}:${item.reasonCode}`).sort()).toEqual([
      'CALL:mail.send:timeout',
      'CALL:sdi.send_invoice:provider_error',
      'CALL:vat.check:account_paused',
      'OUTBOX:email.send:job_failed',
      'OUTBOX:quote.sent:publish_failed',
      'WEBHOOK:webhook.process:processing_failed',
      'WEBHOOK:webhook.process:signature_mismatch',
    ])
    expect(byOperation(items, 'mail.send')).toMatchObject({ tries: 2, reasonCode: 'timeout' })
    // The provider's words are kept scrubbed: an address never stays in the queue.
    expect(byOperation(items, 'email.send').reasonText).not.toContain('buyer@example.com')
    const again = await collectErrors({ database, log: LOG, jobs })
    expect(again).toEqual({ opened: 0, reopened: 0, bumped: 0, healed: 0 })
    const [audit] = await admin(`SELECT count(*)::int AS n FROM "AuditLog" WHERE action = 'integration.errorOpened' AND "tenantId" = $1`, [tenantA])
    expect(audit!.n).toBe(7)
    const [events] = await admin(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'integration.error_opened' AND "tenantId" = $1`, [tenantA])
    expect(events!.n).toBe(7)
  })

  it('keeps to the companies a grant reaches; another tenant never; no right, no queue', async () => {
    const one = await list('admin-one')
    expect(one.items.every((item) => item.companyId === null || item.companyId === companyOne)).toBe(true)
    expect(one.items.length).toBe(7)
    expect((await list('admin-b')).items.map((item) => `${item.companyId}:${item.operation}`)).toEqual([`${companyB}:sdi.send_invoice`])
    expect((await call('nobody', 'GET', '/integrations/errors')).statusCode).toBe(403)
    const viewer = await list('viewer')
    expect(viewer.canManage).toBe(false)
    expect(viewer.items.every((item) => item.retry.held !== null)).toBe(true)
  })

  it('a key that went through after it failed marks its open item RETRIED by the system', async () => {
    await admin(
      `INSERT INTO "IntegrationCall" (id, "tenantId", "accountId", provider, mode, operation, "requestId", "idempotencyKey", "startedAt", "finishedAt", "durationMs", attempts, status) VALUES ($1, $2, $3, 'SES', 'FAKE', 'mail.send', 'req-ok2', 'mail-k1', $4, $4, 30, 1, 'SUCCEEDED')`,
      [newId(), tenantA, ses, ago(2)],
    )
    expect((await collectErrors({ database, log: LOG, jobs })).healed).toBe(1)
    const item = byOperation((await list()).items, 'mail.send')
    expect(item).toMatchObject({ state: 'RETRIED', retriedBySystem: true, tries: 2 })
    const [source] = await admin(`SELECT "sourceId" FROM "IntegrationErrorItem" WHERE id = $1`, [item.id])
    expect(source!.sourceId).toBe(keyedFirst)
  })
})

describe('one item', () => {
  it('says what failed in its source words: the summaries the gateway kept, never a body', async () => {
    const sdi = byOperation((await list()).items, 'sdi.send_invoice')
    const response = await call('viewer', 'GET', `/integrations/errors/${sdi.id}`)
    expect(response.statusCode).toBe(200)
    const body = response.json() as { item: Item; detail: { source: { kind: string; request: Array<{ key: string }>; accountLabel: string } } }
    expect(body.item.retry.held).toBe('FROM_RECORD')
    expect(body.detail.source).toMatchObject({ kind: 'call', accountLabel: 'sdi-one' })
    expect(body.detail.source.request.map((line) => line.key).sort()).toEqual(['bytes', 'sendId'])
    const hook = (await list()).items.find((item) => item.reasonCode === 'processing_failed')!
    expect(JSON.stringify((await call('admin', 'GET', `/integrations/errors/${hook.id}`)).json())).not.toContain('never shown')
    expect((await call('admin-b', 'GET', `/integrations/errors/${sdi.id}`)).statusCode).toBe(404)
  })
})

describe('retry', () => {
  it('sends a dead event back to its relay once; when it dies again the item is open with one more try', async () => {
    const item = byOperation((await list()).items, 'quote.sent')
    const response = await call('admin', 'POST', `/integrations/errors/${item.id}/retry`, { version: item.version })
    expect(response.statusCode).toBe(200)
    expect((response.json() as { item: Item }).item).toMatchObject({ state: 'RETRIED', retriedBySystem: false, retry: { held: 'WAITING' } })
    const [row] = await admin(`SELECT status FROM "OutboxEvent" WHERE id = $1`, [deadEvent])
    expect(row!.status).toBe('PENDING')
    expect((await call('admin', 'POST', `/integrations/errors/${item.id}/retry`, { version: item.version + 1 })).statusCode).toBe(409)
    await admin(`UPDATE "OutboxEvent" SET status = 'DEAD', attempts = 9 WHERE id = $1`, [deadEvent])
    expect((await collectErrors({ database, log: LOG, jobs })).reopened).toBe(1)
    expect(byOperation((await list()).items, 'quote.sent')).toMatchObject({ state: 'OPEN', tries: 2 })
    const audit = await admin(`SELECT action, "actorId" FROM "AuditLog" WHERE "recordId" = $1 ORDER BY at`, [item.id])
    expect(audit.map((entry) => entry.action)).toEqual(['integration.errorOpened', 'integration.retryError', 'integration.errorFailedAgain'])
  })

  it('sends a failed webhook back to processing with its event', async () => {
    const item = (await list()).items.find((entry) => entry.reasonCode === 'processing_failed')!
    expect((await call('admin', 'POST', `/integrations/errors/${item.id}/retry`, { version: item.version })).statusCode).toBe(200)
    const [hook] = await admin(`SELECT status FROM "InboundWebhook" WHERE id = $1`, [failedHook])
    expect(hook!.status).toBe('RECEIVED')
    const [emitted] = await admin(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'integration.inbound_received' AND payload->>'receiptId' = $1`, [failedHook])
    expect(emitted!.n).toBe(1)
  })

  it('runs a background job again through its queue; a job gone or Redis down is refused in words and nothing changes', async () => {
    const item = byOperation((await list()).items, 'email.send')
    retrier = async () => 'gone'
    const gone = await call('admin', 'POST', `/integrations/errors/${item.id}/retry`, { version: item.version })
    expect(gone.statusCode).toBe(409)
    expect(byOperation((await list()).items, 'email.send').state).toBe('OPEN')
    retrier = async () => {
      throw new Error('Redis is down')
    }
    expect((await call('admin', 'POST', `/integrations/errors/${item.id}/retry`, { version: item.version })).statusCode).toBe(503)
    const asked: string[] = []
    retrier = async (queue, jobId) => {
      asked.push(`${queue}/${jobId}`)
      return 'retried'
    }
    expect((await call('admin', 'POST', `/integrations/errors/${item.id}/retry`, { version: item.version })).statusCode).toBe(200)
    expect(asked).toEqual([`event-handlers/email.send.${publishedEvent}`])
    failedAgain.add(`email.send.${publishedEvent}`)
    expect((await collectErrors({ database, log: LOG, jobs })).reopened).toBe(1)
    expect(byOperation((await list()).items, 'email.send')).toMatchObject({ state: 'OPEN', tries: 2 })
  })

  it('holds a failed call and a rejected signature with why; a reader or another company may not', async () => {
    const items = (await list()).items
    const sdi = byOperation(items, 'sdi.send_invoice')
    const refusedCall = await call('admin', 'POST', `/integrations/errors/${sdi.id}/retry`, { version: sdi.version })
    expect(refusedCall.statusCode).toBe(409)
    expect((refusedCall.json() as { error: { message: string } }).error.message).toMatch(/sent again from where it started/)
    const bad = items.find((entry) => entry.reasonCode === 'signature_mismatch')!
    expect((await call('admin', 'POST', `/integrations/errors/${bad.id}/retry`, { version: bad.version })).statusCode).toBe(409)
    const paused = byOperation(items, 'vat.check')
    expect((await call('viewer', 'POST', `/integrations/errors/${paused.id}/dismiss`, { version: paused.version, reason: 'Checked by hand' })).statusCode).toBe(403)
    expect((await call('admin-one', 'POST', `/integrations/errors/${paused.id}/dismiss`, { version: paused.version, reason: 'Checked by hand' })).statusCode).toBe(403)
  })
})

describe('dismiss', () => {
  it('keeps the item with who, when and why; a short reason, a stale screen or a second dismiss is refused', async () => {
    const item = byOperation((await list()).items, 'vat.check')
    expect((await call('admin', 'POST', `/integrations/errors/${item.id}/dismiss`, { version: item.version, reason: 'no' })).statusCode).toBe(400)
    expect((await call('admin', 'POST', `/integrations/errors/${item.id}/dismiss`, { version: item.version + 5, reason: 'Checked by hand' })).statusCode).toBe(409)
    const done = await call('admin', 'POST', `/integrations/errors/${item.id}/dismiss`, { version: item.version, reason: 'The VAT number was checked by hand' })
    expect(done.statusCode).toBe(200)
    expect((await call('admin', 'POST', `/integrations/errors/${item.id}/dismiss`, { version: item.version + 1, reason: 'Again' })).statusCode).toBe(409)
    const one = (await call('admin', 'GET', `/integrations/errors/${item.id}`)).json() as { item: Item & { dismissReason: string }; detail: { dismissedBy: { name: string } } }
    expect(one.item).toMatchObject({ state: 'DISMISSED', dismissReason: 'The VAT number was checked by hand' })
    expect(one.detail.dismissedBy).toEqual({ system: false, name: 'Ada Esempio' })
    expect((await list('admin', 'view=dismissed')).items.map((entry) => entry.id)).toEqual([item.id])
  })
})

describe('Test and Reconnect', () => {
  it('tests a FAKE connection through the gateway: one ledger row, never an item of the queue', async () => {
    const response = await call('admin', 'POST', `/integrations/accounts/${sdiOne}/test`, {})
    expect(response.statusCode).toBe(200)
    expect((response.json() as { test: { outcome: string; fake: boolean } }).test).toMatchObject({ outcome: 'OK', fake: true, reconnected: false })
    const rows = await admin(`SELECT status FROM "IntegrationCall" WHERE "accountId" = $1 AND operation = 'connection.test' AND status = 'SUCCEEDED'`, [sdiOne])
    expect(rows).toHaveLength(1)
    const [audit] = await admin(`SELECT after FROM "AuditLog" WHERE action = 'integration.testAccount' AND "recordId" = $1`, [sdiOne])
    expect(audit!.after).toMatchObject({ outcome: 'OK', reconnect: false })
    const before = (await list()).items.length
    await collectErrors({ database, log: LOG, jobs })
    expect((await list()).items.length).toBe(before)
  })

  it('reconnect closes an open circuit first, then tests; a paused connection is refused by the gateway and Reconnect is held', async () => {
    await connection.hset(`${redis.prefix}:gateway:circuit:${sdiOne}`, 'failures', '5', 'openUntil', String(Date.now() + 60_000))
    expect((await call('admin', 'POST', `/integrations/accounts/${sdiOne}/test`, {})).json()).toMatchObject({ test: { outcome: 'REFUSED', reason: 'circuit_open' } })
    const reconnected = await call('admin', 'POST', `/integrations/accounts/${sdiOne}/reconnect`, {})
    expect(reconnected.statusCode).toBe(200)
    expect((reconnected.json() as { test: unknown }).test).toMatchObject({ outcome: 'OK', reconnected: true, circuitBefore: { failures: 5 } })
    expect(await connection.exists(`${redis.prefix}:gateway:circuit:${sdiOne}`)).toBe(0)
    expect((await call('admin', 'POST', `/integrations/accounts/${paused}/test`, {})).json()).toMatchObject({ test: { outcome: 'REFUSED', reason: 'account_paused' } })
    expect((await call('admin', 'POST', `/integrations/accounts/${paused}/reconnect`, {})).statusCode).toBe(409)
  })

  it('holds a live service without a harmless call; a reader, another company or tenant may not', async () => {
    const held = await call('admin', 'POST', `/integrations/accounts/${live}/test`, {})
    expect(held.statusCode).toBe(409)
    expect((held.json() as { error: { message: string } }).error.message).toMatch(/no harmless test call/)
    expect((await call('viewer', 'POST', `/integrations/accounts/${sdiOne}/test`, {})).statusCode).toBe(403)
    expect((await call('admin-one', 'POST', `/integrations/accounts/${ses}/test`, {})).statusCode).toBe(403)
    expect((await call('admin', 'POST', `/integrations/accounts/${otherSdi}/test`, {})).statusCode).toBe(404)
  })
})
