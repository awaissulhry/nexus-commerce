import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshInTransaction: vi.fn() } }))
const db = vi.hoisted(() => ({ product: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() }, productListingAlias: { updateMany: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  channelListing: { findFirst: vi.fn(), createMany: vi.fn() }, channelConnection: { findUnique: vi.fn(), findMany: vi.fn() }, $queryRawUnsafe: vi.fn(), $transaction: vi.fn() }))
vi.mock('../../db.js', () => ({ default: db }))
vi.mock('./studio-sheet.service.js', () => ({ UnknownProductError: class extends Error {} }))
import { archiveAlias, createAlias, nameListingAlias, updateAlias, validateAliasWriteTargets } from './listing-alias.service.js'

const alias = { id: 'alias-b', productId: 'family', channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'b' }
const target = { productId: 'variant', channel: 'EBAY', marketplace: 'IT', connectionId: 'b', aliasKey: 'alias-b' }
beforeEach(() => {
  vi.resetAllMocks()
  db.product.findUnique.mockResolvedValue({ id: 'family', parentId: null, deletedAt: null, isParent: true, _count: { children: 1 } })
  db.product.findFirst.mockResolvedValue({ id: 'variant', parentId: 'family' })
  db.product.findMany.mockResolvedValue([{ id: 'variant', parentId: 'family' }, { id: 'family', parentId: null }])
  db.productListingAlias.findMany.mockResolvedValue([alias])
  db.productListingAlias.findUnique.mockResolvedValue(alias)
  db.productListingAlias.update.mockResolvedValue(alias)
  db.productListingAlias.findFirst.mockResolvedValue(null)
  db.productListingAlias.create.mockResolvedValue(alias)
  db.channelConnection.findUnique.mockResolvedValue({ id: 'b', channelType: 'EBAY', isActive: true })
  db.channelListing.findFirst.mockResolvedValue(null)
  db.$queryRawUnsafe.mockResolvedValue([{ n: 0 }])
  db.$transaction.mockImplementation(callback => callback(db))
  db.productListingAlias.updateMany.mockResolvedValue({ count: 1 })
})

describe('listing alias ownership', () => {
  it('accepts a variant in the alias family on the exact account and market', async () => {
    await expect(validateAliasWriteTargets([target])).resolves.toBeUndefined()
  })
  it.each([{ productId: 'other' }, { channel: 'AMAZON' }, { marketplace: 'DE' }, { connectionId: 'a' }, { connectionId: null }, { aliasKey: 'missing' }])('refuses an alias from another coordinate: %j', async mismatch => {
    await expect(validateAliasWriteTargets([{ ...target, ...mismatch }])).rejects.toMatchObject({ code: 'LISTING_SCOPE_MISMATCH', statusCode: 409 })
    expect(db.$transaction).not.toHaveBeenCalled()
  })
  it('does not load aliases or products for a primary-listing write', async () => {
    await validateAliasWriteTargets([])
    expect(db.product.findMany).not.toHaveBeenCalled()
    expect(db.productListingAlias.findMany).not.toHaveBeenCalled()
  })
  it('creates a fully inheriting alias family on the named account, including when no primary listing exists', async () => {
    await createAlias({ productId: 'variant', channel: 'EBAY', marketplace: 'IT', accountId: 'b' })
    expect(db.channelConnection.findMany).not.toHaveBeenCalled()
    expect(db.productListingAlias.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ channelConnectionId: 'b', productId: 'family' }) }))
    const rows = db.channelListing.createMany.mock.calls[0][0].data
    expect(rows).toHaveLength(2)
    // Step 7 — every alias row is an inert draft from the one draft rule, exactly as a primary draft.
    for (const row of rows) expect(row).toEqual({ productId: expect.any(String), channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT', region: 'IT', channelConnectionId: 'b',
      aliasKey: 'alias-b', aliasId: 'alias-b', listingStatus: 'DRAFT', isPublished: false, syncPaused: true, externalListingId: null, quantity: null, price: null })
    expect(rows.every((row: object) => !Object.hasOwn(row, 'overrideData'))).toBe(true)
  })

  it('refuses an alias when the channel has no connected account, and writes nothing', async () => {
    db.channelConnection.findMany.mockResolvedValue([])
    await expect(createAlias({ productId: 'variant', channel: 'EBAY', marketplace: 'IT' })).rejects.toThrow('Connect an eBay account')
    expect(db.productListingAlias.create).not.toHaveBeenCalled()
    expect(db.channelListing.createMany).not.toHaveBeenCalled()
  })

  it.each(['rename', 'archive'])('validates the family and account before %s', async operation => {
    const mutate = (productId: string, accountId: string) => operation === 'rename'
      ? updateAlias('alias-b', { label: 'My listing' }, { productId, accountId })
      : archiveAlias('alias-b', { productId, accountId })
    await expect(mutate('other-family', 'b')).rejects.toMatchObject({ code: 'LISTING_SCOPE_MISMATCH' })
    expect(db.productListingAlias.update).not.toHaveBeenCalled()
    db.channelConnection.findUnique.mockResolvedValueOnce({ id: 'a', channelType: 'EBAY', isActive: true })
    await expect(mutate('variant', 'a')).rejects.toMatchObject({ code: 'LISTING_SCOPE_MISMATCH' })
    expect(db.productListingAlias.update).not.toHaveBeenCalled()
    await expect(mutate('variant', 'b')).resolves.toEqual(alias)
    expect(db.productListingAlias.update).toHaveBeenCalledOnce()
  })
})

