import { randomBytes } from 'node:crypto'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { IntegrationMode, IntegrationProvider, openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase, type Prisma } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { systemClock } from '@nexus/factory-domain/core/time'
import type { KmsPort } from '@nexus/factory-domain/ports/kms'
import { INTEGRATION_MODES, INTEGRATION_PROVIDERS } from '@nexus/factory-domain/ports/provider'
import { callerFor, command, type CommandCaller } from '../../core/command'
import type { RequestContext } from '../../core/context'
import { testRedis, type TestRedis } from '../outbox/testing'
import { createSecretsService, type SecretsService } from '../secrets/envelope'
import { localKeyProvider } from '../secrets/local'
import { readSecret, rotateSecret, SECRET_PURPOSES, storeSecret } from '../secrets/store'
import { assertNoFakeAccountsInProduction, FakeAccountsInProductionError } from './boot'
import { createGateway, GatewayCallFailed, gatewayAccount, GatewayRefusal, ProviderError, type GatewayCall, type GatewayOptions } from './gateway'

/**
 * The gateway and the sealed secrets on the local stack: a throwaway PostgreSQL 17 database from the migrations, the
 * runtime login factory_app through the scoped clients, and the local Redis under this file's own prefix. Nothing here
 * reaches an outside service: `fn` is the test's own function. Run with `node scripts/factory/run-pg-tests.mjs gateway`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let redis: TestRedis
let connection: Redis
let currentKey: KmsPort
let secrets: SecretsService
const tenantA = newId()
const tenantB = newId()
const companyA = newId()
const companyB = newId()
const user = newId()
const SECRET_KEY = 'sk_test_made_up_value_7f3a9c'
let nowMs = Date.parse('2026-10-28T09:00:00.000Z')
const clock = { now: () => new Date(nowMs) }
const silent = { info() {}, warn() {}, error() {} }

const admin = async <T = Record<string, any>>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const office = (tenantId = tenantA): RequestContext => ({ audience: 'office', tenantId, actorId: user, companyId: tenantId === tenantA ? companyA : companyB, grants: [], requestId: newId() })
const system = (tenantId = tenantA): RequestContext => ({ audience: 'system', tenantId, actorId: '00000000-0000-7000-8000-000000000000', grants: [], requestId: newId() })
const floor = (): RequestContext => ({ audience: 'floor', tenantId: tenantA, actorId: user, siteId: newId(), deviceId: newId(), grants: [], requestId: newId() })
const as = (context: RequestContext): CommandCaller => callerFor(database, context)
const gateway = (options: Partial<GatewayOptions> = {}) =>
  createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, clock, sleep: async () => {}, log: silent, ...options })
const callsOf = (accountId: string) => admin(`SELECT * FROM "IntegrationCall" WHERE "accountId" = $1 ORDER BY "startedAt", id`, [accountId])
const ok = async () => 'ok'
const secretOf = async (accountId: string): Promise<string> =>
  (await admin<{ credentialsSecretId: string }>(`SELECT "credentialsSecretId" FROM "IntegrationAccount" WHERE id = $1`, [accountId]))[0]!.credentialsSecretId
const failWith = (httpStatus: number) => async (): Promise<never> => {
  throw new ProviderError(`the provider answered ${httpStatus}`, { httpStatus })
}

/** An account made the way the admin step will make one: through command(), its credentials sealed by storeSecret. */
async function account(fields: Partial<Prisma.IntegrationAccountUncheckedCreateInput> = {}, credentials: Record<string, unknown> | null = { apiKey: SECRET_KEY }, tenantId = tenantA): Promise<string> {
  const id = newId()
  await command(as(office(tenantId)), { name: 'integration.createAccount', input: { id } }, async (tools) => {
    const secret = credentials ? await storeSecret(tools, secrets, { purpose: SECRET_PURPOSES.credentials, plaintext: JSON.stringify(credentials) }) : null
    await tools.tx.integrationAccount.create({
      data: { id, provider: 'SES', code: `acc-${id.slice(-12)}`, label: 'Test account', mode: 'LIVE', credentialsSecretId: secret?.id ?? null, ...fields },
      select: { id: true },
    })
    tools.audit({ recordType: 'IntegrationAccount', recordId: id })
    return { id }
  })
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('gateway')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  redis = testRedis()
  connection = redis.connect()
  currentKey = localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })
  secrets = createSecretsService({ providers: [currentKey] })
  for (const [tenantId, slug, companyId] of [
    [tenantA, 'gw-a', companyA],
    [tenantB, 'gw-b', companyB],
  ] as const) {
    await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenantId, slug])
    await admin('INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, $3, $3)', [companyId, tenantId, `${slug}-c`])
  }
}, 60_000)

