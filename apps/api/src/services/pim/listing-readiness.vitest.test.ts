import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../db.js', () => ({ default: {
  product: { count: vi.fn(), findMany: vi.fn() }, channelListing: { count: vi.fn(), findMany: vi.fn() },
  marketplace: { findMany: vi.fn() }, bulkOperation: { findFirst: vi.fn() }, importJobRow: { findMany: vi.fn() },
} }))
vi.mock('./mapping/resolve-batch.service.js', () => ({ resolveBatch: vi.fn() }))
import prisma from '../../db.js'
import { resolveBatch, type ResolvedProduct } from './mapping/resolve-batch.service.js'
import { listingReadiness, preparationIssues, readinessQuery } from './listing-readiness.service.js'

const listing = (id: string, productId: string, accountId = 'a', aliasKey = '', marketplace = 'IT') => ({
  id, productId, channel: 'AMAZON', marketplace, channelConnectionId: accountId, aliasKey, version: 1,
  listingStatus: 'ACTIVE', lastSyncedAt: new Date('2026-09-01'),
  product: { id: productId, sku: productId, name: 'Jacket', version: 1 },
  channelConnection: { channelType: 'AMAZON', isActive: true, marketplace: null, accountLabel: accountId, displayName: accountId },
})
const resolved = (id = 'p1') => ({ productId: id, sku: id, name: 'Jacket', category: { channelCategoryId: 'COAT' }, cells: { title: cell('Jacket') },
  readiness: { state: 'locally-valid', schemaValidation: 'evaluated', channelValidation: 'not-checked' },
  validationContext: { schema: { version: 'v1', fetchedAt: '2026-09-01' } },
} as unknown as ResolvedProduct)
const cell = (value: unknown, overrides = {}) => ({ fieldKey: 'title', label: 'Title', value, errors: [] as string[], warnings: [] as string[], required: true, ...overrides })
let listings: ReturnType<typeof listing>[]
beforeEach(() => {
  vi.resetAllMocks(); listings = [listing('l1', 'p1')]
  vi.mocked(prisma.product.count).mockResolvedValue(1)
  vi.mocked(prisma.product.findMany).mockResolvedValue([])
  vi.mocked(prisma.channelListing.count).mockResolvedValue(1)
  vi.mocked(prisma.channelListing.findMany).mockImplementation((async () => listings) as never)
  vi.mocked(prisma.marketplace.findMany).mockResolvedValue(['IT', 'DE'].map(code => ({ channel: 'AMAZON', code, language: code.toLowerCase(), languages: [code.toLowerCase()] })) as never)
  vi.mocked(resolveBatch).mockImplementation(async input => ({ channel: input.channel, marketplace: input.marketplace, locale: input.marketplace === 'IT' ? 'it' : 'de', catalogue: null, missingProductIds: [], products: input.productIds.map(id => resolved(id)) }))
})
describe('listing preparation review', () => {
  it('batches products while keeping seller accounts, aliases and markets independent', async () => {
    listings = [listing('l1', 'p1'), listing('l2', 'p2'), listing('l3', 'p1', 'b'), listing('l4', 'p1', 'a', 'alternate'), listing('l5', 'p1', 'a', '', 'DE')]
    const page = await listingReadiness({ familyId: 'jackets' }, null)
    expect(resolveBatch).toHaveBeenCalledTimes(4)
    expect(resolveBatch).toHaveBeenCalledWith(expect.objectContaining({ productIds: ['p1', 'p2'], channelConnectionId: 'a', aliasKey: '', marketplace: 'IT', includeCatalogue: false }))
    expect(page.rows.map(r => [r.accountId, r.aliasKey, r.locale])).toEqual([['a', '', 'it'], ['a', '', 'it'], ['b', '', 'it'], ['a', 'alternate', 'it'], ['a', '', 'de']])
    expect(new URL(page.rows[2].editorHref, 'http://nexus.test').searchParams.get('listing')).toBe('l3')
    expect(new URL(page.rows[2].editorHref, 'http://nexus.test').searchParams.get('account')).toBe('b')
    expect(page.rows[0].state).toBe('checks-passed')
    expect(page.rows[0]).not.toHaveProperty('live')
  })
  it('bounds listing work and includes unmatched coverage independently of page totals', async () => {
    vi.mocked(prisma.product.count).mockResolvedValueOnce(32).mockResolvedValueOnce(7)
    vi.mocked(prisma.product.findMany).mockResolvedValue([{ id: 'p9', sku: 'NO-DRAFT' }] as never)
    vi.mocked(prisma.channelListing.count).mockResolvedValue(125)
    const page = await listingReadiness({ familyId: 'f', accountId: 'b', marketplace: 'de', page: '3' }, null)
    expect(prisma.channelListing.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 25, skip: 50, where: expect.objectContaining({ channelConnectionId: 'b', marketplace: 'DE', product: expect.objectContaining({ deletedAt: null }) }) }))
    expect(page).toMatchObject({ total: 125, productCount: 32, withoutListing: { total: 7, sample: [{ id: 'p9', sku: 'NO-DRAFT' }] } })
  })
  it('refuses inactive or unattributed destinations without falling back to a primary account', async () => {
    listings[0].channelConnection.isActive = false
    const result = await listingReadiness({ productIds: 'p1' }, null)
    expect(resolveBatch).not.toHaveBeenCalled()
    expect(result.rows[0]).toMatchObject({ state: 'unavailable', issues: [expect.objectContaining({ kind: 'account' })] })
  })
  it('retains other destination results when a resolver fails', async () => {
    listings.push(listing('l2', 'p1', 'b'))
    vi.mocked(resolveBatch).mockRejectedValueOnce(new Error('provider unavailable'))
    const result = await listingReadiness({ productIds: 'p1' }, null)
    expect(result.rows.map(r => r.state)).toEqual(['unavailable', 'checks-passed'])
  })
  it('never turns a missing resolver result or a changed listing green', async () => {
    vi.mocked(resolveBatch).mockResolvedValueOnce({ products: [], missingProductIds: ['p1'], locale: 'it' } as never)
    expect((await listingReadiness({ productIds: 'p1' }, null)).rows[0].state).toBe('unavailable')
    vi.mocked(prisma.channelListing.findMany).mockResolvedValueOnce(listings as never).mockResolvedValueOnce([{ ...listings[0], version: 2 }] as never)
    const next = await listingReadiness({ productIds: 'p1' }, null)
    expect(next.rows[0]).toMatchObject({ state: 'unavailable', issues: [expect.objectContaining({ label: 'Changed during check' })] })
  })
  it('checks job ownership before loading saved identities and includes only saved records', async () => {
    vi.mocked(prisma.bulkOperation.findFirst).mockResolvedValueOnce(null)
    await expect(listingReadiness({ job: 'someone-elses-job' }, 'viewer')).rejects.toThrow('not found')
    expect(prisma.bulkOperation.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'someone-elses-job', userId: 'viewer' } }))
    expect(prisma.importJobRow.findMany).not.toHaveBeenCalled()
    vi.mocked(prisma.bulkOperation.findFirst).mockResolvedValue({ status: 'PARTIAL', changes: { kind: 'catalog-transfer-v2' } } as never)
    vi.mocked(prisma.importJobRow.findMany).mockResolvedValue([{ targetId: '["Products","GALE"]' }, { targetId: '["Listings","GALE","AMAZON","a","IT",""]' }] as never)
    await listingReadiness({ job: 'owned' }, 'viewer')
    expect(prisma.importJobRow.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { jobId: 'owned', status: 'SUCCESS' }, select: { targetId: true }, take: 50001 }))
    expect(prisma.product.count).toHaveBeenCalledWith({ where: { deletedAt: null, sku: { in: ['GALE'] } } })
  })
  it('an import with no saved products remains an empty selection', async () => {
    vi.mocked(prisma.bulkOperation.findFirst).mockResolvedValue({ status: 'FAILED', changes: { kind: 'catalog-transfer-v2' } } as never)
    vi.mocked(prisma.importJobRow.findMany).mockResolvedValue([])
    await listingReadiness({ job: 'empty' }, 'viewer')
    expect(prisma.product.count).toHaveBeenCalledWith({ where: { deletedAt: null, sku: { in: [] } } })
  })
  it('reports missing selected products instead of silently reducing the selection', async () => {
    expect((await listingReadiness({ productIds: 'p1,missing,missing' }, null)).missingSelectionCount).toBe(1)
  })
  it('keeps an explicit listing selection out of other accounts and reports missing listing IDs', async () => {
    const result = await listingReadiness({ listingIds: 'l1,missing' }, null)
    expect(prisma.channelListing.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { in: ['l1', 'missing'] } }) }))
    expect(result.missingSelectionCount).toBe(1)
    expect(prisma.product.count).toHaveBeenCalledWith({ where: { AND: [expect.objectContaining({ channelListings: { some: { id: { in: ['l1', 'missing'] } } } }), expect.any(Object)] } })
  })
  it('separates missing facts, bad values, translations and warnings without losing zero or false', () => {
    const product = resolved()
    product.cells = { missing: cell(null, { errors: ['Required'] }), zero: cell(0), boolean: cell(false), title: cell('Italian', { errors: ['Too long'], needsTranslation: true, warnings: ['Review spelling'] }) } as never
    expect(preparationIssues(product).map(i => i.kind)).toEqual(['missing', 'invalid', 'translation', 'warning'])
    product.readiness = undefined
    expect(preparationIssues(product)[0].kind).toBe('schema')
    product.cells = {}; product.readiness = { ...resolved().readiness!, state: 'blocked' }
    expect(preparationIssues(product)[0].kind).toBe('check')
  })
  it('preserves SKU commas and leading zeroes and refuses malformed SKU lists', () => {
    expect(readinessQuery({ skus: '["0001","JACKET, BLUE"]' }).skus).toEqual(['0001', 'JACKET, BLUE'])
    expect(readinessQuery({ skus: 'JACKET, BLUE' }).skus).toEqual(['JACKET, BLUE'])
    expect(() => readinessQuery({ skus: '[1,null]' })).toThrow()
    expect(() => readinessQuery({ skus: '[]' })).toThrow()
  })
  it.each(['SHOPIFY', 'ETSY'])('accepts %s store-wide preparation checks', channel => {
    expect(readinessQuery({ familyId: 'f', channel, marketplace: 'GLOBAL' })).toMatchObject({ channel, marketplace: 'GLOBAL' })
  })
  it.each([{ familyId: 'f', productIds: 'p' }, {}, { productIds: 'p,,q' }, { familyId: 'f', page: '-1' }, { familyId: 'f', page: [] }, { familyId: 'f', channel: 'UNKNOWN' }, { skus: Array(201).fill('s') }])('refuses ambiguous or unbounded input %j', input => {
    expect(() => readinessQuery(input)).toThrow()
  })
})