// 2026-10-01 — an extra listing has its own seller SKU (an eBay file names it by it), unique in the business.
describe('listing SKU', () => {
  it('creates an alias with its SKU, after an archived listing gives that SKU up', async () => {
    db.product.findFirst.mockImplementation(async ({ where }: any) => where.sku ? null : { id: 'variant', parentId: 'family' })
    await createAlias({ productId: 'variant', channel: 'EBAY', marketplace: 'IT', accountId: 'b', label: 'IT-FAM', sku: ' IT-FAM ' })
    expect(db.productListingAlias.updateMany).toHaveBeenCalledWith({ where: { sku: 'IT-FAM', status: 'ARCHIVED' }, data: { sku: null } })
    expect(db.productListingAlias.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ sku: 'IT-FAM', label: 'IT-FAM' }) }))
  })
  it('refuses a listing SKU that is a product SKU in the business, and writes nothing', async () => {
    db.product.findFirst.mockImplementation(async ({ where }: any) => where.sku ? { id: 'p' } : { id: 'variant', parentId: 'family' })
    await expect(createAlias({ productId: 'variant', channel: 'EBAY', marketplace: 'IT', accountId: 'b', sku: 'FAM' })).rejects.toThrow('FAM is already a product SKU in this business')
    expect(db.productListingAlias.create).not.toHaveBeenCalled()
  })
  it('says which SKU is taken when another listing holds it', async () => {
    db.product.findFirst.mockImplementation(async ({ where }: any) => where.sku ? null : { id: 'variant', parentId: 'family' })
    db.productListingAlias.create.mockRejectedValue(Object.assign(new Error('Unique constraint'), { code: 'P2002' }))
    await expect(createAlias({ productId: 'variant', channel: 'EBAY', marketplace: 'IT', accountId: 'b', sku: 'IT-FAM' })).rejects.toThrow('IT-FAM is already the SKU of another listing in this business.')
  })
  it('names a listing only while it has no SKU', async () => {
    db.product.findFirst.mockResolvedValue(null)
    await nameListingAlias('alias-b', 'IT-FAM')
    expect(db.productListingAlias.updateMany).toHaveBeenLastCalledWith({ where: { id: 'alias-b', sku: null, status: 'ACTIVE' }, data: { sku: 'IT-FAM' } })
    db.productListingAlias.updateMany.mockResolvedValue({ count: 0 })
    await expect(nameListingAlias('alias-b', 'IT-FAM')).rejects.toThrow('This listing changed, or already has a SKU.')
  })
})