afterAll(async () => {
  await redis?.cleanup()
  await database?.close()
  await db?.close()
}, 60_000)

describe('the ports match the schema', () => {
  it('lists the same providers and modes as the database enums', () => {
    expect([...INTEGRATION_PROVIDERS].sort()).toEqual(Object.values(IntegrationProvider).sort())
    expect([...INTEGRATION_MODES].sort()).toEqual(Object.values(IntegrationMode).sort())
  })
})

describe('sealed secrets in SecretValue rows (PLT-197)', () => {
  it('stores only the envelope, opens it for its tenant and purpose, and audits without the value', async () => {
    const id = await account()
    const [row] = await admin(`SELECT s.* FROM "SecretValue" s JOIN "IntegrationAccount" a ON a."credentialsSecretId" = s.id WHERE a.id = $1`, [id])
    expect(row).toMatchObject({ tenantId: tenantA, purpose: 'integration.credentials', algorithm: 'AES-256-GCM', keyId: secrets.keyId, version: 1, rotatedAt: null })
    for (const column of ['wrappedKey', 'iv', 'ciphertext', 'authTag']) expect(Buffer.isBuffer(row![column])).toBe(true)
    const dump = JSON.stringify(await admin('SELECT * FROM "SecretValue"')) + JSON.stringify(await admin('SELECT * FROM "AuditLog"'))
    expect(dump).not.toContain(SECRET_KEY)
    const opened = await as(office()).withClient((client) => readSecret(client, secrets, { id: row!.id, tenantId: tenantA, purpose: SECRET_PURPOSES.credentials }))
    expect(JSON.parse(opened)).toEqual({ apiKey: SECRET_KEY })
    await expect(as(office()).withClient((client) => readSecret(client, secrets, { id: row!.id, tenantId: tenantA, purpose: SECRET_PURPOSES.webhook }))).rejects.toThrow(/is for integration.credentials/)
    // Another tenant does not even see the row (RLS).
    await expect(as(office(tenantB)).withClient((client) => readSecret(client, secrets, { id: row!.id, tenantId: tenantB, purpose: SECRET_PURPOSES.credentials }))).rejects.toThrow(/does not exist/)
    const [audit] = await admin(`SELECT after FROM "AuditLog" WHERE "recordType" = 'SecretValue' AND "recordId" = $1`, [row!.id])
    expect(audit!.after).toEqual({ purpose: 'integration.credentials', keyId: secrets.keyId })
  })

  it('a row copied to another tenant does not open there (its tenant is in the encryption context)', async () => {
    const id = await account()
    const secretId = await secretOf(id)
    const copy = newId()
    await admin(`INSERT INTO "SecretValue" SELECT $1, $2, purpose, "keyId", algorithm, "wrappedKey", iv, ciphertext, "authTag", version, "createdAt", "updatedAt", "rotatedAt", "createdById" FROM "SecretValue" WHERE id = $3`, [copy, tenantB, secretId])
    await expect(as(office(tenantB)).withClient((client) => readSecret(client, secrets, { id: copy, tenantId: tenantB, purpose: SECRET_PURPOSES.credentials }))).rejects.toThrow(/did not unwrap|does not open/)
  })

  it('rotates a stored secret in place under the current key (rotatedAt, version, audit)', async () => {
    const id = await account()
    const secretId = await secretOf(id)
    const [before] = await admin('SELECT * FROM "SecretValue" WHERE id = $1', [secretId])
    const newKey = localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })
    // A service that does not hold the old key cannot rotate the value.
    await expect(rotateSecret(as(office()), createSecretsService({ providers: [newKey] }), secretId)).rejects.toThrow(/No key provider holds key/)
    const moving = createSecretsService({ providers: [newKey, currentKey] })
    expect(moving.needsRotation(before as never)).toBe(true)
    expect(await rotateSecret(as(office()), moving, secretId)).toEqual({ id: secretId, keyId: newKey.keyId, version: 2 })
    const [after] = await admin('SELECT * FROM "SecretValue" WHERE id = $1', [secretId])
    expect(after).toMatchObject({ keyId: newKey.keyId, version: 2 })
    expect(after!.rotatedAt).toBeInstanceOf(Date)
    expect(Buffer.compare(after!.ciphertext, before!.ciphertext)).not.toBe(0)
    const opened = await as(office()).withClient((client) => readSecret(client, createSecretsService({ providers: [newKey] }), { id: secretId, tenantId: tenantA, purpose: SECRET_PURPOSES.credentials }))
    expect(JSON.parse(opened)).toEqual({ apiKey: SECRET_KEY })
    const [audit] = await admin(`SELECT before, after FROM "AuditLog" WHERE action = 'integration.rotateSecret' AND "recordId" = $1`, [secretId])
    expect(audit).toEqual({ before: { keyId: currentKey.keyId }, after: { keyId: newKey.keyId, rotated: true } })
  })
})

