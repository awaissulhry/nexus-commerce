/**
 * Delete rows from the product sheet (Owner, 2026-10-06) — what a ticked row deletes, what is refused and why, and the
 * Undo, over a real PostgreSQL in-process (PGlite). Every id and SKU is invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn(async () => undefined) }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { deleteSheetRows, listingStillOnChannel, planSheetDelete, restoreSheetRows, SheetDeleteError } from './sheet-delete-rows.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const plan = (productId: string, rows: Array<{ productId: string; aliasId: string | null }>) => scoped(() => planSheetDelete(prisma, productId, rows))
const main = (productId: string) => ({ productId, aliasId: null })

let account = ''

beforeAll(() => scoped(async () => {
  account = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'del-ebay', isActive: true, isPrimary: true } as never })).id
  const product = (id: string, parentId: string | null) => prisma.product.create({ data: { id, sku: `TEST-${id.toUpperCase()}`, name: id, basePrice: 10, isParent: parentId === null, parentId } as never })
  const listing = (productId: string, live: { itemId?: string; aliasId?: string } = {}) => prisma.channelListing.create({ data: {
    productId, channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT', region: 'EU', channelConnectionId: account,
    aliasKey: live.aliasId ?? '', aliasId: live.aliasId ?? null,
    ...(live.itemId ? { listingStatus: 'ACTIVE', isPublished: true, externalListingId: live.itemId } : { listingStatus: 'DRAFT', isPublished: false, syncPaused: true }),
  } as never })
  const alias = (id: string, productId: string, label: string, position: number) => prisma.productListingAlias.create({ data: { id, productId, channel: 'EBAY', marketplace: 'IT', channelConnectionId: account, label, position } as never })

  // Family f: a draft variation, a live one, one sold through an eBay item's membership, and two extra listings.
  await product('f-p', null)
  for (const id of ['f-a', 'f-b', 'f-c', 'f-d']) await product(id, 'f-p')
  await listing('f-p', { itemId: '111' })
  await listing('f-a')
  await listing('f-b')
  await listing('f-c', { itemId: '111' })
  await prisma.sharedListingMembership.create({ data: { marketplace: 'IT', sku: 'TEST-F-D', itemId: '222', parentSku: 'TEST-F-P', productId: 'f-d', variationSpecifics: { Colore: 'Nero' } } as never })
  await alias('alias-draft', 'f-p', 'test', 1)
  await listing('f-p', { aliasId: 'alias-draft' })
  await listing('f-a', { aliasId: 'alias-draft' })
  await alias('alias-live', 'f-p', 'ALT1', 2)
  await listing('f-p', { aliasId: 'alias-live', itemId: '333' })

  // Family g: nothing on a channel, so the whole family may go.
  await product('g-p', null)
  await product('g-a', 'g-p')
  await listing('g-p')
  await listing('g-a')
  await alias('alias-g', 'g-p', 'G extra', 1)
  await listing('g-p', { aliasId: 'alias-g' })
}), 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)

describe('what a ticked row deletes', () => {
  it('a Shared or Main listing row is the product: to the recycle bin, nothing refused', async () => {
    const p = await plan('f-p', [main('f-a')])
    expect(p.products).toEqual([{ id: 'f-a', sku: 'TEST-F-A' }])
    expect(p.aliases).toEqual([])
    expect(p.refusals).toEqual([])
    expect(p.familyDeleted).toBe(false)
  })

  it('works from a variation\'s own page too (the family is found from it)', async () => {
    expect((await plan('f-b', [main('f-a')])).products).toEqual([{ id: 'f-a', sku: 'TEST-F-A' }])
  })

  it('an extra listing\'s main row removes that listing only; its colour rows go with it', async () => {
    const p = await plan('f-p', [{ productId: 'f-p', aliasId: 'alias-draft' }, { productId: 'f-a', aliasId: 'alias-draft' }])
    expect(p.aliases).toEqual([{ id: 'alias-draft', label: 'test', channel: 'EBAY', marketplace: 'IT' }])
    expect(p.products).toEqual([])
    expect(p.refusals).toEqual([])
  })

  it('an extra listing\'s colour row alone is refused: it is the Main listing\'s product', async () => {
    const p = await plan('f-p', [{ productId: 'f-a', aliasId: 'alias-draft' }])
    expect(p.aliases).toEqual([])
    expect(p.products).toEqual([])
    expect(p.refusals).toEqual([expect.objectContaining({ sku: 'TEST-F-A', reason: expect.stringContaining('same product as in the Main listing') })])
  })
})

describe('a row still on a channel is refused, with the way out', () => {
  it('a variation with an eBay Item ID', async () => {
    const p = await plan('f-p', [main('f-c'), main('f-a')])
    expect(p.products.map((x) => x.id)).toEqual(['f-a'])
    expect(p.refusals).toEqual([expect.objectContaining({ productId: 'f-c', reason: 'TEST-F-C is still on eBay · IT (Item ID 111). Set its Action to Delete and press Publish first, then delete the row.' })])
  })

  it('a variation sold through an eBay item\'s membership, though its own row holds no id', async () => {
    const p = await plan('f-p', [main('f-d')])
    expect(p.products).toEqual([])
    expect(p.refusals[0]?.reason).toContain('eBay · IT (Item ID 222)')
  })

  it('a live extra listing', async () => {
    const p = await plan('f-p', [{ productId: 'f-p', aliasId: 'alias-live' }])
    expect(p.aliases).toEqual([])
    expect(p.refusals[0]?.reason).toBe('ALT1 is still on eBay · IT, ALT1 (Item ID 333). Set its Action to Delete and press Publish first, then delete the row.')
  })

  it('the family\'s main row, when anything in the family is live — and nothing of it moves', async () => {
    const p = await plan('f-p', [main('f-p'), main('f-a')])
    expect(p.products).toEqual([])
    expect(p.familyDeleted).toBe(false)
    expect(p.refusals).toHaveLength(1)
    expect(p.refusals[0]?.reason).toMatch(/^The family TEST-F-P is still on eBay · IT \(Item ID 111\); eBay · IT \(Item ID 222\); eBay · IT, ALT1 \(Item ID 333\)\./)
  })

  it('the rule: an id or a pending ASIN is on the channel; ended, closed or a bare "published" flag is not', () => {
    const base = { channel: 'EBAY', externalListingId: null, isPublished: false, listingStatus: 'DRAFT', offerClosedAt: null }
    expect(listingStillOnChannel({ ...base, externalListingId: '1' })).toBe(true)
    expect(listingStillOnChannel({ ...base, channel: 'AMAZON', isPublished: true, listingStatus: 'ACTIVE' })).toBe(true)
    expect(listingStillOnChannel({ ...base, externalListingId: '1', listingStatus: 'ENDED' })).toBe(false)
    expect(listingStillOnChannel({ ...base, externalListingId: '1', offerClosedAt: new Date() })).toBe(false)
    expect(listingStillOnChannel({ ...base, isPublished: true, listingStatus: 'NOT_LISTED' })).toBe(false)
  })
})

describe('delete and Undo', () => {
  it('moves exactly what the confirm named, the sheet stops showing it, and Undo puts it back', async () => {
    const rows = [main('f-a'), { productId: 'f-p', aliasId: 'alias-draft' }]
    const before = await plan('f-p', rows)
    const expected = { products: before.products.map((x) => x.id), aliases: before.aliases.map((x) => x.id) }
    const ran = await scoped(() => deleteSheetRows('f-p', rows, expected, 'user-1'))
    expect(ran.deleted).toEqual({ products: 1, aliases: 1 })
    await scoped(async () => {
      expect((await prisma.product.findUnique({ where: { id: 'f-a' } }))?.deletedAt).toBeInstanceOf(Date)
      expect((await prisma.productListingAlias.findUnique({ where: { id: 'alias-draft' } }))?.status).toBe('ARCHIVED')
      // The rest of the family is untouched.
      expect((await prisma.product.findUnique({ where: { id: 'f-b' } }))?.deletedAt).toBeNull()
      expect(await prisma.auditLog.count({ where: { entityId: { in: ['f-a', 'alias-draft'] }, metadata: { path: ['source'], equals: 'product-sheet' } } })).toBe(2)
    })
    // Deleted rows are not in this family any more: a second press is refused, not repeated.
    expect((await plan('f-p', [main('f-a')])).refusals[0]?.reason).toContain('not in this product family')

    const undone = await scoped(() => restoreSheetRows('f-p', expected, 'user-1'))
    expect(undone.restored).toEqual({ products: 1, aliases: 1 })
    await scoped(async () => {
      expect((await prisma.product.findUnique({ where: { id: 'f-a' } }))?.deletedAt).toBeNull()
      expect((await prisma.productListingAlias.findUnique({ where: { id: 'alias-draft' } }))?.status).toBe('ACTIVE')
    })
    // A second Undo finds everything back.
    expect((await scoped(() => restoreSheetRows('f-p', expected, 'user-1'))).restored).toEqual({ products: 0, aliases: 0 })
  })

  it('writes nothing when the rows changed since the confirm', async () => {
    await expect(scoped(() => deleteSheetRows('f-p', [main('f-a'), main('f-b')], { products: ['f-a'], aliases: [] }, null)))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('Nothing was deleted') })
    await scoped(async () => {
      expect(await prisma.product.count({ where: { id: { in: ['f-a', 'f-b'] }, deletedAt: { not: null } } })).toBe(0)
    })
  })

  it('the whole family goes from its main row, extra listings included, and Undo from its own id brings it back', async () => {
    const before = await plan('g-p', [main('g-p')])
    expect(before.familyDeleted).toBe(true)
    expect(before.products.map((x) => x.id)).toEqual(['g-p', 'g-a'])
    const expected = { products: before.products.map((x) => x.id), aliases: [] }
    await scoped(() => deleteSheetRows('g-p', [main('g-p')], expected, null))
    await scoped(async () => {
      expect(await prisma.product.count({ where: { id: { in: ['g-p', 'g-a'] }, deletedAt: { not: null } } })).toBe(2)
      // The extra listing stays as it was: it comes back with its product.
      expect((await prisma.productListingAlias.findUnique({ where: { id: 'alias-g' } }))?.status).toBe('ACTIVE')
    })
    await expect(plan('g-p', [main('g-a')])).rejects.toBeInstanceOf(SheetDeleteError)
    // Undo of a variation alone, while the family's main product is in the bin, is refused.
    await expect(scoped(() => restoreSheetRows('g-p', { products: ['g-a'], aliases: [] }, null))).rejects.toMatchObject({ statusCode: 409 })
    expect((await scoped(() => restoreSheetRows('g-p', expected, null))).restored.products).toBe(2)
  })

  it('refuses another family\'s products and listings', async () => {
    await expect(scoped(() => restoreSheetRows('f-p', { products: ['g-a'], aliases: [] }, null))).rejects.toMatchObject({ statusCode: 409 })
    await expect(scoped(() => restoreSheetRows('f-p', { products: [], aliases: ['alias-g'] }, null))).rejects.toMatchObject({ statusCode: 409 })
    const p = await plan('f-p', [main('g-a'), { productId: 'f-p', aliasId: 'alias-g' }])
    expect(p.products).toEqual([])
    expect(p.aliases).toEqual([])
    expect(p.refusals).toHaveLength(2)
  })
})
