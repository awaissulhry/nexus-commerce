import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../../db.js', () => ({ default: new Proxy({}, { get: (_t, key) => (database.client as any)[key] }) }))
const { recordInbound } = await import('./ledger.js')
const { claimEbayInbound, commitEbayInbound, finishEbayInbound, renewEbayInboundClaim } = await import('./ebay-claims.js')
const OWNER = 'nexus_legacy_workspace'
const OTHER = randomUUID()
const inProfile = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const inOwner = <T>(work: () => Promise<T>) => inProfile(OWNER, work)
const queuedReceipt = () => ({
  channel: 'EBAY' as const, eventType: 'AUTHORIZATION_REVOCATION', externalId: randomUUID(),
  connectionId: 'seller-a', signatureOk: true, verifiedBy: 'ebay_ecdsa' as const,
  queueForRetry: true as const, payload: { notification: { data: { userId: 'seller-id' } } },
})
async function queued() { const result = await inOwner(() => recordInbound(queuedReceipt())); expect(result.id).toBeTruthy(); return result.id! }
async function stored(id: string) { return inOwner(() => database.client.webhookEvent.findUniqueOrThrow({ where: { id } })) }
async function expire(id: string) { await database.pool.query('UPDATE "WebhookEvent" SET "leaseUntil"=clock_timestamp()-interval \'1 second\',"nextAttemptAt"=clock_timestamp()-interval \'1 second\' WHERE id=$1', [id]) }
const productData = () => ({ id: randomUUID(), sku: `receipt-effect-${randomUUID()}`, name: 'Receipt transaction effect', basePrice: 1, bulletPoints: [], keywords: [], validationErrors: [] })
async function productCount(id: string) { return Number((await database.pool.query('SELECT count(*) AS n FROM "Product" WHERE id=$1', [id])).rows[0].n) }
async function waitForBlocked(pid: number): Promise<boolean> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const result = await database.pool.query('SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked', [pid])
    if (result.rows[0].blocked) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return false
}