describe('gateway.call: one IntegrationCall row per call (PLT-195)', () => {
  it('records a successful call with its request id, idempotency key, attempts and redacted summaries', async () => {
    const id = await account({ companyId: companyA })
    const context = system()
    const answer = await gateway({ clock: systemClock }).call(
      gatewayAccount(as(context), id),
      { name: 'mail.send', idempotent: true, idempotencyKey: 'mail-0001', request: { to: ['buyer@example.com'], template: 'quote', apiKey: SECRET_KEY } },
      async (call: GatewayCall) => {
        const credentials = await call.credentials<{ apiKey: string }>()
        expect(credentials).toEqual({ apiKey: SECRET_KEY })
        expect(call.account).toMatchObject({ id, tenantId: tenantA, companyId: companyA, provider: 'SES', mode: 'LIVE' })
        expect(call.idempotencyKey).toBe('mail-0001')
        await new Promise((resolve) => setTimeout(resolve, 20))
        call.answer({ httpStatus: 200, response: { messageId: 'm-1', echo: `key ${credentials!.apiKey} for ops@example.com`, recipient: { name: 'Ada Example' } } })
        return 'm-1'
      },
    )
    expect(answer).toBe('m-1')
    const rows = await callsOf(id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      tenantId: tenantA,
      companyId: companyA,
      accountId: id,
      provider: 'SES',
      mode: 'LIVE',
      operation: 'mail.send',
      requestId: context.requestId,
      idempotencyKey: 'mail-0001',
      attempts: 1,
      status: 'SUCCEEDED',
      reason: null,
      httpStatus: 200,
      error: null,
      requestSummary: { to: '[personal]', template: 'quote', apiKey: '[redacted]' },
      responseSummary: { messageId: 'm-1', echo: 'key [redacted] for [email]', recipient: '[personal]' },
    })
    expect(rows[0]!.durationMs).toBeGreaterThanOrEqual(15)
    expect(JSON.stringify(rows)).not.toContain(SECRET_KEY)
    const [health] = await admin('SELECT "lastOkAt", "lastError" FROM "IntegrationAccount" WHERE id = $1', [id])
    expect(health!.lastOkAt).toBeInstanceOf(Date)
  })

  it('records a failed call once, without its secret, and throws GatewayCallFailed', async () => {
    const id = await account()
    const failure = await gateway()
      .call(gatewayAccount(as(office()), id), { name: 'mail.send', idempotent: false }, async (call) => {
        const { apiKey } = (await call.credentials<{ apiKey: string }>())!
        throw new ProviderError(`invalid recipient (sent with ${apiKey})`, { httpStatus: 400, response: { error: 'bad address', email: 'x@example.com' } })
      })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(GatewayCallFailed)
    expect(failure).toMatchObject({ kind: 'provider_error', retryable: false, httpStatus: 400, attempts: 1 })
    expect((failure as Error).message).not.toContain(SECRET_KEY)
    const rows = await callsOf(id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'FAILED', reason: 'provider_error', httpStatus: 400, attempts: 1, responseSummary: { error: 'bad address', email: '[personal]' } })
    expect(rows[0]!.error).toBe('invalid recipient (sent with [redacted])')
    const [health] = await admin('SELECT "lastErrorAt", "lastError" FROM "IntegrationAccount" WHERE id = $1', [id])
    expect(health).toMatchObject({ lastError: 'mail.send: invalid recipient (sent with [redacted])' })
  })

  it('retries a timeout, a network error, a 429 or a 5xx only for an idempotent operation', async () => {
    const idempotent = await account()
    let tries = 0
    const answer = await gateway().call(gatewayAccount(as(office()), idempotent), { name: 'parcel.track', idempotent: true }, async () => {
      tries++
      if (tries === 1) throw new ProviderError('busy', { httpStatus: 503 })
      if (tries === 2) throw new TypeError('fetch failed')
      return 'delivered'
    })
    expect(answer).toBe('delivered')
    expect(await callsOf(idempotent)).toEqual([expect.objectContaining({ status: 'SUCCEEDED', attempts: 3 })])

    const once = await account()
    let sent = 0
    await expect(
      gateway().call(gatewayAccount(as(office()), once), { name: 'parcel.create', idempotent: false }, async () => {
        sent++
        throw new ProviderError('busy', { httpStatus: 503 })
      }),
    ).rejects.toMatchObject({ kind: 'provider_error', retryable: true, attempts: 1 })
    expect(sent).toBe(1)
    expect(await callsOf(once)).toEqual([expect.objectContaining({ status: 'FAILED', attempts: 1, httpStatus: 503 })])

    const exhausted = await account()
    await expect(gateway().call(gatewayAccount(as(office()), exhausted), { name: 'parcel.track', idempotent: true, maxAttempts: 2 }, failWith(502))).rejects.toMatchObject({ attempts: 2 })
    expect(await callsOf(exhausted)).toEqual([expect.objectContaining({ status: 'FAILED', attempts: 2, httpStatus: 502 })])
  })

  it('stops an attempt at its timeout (the signal aborts) and records TIMED_OUT', async () => {
    const id = await account({ callTimeoutMs: 40 })
    let aborted = false
    await expect(
      gateway().call(gatewayAccount(as(office()), id), { name: 'vat.check', idempotent: false }, (call) =>
        new Promise((resolve) => {
          call.signal.addEventListener('abort', () => {
            aborted = true
          })
          setTimeout(resolve, 2_000)
        }),
      ),
    ).rejects.toMatchObject({ kind: 'timeout', retryable: true, attempts: 1 })
    expect(aborted).toBe(true)
    expect(await callsOf(id)).toEqual([expect.objectContaining({ status: 'TIMED_OUT', reason: 'timeout', attempts: 1 })])
  })
})

