import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
let gate: { externalId: string; arrived: number; ready: Promise<void>; release: () => void } | null = null
let failWrites = false
let failDuplicateUpdate = false
const log = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }))
vi.mock('../../../utils/logger.js', () => ({ logger: log }))
vi.mock('../../../db.js', () => ({ default: new Proxy({}, {
  get: (_target, key) => key === 'webhookEvent' ? new Proxy({}, {
    get: (_model, method: string) => async (args: any) => {
      if (method === 'update' && failDuplicateUpdate) throw new Error('C9_DUPLICATE_SECRET')
      if (method === 'create' || method === 'createMany') {
        if (failWrites) throw new Error('C9_SECRET_SENTINEL')
        const input = Array.isArray(args.data) ? args.data[0] : args.data
        if (gate && input.externalId === gate.externalId) {
          const rendezvous = gate
          if (++rendezvous.arrived === 2) rendezvous.release()
          await rendezvous.ready
        }
      }
      return (database.client.webhookEvent as any)[method](args)
    },
  }) : (database.client as any)[key],
}) }))
const { recordInbound } = await import('./ledger.js')

const OWNER = 'nexus_legacy_workspace'
const OTHER = randomUUID()
const inProfile = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const receipt = (externalId = randomUUID()) => ({
  channel: 'EBAY', eventType: 'ORDER_CONFIRMATION', externalId,
  connectionId: 'seller-a', signatureOk: true, verifiedBy: 'ebay_ecdsa' as const,
  payload: { notification: { data: { order: { orderId: 'order-1' } } } },
  rawBody: Buffer.from('{"synthetic":"receipt"}'),
})

