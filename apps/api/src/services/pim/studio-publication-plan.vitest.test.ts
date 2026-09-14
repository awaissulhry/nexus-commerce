import { beforeEach, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ destination: vi.fn(), listingRead: vi.fn(), products: vi.fn(), resolve: vi.fn(), excluded: vi.fn() }))
vi.mock('../../db.js', () => ({ default: { product: { findMany: m.products }, channelListing: { findMany: m.listingRead }, productListingAlias: { findUnique: async () => ({ label: 'Summer' }) } } }))
vi.mock('./workspace-destination.js', () => ({ resolveWorkspaceDestination: m.destination, WorkspaceScopeError: class extends Error { constructor(message: string, public statusCode = 409) { super(message) } } }))
vi.mock('../connection-resolver.service.js', () => ({ resolveConnection: async () => ({ displayName: 'Selected account', authStatus: 'connected' }) }))
vi.mock('./variation-excluded.js', () => ({ readExcludedListingIds: m.excluded }))
vi.mock('./mapping/resolve-batch.service.js', () => ({ resolveBatch: m.resolve }))
vi.mock('./market-languages.js', () => ({ marketLanguages: async () => ['it', 'en'] }))
vi.mock('./publish-review-gate.js', () => ({ resolvePublishContent: async () => [], publishContentIssues: () => [], requireReviewedContent: () => false }))
import { readPublicationFacts, publicationScope, publicationDigest } from './studio-publication-plan.js'
import { permissionForRoute } from '../../lib/auth/permissions-manifest.js'
const scope = { channel: 'AMAZON', marketplace: 'IT', accountId: 'account-b', listingId: 'alias-parent' }
beforeEach(() => {
  vi.clearAllMocks(); m.destination.mockResolvedValue({ familyId: 'parent', accountId: 'account-b', aliasKey: 'summer' })
  m.products.mockResolvedValue([{ id: 'child', sku: 'CHILD', parentId: 'parent' }, { id: 'excluded', sku: 'EXCLUDED', parentId: 'parent' }, { id: 'parent', sku: 'PARENT', isParent: true }])
  m.listingRead.mockResolvedValue([{ id: 'alias-parent', productId: 'parent' }, { id: 'listing-child', productId: 'child' }, { id: 'listing-excluded', productId: 'excluded' }])
  m.excluded.mockResolvedValue(new Set(['listing-excluded']))
  m.resolve.mockImplementation(async ({ productIds }: any) => ({ products: productIds.map((productId: string) => ({ productId, sku: productId.toUpperCase(), cells: {} })), missingProductIds: [], catalogue: {} }))
})
it('loads and resolves only the selected account, alias and included family in every configured language', async () => {
  const facts = await readPublicationFacts('child', scope)
  expect(m.destination).toHaveBeenCalledWith({ productId: 'child', ...scope })
  expect(m.listingRead.mock.calls[0][0].where).toMatchObject({ channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'account-b', aliasKey: 'summer' })
  expect(facts.products.map(p => p.id)).toEqual(['parent', 'child']); expect(facts.excluded).toBe(1)
  expect(m.resolve.mock.calls.map(([r]) => r.locale)).toEqual(['it', 'en'])
  expect(m.resolve.mock.calls.every(([r]) => r.channelConnectionId === 'account-b' && r.aliasKey === 'summer' && r.productIds.join(',') === 'parent,child')).toBe(true)
})
it('makes changed mapping results invalidate the reviewed saved revision', async () => {
  const before = await readPublicationFacts('parent', scope)
  m.resolve.mockResolvedValue({ products: [{ productId: 'child', sku: 'CHILD', cells: { title: { value: 'Changed mapping', errors: ['Needs review'] } } }], missingProductIds: [], catalogue: {} })
  const after = await readPublicationFacts('parent', scope)
  expect(after.revision).not.toBe(before.revision)
  expect(after.issues).toContainEqual(expect.objectContaining({ sku: 'CHILD', field: 'title', severity: 'error' }))
})
it('preserves the saved revision when PostgreSQL JSON storage reorders scope keys', async () => {
  const before = await readPublicationFacts('parent', scope)
  const storedScope = { channel: scope.channel, accountId: scope.accountId, listingId: scope.listingId, marketplace: scope.marketplace }
  expect(Object.keys(storedScope)).not.toEqual(Object.keys(scope))
  expect((await readPublicationFacts('parent', storedScope)).revision).toBe(before.revision)
})
it('ignores object key order while retaining value, array-order and date changes in publication revisions', () => {
  const before = { price: 99, content: { bullets: ['First', 'Second'], date: new Date('2026-01-01') } }
  const stored = { content: { date: '2026-01-01T00:00:00.000Z', bullets: ['First', 'Second'] }, price: 99 }
  expect(publicationDigest(stored)).toBe(publicationDigest(before))
  expect(publicationDigest({ ...stored, price: 100 })).not.toBe(publicationDigest(before))
  expect(publicationDigest({ ...stored, content: { ...stored.content, bullets: ['Second', 'First'] } })).not.toBe(publicationDigest(before))
  expect(publicationDigest({ ...stored, content: { ...stored.content, date: '2026-01-02T00:00:00.000Z' } })).not.toBe(publicationDigest(before))
})
it('rejects incomplete and malformed publication coordinates', () => {
  for (const input of [null, {}, { ...scope, accountId: '' }, { ...scope, listingId: {} }]) expect(() => publicationScope(input)).toThrow()
  expect(publicationScope({ ...scope, channel: 'amazon', marketplace: 'it' })).toEqual(scope)
})
it('requires publish permission for every publication route, independently of product edit access', () => {
  for (const [method, path] of [['POST', '/api/products/:id/studio-publication/preview'], ['POST', '/api/products/:id/studio-publication/:reviewId/submit'], ['GET', '/api/products/:id/studio-publication/:reviewId']]) {
    expect(permissionForRoute(method, path)).toBe('products.publish')
  }
})
