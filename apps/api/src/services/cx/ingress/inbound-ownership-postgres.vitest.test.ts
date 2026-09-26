/**
 * One owner per inbound row type, now that two lease systems share WebhookEvent.
 *
 * Package A leases verified eBay receipts (leaseToken/leaseUntil, ebay-claims.ts); #4 claims
 * every other trusted inbound row (processingToken/processingUntil, claims.ts). Each is blind
 * to the other's columns by construction, so the rule is enforced in both directions:
 *   - the generic claimant, its scheduler, its completion and the legacy writers never own an
 *     eBay row;
 *   - the eBay lease never owns a generic row, nor any row that carries a processing claim;
 *   - retention archives finished, unowned history and deletes nothing (Package A's
 *     DELETE/TRUNCATE guard).
 * Real PostgreSQL 17 through the restricted runtime login (concurrent-database.ts), with the
 * production row policies. Every rule below was shown red by removing its guard.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => (database.client as any)[key] }) }))

const claims = await import('./claims.js')
const ledger = await import('./ledger.js')
const ebay = await import('./ebay-claims.js')
const { runRetentionSweepOnce } = await import('../../../jobs/data-retention-sweep.job.js')

let profile = ''
const inProfile = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: profile, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000)
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000)
const stored = (id: string) => inProfile(() => database.client.webhookEvent.findUniqueOrThrow({ where: { id } }))

function create(fields: Record<string, unknown>) {
  const id = randomUUID()
  return inProfile(() => database.client.webhookEvent.create({ data: {
    id, externalId: id, payload: { original: true }, status: 'pending', attempts: 0, deliveries: 1, ...fields,
  } as any }))
}
const verifiedEbay = (fields: Record<string, unknown> = {}) => create({
  channel: 'EBAY', eventType: 'AUTHORIZATION_REVOCATION', signatureOk: true, verifiedBy: 'ebay_ecdsa',
  connectionId: 'ebay-account', ...fields, externalId: `ebay:production:${randomUUID()}`,
})
const shopify = (fields: Record<string, unknown> = {}) => create({
  channel: 'SHOPIFY', eventType: 'product/update', signatureOk: true, verifiedBy: 'shopify_hmac',
  connectionId: 'shop-account', ...fields,
})
const forgedClaim = (id: string, token: string) => ({ id, token, attempt: 1, payload: {}, connectionId: null, eventType: 'AUTHORIZATION_REVOCATION', channel: 'EBAY' })

describe.skipIf(!concurrentDatabaseUrl())('one owner per inbound row type (Package A eBay leases × #4 processing claims)', () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_ENABLE_RETENTION_SWEEP', '1')
    database = await concurrentDatabase({ maxConnections: 16 })
  }, 120_000)
  beforeEach(async () => {
    // Inbound history cannot be deleted, so every test gets its own business profile.
    profile = randomUUID()
    await database.pool.query('INSERT INTO "Workspace" (id,name,"createdByUserId","creationKey","updatedAt") VALUES ($1,\'Ownership fixture\',\'test\',$1,now())', [profile])
  })
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  describe('the generic claimant never owns an eBay row', () => {
    it('refuses a due verified eBay receipt to every concurrent generic claimer', async () => {
      const due = await verifiedEbay({ nextAttemptAt: ago(1) })
      const results = await inProfile(() => Promise.all(Array.from({ length: 8 }, () => claims.claimInbound(due.id))))
      expect(results.filter(result => result !== null)).toHaveLength(0)
      expect(await stored(due.id)).toMatchObject({ status: 'pending', attempts: 0, processingToken: null, processingUntil: null, leaseToken: null })
    })

    it('refuses legacy eBay rows whose trust predates ebay_ecdsa, even when due', async () => {
      const legacy = await create({ channel: 'EBAY', eventType: 'AUTHORIZATION_REVOCATION', signatureOk: true, verifiedBy: null, nextAttemptAt: ago(1) })
      expect(await inProfile(() => claims.claimInbound(legacy.id))).toBeNull()
      expect(await stored(legacy.id)).toMatchObject({ attempts: 0, processingToken: null })
    })

    it('cannot finish a processing token planted on an eBay row', async () => {
      const planted = await verifiedEbay({ processingToken: 'planted', processingUntil: later(5), attempts: 1 })
      expect(await inProfile(() => claims.finishInboundClaim(forgedClaim(planted.id, 'planted') as any, true))).toBe(false)
      expect(await stored(planted.id)).toMatchObject({ status: 'pending', isProcessed: false, processedAt: null })
    })

    it('keeps eBay admission unscheduled while other trusted arrivals are due at once', async () => {
      const ebayReceipt = await inProfile(() => ledger.recordInbound({
        channel: 'EBAY', eventType: 'AUTHORIZATION_REVOCATION', externalId: `ebay:production:${randomUUID()}`, payload: {},
        signatureOk: true, verifiedBy: 'ebay_ecdsa', connectionId: 'ebay-account', status: 'pending',
      }))
      const shopifyArrival = await inProfile(() => ledger.recordInbound({
        channel: 'SHOPIFY', eventType: 'product/update', externalId: randomUUID(), payload: {},
        signatureOk: true, verifiedBy: 'shopify_hmac', connectionId: 'shop-account', status: 'pending',
      }))
      expect((await stored(ebayReceipt.id!)).nextAttemptAt).toBeNull()
      expect((await stored(shopifyArrival.id!)).nextAttemptAt).toBeInstanceOf(Date)
    })

    it('leaves verified eBay receipts out of the generic due list and unverified eBay rows in it for dead-lettering', async () => {
      const verified = await verifiedEbay({ nextAttemptAt: ago(1) })
      const unverified = await create({ channel: 'EBAY', eventType: 'AUTHORIZATION_REVOCATION', signatureOk: false, verifiedBy: 'none', status: 'failed', nextAttemptAt: ago(1) })
      const generic = await shopify({ status: 'failed', nextAttemptAt: ago(1) })
      const due = await inProfile(() => ledger.dueInboundEvents(50, new Date(), { excludeVerifiedEbay: true }))
      expect(due.map(event => event.id).sort()).toEqual([unverified.id, generic.id].sort())
      expect(due.map(event => event.id)).not.toContain(verified.id)
    })
  })

  describe('the eBay lease never owns a generic row', () => {
    it('refuses to lease a due Shopify event', async () => {
      const due = await shopify({ nextAttemptAt: ago(1) })
      expect(await inProfile(() => ebay.claimEbayInbound(due.id))).toBeNull()
      expect(await stored(due.id)).toMatchObject({ leaseToken: null, leaseUntil: null, attempts: 0 })
    })

    it('refuses an eBay row that carries a generic processing claim', async () => {
      const claimed = await verifiedEbay({ nextAttemptAt: ago(1), processingToken: 'generic-owner', processingUntil: later(5) })
      expect(await inProfile(() => ebay.claimEbayInbound(claimed.id))).toBeNull()
      expect(await stored(claimed.id)).toMatchObject({ leaseToken: null, processingToken: 'generic-owner', attempts: 0 })
    })
  })

  describe('concurrent mixed claimers give each row type exactly one owner of the right kind', () => {
    it.each([['SHOPIFY', 1, 0], ['EBAY', 0, 1]] as const)('%s row: %i generic winner(s), %i eBay winner(s)', async (channel, genericWins, ebayWins) => {
      const due = channel === 'EBAY' ? await verifiedEbay({ nextAttemptAt: ago(1) }) : await shopify({ nextAttemptAt: ago(1) })
      const attempts = Array.from({ length: 12 }, (_, index) => index % 2
        ? inProfile(() => claims.claimInbound(due.id)).then(result => ({ kind: 'generic' as const, result }))
        : inProfile(() => ebay.claimEbayInbound(due.id)).then(result => ({ kind: 'ebay' as const, result })))
      const settled = await Promise.all(attempts)
      expect(settled.filter(item => item.kind === 'generic' && item.result).length).toBe(genericWins)
      expect(settled.filter(item => item.kind === 'ebay' && item.result).length).toBe(ebayWins)
      const row = await stored(due.id)
      expect(row.attempts).toBe(1)
      if (channel === 'EBAY') expect(row).toMatchObject({ processingToken: null, leaseToken: expect.any(String) })
      else expect(row).toMatchObject({ leaseToken: null, processingToken: expect.any(String) })
    }, 30_000)
  })

  describe('legacy writers honour both owners', () => {
    it('never completes an eBay receipt or a row held by a processing claim', async () => {
      const ebayReceipt = await verifiedEbay()
      const generic = await shopify({ nextAttemptAt: ago(1) })
      const claim = await inProfile(() => claims.claimInbound(generic.id))
      expect(claim).not.toBeNull()
      await inProfile(() => ledger.completeInbound(ebayReceipt.id, true))
      await inProfile(() => ledger.completeInbound(generic.id, true))
      await inProfile(() => ledger.completeInbound(generic.id, false, 'legacy failure'))
      expect(await stored(ebayReceipt.id)).toMatchObject({ status: 'pending', isProcessed: false })
      expect(await stored(generic.id)).toMatchObject({ status: 'pending', attempts: 1, processingToken: claim!.token, lastError: null })
    })

    it('dead-letters only rows no owner holds', async () => {
      const leased = await verifiedEbay({ nextAttemptAt: ago(1) })
      expect(await inProfile(() => ebay.claimEbayInbound(leased.id))).not.toBeNull()
      const generic = await shopify({ nextAttemptAt: ago(1) })
      expect(await inProfile(() => claims.claimInbound(generic.id))).not.toBeNull()
      const unverified = await create({ channel: 'EBAY', eventType: 'AUTHORIZATION_REVOCATION', signatureOk: false, verifiedBy: 'none', status: 'failed' })
      for (const id of [leased.id, generic.id, unverified.id]) await inProfile(() => ledger.deadLetterInbound(id, 'owner check'))
      expect((await stored(leased.id)).status).toBe('pending')
      expect((await stored(generic.id)).status).toBe('pending')
      expect((await stored(unverified.id)).status).toBe('dlq')
    })
  })

  describe('retention archives inbound history instead of deleting it', () => {
    it('archives finished unowned rows of both types, keeps owned, scheduled and unfinished rows, deletes nothing', async () => {
      await inProfile(() => database.client.dataRetentionPolicy.create({ data: { policies: { webhookEvents: 1 } } }))
      const old = ago(3 * 24 * 60)
      const done = { status: 'done', isProcessed: true, processedAt: old, createdAt: old }
      const finishedGeneric = await shopify(done)
      const finishedEbay = await verifiedEbay(done)
      const claimedDone = await shopify({ ...done, processingToken: 'late-owner', processingUntil: later(5) })
      const leasedDone = await verifiedEbay({ ...done, leaseToken: 'late-lease', leaseUntil: later(5) })
      const scheduled = await shopify({ status: 'failed', createdAt: old, nextAttemptAt: later(5) })
      const deadLetter = await shopify({ status: 'dlq', createdAt: old, attempts: 5 })
      const all = [finishedGeneric, finishedEbay, claimedDone, leasedDone, scheduled, deadLetter].map(row => row.id)

      const summary = await inProfile(() => runRetentionSweepOnce())
      expect(summary.deletedByKey.webhookEvents).toBeUndefined()
      expect(summary.skippedKeys.filter(key => key.startsWith('webhookEvents'))).toEqual([])
      expect(summary.archivedByKey.webhookEvents).toBe(2)
      const rows = await inProfile(() => database.client.webhookEvent.findMany({ where: { id: { in: all } }, select: { id: true, archivedAt: true } }))
      expect(rows.map(row => row.id).sort()).toEqual([...all].sort())
      expect(rows.filter(row => row.archivedAt).map(row => row.id).sort()).toEqual([finishedGeneric.id, finishedEbay.id].sort())
    })

    it('refuses deletion of inbound history to the runtime login and to the owner', async () => {
      const history = await shopify({ status: 'done', isProcessed: true, processedAt: ago(10) })
      await expect(inProfile(() => database.client.webhookEvent.deleteMany({ where: { id: history.id } }))).rejects.toThrow()
      await expect(database.pool.query('DELETE FROM "WebhookEvent" WHERE id=$1', [history.id])).rejects.toMatchObject({ code: '42501' })
      await expect(database.pool.query('TRUNCATE "WebhookEvent" CASCADE')).rejects.toMatchObject({ code: '42501' })
      expect((await stored(history.id)).id).toBe(history.id)
    })
  })
})
