/**
 * Step 7, part 1 — the group-B sites that record a listing the channel already has, through `recordLiveListings`:
 * the reconciliation confirm, the Amazon flat-file resync after an accepted feed, and the Amazon flat-file pull.
 * (The wizard write-back is in live-listing.service.vitest.test.ts; the eBay push write-back in
 * ebay-variation-push.cx-review.vitest.test.ts.)
 *
 * On an in-process PostgreSQL (PGlite) with the generated schema and the production row policies. No channel is
 * called: the pull's Amazon read is a fixture. Every id is invented.
 *
 * Run: DATABASE_URL=postgresql://nexus@127.0.0.1:1/nexus_unit_test npx vitest run src/services/pim/live-listing-sites.vitest.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, pulled: new Map<string, any>() }))
vi.mock('@nexus/database', async importOriginal => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { ...await importOriginal<any>(), default: state.db.client, prisma: state.db.client }
})
vi.mock('../marketplaces/amazon.service.js', () => ({
  AmazonService: class { async fetchListingForFlatFile(sku: string) { return state.pulled.get(sku) ?? null } },
  AMAZON_MARKETPLACE_CODE_TO_ID: {}, XAVIA_ACTIVE_MARKETPLACES: [],
}))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { confirmReconRow } from '../listing-reconciliation.service.js'
import { AmazonFlatFileService } from '../amazon/flat-file.service.js'
import { getJobStatus, startPullJob } from '../amazon/flat-file-pull.service.js'
import { ensureDraftListings } from './draft-listing.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const rowsOf = (productId: string) => scoped(() => prisma.channelListing.findMany({ where: { productId }, orderBy: { createdAt: 'asc' } }))
const listing = (data: Record<string, unknown>) => scoped(() => prisma.channelListing.create({ data: { channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT',
  region: 'IT', channelConnectionId: accounts.primary, ...data } as never }))

const ids: Record<string, string> = {}
const accounts: Record<string, string> = {}

afterAll(async () => { await state.db?.close() })

beforeAll(async () => {
  await scoped(async () => {
    await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
    accounts.primary = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'primary', isActive: true, isPrimary: true,
      externalAccountId: 'SELLER-P', authStatus: 'connected', managedBy: 'oauth' } as never })).id
    for (const key of ['reconNull', 'reconDraft', 'reconLinked', 'feedNew', 'feedLegacy', 'feedDraft', 'feedVersion', 'pullLegacy']) {
      ids[key] = (await prisma.product.create({ data: { sku: `LS-${key}`, name: key, basePrice: 10, productType: key.startsWith('pull') ? 'LLPULL' : 'JACKET' } as never })).id
    }
  })
}, 60_000)

describe('reconciliation confirm', () => {
  const recon = (productId: string, extra: Record<string, unknown> = {}) => scoped(() => prisma.listingReconciliation.create({ data: {
    channel: 'AMAZON', marketplace: 'IT', externalSku: `SKU-${productId}`, externalListingId: 'ASIN-RECON', matchedProductId: productId, runId: 'run', ...extra } as never }))
  const coordinate = (productId: string, channelConnectionId: string | null = accounts.primary) =>
    ({ productId, channel: 'AMAZON', marketplace: 'IT', channelConnectionId, aliasKey: '' })

  it('refuses a coordinate with no account, and writes nothing', async () => {
    const row = await recon(ids.reconNull)
    await expect(scoped(() => confirmReconRow(row.id, 'test', coordinate(ids.reconNull, null)))).rejects.toThrow('RECON_ACCOUNT_REQUIRED')
    expect(await rowsOf(ids.reconNull)).toHaveLength(0)
  })

  it('a still-draft is confirmed live: ACTIVE, published and unpaused', async () => {
    await scoped(() => prisma.$transaction(tx => ensureDraftListings(tx, { channel: 'AMAZON', market: 'IT', productIds: [ids.reconDraft] })))
    const row = await recon(ids.reconDraft)
    await scoped(() => confirmReconRow(row.id, 'test', coordinate(ids.reconDraft)))
    expect(await rowsOf(ids.reconDraft)).toEqual([expect.objectContaining({ listingStatus: 'ACTIVE', isPublished: true, syncPaused: false })])
    expect((await scoped(() => prisma.listingReconciliation.findUnique({ where: { id: row.id } })))?.reconciliationStatus).toBe('CONFIRMED')
  })

  it('a different stored parent ASIN is refused, not replaced, and the row is left as it was', async () => {
    await listing({ productId: ids.reconLinked, listingStatus: 'INACTIVE', isPublished: true, externalListingId: 'PARENT-OLD', externalParentId: 'PARENT-OLD' })
    const row = await recon(ids.reconLinked, { parentAsin: 'PARENT-NEW' })
    await expect(scoped(() => confirmReconRow(row.id, 'test', coordinate(ids.reconLinked)))).rejects.toThrow('RECON_ASIN_CONFLICT')
    expect(await rowsOf(ids.reconLinked)).toEqual([expect.objectContaining({ listingStatus: 'INACTIVE', externalListingId: 'PARENT-OLD' })])
    expect((await scoped(() => prisma.listingReconciliation.findUnique({ where: { id: row.id } })))?.reconciliationStatus).toBe('PENDING')
  })
})

describe('Amazon flat-file resync after an accepted feed (isPublished)', () => {
  const service = () => new AmazonFlatFileService(prisma as never, {} as never)
  const resync = (row: Record<string, unknown>) => scoped(() => service().syncRowsToPlatform([{ product_type: 'JACKET', item_name: 'Jacket', record_action: 'partial_update', ...row } as never], 'IT', {}, { isPublished: true }))

  it('a new listing is recorded on the primary account, published and ACTIVE, with its ASIN', async () => {
    const result = await resync({ item_sku: 'LS-feedNew', _asin: 'ASIN-FEED' })
    expect(result.errors).toEqual([])
    expect(await rowsOf(ids.feedNew)).toEqual([expect.objectContaining({ channelConnectionId: accounts.primary, marketplace: 'IT', listingStatus: 'ACTIVE',
      isPublished: true, syncPaused: false, externalListingId: 'ASIN-FEED', title: 'Jacket', syncStatus: 'SYNCED' })])
  })

  it('a row an earlier save wrote with no account is adopted, not duplicated', async () => {
    const legacy = await listing({ productId: ids.feedLegacy, channelConnectionId: null, listingStatus: 'DRAFT', isPublished: true })
    await resync({ item_sku: 'LS-feedLegacy' })
    expect(await rowsOf(ids.feedLegacy)).toEqual([expect.objectContaining({ id: legacy.id, channelConnectionId: accounts.primary, listingStatus: 'ACTIVE', isPublished: true })])
  })

  it('a paused still-draft is refused by the flat-file push lock: it stays an inert draft (the feed never sent it)', async () => {
    await scoped(() => prisma.$transaction(tx => ensureDraftListings(tx, { channel: 'AMAZON', market: 'IT', productIds: [ids.feedDraft] })))
    await resync({ item_sku: 'LS-feedDraft' })
    expect(await rowsOf(ids.feedDraft)).toEqual([expect.objectContaining({ listingStatus: 'DRAFT', isPublished: false, syncPaused: true, syncStatus: 'FAILED' })])
  })

  it('a row changed since the grid read it is reported with its current version, not written', async () => {
    const live = await listing({ productId: ids.feedVersion, listingStatus: 'ACTIVE', isPublished: true, version: 7 })
    const result = await resync({ item_sku: 'LS-feedVersion', _version: 6 })
    expect(result.errors).toEqual([expect.objectContaining({ sku: 'LS-feedVersion', currentVersion: 7 })])
    expect(await rowsOf(ids.feedVersion)).toEqual([expect.objectContaining({ id: live.id, version: 7 })])
    // With the version it read, the same resync is written.
    const again = await resync({ item_sku: 'LS-feedVersion', _version: 7 })
    expect(again.errors).toEqual([])
    expect((again as { versions: Record<string, number> }).versions['LS-feedVersion']).toBe(8)
  })
})

describe('Amazon flat-file pull', () => {
  it('records the pulled listing on the primary account: a legacy row is adopted, the status is Amazon\'s, the quantity stays the pool\'s', async () => {
    const legacy = await listing({ productId: ids.pullLegacy, channelConnectionId: null, listingStatus: 'DRAFT', isPublished: true, quantity: 5 })
    state.pulled.set('LS-pullLegacy', { asin: 'ASIN-PULL', attributes: { fulfillment_availability: [{ quantity: 0 }] }, title: 'Pulled', listingStatus: 'DISCOVERABLE', productType: 'LLPULL', relationships: [] })
    const jobId = await scoped(async () => startPullJob('IT', 'LLPULL'))
    for (let i = 0; i < 200 && getJobStatus(jobId)?.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 25))
    expect(getJobStatus(jobId)).toMatchObject({ status: 'done', pulled: 1, failed: 0 })
    expect(await rowsOf(ids.pullLegacy)).toEqual([expect.objectContaining({ id: legacy.id, channelConnectionId: accounts.primary, listingStatus: 'DISCOVERABLE',
      isPublished: true, externalListingId: 'ASIN-PULL', title: 'Pulled', quantity: 5 })])
  })
})