describe('gateway.call refusals: nothing is sent, the refusal is recorded', () => {
  const refusedRow = (reason: string) => expect.objectContaining({ status: 'REFUSED', reason, attempts: 0, httpStatus: null })

  it('refuses a FAKE account in production (and calls it elsewhere)', async () => {
    const id = await account({ mode: 'FAKE' }, null)
    let called = 0
    const fn = async () => {
      called++
      return 'fake'
    }
    await expect(gateway({ environment: 'production' }).call(gatewayAccount(as(office()), id), { name: 'mail.send', idempotent: true }, fn)).rejects.toMatchObject({
      name: 'GatewayRefusal',
      reason: 'fake_in_production',
    })
    expect(called).toBe(0)
    expect(await gateway().call(gatewayAccount(as(office()), id), { name: 'mail.send', idempotent: true }, fn)).toBe('fake')
    expect(await callsOf(id)).toEqual([refusedRow('fake_in_production'), expect.objectContaining({ status: 'SUCCEEDED', mode: 'FAKE' })])
  })

  it('refuses a paused account (the kill switch acts on the next call) and a disabled one', async () => {
    const id = await account()
    expect(await gateway().call(gatewayAccount(as(office()), id), { name: 'mail.send', idempotent: true }, ok)).toBe('ok')
    await admin(`UPDATE "IntegrationAccount" SET status = 'PAUSED' WHERE id = $1`, [id])
    await expect(gateway().call(gatewayAccount(as(office()), id), { name: 'mail.send', idempotent: true }, ok)).rejects.toMatchObject({ reason: 'account_paused' })
    await admin(`UPDATE "IntegrationAccount" SET status = 'DISABLED' WHERE id = $1`, [id])
    await expect(gateway().call(gatewayAccount(as(office()), id), { name: 'mail.send', idempotent: true }, ok)).rejects.toMatchObject({ reason: 'account_disabled' })
    expect(await callsOf(id)).toEqual([expect.objectContaining({ status: 'SUCCEEDED' }), refusedRow('account_paused'), refusedRow('account_disabled')])
  })

  it('holds each account to its rate limit (burst, then refill per minute)', async () => {
    const id = await account({ rateLimitBurst: 2, rateLimitPerMinute: 6 })
    const send = () => gateway({ maxRateWaitMs: 0 }).call(gatewayAccount(as(office()), id), { name: 'mail.send', idempotent: true }, ok)
    expect(await send()).toBe('ok')
    expect(await send()).toBe('ok')
    const refusal = await send().catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(GatewayRefusal)
    expect(refusal).toMatchObject({ reason: 'rate_limited' })
    expect((refusal as GatewayRefusal).retryAfterMs).toBeGreaterThan(9_000)
    // Six a minute: a token is back after ten seconds.
    nowMs += 10_000
    expect(await send()).toBe('ok')
    // Another account has its own bucket.
    const other = await account({ rateLimitBurst: 1, rateLimitPerMinute: 1 })
    expect(await gateway({ maxRateWaitMs: 0 }).call(gatewayAccount(as(office()), other), { name: 'mail.send', idempotent: true }, ok)).toBe('ok')
    expect((await callsOf(id)).map((row) => row.status)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'REFUSED', 'SUCCEEDED'])
  })

  it('waits for a token when the wait is short', async () => {
    const id = await account({ rateLimitBurst: 1, rateLimitPerMinute: 60 })
    const waits: number[] = []
    const patient = gateway({
      maxRateWaitMs: 2_000,
      sleep: async (ms) => {
        waits.push(ms)
        nowMs += ms
      },
    })
    expect(await patient.call(gatewayAccount(as(office()), id), { name: 'mail.send', idempotent: true }, ok)).toBe('ok')
    expect(await patient.call(gatewayAccount(as(office()), id), { name: 'mail.send', idempotent: true }, ok)).toBe('ok')
    expect(waits).toEqual([1_000])
  })

  it('opens the circuit after failed calls in a row, lets one trial through after the cool-down, and closes on success', async () => {
    const id = await account({ circuitFailureThreshold: 2, circuitCooldownSeconds: 30 })
    const call = (fn: () => Promise<string>) => gateway().call(gatewayAccount(as(office()), id), { name: 'sdi.status', idempotent: false }, fn)
    await expect(call(failWith(500))).rejects.toBeInstanceOf(GatewayCallFailed)
    await expect(call(failWith(503))).rejects.toBeInstanceOf(GatewayCallFailed)
    let sent = 0
    const counted = async () => {
      sent++
      return 'ok'
    }
    const open = await call(counted).catch((error: unknown) => error)
    expect(open).toMatchObject({ reason: 'circuit_open' })
    expect((open as GatewayRefusal).retryAfterMs).toBe(30_000)
    expect(sent).toBe(0)
    // After the cool-down one trial goes through; a failed trial opens the circuit again at once.
    nowMs += 30_000
    await expect(call(failWith(500))).rejects.toBeInstanceOf(GatewayCallFailed)
    await expect(call(counted)).rejects.toMatchObject({ reason: 'circuit_open' })
    nowMs += 30_000
    expect(await call(counted)).toBe('ok')
    expect(await call(counted)).toBe('ok')
    expect(sent).toBe(2)
    expect((await callsOf(id)).map((row) => `${row.status}${row.reason ? `:${row.reason}` : ''}`)).toEqual([
      'FAILED:provider_error',
      'FAILED:provider_error',
      'REFUSED:circuit_open',
      'FAILED:provider_error',
      'REFUSED:circuit_open',
      'SUCCEEDED',
      'SUCCEEDED',
    ])
  })

  it('a 4xx answer is the provider working: it does not open the circuit', async () => {
    const id = await account({ circuitFailureThreshold: 1 })
    await expect(gateway().call(gatewayAccount(as(office()), id), { name: 'sdi.send', idempotent: false }, failWith(422))).rejects.toBeInstanceOf(GatewayCallFailed)
    expect(await gateway().call(gatewayAccount(as(office()), id), { name: 'sdi.send', idempotent: false }, ok)).toBe('ok')
  })

  it('refuses when Redis cannot be reached: never a call without its limits', async () => {
    const id = await account()
    const down = new Redis('redis://127.0.0.1:1', { maxRetriesPerRequest: 0, enableOfflineQueue: false, lazyConnect: true, retryStrategy: () => null })
    down.on('error', () => {})
    try {
      let sent = 0
      await expect(
        gateway({ redis: down, redisTimeoutMs: 500 }).call(gatewayAccount(as(office()), id), { name: 'mail.send', idempotent: true }, async () => {
          sent++
          return 'ok'
        }),
      ).rejects.toMatchObject({ reason: 'gateway_unavailable' })
      expect(sent).toBe(0)
    } finally {
      down.disconnect()
    }
    expect(await callsOf(id)).toEqual([refusedRow('gateway_unavailable')])
  })

  it('serves only office and system callers, and only their own tenant\'s accounts', async () => {
    const id = await account()
    await expect(gateway().call(gatewayAccount(as(floor()), id), { name: 'mail.send', idempotent: true }, ok)).rejects.toBeInstanceOf(ForbiddenError)
    await expect(gateway().call(gatewayAccount(as(office(tenantB)), id), { name: 'mail.send', idempotent: true }, ok)).rejects.toBeInstanceOf(NotFoundError)
    await expect(gateway().call(gatewayAccount(as(office()), id), { name: 'Mail Send', idempotent: true }, ok)).rejects.toThrow(/not <area>.<action>/)
    expect(await callsOf(id)).toEqual([])
  })
})

