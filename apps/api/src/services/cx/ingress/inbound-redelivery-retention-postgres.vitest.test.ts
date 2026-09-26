/**
 * Redelivery identity and bounded retention of inbound history (re-review of #15).
 *
 * 1. A redelivery's account is an identity, not a connection row. A delivery stored before its
 *    shop had a route (connectionId NULL) or under an earlier row of the same account (a fresh
 *    Connect after disconnect) is the same delivery: it binds to the arriving connection and is
 *    processed once. A genuinely different account is still refused, and a receiver says so
 *    instead of reporting a ledger outage. Concurrent redeliveries bind once.
 * 2. Inbound history cannot be deleted (DELETE/TRUNCATE guard), so its personal data expires by
 *    UPDATE: rawBody, payload and verificationHeaders are cleared on rejected/unverified rows and
 *    on archived rows after #4's window (policy webhookEvents days on createdAt). Leased,
 *    claimed, scheduled, verified-unarchived and quarantine-linked rows are never touched.
 * Real PostgreSQL 17 through the restricted runtime login (concurrent-database.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
/** When set, the first `count` redelivery UPDATEs wait for each other (deterministic race). */
let updateGate: { count: number; arrived: number; ready: Promise<void>; release: () => void } | null = null
vi.mock('../../../db.js', () => ({ default: new Proxy({}, {
  get: (_target, key) => key === 'webhookEvent' ? new Proxy({}, {
    get: (_model, method: string) => async (args: any) => {
      if (method === 'update' && updateGate && args?.where?.channel_externalId && updateGate.arrived < updateGate.count) {
        const gate = updateGate
        if (++gate.arrived === gate.count) gate.release()
        await gate.ready
      }
      return (database.client.webhookEvent as any)[method](args)
    },
  }) : (database.client as any)[key],
}) }))

const ledger = await import('./ledger.js')
const claims = await import('./claims.js')
const archive = await import('./archive.js')
const { runRetentionSweepOnce } = await import('../../../jobs/data-retention-sweep.job.js')

let profile = ''
const inProfile = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: profile, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const days = (n: number) => new Date(Date.now() - n * 86_400_000)
const row = (id: string) => database.pool.query('SELECT * FROM "WebhookEvent" WHERE id=$1', [id]).then(result => result.rows[0])

async function connection(externalAccountId: string, isActive: boolean) {
  const id = `conn-${randomUUID()}`
  await database.pool.query(`INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","externalAccountId","isActive","updatedAt")
    VALUES ($1,$2,'SHOPIFY',$3,$4,now())`, [id, profile, externalAccountId, isActive])
  return id
}

// The Shopify receiver's own sequence (routes/shopify-webhooks.ts), with a counting handler.
const handled: Array<string | null> = []
const delivery = (externalId: string, connectionId?: string, extra: Record<string, unknown> = {}) => ({
  channel: 'SHOPIFY', eventType: 'order/create', externalId, payload: { order: { id: 'synthetic-order' } },
  rawBody: Buffer.from('{"order":{"id":"synthetic-order"}}'), signatureOk: true, verifiedBy: 'shopify_hmac' as const,
  ...(connectionId ? { connectionId } : {}), ...extra,
})
async function receive(externalId: string, connectionId: string) {
  const written = await inProfile(() => ledger.recordInbound({ ...delivery(externalId, connectionId), status: 'pending' }))
  if (!written.id) return { status: 503, written, reason: ledger.inboundNotRecorded(written) }
  if (written.duplicate && written.existingStatus === 'done') return { status: 200, written, processed: false }
  const claim = await inProfile(() => claims.claimInbound(written.id!))
  if (!claim) return { status: 200, written, processed: false }
  await inProfile(() => claims.runWithInboundClaim(claim, async stored => { handled.push(stored.connectionId) }))
  return { status: 200, written, processed: true }
}

