/**
 * MCP full control, T1 (docs/mcp-full-control/sections/03-content.md §4.1–4.2) — the product-sheet writer can save
 * content in Nexus only.
 *
 * `applyProductBulkEdits` with `queueOutbound: false` on its context:
 *   · a shared (source) write still cascades: a listing that follows the text gets its follow marker;
 *   · NO channel update is queued (0 `OutboundSyncQueue` rows);
 *   · the listing is not marked "Pending" (lastSyncStatus / lastSyncedAt untouched): nothing waits to be sent.
 * Control: the same write without the flag queues one CONTENT_UPDATE and marks the listing PENDING, exactly as before.
 *
 * Runs the real writer on PostgreSQL (PGlite) and reads what was STORED.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
vi.mock('../pim/readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { applyProductBulkEdits, type ProductBulkContext } from './bulk-edit.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let amazon = ''

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Amazon IT', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } as never })
  amazon = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 't1-amazon', isActive: true, isPrimary: true } as never })).id
}), 60_000)
afterAll(async () => { await state.db?.close() })

/** A product with one LIVE Amazon IT listing that follows the master title (published, has a channel id, not paused). */
async function seed(sku: string) {
  const product = await prisma.product.create({ data: { sku, name: `${sku} titolo`, basePrice: 10, status: 'ACTIVE' } })
  const listing = await prisma.channelListing.create({ data: {
    productId: product.id, channel: 'AMAZON', marketplace: 'IT', region: 'IT', channelMarket: 'AMAZON_IT', channelConnectionId: amazon, aliasKey: '',
    listingStatus: 'ACTIVE', isPublished: true, externalListingId: `FIXTURE-${sku}`, syncPaused: false, followMasterTitle: true,
    lastSyncStatus: 'SUCCESS', lastSyncedAt: new Date('2026-09-30T10:00:00Z'),
  } as never })
  return { product, listing }
}

const saveTitle = (productId: string, version: number, title: string, extra: Partial<ProductBulkContext> = {}) =>
  applyProductBulkEdits({ changes: [{ id: productId, field: 'name', value: title, contentAddress: { tier: 'source' } }], expectedVersion: version } as never,
    { formulaCascade: false, logger: { warn: vi.fn(), error: vi.fn() }, ...extra } as ProductBulkContext) as Promise<any>

describe('T1 — the sheet writer with queueOutbound: false saves Nexus only', () => {
  it('cascades the follow marker, queues 0 channel updates, and leaves the listing not "Pending"', () => scoped(async () => {
    const { product, listing } = await seed('TEST-SKU-T1-NEXUS-ONLY')
    const saved = await saveTitle(product.id, product.version, 'Titolo solo in Nexus', { queueOutbound: false })
    expect(saved.errors).toEqual([])
    expect(await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).toMatchObject({ name: 'Titolo solo in Nexus', version: product.version + 1 })
    expect(await prisma.outboundSyncQueue.count({ where: { productId: product.id } })).toBe(0)
    expect(await prisma.channelListingTranslation.findFirst({ where: { channelListingId: listing.id, language: 'it' } })).toMatchObject({ follows: ['title'] })
    const after = await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })
    expect(after).toMatchObject({ version: listing.version + 1, lastSyncStatus: 'SUCCESS', lastSyncedAt: new Date('2026-09-30T10:00:00Z') })
  }))

  it('control: the same write without the flag queues one CONTENT_UPDATE and marks the listing PENDING', () => scoped(async () => {
    const { product, listing } = await seed('TEST-SKU-T1-QUEUED')
    const saved = await saveTitle(product.id, product.version, 'Titolo inviato')
    expect(saved.errors).toEqual([])
    const queued = await prisma.outboundSyncQueue.findMany({ where: { productId: product.id } })
    expect(queued).toEqual([expect.objectContaining({ channelListingId: listing.id, syncType: 'CONTENT_UPDATE', payload: expect.objectContaining({ title: 'Titolo inviato', language: 'it' }) })])
    expect(await prisma.channelListingTranslation.findFirst({ where: { channelListingId: listing.id, language: 'it' } })).toMatchObject({ follows: ['title'] })
    expect(await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })).toMatchObject({ version: listing.version + 1, lastSyncStatus: 'PENDING', lastSyncedAt: null })
  }))
})
