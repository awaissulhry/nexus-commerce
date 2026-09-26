import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Pick<Awaited<ReturnType<typeof formulaDatabase>>, 'client' | 'close'>
/** Owner-side SQL for fixtures only (the app client is the restricted runtime login). */
let adminQuery: (sql: string, params: unknown[]) => Promise<unknown>
vi.mock('../../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

// Recovery runs on the release's database, whose DELETE/TRUNCATE guard retains inbound
// history, so each test uses a fresh business profile instead of clearing a shared one.
let WORKSPACE = 'nexus_legacy_workspace'
const NOW = new Date('2026-09-25T12:00:00.000Z')
const inWorkspace = <T>(work: () => Promise<T>) => withWorkspace({
  workspaceId: WORKSPACE, actorUserId: null, membershipId: null, roleKeys: [],
}, work)

/**
 * Real Prisma queries and production workspace policies, with only the application
 * database module redirected to a disposable database. The real-PG gate supplies a
 * multi-connection server with a restricted runtime login; standalone runs use PGlite.
 */
describe('durable inbound claim ownership', () => {
  let claims: typeof import('./claims.js')
  let ledger: typeof import('./ledger.js')

  beforeAll(async () => {
    if (concurrentDatabaseUrl()) {
      const concurrent = await concurrentDatabase()
      database = concurrent
      adminQuery = (sql, params) => concurrent.pool.query(sql, params)
    } else {
      const formula = await formulaDatabase()
      database = formula
      adminQuery = (sql, params) => formula.db.query(sql, params)
    }
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    claims = await import('./claims.js')
    ledger = await import('./ledger.js')
  }, 120_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    await database?.close()
  }, 30_000)

  beforeEach(async () => {
    WORKSPACE = `claims-${randomUUID()}`
    await adminQuery('INSERT INTO "Workspace" (id,name,"createdByUserId","creationKey","updatedAt") VALUES ($1,$2,$3,$1,now())', [WORKSPACE, 'Claims fixture', 'test'])
    await inWorkspace(() => database.client.dataRetentionPolicy.deleteMany())
  })

  const event = (overrides: Partial<Prisma.WebhookEventUncheckedCreateInput> = {}) => inWorkspace(() =>
    database.client.webhookEvent.create({ data: {
      channel: 'SHOPIFY', eventType: 'order/create', externalId: randomUUID(),
      payload: { id: 'order_original', total: '19.95' }, signatureOk: true,
      verifiedBy: 'shopify_hmac', status: 'pending', attempts: 0, deliveries: 1,
      connectionId: 'account_original', ...overrides,
    } }))
  const row = (id: string) => inWorkspace(() => database.client.webhookEvent.findUniqueOrThrow({ where: { id } }))

  it('gives competing calls one owner and spends one attempt when work starts', async () => {
    const pending = await event()
    const results = await inWorkspace(() => Promise.all(Array.from({ length: 8 }, () => claims.claimInbound(pending.id, NOW))))
    const winners = results.filter(result => result !== null)
    expect(winners).toHaveLength(1)
    const claim = winners[0]!
    expect(claim).toMatchObject({ id: pending.id, attempt: 1, channel: 'SHOPIFY', eventType: 'order/create', connectionId: 'account_original' })
    expect(claim.token).toEqual(expect.any(String))
    expect(claim.token.length).toBeGreaterThan(0)
    const persisted = await row(pending.id)
    expect(persisted.attempts).toBe(1)
    expect(persisted.processingToken).toBe(claim.token)
    expect(persisted.processingUntil!.getTime()).toBeGreaterThan(NOW.getTime())
  })

  it('returns the stored trusted payload when the same delivery arrives with different content', async () => {
    const externalId = randomUUID()
    const original = { order: { id: 123, amount: '19.95' } }
    const first = await inWorkspace(() => ledger.recordInbound({
      channel: 'SHOPIFY', eventType: 'order/create', externalId, payload: original,
      signatureOk: true, verifiedBy: 'shopify_hmac', connectionId: 'verified_account',
    }))
    expect(first.id).toBeTruthy()
    const duplicate = await inWorkspace(() => ledger.recordInbound({
      channel: 'SHOPIFY', eventType: 'order/create', externalId, payload: { order: { id: 999 } },
      signatureOk: false, verifiedBy: 'none', connectionId: 'different_account',
    }))
    expect(duplicate).toMatchObject({ id: first.id, duplicate: true })
    const stored = await row(first.id!)
    const claimAt = stored.nextAttemptAt ?? new Date()
    const claim = await inWorkspace(() => claims.claimInbound(first.id!, claimAt))
    expect(claim).toMatchObject({ payload: original, connectionId: 'verified_account', attempt: 1 })
    expect((await row(first.id!)).deliveries).toBe(2)
  })

  it('recovers a crashed owner and prevents that owner from finishing the replacement claim', async () => {
    const pending = await event()
    const first = await inWorkspace(() => claims.claimInbound(pending.id, NOW))
    expect(first).not.toBeNull()
    const expiredAt = new Date((await row(pending.id)).processingUntil!.getTime() + 1)
    const second = await inWorkspace(() => claims.claimInbound(pending.id, expiredAt))
    expect(second).toMatchObject({ id: pending.id, attempt: 2 })
    expect(second!.token).not.toBe(first!.token)
    expect(await inWorkspace(() => claims.finishInboundClaim(first!, true, undefined, expiredAt))).toBe(false)
    expect(await inWorkspace(() => claims.finishInboundClaim(first!, false, 'stale failure', expiredAt))).toBe(false)
    expect((await row(pending.id)).processingToken).toBe(second!.token)
    expect(await inWorkspace(() => claims.finishInboundClaim(second!, true, undefined, expiredAt))).toBe(true)
    expect(await row(pending.id)).toMatchObject({
      status: 'done', isProcessed: true, attempts: 2, processingToken: null,
      processingUntil: null, nextAttemptAt: null, lastError: null,
    })
    expect(await inWorkspace(() => claims.finishInboundClaim(second!, true, undefined, expiredAt))).toBe(false)
  })

  it('schedules a failed claim without counting completion as another attempt', async () => {
    const pending = await event()
    const claim = await inWorkspace(() => claims.claimInbound(pending.id, NOW))
    expect(claim).not.toBeNull()
    expect(await inWorkspace(() => claims.finishInboundClaim(claim!, false, 'provider unavailable', NOW))).toBe(true)
    const failed = await row(pending.id)
    expect(failed).toMatchObject({
      status: 'failed', attempts: 1, isProcessed: false, processingToken: null,
      processingUntil: null, lastError: 'provider unavailable',
    })
    expect(failed.nextAttemptAt!.getTime()).toBeGreaterThan(NOW.getTime())
    expect(await inWorkspace(() => claims.claimInbound(pending.id, NOW))).toBeNull()
    expect(await inWorkspace(() => claims.claimInbound(pending.id, failed.nextAttemptAt!))).toMatchObject({ attempt: 2 })
  })

  it.each([
    ['rejected signature', { signatureOk: false }],
    ['unknown trust', { signatureOk: null, verifiedBy: 'none' }],
    ['wrong unsigned transport', { channel: 'SHOPIFY', signatureOk: null, verifiedBy: 'sqs_iam' }],
    ['archived payload', { archivedAt: NOW }],
    ['completed event', { status: 'done', isProcessed: true }],
    ['dead letter', { status: 'dlq', attempts: 5 }],
  ] satisfies Array<[string, Partial<Prisma.WebhookEventUncheckedCreateInput>]>)(
    'never claims %s', async (_description, overrides) => {
      const pending = await event(overrides)
      expect(await inWorkspace(() => claims.claimInbound(pending.id, NOW))).toBeNull()
      expect(await row(pending.id)).toMatchObject({ attempts: pending.attempts, processingToken: null, processingUntil: null })
    },
  )

  it('accepts Amazon events whose transport trust is SQS IAM', async () => {
    const pending = await event({ channel: 'AMAZON', signatureOk: null, verifiedBy: 'sqs_iam' })
    expect(await inWorkspace(() => claims.claimInbound(pending.id, NOW))).toMatchObject({ id: pending.id, attempt: 1 })
  })

  it('lets a live fifth attempt finish but dead-letters it after its lease expires', async () => {
    const pending = await event({ attempts: 4 })
    const last = await inWorkspace(() => claims.claimInbound(pending.id, NOW))
    expect(last).toMatchObject({ attempt: 5 })
    expect(await inWorkspace(() => claims.claimInbound(pending.id, NOW))).toBeNull()
    const live = await row(pending.id)
    expect(live.status).not.toBe('dlq')
    expect(live.processingToken).toBe(last!.token)
    const expiredAt = new Date(live.processingUntil!.getTime() + 1)
    expect(await inWorkspace(() => claims.claimInbound(pending.id, expiredAt))).toBeNull()
    expect(await row(pending.id)).toMatchObject({
      status: 'dlq', attempts: 5, isProcessed: false, nextAttemptAt: null,
      processingToken: null, processingUntil: null,
    })
    expect(await inWorkspace(() => claims.finishInboundClaim(last!, true, undefined, expiredAt))).toBe(false)
  })

  it('refuses manual replay during an active lease without resetting its token or budget', async () => {
    const pending = await event({ attempts: 2 })
    const claim = await inWorkspace(() => claims.claimInbound(pending.id, new Date()))
    expect(claim).not.toBeNull()
    expect(await inWorkspace(() => ledger.replayInbound({ id: pending.id }))).toMatchObject({ ok: false })
    expect(await row(pending.id)).toMatchObject({ attempts: 3, processingToken: claim!.token })
  })

  it('makes a trusted replayable arrival due at once, and nothing that cannot run', async () => {
    const record = (overrides: Partial<Parameters<typeof ledger.recordInbound>[0]>) => inWorkspace(() => ledger.recordInbound({
      channel: 'SHOPIFY', eventType: 'order/create', externalId: randomUUID(), payload: { id: 'order' },
      signatureOk: true, verifiedBy: 'shopify_hmac', connectionId: 'account_original', status: 'pending', ...overrides,
    }))
    const due = await record({})
    const refused = await record({ signatureOk: false })
    const noHandler = await record({ eventType: 'unknown/topic' })
    const finished = await record({ status: 'done' })
    for (const written of [refused, noHandler, finished]) expect((await row(written.id!)).nextAttemptAt).toBeNull()
    // A receiver that dies after recording leaves the row to the retry worker.
    const later = new Date(Date.now() + 1_000)
    expect((await inWorkspace(() => ledger.dueInboundEvents(50, later))).map(item => item.id)).toEqual([due.id])
  })

  it('never collects a row stranded before claims existed; an operator can still claim it', async () => {
    const stranded = await event({ createdAt: new Date(NOW.getTime() - 24 * 60 * 60_000), nextAttemptAt: null })
    expect(await inWorkspace(() => ledger.dueInboundEvents(50, NOW))).toEqual([])
    expect(await inWorkspace(() => claims.claimInbound(stranded.id, NOW))).toMatchObject({ id: stranded.id, attempt: 1 })
  })

  it('persists exact request bytes and only bounded verification headers', async () => {
    const rawBody = Buffer.from('  { "name": "caffè", "amount": 19.95 }\r\n', 'utf8')
    const payload = JSON.parse(rawBody.toString('utf8'))
    const written = await inWorkspace(() => ledger.recordInbound({
      channel: 'SHOPIFY', eventType: 'order/create', externalId: randomUUID(),
      signatureOk: true, verifiedBy: 'shopify_hmac', connectionId: 'verified_account',
      rawBody, payload, headers: {
        'x-shopify-hmac-sha256': 'fixture-signature',
        'x-shopify-webhook-id': 'fixture-delivery',
        'x-shopify-shop-domain': 'fixture.myshopify.com',
        Authorization: 'Bearer must-not-be-retained',
        authorization: 'another-secret-value',
        cookie: 'session=must-not-be-retained',
        'x-extra-header': 'unnecessary data',
        'webhook-signature': 'x'.repeat(8193),
      },
    }))
    expect(written.id).toBeTruthy()
    const persisted = await row(written.id!)
    expect(Buffer.from(persisted.rawBody!)).toEqual(rawBody)
    expect(persisted.payload).toEqual(payload)
    expect(persisted.payloadDigest).toBe(createHash('sha256').update(rawBody).digest('hex'))
    expect(persisted.verificationHeaders).toEqual({
      'x-shopify-hmac-sha256': 'fixture-signature',
      'x-shopify-webhook-id': 'fixture-delivery',
      'x-shopify-shop-domain': 'fixture.myshopify.com',
    })
    expect(persisted.nextAttemptAt).toBeInstanceOf(Date)
  })

  it('omits oversized raw bodies while retaining their digest and parsed payload', async () => {
    const rawBody = Buffer.alloc(1024 * 1024 + 1, 'x')
    const payload = { id: 'large_delivery' }
    const written = await inWorkspace(() => ledger.recordInbound({
      channel: 'SHOPIFY', eventType: 'order/create', externalId: randomUUID(),
      signatureOk: true, verifiedBy: 'shopify_hmac', connectionId: 'verified_account', rawBody, payload,
    }))
    expect(written.id).toBeTruthy()
    expect(await row(written.id!)).toMatchObject({
      rawBody: null, payload, payloadDigest: createHash('sha256').update(rawBody).digest('hex'),
    })
  })

  it('persists competing copies of one delivery once without losing delivery counts', async () => {
    const externalId = randomUUID()
    const arrivals = await inWorkspace(() => Promise.all(Array.from({ length: 8 }, () => ledger.recordInbound({
      channel: 'SHOPIFY', eventType: 'order/create', externalId,
      signatureOk: true, verifiedBy: 'shopify_hmac', connectionId: 'verified_account',
      rawBody: Buffer.from('{"id":123}'), payload: { id: 123 },
    }))))
    expect(arrivals.every(item => item.id !== null)).toBe(true)
    expect(new Set(arrivals.map(item => item.id)).size).toBe(1)
    expect(arrivals.filter(item => !item.duplicate)).toHaveLength(1)
    expect(await inWorkspace(() => database.client.webhookEvent.count({ where: { externalId } }))).toBe(1)
    expect(await row(arrivals[0].id!)).toMatchObject({ deliveries: 8, attempts: 0, payload: { id: 123 } })
  })

  it('prevents legacy completion from overwriting a claim owned by a current handler', async () => {
    const pending = await event()
    const claim = await inWorkspace(() => claims.claimInbound(pending.id, NOW))
    expect(claim).not.toBeNull()
    const owned = await row(pending.id)
    for (const ok of [true, false]) {
      await inWorkspace(() => ledger.completeInbound(pending.id, ok, 'late legacy completion'))
      expect(await row(pending.id)).toMatchObject({
        processingToken: claim!.token, processingUntil: owned.processingUntil,
        nextAttemptAt: owned.nextAttemptAt, attempts: 1, status: 'pending',
        isProcessed: false, processedAt: null, lastError: null,
      })
    }
    expect(await inWorkspace(() => claims.finishInboundClaim(claim!, true, undefined, NOW))).toBe(true)
  })

  it('cannot delete inbound history on the release database: the sweep reports it and every row survives', async () => {
    vi.stubEnv('NEXUS_ENABLE_RETENTION_SWEEP', '1')
    const { runRetentionSweepOnce } = await import('../../../jobs/data-retention-sweep.job.js')
    await inWorkspace(() => database.client.dataRetentionPolicy.create({ data: { policies: { webhookEvents: 1 } } }))
    const now = new Date()
    const old = new Date(now.getTime() - 2 * 24 * 60 * 60_000)
    const scheduled = await event({ createdAt: old, status: 'failed', nextAttemptAt: new Date(now.getTime() + 60_000) })
    const active = await event({ createdAt: old })
    const claim = await inWorkspace(() => claims.claimInbound(active.id, now))
    expect(claim).not.toBeNull()
    const finished = await event({ createdAt: old, status: 'done', isProcessed: true, processedAt: old })
    const deadLetter = await event({ createdAt: old, status: 'dlq', attempts: 5 })
    const rejected = await event({ createdAt: old, status: 'failed', signatureOk: false })
    const stranded = await event({ createdAt: old, nextAttemptAt: null })
    const recent = await event({ createdAt: now, status: 'done', isProcessed: true, processedAt: now })
    const all = [scheduled, active, finished, deadLetter, rejected, stranded, recent].map(item => item.id)

    const result = await inWorkspace(() => runRetentionSweepOnce())
    // Main's sweep still tries to delete; Package A's DELETE guard refuses it (42501). The
    // recovery build reports the refusal as a skipped key and retains every row.
    expect(result.deletedByKey.webhookEvents).toBeUndefined()
    expect(result.skippedKeys.some(key => key.startsWith('webhookEvents (error'))).toBe(true)
    const survivors = await inWorkspace(() => database.client.webhookEvent.findMany({ where: { id: { in: all } }, select: { id: true } }))
    expect(survivors.map(item => item.id).sort()).toEqual([...all].sort())
    expect((await row(active.id)).processingToken).toBe(claim!.token)
  })
})