describe.skipIf(!concurrentDatabaseUrl())('redelivery identity and bounded inbound retention', () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_ENABLE_RETENTION_SWEEP', '1')
    database = await concurrentDatabase({ maxConnections: 16 })
  }, 120_000)
  beforeEach(async () => {
    profile = randomUUID(); handled.length = 0; updateGate = null
    await database.pool.query('INSERT INTO "Workspace" (id,name,"createdByUserId","creationKey","updatedAt") VALUES ($1,\'Redelivery fixture\',\'test\',$1,now())', [profile])
  })
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  describe('a redelivery is identified by account, not by connection row', () => {
    it('binds a delivery stored without a route to the reconnected shop and processes it once', async () => {
      const externalId = randomUUID()
      // Recorded while the shop had no route (the receiver's no-route path: failed, no connection).
      await inProfile(() => ledger.recordInbound({ ...delivery(externalId), status: 'failed', lastError: 'no connected shop matches' }))
      const shop = await connection('shop-x.myshopify.com', true)
      const first = await receive(externalId, shop)
      expect(first).toMatchObject({ status: 200, processed: true, written: { duplicate: true, existingStatus: 'failed' } })
      const again = await receive(externalId, shop)
      expect(again).toMatchObject({ status: 200, processed: false, written: { existingStatus: 'done' } })
      expect(handled).toEqual([shop])
      expect(await row(first.written.id!)).toMatchObject({ connectionId: shop, status: 'done', deliveries: 3 })
    })

    it('treats a fresh Connect of the same shop (new connection row) as the same delivery and processes it once', async () => {
      const externalId = randomUUID()
      const old = await connection('shop-y.myshopify.com', false)
      const stored = await inProfile(() => ledger.recordInbound({ ...delivery(externalId, old), status: 'failed', lastError: 'handler failed before disconnect' }))
      const fresh = await connection('shop-y.myshopify.com', true)
      expect(await receive(externalId, fresh)).toMatchObject({ status: 200, processed: true, written: { id: stored.id, duplicate: true } })
      expect(await receive(externalId, fresh)).toMatchObject({ status: 200, processed: false })
      expect(handled).toEqual([fresh])
      expect(await row(stored.id!)).toMatchObject({ connectionId: fresh, status: 'done', deliveries: 3 })
    })

    it('refuses a genuinely different account and says so instead of reporting a ledger outage', async () => {
      const externalId = randomUUID()
      const mine = await connection('shop-a.myshopify.com', true)
      const stored = await inProfile(() => ledger.recordInbound({ ...delivery(externalId, mine), status: 'failed' }))
      const other = await connection('shop-b.myshopify.com', true)
      const refused = await receive(externalId, other)
      expect(refused).toMatchObject({ status: 503, written: { id: null, duplicate: true, conflict: 'identity_mismatch' } })
      expect(refused.reason).toMatch(/bound to another account/)
      expect(refused.reason).not.toMatch(/unavailable/)
      expect(handled).toEqual([])
      expect(await row(stored.id!)).toMatchObject({ connectionId: mine, deliveries: 1, status: 'failed' })
    })

    it('binds once when redeliveries race, and re-evaluates the loser against the winner', async () => {
      const externalId = randomUUID()
      const stored = await inProfile(() => ledger.recordInbound({ ...delivery(externalId), status: 'failed' }))
      const shop = await connection('shop-c.myshopify.com', true)
      const settled = await Promise.all(Array.from({ length: 8 }, () => inProfile(() => ledger.recordInbound({ ...delivery(externalId, shop), status: 'pending' }))))
      expect(settled.every(result => result.id === stored.id && result.duplicate)).toBe(true)
      expect(await row(stored.id!)).toMatchObject({ connectionId: shop, deliveries: 9 })

      // Two accounts race for one unbound delivery: both read NULL before either writes.
      const contested = randomUUID()
      const unbound = await inProfile(() => ledger.recordInbound({ ...delivery(contested), status: 'failed' }))
      const [a, b] = [await connection('shop-d.myshopify.com', true), await connection('shop-e.myshopify.com', true)]
      let release!: () => void
      updateGate = { count: 2, arrived: 0, ready: new Promise<void>(resolve => { release = resolve }), release: () => release() }
      const raced = await Promise.all([a, b].map(id => inProfile(() => ledger.recordInbound({ ...delivery(contested, id), status: 'pending' }))))
      expect(updateGate.arrived).toBe(2)
      const winners = raced.filter(result => result.id !== null)
      expect(winners).toHaveLength(1)
      expect(raced.filter(result => result.conflict === 'identity_mismatch')).toHaveLength(1)
      const bound = await row(unbound.id!)
      expect([a, b]).toContain(bound.connectionId)
      expect(bound.deliveries).toBe(2)
    }, 30_000)
  })

  describe('personal data in retained inbound history expires by UPDATE, never by DELETE', () => {
    async function event(fields: Record<string, unknown>) {
      const id = randomUUID()
      await inProfile(() => database.client.webhookEvent.create({ data: {
        id, externalId: id, channel: 'SHOPIFY', eventType: 'order/create', status: 'failed', attempts: 0, deliveries: 1,
        payload: { buyer: 'synthetic-buyer' }, rawBody: Uint8Array.from(Buffer.from('{"buyer":"synthetic-buyer"}')),
        verificationHeaders: { 'x-shopify-webhook-id': id }, ...fields,
      } as any }))
      return id
    }
    const scrubbed = (r: any) => r.rawBody === null && r.verificationHeaders === null && r.payload === null
    const intact = (r: any) => r.rawBody !== null && r.verificationHeaders !== null && r.payload !== null

    it('scrubs rejected, unverified and archived rows after the window and nothing else', async () => {
      await inProfile(() => database.client.dataRetentionPolicy.create({ data: { policies: { webhookEvents: 1 } } }))
      const old = days(3)
      const ids = {
        rejectedOld: await event({ createdAt: old, signatureOk: false, verifiedBy: 'shopify_hmac' }),
        rejectedRecent: await event({ createdAt: new Date(), signatureOk: false, verifiedBy: 'shopify_hmac' }),
        unverifiedEbayOld: await event({ createdAt: old, channel: 'EBAY', eventType: 'AUTHORIZATION_REVOCATION', signatureOk: true, verifiedBy: null }),
        finishedOld: await event({ createdAt: old, status: 'done', isProcessed: true, processedAt: old, signatureOk: true, verifiedBy: 'shopify_hmac' }),
        deadLetterOld: await event({ createdAt: old, status: 'dlq', attempts: 5, signatureOk: true, verifiedBy: 'shopify_hmac' }),
        strandedOld: await event({ createdAt: old, status: 'pending', signatureOk: true, verifiedBy: 'shopify_hmac' }),
        amazonTrustedOld: await event({ createdAt: old, channel: 'AMAZON', eventType: 'ORDER_CHANGE', status: 'pending', signatureOk: null, verifiedBy: 'sqs_iam' }),
        claimedRejectedOld: await event({ createdAt: old, signatureOk: false, verifiedBy: 'shopify_hmac', processingToken: 'live-owner', processingUntil: new Date(Date.now() + 300_000) }),
        leasedEbayOld: await event({ createdAt: old, channel: 'EBAY', eventType: 'AUTHORIZATION_REVOCATION', signatureOk: false, verifiedBy: 'none', leaseToken: 'live-lease', leaseUntil: new Date(Date.now() + 300_000) }),
        scheduledRejectedOld: await event({ createdAt: old, signatureOk: false, verifiedBy: 'shopify_hmac', nextAttemptAt: new Date(Date.now() + 300_000) }),
      }
      // A receipt an eBay quarantine row resolved to: archived like any finished receipt, never scrubbed here.
      const noticeId = randomUUID()
      const linked = await event({ createdAt: old, channel: 'EBAY', eventType: 'AUTHORIZATION_REVOCATION', externalId: `ebay:production:${noticeId}`,
        status: 'done', isProcessed: true, processedAt: old, signatureOk: true, verifiedBy: 'ebay_ecdsa', connectionId: 'ebay-account' })
      // A verified quarantine row must carry its (synthetic) encrypted body and key id.
      await database.pool.query(`INSERT INTO "EbayNoticeQuarantine" (id,environment,"signatureOk","externalId",topic,"payloadEnc","payloadKeyId","payloadDigest",reason,"resolvedWorkspaceId","resolvedReceiptId","resolvedAt")
        VALUES ($1,'production',true,$2,'AUTHORIZATION_REVOCATION','v1:synthetic.synthetic.synthetic','env',repeat('a',64),'owner_unknown',$3,$4,now())`, [randomUUID(), noticeId, profile, linked])

      const summary = await inProfile(() => runRetentionSweepOnce())
      expect(summary.deletedByKey.webhookEvents).toBeUndefined()
      expect(summary.scrubbedByKey.webhookEvents).toBe(3)
      expect(summary.scrubLimitReached).toBe(false)
      const after = Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([name, id]) => [name, await row(id)])))
      for (const name of ['rejectedOld', 'unverifiedEbayOld', 'finishedOld']) expect(scrubbed(after[name]), name).toBe(true)
      for (const name of ['rejectedRecent', 'deadLetterOld', 'strandedOld', 'amazonTrustedOld', 'claimedRejectedOld', 'leasedEbayOld', 'scheduledRejectedOld']) expect(intact(after[name]), name).toBe(true)
      expect(after.finishedOld.archivedAt).toBeInstanceOf(Date)
      // The metadata row is kept: identity, verdict, status, timings and delivery count.
      expect(after.rejectedOld).toMatchObject({ id: ids.rejectedOld, externalId: ids.rejectedOld, eventType: 'order/create', signatureOk: false, status: 'failed', deliveries: 1 })
      const linkedRow = await row(linked)
      expect(linkedRow.archivedAt).toBeInstanceOf(Date)
      expect(intact(linkedRow)).toBe(true)
      expect((await database.pool.query('SELECT count(*)::int AS n FROM "EbayNoticeQuarantine" WHERE "resolvedReceiptId"=$1', [linked])).rows[0].n).toBe(1)
    })

    it('keeps the deletion guard: a scrubbed row can still not be deleted, by the runtime login or the owner', async () => {
      await inProfile(() => database.client.dataRetentionPolicy.create({ data: { policies: { webhookEvents: 1 } } }))
      const id = await event({ createdAt: days(3), signatureOk: false, verifiedBy: 'shopify_hmac' })
      await inProfile(() => runRetentionSweepOnce())
      expect(scrubbed(await row(id))).toBe(true)
      await expect(inProfile(() => database.client.webhookEvent.deleteMany({ where: { id } }))).rejects.toThrow()
      await expect(database.pool.query('DELETE FROM "WebhookEvent" WHERE id=$1', [id])).rejects.toMatchObject({ code: '42501' })
      expect((await row(id)).id).toBe(id)
    })

    it('works in bounded batches and reports when the limit was reached', async () => {
      await inProfile(() => database.client.dataRetentionPolicy.create({ data: { policies: { webhookEvents: 1 } } }))
      // The documented per-run bound: batches of 500, at most 20 per profile per run.
      const perRun = 10_000
      expect(archive.INBOUND_SCRUB_BATCH * archive.INBOUND_SCRUB_MAX_BATCHES).toBe(perRun)
      const total = perRun + 1
      await database.pool.query(`INSERT INTO "WebhookEvent" ("workspaceId",id,channel,"eventType","externalId",payload,"rawBody",status,"signatureOk","verifiedBy","createdAt","updatedAt")
        SELECT $1, 'bulk-' || g || '-' || $1, 'SHOPIFY', 'order/create', 'bulk-' || g || '-' || $1, '{"buyer":"synthetic"}'::jsonb, '\\x7b7d'::bytea, 'failed', false, 'shopify_hmac', now() - interval '3 days', now()
        FROM generate_series(1, $2::int) g`, [profile, total])
      const first = await inProfile(() => runRetentionSweepOnce())
      expect(first.scrubbedByKey.webhookEvents).toBe(total - 1)
      expect(first.scrubLimitReached).toBe(true)
      const second = await inProfile(() => runRetentionSweepOnce())
      expect(second.scrubbedByKey.webhookEvents).toBe(1)
      expect(second.scrubLimitReached).toBe(false)
    }, 120_000)
  })
})