describe('the call ledger is append-only', () => {
  it('refuses UPDATE, DELETE and TRUNCATE for every login, and the runtime role has no grant for them', async () => {
    const id = await account()
    await gateway().call(gatewayAccount(as(office()), id), { name: 'mail.send', idempotent: true }, ok)
    await expect(admin(`UPDATE "IntegrationCall" SET status = 'FAILED' WHERE "accountId" = $1`, [id])).rejects.toThrow(/append-only/)
    await expect(admin(`DELETE FROM "IntegrationCall" WHERE "accountId" = $1`, [id])).rejects.toThrow(/append-only/)
    await expect(admin('TRUNCATE "IntegrationCall"')).rejects.toThrow(/append-only|cannot truncate/)
    await expect(as(office()).withClient((client) => client.$executeRawUnsafe(`UPDATE "IntegrationCall" SET status = 'FAILED' WHERE "accountId" = $1::uuid`, id))).rejects.toThrow(/permission denied/)
    await expect(as(office()).withClient((client) => client.$executeRawUnsafe(`DELETE FROM "IntegrationCall" WHERE "accountId" = $1::uuid`, id))).rejects.toThrow(/permission denied/)
    expect(await callsOf(id)).toHaveLength(1)
  })
})

describe('the boot rule: no FAKE account in production (A1 §4)', () => {
  it('refuses production while any tenant has a FAKE account, and passes elsewhere or once none is left', async () => {
    const fake = await account({ mode: 'FAKE', code: 'fake-b' }, null, tenantB)
    await assertNoFakeAccountsInProduction(database, 'local')
    await assertNoFakeAccountsInProduction(database, 'staging')
    const refusal = await assertNoFakeAccountsInProduction(database, 'production').catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(FakeAccountsInProductionError)
    expect((refusal as FakeAccountsInProductionError).accounts).toEqual(expect.arrayContaining([{ tenantId: tenantB, id: fake, code: 'fake-b', provider: 'SES' }]))
    expect((refusal as Error).message).toMatch(/FAKE mode with FACTORY_ENV=production .*SES fake-b/)
    await admin(`UPDATE "IntegrationAccount" SET mode = 'SANDBOX' WHERE mode = 'FAKE'`)
    await assertNoFakeAccountsInProduction(database, 'production')
  })
})
