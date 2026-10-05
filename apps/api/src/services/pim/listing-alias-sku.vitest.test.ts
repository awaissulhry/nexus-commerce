/**
 * Add rows R3 (plan docs/sheet-ids-sku-rows/PLAN.md) — a new listing alias created with the SKU typed into an empty sheet
 * row: the SKU is the alias's record AND its main row's own channel SKU, written by the one writer (`setChannelSku`) inside
 * the same transaction. On PGlite with the production schema and row-level security: a refused SKU creates nothing; the
 * eBay import (no `channelSku`) keeps its alias-only record.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

vi.setConfig({ testTimeout: 60_000 })
let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return {
    default: new Proxy({}, {
      get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property),
    }),
  }
})
vi.mock('../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))

import { createAlias } from './listing-alias.service.js'

const inside = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const db = () => database.client
const ids: Record<string, string> = {}

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    ids.ebay = (await db().channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'rows-ebay', externalAccountId: 'rows-ebay', isActive: true, isPrimary: false } as never })).id
    ids.root = (await db().product.create({ data: { sku: 'ROWS-FAM', name: 'Rows family', basePrice: 10, isParent: true } as never })).id
    ids.child = (await db().product.create({ data: { sku: 'ROWS-FAM-M', name: 'Rows family M', basePrice: 10, parentId: ids.root } as never })).id
    // Another product whose eBay listing on the same account already sends TAKEN-1.
    ids.other = (await db().product.create({ data: { sku: 'ROWS-OTHER', name: 'Other', basePrice: 10 } as never })).id
    await db().channelListing.create({ data: { productId: ids.other, channel: 'EBAY', marketplace: 'IT', region: 'IT', channelMarket: 'EBAY_IT',
      channelConnectionId: ids.ebay, aliasKey: '', listingStatus: 'DRAFT', isPublished: false, channelSku: 'TAKEN-1' } as never })
  })
}, 120_000)
afterAll(async () => { await database?.close() }, 30_000)

const counts = () => inside(async () => ({
  aliases: await db().productListingAlias.count({ where: { productId: ids.root } }),
  listings: await db().channelListing.count({ where: { productId: { in: [ids.root, ids.child] } } }),
}))

describe('a new listing alias named by the sheet', () => {
  it('stores the SKU on the alias and as its main row\'s own channel SKU, with its history line', async () => {
    const alias = await inside(() => createAlias({ productId: ids.child, channel: 'EBAY', marketplace: 'IT', accountId: ids.ebay, sku: ' IT-ROWS-2 ', channelSku: true, createdBy: null }))
    expect(alias.sku).toBe('IT-ROWS-2')
    const rows = await inside(() => db().channelListing.findMany({ where: { aliasId: alias.id }, select: { id: true, productId: true, channelSku: true, version: true, listingStatus: true } }))
    const main = rows.find(row => row.productId === ids.root)!
    const child = rows.find(row => row.productId === ids.child)!
    expect(main).toMatchObject({ channelSku: 'IT-ROWS-2', listingStatus: 'DRAFT' })
    // Only the main row: a variation keeps following its own product SKU.
    expect(child.channelSku).toBeNull()
    const history = await inside(() => db().channelListingOverride.findMany({ where: { channelListingId: main.id } }))
    expect(history).toEqual([expect.objectContaining({ fieldName: 'channelSku', previousValue: null, newValue: 'IT-ROWS-2', reason: 'New listing alias' })])
  })

  it('refuses a SKU another product\'s listing sends on this account, in the writer\'s words, and creates nothing', async () => {
    const before = await counts()
    await expect(inside(() => createAlias({ productId: ids.root, channel: 'EBAY', marketplace: 'IT', accountId: ids.ebay, sku: 'TAKEN-1', channelSku: true })))
      .rejects.toMatchObject({ statusCode: 409, code: 'SKU_TAKEN', message: expect.stringContaining('TAKEN-1 is already the SKU of ROWS-OTHER') })
    expect(await counts()).toEqual(before)
  })

  it('refuses characters the SKU rule does not allow before reading anything, and creates nothing', async () => {
    const before = await counts()
    await expect(inside(() => createAlias({ productId: ids.root, channel: 'EBAY', marketplace: 'IT', accountId: ids.ebay, sku: 'IT ROWS', channelSku: true })))
      .rejects.toMatchObject({ statusCode: 400, code: 'INVALID_SKU', message: 'Use only letters, numbers, dots (.), hyphens (-) and underscores (_). No spaces.' })
    expect(await counts()).toEqual(before)
  })

  it('leaves the main row following the alias record when the caller does not ask (the eBay import)', async () => {
    const alias = await inside(() => createAlias({ productId: ids.root, channel: 'EBAY', marketplace: 'IT', accountId: ids.ebay, sku: 'IT-ROWS-IMPORT' }))
    expect(alias.sku).toBe('IT-ROWS-IMPORT')
    const main = await inside(() => db().channelListing.findFirst({ where: { aliasId: alias.id, productId: ids.root }, select: { channelSku: true } }))
    expect(main?.channelSku).toBeNull()
  })
})