describe.skipIf(!concurrentDatabaseUrl())('inbound receipt identity in real PostgreSQL', () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    database = await concurrentDatabase({ maxConnections: 8 })
    await database.pool.query('INSERT INTO "Workspace" (id,name,"createdByUserId","creationKey","updatedAt") VALUES ($1,\'Other receipt owner\',\'test\',$1,now())', [OTHER])
  }, 180_000)
  beforeEach(() => { gate = null; failWrites = false; failDuplicateUpdate = false; vi.clearAllMocks() })
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('returns the same durable receipt to two simultaneous first deliveries', async () => {
    const input = receipt()
    let release!: () => void
    gate = { externalId: input.externalId, arrived: 0, ready: new Promise<void>(resolve => { release = resolve }), release: () => release() }
    const results = await Promise.all([inProfile(OWNER, () => recordInbound(input)), inProfile(OWNER, () => recordInbound(input))])
    expect(gate.arrived).toBe(2)
    expect(results.every(result => result.id !== null)).toBe(true)
    expect(new Set(results.map(result => result.id)).size).toBe(1)
    expect(results.map(result => result.duplicate).sort()).toEqual([false, true])
    const rows = await database.pool.query('SELECT deliveries,attempts FROM "WebhookEvent" WHERE "externalId"=$1', [input.externalId])
    expect(rows.rows).toEqual([{ deliveries: 2, attempts: 0 }])
  })

  it('counts concurrent redeliveries without rewriting the original outcome or retry budget', async () => {
    const input = { ...receipt(), providerTimestamp: new Date('2026-09-22T00:00:00Z') }
    const first = await inProfile(OWNER, () => recordInbound(input))
    await database.pool.query('UPDATE "WebhookEvent" SET status=\'failed\',attempts=3,"lastError"=\'original failure\',"nextAttemptAt"=\'2030-01-01 00:00:00\' WHERE id=$1', [first.id])
    // Delivery metadata may change on a retry. The first envelope remains the
    // receipt's evidence; a duplicate cannot replace it or reset its backoff.
    const redelivery = { ...input, status: 'done' as const,
      payload: { notification: { ...input.payload.notification, publishAttemptCount: 2 } },
      rawBody: Buffer.from('{"synthetic":"redelivery"}'), providerTimestamp: new Date('2026-09-23T00:00:00Z'),
    }
    const copies = await Promise.all(Array.from({ length: 12 }, () => inProfile(OWNER, () => recordInbound(redelivery))))
    expect(copies.every(copy => copy.id === first.id && copy.duplicate && copy.existingStatus === 'failed')).toBe(true)
    const saved = (await database.pool.query('SELECT deliveries,attempts,status,payload,"lastError","connectionId","signatureOk","nextAttemptAt"::text,"providerTimestamp"::text,"payloadDigest" FROM "WebhookEvent" WHERE id=$1', [first.id])).rows[0]
    expect(saved).toEqual({ deliveries: 13, attempts: 3, status: 'failed', payload: input.payload, lastError: 'original failure', connectionId: 'seller-a', signatureOk: true, nextAttemptAt: '2030-01-01 00:00:00', providerTimestamp: '2026-09-22 00:00:00', payloadDigest: createHash('sha256').update(input.rawBody).digest('hex') })
    await database.pool.query('UPDATE "WebhookEvent" SET status=\'done\',"isProcessed"=true,"nextAttemptAt"=NULL WHERE id=$1', [first.id])
    expect(await inProfile(OWNER, () => recordInbound(input))).toMatchObject({ id: first.id, duplicate: true, existingStatus: 'done' })
    expect((await database.pool.query('SELECT status,"isProcessed",attempts,deliveries FROM "WebhookEvent" WHERE id=$1', [first.id])).rows)
      .toEqual([{ status: 'done', isProcessed: true, attempts: 3, deliveries: 14 }])
  })

  it('keeps the same provider delivery ID independent across business profiles', async () => {
    const input = receipt()
    const [a, b] = await Promise.all([inProfile(OWNER, () => recordInbound(input)), inProfile(OTHER, () => recordInbound({ ...input, connectionId: 'seller-b' }))])
    expect(a.id).toBeTruthy(); expect(b.id).toBeTruthy(); expect(a.id).not.toBe(b.id)
    const saved = (await database.pool.query('SELECT "workspaceId","connectionId",deliveries FROM "WebhookEvent" WHERE "externalId"=$1 ORDER BY "connectionId"', [input.externalId])).rows
    expect(saved).toEqual([{ workspaceId: OWNER, connectionId: 'seller-a', deliveries: 1 }, { workspaceId: OTHER, connectionId: 'seller-b', deliveries: 1 }])
  })

  it('refuses to reuse a receipt for another account within the same profile', async () => {
    const input = receipt()
    const first = await inProfile(OWNER, () => recordInbound(input))
    expect(await inProfile(OWNER, () => recordInbound({ ...input, connectionId: 'seller-b' })))
      .toMatchObject({ id: null, duplicate: true, conflict: 'identity_mismatch' })
    expect((await database.pool.query('SELECT "connectionId",deliveries FROM "WebhookEvent" WHERE id=$1', [first.id])).rows)
      .toEqual([{ connectionId: 'seller-a', deliveries: 1 }])
  })

  it('refuses a different topic or verification verdict on an existing delivery ID', async () => {
    const input = receipt()
    const first = await inProfile(OWNER, () => recordInbound(input))
    for (const altered of [{ ...input, eventType: 'AUTHORIZATION_REVOCATION' }, { ...input, signatureOk: false }, { ...input, verifiedBy: 'none' as const }]) {
      expect(await inProfile(OWNER, () => recordInbound(altered))).toMatchObject({ id: null, duplicate: true, conflict: 'identity_mismatch' })
    }
    expect((await database.pool.query('SELECT "eventType","signatureOk","verifiedBy",deliveries FROM "WebhookEvent" WHERE id=$1', [first.id])).rows)
      .toEqual([{ eventType: 'ORDER_CONFIRMATION', signatureOk: true, verifiedBy: 'ebay_ecdsa', deliveries: 1 }])
  })

  it('treats null ownership and unsigned transport evidence as explicit identity values', async () => {
    const unbound = { ...receipt(), connectionId: null }
    const first = await inProfile(OWNER, () => recordInbound(unbound))
    expect(await inProfile(OWNER, () => recordInbound(unbound))).toMatchObject({ id: first.id, duplicate: true })
    expect(await inProfile(OWNER, () => recordInbound({ ...unbound, connectionId: 'seller-a' })))
      .toMatchObject({ id: null, conflict: 'identity_mismatch' })
    const unsigned = { ...receipt(), channel: 'AMAZON', signatureOk: null, verifiedBy: 'sqs_iam' as const }
    const trusted = await inProfile(OWNER, () => recordInbound(unsigned))
    expect(await inProfile(OWNER, () => recordInbound(unsigned))).toMatchObject({ id: trusted.id, duplicate: true })
    expect(await inProfile(OWNER, () => recordInbound({ ...unsigned, signatureOk: true })))
      .toMatchObject({ id: null, conflict: 'identity_mismatch' })
  })

  it('does not acknowledge a duplicate when its atomic arrival update fails', async () => {
    const input = receipt()
    const first = await inProfile(OWNER, () => recordInbound(input))
    failDuplicateUpdate = true
    expect(await inProfile(OWNER, () => recordInbound(input))).toMatchObject({ id: null })
    expect((await database.pool.query('SELECT deliveries FROM "WebhookEvent" WHERE id=$1', [first.id])).rows).toEqual([{ deliveries: 1 }])
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('C9_DUPLICATE_SECRET')
  })

  it('refuses unavailable persistence without copying sensitive exception text to diagnostics', async () => {
    failWrites = true
    expect(await inProfile(OWNER, () => recordInbound(receipt()))).toMatchObject({ id: null, duplicate: false })
    expect(log.error).toHaveBeenCalled()
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('C9_SECRET_SENTINEL')
  })
})