describe.skipIf(!concurrentDatabaseUrl())('durable eBay receipt processing in PostgreSQL', () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    database = await concurrentDatabase({ maxConnections: 8 })
    // Apply the actual additive migration over the old shape and a legacy receipt.
    await database.pool.query('ALTER TABLE "WebhookEvent" DROP COLUMN "leaseToken", DROP COLUMN "leaseUntil"')
    await database.pool.query('INSERT INTO "WebhookEvent" (id,"workspaceId",channel,"eventType","externalId",payload,"updatedAt") VALUES (\'legacy-receipt\',$1,\'SHOPIFY\',\'product/update\',\'legacy-receipt\',\'{}\',now())', [OWNER])
    await database.pool.query(readFileSync(new URL('../../../../../../packages/database/prisma/migrations/20260923a_cx_inbound_leases/migration.sql', import.meta.url), 'utf8'))
    await database.pool.query('INSERT INTO "Workspace" (id,name,"createdByUserId","creationKey","updatedAt") VALUES ($1,\'Other claim owner\',\'test\',$1,now())', [OTHER])
    for (const [id, workspace] of [['seller-a', OWNER], ['seller-b', OTHER]]) {
      await database.pool.query('INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","externalAccountId","isActive","updatedAt") VALUES ($1,$2,\'EBAY\',$3,true,now())', [id, workspace, id === 'seller-a' ? 'seller-id' : 'other-seller-id'])
    }
  }, 180_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('persists pending work and its retry time together before a receiver can crash', async () => {
    const before = Date.now()
    const receipt = await inOwner(() => recordInbound(queuedReceipt()))
    expect(receipt.id).toBeTruthy()
    const stored = await inOwner(() => database.client.webhookEvent.findUniqueOrThrow({ where: { id: receipt.id! } }))
    expect(stored.status).toBe('pending')
    expect(stored.isProcessed).toBe(false)
    expect(stored.nextAttemptAt).toBeInstanceOf(Date)
    expect(stored.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before)
  })

  it('schedules each row type only by its owner and never queues an unverified receipt', async () => {
    // #4 (claims.ts): a trusted arrival with a replay handler is due at once for the generic
    // claimant; one without a handler stays unscheduled. Package A's eBay queue never takes them.
    for (const [channel, eventType, verifiedBy, signatureOk, dueAtOnce] of [
      ['SHOPIFY', 'product/update', 'shopify_hmac', true, true], ['AMAZON', 'ORDER_CHANGE', 'sqs_iam', null, false], ['ETSY', 'order.paid', 'none', true, true],
    ] as const) {
      const receipt = await inOwner(() => recordInbound({ ...queuedReceipt(), channel, eventType, verifiedBy, signatureOk, queueForRetry: false }))
      const row = await inOwner(() => database.client.webhookEvent.findUniqueOrThrow({ where: { id: receipt.id! } }))
      if (dueAtOnce) expect(row.nextAttemptAt).toBeInstanceOf(Date)
      else expect(row.nextAttemptAt).toBeNull()
      expect(row).toMatchObject({ leaseToken: null, leaseUntil: null })
    }
    // A verified eBay receipt admitted without the eBay queue stays unscheduled (held).
    const held = await inOwner(() => recordInbound({ ...queuedReceipt(), queueForRetry: false }))
    expect((await inOwner(() => database.client.webhookEvent.findUniqueOrThrow({ where: { id: held.id! } }))).nextAttemptAt).toBeNull()
    const rejected = await inOwner(() => recordInbound({ ...queuedReceipt(), signatureOk: false }))
    const stored = await inOwner(() => database.client.webhookEvent.findUniqueOrThrow({ where: { id: rejected.id! } }))
    expect(stored.status).toBe('failed')
    expect(stored.nextAttemptAt).toBeNull()
    const unsupported = { ...queuedReceipt(), channel: 'SHOPIFY' }
    expect(await inOwner(() => recordInbound(unsupported as any))).toMatchObject({ id: null })
    expect((await database.pool.query('SELECT count(*)::int AS n FROM "WebhookEvent" WHERE "externalId"=$1', [unsupported.externalId])).rows[0].n).toBe(0)
  })

  it('preserves legacy receipts and enforces paired lease fields in the real migration', async () => {
    expect(await stored('legacy-receipt')).toMatchObject({ status: 'pending', nextAttemptAt: null, leaseToken: null, leaseUntil: null })
    await expect(database.pool.query('UPDATE "WebhookEvent" SET "leaseToken"=\'broken\' WHERE id=\'legacy-receipt\''))
      .rejects.toMatchObject({ code: '23514' })
  })

  it('gives two simultaneous claimants one stored payload, one owner and one attempt', async () => {
    const id = await queued()
    const claims = await Promise.all([inOwner(() => claimEbayInbound(id)), inOwner(() => claimEbayInbound(id))])
    const winners = claims.filter(claim => claim !== null)
    expect(winners).toHaveLength(1)
    expect(winners[0]).toMatchObject({ id, workspaceId: OWNER, connectionId: 'seller-a', attempt: 1, payload: queuedReceipt().payload })
    const row = await stored(id)
    expect(row).toMatchObject({ status: 'pending', attempts: 1, isProcessed: false, leaseToken: winners[0]!.leaseToken })
    expect(row.nextAttemptAt).toEqual(row.leaseUntil)
    expect(await inOwner(() => renewEbayInboundClaim(winners[0]!))).toBe(true)
    const renewed = await stored(id)
    expect(renewed.leaseUntil!.getTime()).toBeGreaterThanOrEqual(row.leaseUntil!.getTime())
    expect(renewed.nextAttemptAt).toEqual(renewed.leaseUntil)
    expect(renewed.attempts).toBe(1)
    expect(await inOwner(() => claimEbayInbound(id))).toBeNull()
  })

  it('does not reset ownership, attempts or expiry on a provider redelivery', async () => {
    const input = queuedReceipt()
    const receipt = await inOwner(() => recordInbound(input))
    const claim = await inOwner(() => claimEbayInbound(receipt.id!))
    expect(claim).toBeTruthy()
    const before = await stored(receipt.id!)
    await inOwner(() => recordInbound({ ...input, payload: { different: 'retry metadata' } }))
    const after = await stored(receipt.id!)
    expect(after).toMatchObject({ deliveries: 2, attempts: 1, leaseToken: before.leaseToken, leaseUntil: before.leaseUntil, nextAttemptAt: before.nextAttemptAt, payload: before.payload })
  })

  it('reclaims an expired attempt and fences every stale completion, deferral and renewal', async () => {
    const id = await queued(), first = (await inOwner(() => claimEbayInbound(id)))!
    await expire(id)
    const second = (await inOwner(() => claimEbayInbound(id)))!
    expect(second).toBeTruthy(); expect(second.attempt).toBe(2); expect(second.leaseToken).not.toBe(first.leaseToken)
    expect(await inOwner(() => renewEbayInboundClaim(first))).toBe(false)
    for (const outcome of [{ kind: 'retry', reason: 'stale' }, { kind: 'dead_letter', reason: 'stale' }, { kind: 'defer', code: 'AUTH_REQUIRED', reason: 'stale' }] as const) {
      expect(await inOwner(() => finishEbayInbound(first, outcome))).toBe(false)
    }
    const effect = vi.fn(async () => 'must not execute')
    expect(await inOwner(() => commitEbayInbound(first, effect))).toEqual({ committed: false })
    expect(effect).not.toHaveBeenCalled()
    expect((await stored(id)).leaseToken).toBe(second.leaseToken)
    expect(await inOwner(() => commitEbayInbound(second, async () => 'done'))).toEqual({ committed: true, value: 'done' })
    expect(await stored(id)).toMatchObject({ status: 'done', isProcessed: true, attempts: 2, leaseToken: null, leaseUntil: null, nextAttemptAt: null })
    // An explicit operator replay can reset the budget; attempt number alone is
    // therefore not an ownership token. Simulate that permitted reset after done.
    await database.pool.query('UPDATE "WebhookEvent" SET status=\'pending\',attempts=0,"isProcessed"=false,"processedAt"=NULL,"nextAttemptAt"=clock_timestamp()-interval \'1 second\' WHERE id=$1', [id])
    const replay = (await inOwner(() => claimEbayInbound(id)))!
    expect(replay.attempt).toBe(first.attempt)
    expect(await inOwner(() => renewEbayInboundClaim(first))).toBe(false)
    expect(await inOwner(() => finishEbayInbound(first, { kind: 'retry', reason: 'stale before reset' }))).toBe(false)
    expect(await inOwner(() => commitEbayInbound(first, effect))).toEqual({ committed: false })
    expect(effect).not.toHaveBeenCalled()
  })

  it('commits a domain write and completion together using reloaded, owned context', async () => {
    const id = await queued(), claim = (await inOwner(() => claimEbayInbound(id)))!, data = productData()
    const tampered = { ...claim, connectionId: 'seller-b', payload: { wrong: 'caller copy' } }
    const result = await inOwner(() => commitEbayInbound(tampered, async (tx, receipt) => {
      expect(receipt).toMatchObject({ connectionId: 'seller-a', workspaceId: OWNER, payload: queuedReceipt().payload })
      return (await tx.product.create({ data })).id
    }))
    expect(result).toEqual({ committed: true, value: data.id })
    expect(await productCount(data.id)).toBe(1)
    expect(await stored(id)).toMatchObject({ status: 'done', isProcessed: true, error: null, lastError: null, leaseToken: null })
  })

  it('rolls back every domain write when the callback fails', async () => {
    const id = await queued(), claim = (await inOwner(() => claimEbayInbound(id)))!, data = productData()
    await expect(inOwner(() => commitEbayInbound(claim, async tx => { await tx.product.create({ data }); throw new Error('domain failure') })))
      .rejects.toThrow('domain failure')
    expect(await productCount(data.id)).toBe(0)
    expect(await stored(id)).toMatchObject({ status: 'pending', attempts: 1, leaseToken: claim.leaseToken, isProcessed: false })
  })

  it('rolls back domain changes if the callback invalidates its final completion fence', async () => {
    const id = await queued(), claim = (await inOwner(() => claimEbayInbound(id)))!, data = productData()
    await expect(inOwner(() => commitEbayInbound(claim, async tx => {
      await tx.product.create({ data })
      await tx.webhookEvent.update({ where: { id }, data: { leaseToken: 'different-owner' } })
    }))).rejects.toMatchObject({ name: 'EbayInboundClaimLost' })
    expect(await productCount(data.id)).toBe(0)
    expect((await stored(id)).leaseToken).toBe(claim.leaseToken)
  })

  it('keeps a competing claimant out while an expired owner commits domain effects', async () => {
    const id = await queued(), claim = (await inOwner(() => claimEbayInbound(id)))!, data = productData()
    await expire(id)
    let unlock!: () => void, entered!: () => void
    let ownerPid = 0
    const release = new Promise<void>(resolve => { unlock = resolve }), locked = new Promise<void>(resolve => { entered = resolve })
    const commit = inOwner(() => commitEbayInbound(claim, async tx => {
      ownerPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid
      entered(); await release; await tx.product.create({ data })
    }))
    await locked
    const contender = inOwner(() => claimEbayInbound(id))
    let observedBlock = false
    try { observedBlock = await waitForBlocked(ownerPid) } finally { unlock() }
    expect(await commit).toMatchObject({ committed: true })
    expect(await contender).toBeNull()
    expect(observedBlock).toBe(true)
    expect(await productCount(data.id)).toBe(1)
    expect((await stored(id)).attempts).toBe(1)
  })

  it('exhausts five abandoned attempts without an endless crash loop', async () => {
    const id = await queued()
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect((await inOwner(() => claimEbayInbound(id)))?.attempt).toBe(attempt)
      await expire(id)
    }
    expect(await inOwner(() => claimEbayInbound(id))).toBeNull()
    expect(await stored(id)).toMatchObject({ status: 'dlq', attempts: 5, leaseToken: null, leaseUntil: null, nextAttemptAt: null })
  })

  it('schedules failure once, preserves prior budget on explicit holds, and dead-letters exhaustion', async () => {
    const id = await queued()
    await database.pool.query('UPDATE "WebhookEvent" SET attempts=3 WHERE id=$1', [id])
    const claim = (await inOwner(() => claimEbayInbound(id)))!
    expect(await inOwner(() => finishEbayInbound(claim, { kind: 'defer', code: 'AUTH_REQUIRED', reason: 'Reconnect the account.' }))).toBe(true)
    expect(await stored(id)).toMatchObject({ status: 'failed', attempts: 3, isProcessed: false, leaseToken: null })
    expect(await inOwner(() => claimEbayInbound(id))).toBeNull()
    await database.pool.query('UPDATE "WebhookEvent" SET attempts=4,"nextAttemptAt"=clock_timestamp()-interval \'1 second\' WHERE id=$1', [id])
    const last = (await inOwner(() => claimEbayInbound(id)))!
    expect(await inOwner(() => finishEbayInbound(last, { kind: 'retry', reason: 'Still failing.' }))).toBe(true)
    expect(await stored(id)).toMatchObject({ status: 'dlq', attempts: 5, nextAttemptAt: null, error: 'Still failing.' })
    expect(await inOwner(() => finishEbayInbound(last, { kind: 'retry', reason: 'Late retry.' }))).toBe(false)
  })

  it('rejects foreign, unverified, archived, done and dead-lettered receipts without spending an attempt', async () => {
    const id = await queued()
    expect(await inProfile(OTHER, () => database.client.$queryRaw<Array<{ id: string }>>`SELECT id FROM "WebhookEvent" WHERE id=${id}`)).toEqual([])
    expect(await inProfile(OTHER, () => claimEbayInbound(id))).toBeNull()
    for (const change of [{ signatureOk: false }, { verifiedBy: 'none' }, { archivedAt: new Date() }, { status: 'done' }, { status: 'dlq' }, { channel: 'SHOPIFY' }]) {
      const rowId = await queued()
      await inOwner(() => database.client.webhookEvent.update({ where: { id: rowId }, data: change }))
      expect(await inOwner(() => claimEbayInbound(rowId))).toBeNull()
      expect((await stored(rowId)).attempts).toBe(0)
    }
    const claim = (await inOwner(() => claimEbayInbound(id)))!, effect = vi.fn(async () => null)
    expect(await inProfile(OTHER, () => commitEbayInbound(claim, effect))).toEqual({ committed: false })
    expect(await inProfile(OTHER, () => finishEbayInbound(claim, { kind: 'retry', reason: 'wrong owner' }))).toBe(false)
    expect(effect).not.toHaveBeenCalled()
  })

  it('refuses domain effects when the stored account belongs to another business', async () => {
    const receipt = await inOwner(() => recordInbound({ ...queuedReceipt(), connectionId: 'seller-b' }))
    const claim = (await inOwner(() => claimEbayInbound(receipt.id!)))!, effect = vi.fn(async () => null)
    await expect(inOwner(() => commitEbayInbound(claim, effect))).rejects.toThrow(/not owned/)
    expect(effect).not.toHaveBeenCalled()
    expect((await stored(receipt.id!)).status).toBe('pending')
  })

  it('keeps account credentials stable until the owned domain transaction finishes', async () => {
    const accountId = randomUUID(), data = productData()
    await database.pool.query('INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","externalAccountId","isActive","updatedAt") VALUES ($1,$2,\'EBAY\',$1,true,now())', [accountId, OWNER])
    const receipt = await inOwner(() => recordInbound({ ...queuedReceipt(), connectionId: accountId }))
    const claim = (await inOwner(() => claimEbayInbound(receipt.id!)))!
    let entered!: () => void, unlock!: () => void, ownerPid = 0
    const locked = new Promise<void>(resolve => { entered = resolve }), release = new Promise<void>(resolve => { unlock = resolve })
    const commit = inOwner(() => commitEbayInbound(claim, async tx => {
      ownerPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid
      entered(); await release; await tx.product.create({ data })
      return (await tx.channelConnection.findUniqueOrThrow({ where: { id: accountId }, select: { credentialsKeyId: true } })).credentialsKeyId
    }))
    await locked
    const credentialUpdate = database.pool.query('UPDATE "ChannelConnection" SET "credentialsKeyId"=\'test-next-key\' WHERE id=$1', [accountId])
    let observedBlock = false
    try { observedBlock = await waitForBlocked(ownerPid) } finally { unlock() }
    expect(await commit).toEqual({ committed: true, value: null })
    await credentialUpdate
    expect(observedBlock).toBe(true)
    expect(await productCount(data.id)).toBe(1)
    expect((await stored(receipt.id!)).status).toBe('done')
    expect((await database.pool.query('SELECT "credentialsKeyId" FROM "ChannelConnection" WHERE id=$1', [accountId])).rows[0].credentialsKeyId).toBe('test-next-key')
    // Ownership moves already have a separate, immutable database guard.
    await expect(database.pool.query('UPDATE "ChannelConnection" SET "workspaceId"=$1 WHERE id=$2', [OTHER, accountId])).rejects.toMatchObject({ code: '23514' })
  })
})
