import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshInTransaction: vi.fn() } }))
const db = vi.hoisted(() => ({ product: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() }, productListingAlias: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  channelListing: { findFirst: vi.fn(), createMany: vi.fn() }, channelConnection: { findUnique: vi.fn(), findMany: vi.fn() }, $queryRawUnsafe: vi.fn(), $transaction: vi.fn() }))
vi.mock('../../db.js', () => ({ default: db }))
vi.mock('./studio-sheet.service.js', () => ({ UnknownProductError: class extends Error {} }))
import { archiveAlias, createAlias, updateAlias, validateAliasWriteTargets } from './listing-alias.service.js'

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
    expect(db.channelListing.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { productId: 'family', channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'b', aliasKey: '' } }))
    expect(db.productListingAlias.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ channelConnectionId: 'b', productId: 'family' }) }))
    const rows = db.channelListing.createMany.mock.calls[0][0].data
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row).toMatchObject({ channelConnectionId: 'b', aliasKey: 'alias-b', aliasId: 'alias-b', isPublished: false, listingStatus: 'DRAFT' })
    expect(rows.every((row: object) => !Object.hasOwn(row, 'overrideData'))).toBe(true)
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
