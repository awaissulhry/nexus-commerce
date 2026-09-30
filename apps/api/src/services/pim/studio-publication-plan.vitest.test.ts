import { beforeEach, describe, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ destination: vi.fn(), listingRead: vi.fn(), products: vi.fn(), resolve: vi.fn(), excluded: vi.fn(), languages: vi.fn(), closed: vi.fn() }))
vi.mock('../amazon-market-offer.service.js', () => ({ closedMarketSet: m.closed }))
vi.mock('../../db.js', () => ({ default: { product: { findMany: m.products }, channelListing: { findMany: m.listingRead }, productListingAlias: { findUnique: async () => ({ label: 'Summer' }) } } }))
vi.mock('./workspace-destination.js', () => ({ resolveWorkspaceDestination: m.destination, WorkspaceScopeError: class extends Error { constructor(message: string, public statusCode = 409) { super(message) } } }))
vi.mock('../connection-resolver.service.js', () => ({ resolveConnection: async () => ({ displayName: 'Selected account', authStatus: 'connected' }) }))
vi.mock('./variation-excluded.js', () => ({ readExcludedListingIds: m.excluded }))
vi.mock('./mapping/resolve-batch.service.js', () => ({ resolveBatch: m.resolve }))
vi.mock('./market-languages.js', () => ({ marketLanguages: m.languages }))
// A-32 — the primary content language is pinned here, whatever a local .env says.
vi.mock('./content-locale.js', async (importOriginal) => ({ ...(await importOriginal<object>()), PRIMARY_CONTENT_LOCALE: 'it' }))
vi.mock('./publish-review-gate.js', () => ({ resolvePublishContent: async () => [], publishContentIssues: () => [], requireReviewedContent: () => false }))
import { readPublicationFacts, publicationScope, publicationDigest } from './studio-publication-plan.js'
import { permissionForRoute } from '../../lib/auth/permissions-manifest.js'
const scope = { channel: 'AMAZON', marketplace: 'IT', accountId: 'account-b', listingId: 'alias-parent' }
beforeEach(() => {
  vi.clearAllMocks(); m.destination.mockResolvedValue({ familyId: 'parent', accountId: 'account-b', aliasKey: 'summer' })
  m.closed.mockResolvedValue(new Set())
  m.languages.mockResolvedValue(['it', 'en'])
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
it.each(['AMAZON', 'EBAY'])('keeps new-listing offer requirements but does not block existing %s content on price or stock cells', async channel => {
  m.listingRead.mockResolvedValue([{ id: 'alias-parent', productId: 'parent', externalListingId: 'existing' }, { id: 'listing-child', productId: 'child' }, { id: 'listing-excluded', productId: 'excluded' }])
  m.resolve.mockImplementation(async ({ productIds }: any) => ({ products: productIds.map((productId: string) => ({ productId, sku: productId.toUpperCase(), cells: {
    price: { value: null, sourceOwner: { label: 'Pricing' }, errors: ['Missing price'] },
    quantity: { value: -1, sourceOwner: { label: 'Inventory' }, errors: ['Invalid stock'] },
    title: { value: 'Title', errors: ['Review this title'] },
  } })), missingProductIds: [], catalogue: { fields: [] } }))
  const facts = await readPublicationFacts('parent', { ...scope, channel })
  expect(facts.issues.filter(i => i.productId === 'parent').map(i => i.field)).toEqual(['title', 'title'])
  expect(facts.issues.filter(i => i.productId === 'child').map(i => i.field)).toEqual(['price', 'quantity', 'title', 'price', 'quantity', 'title'])
})
it('skips and names a closed Amazon product before resolving its fields, retaining the open child and parent identity', async () => {
  m.closed.mockResolvedValue(new Set(['parent|IT']))
  const facts = await readPublicationFacts('parent', scope)
  expect(facts.products.map(p => p.id)).toEqual(['child'])
  expect(facts.parent.id).toBe('parent')
  expect(facts.listings.some(l => l.productId === 'parent')).toBe(true)
  expect(facts.skipped).toEqual([{ productId: 'parent', sku: 'PARENT', reason: 'Offer closed — not sent' }])
  expect(facts.issues.filter(i => i.severity === 'error')).toEqual([])
  expect(m.resolve.mock.calls.every(([r]) => r.productIds.join(',') === 'child')).toBe(true)
})
it('binds closed-offer changes into the review and does not skip another marketplace or eBay', async () => {
  const before = await readPublicationFacts('parent', scope)
  m.closed.mockResolvedValue(new Set(['child|IT']))
  expect((await readPublicationFacts('parent', scope)).revision).not.toBe(before.revision)
  m.closed.mockResolvedValue(new Set(['child|DE']))
  expect((await readPublicationFacts('parent', scope)).products.map(p => p.id)).toEqual(['parent', 'child'])
  m.closed.mockResolvedValue(new Set(['child|IT']))
  expect((await readPublicationFacts('parent', { ...scope, channel: 'EBAY' })).products.map(p => p.id)).toEqual(['parent', 'child'])
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

it('🔴 A-32 (R-30): a DE listing whose pinned own title is the Italian product text is named, as a warning', async () => {
  m.languages.mockResolvedValue(['de'])
  m.products.mockResolvedValue([{ id: 'child', sku: 'CHILD', parentId: 'parent', name: 'Giacca Italiana' }, { id: 'parent', sku: 'PARENT', isParent: true, name: 'Giacca Italiana' }])
  // The child pins its own title; the parent's listing follows the product (control: not named).
  m.listingRead.mockResolvedValue([{ id: 'alias-parent', productId: 'parent', title: 'Giacca Italiana', followMasterTitle: true },
    { id: 'listing-child', productId: 'child', title: 'Giacca Italiana', followMasterTitle: false }])
  m.excluded.mockResolvedValue(new Set())
  const facts = await readPublicationFacts('child', { ...scope, marketplace: 'DE' })
  expect(facts.issues).toContainEqual(expect.objectContaining({ sku: 'CHILD', field: 'title', severity: 'warning' }))
  expect(facts.issues.filter(i => i.sku === 'PARENT')).toEqual([])
  // Control: the same data on a market that speaks Italian names nothing.
  m.languages.mockResolvedValue(['it'])
  expect((await readPublicationFacts('child', scope)).issues.filter(i => i.field === 'title')).toEqual([])
})

it('🔴 VTR step 0: a variant with NO listing row here is not included — the answer Information shows', async () => {
  // Information and the dock read `!!own && !excluded.has(own.id)` ("No listing record on this coordinate. Tick it to
  // create one as a draft."). Publish used to count the rowless variant IN, and on a live Amazon family that created a listing.
  m.listingRead.mockResolvedValue([{ id: 'alias-parent', productId: 'parent' }, { id: 'listing-excluded', productId: 'excluded' }])
  m.excluded.mockResolvedValue(new Set())
  const facts = await readPublicationFacts('parent', scope)
  expect(facts.products.map(p => p.id)).toEqual(['parent', 'excluded'])
  expect(facts.excluded).toBe(1)
  expect(m.resolve.mock.calls.every(([r]) => r.productIds.join(',') === 'parent,excluded')).toBe(true)
  // Every variant without a row: the family has nothing to publish, and says so.
  m.listingRead.mockResolvedValue([{ id: 'alias-parent', productId: 'parent' }])
  const empty = await readPublicationFacts('parent', scope)
  expect(empty.products.map(p => p.id)).toEqual(['parent'])
  expect(empty.issues).toContainEqual(expect.objectContaining({ severity: 'error', message: 'This family has no included variants to publish.' }))
})

it('VTR step 0: the family root and a single product keep their answer — only a VARIANT needs its own row', async () => {
  m.products.mockResolvedValue([{ id: 'solo', sku: 'SOLO' }])
  m.destination.mockResolvedValue({ familyId: 'solo', accountId: 'account-b', aliasKey: 'summer' })
  m.listingRead.mockResolvedValue([])
  m.excluded.mockResolvedValue(new Set())
  const facts = await readPublicationFacts('solo', scope)
  expect(facts.products.map(p => p.id)).toEqual(['solo'])
  expect(facts.excluded).toBe(0)
})

// Draft listing safety — a still-draft's pause keeps it inert, and Publish is the one action allowed to send it.
const PAUSED = 'Listing sync is paused. Resume sync before sending changes.'
const stillDraft = { listingStatus: 'DRAFT', isPublished: false, externalListingId: null, syncPaused: true }
it('includes a paused still-draft Amazon row in the Publish plan — no refusal, its fields are resolved', async () => {
  m.listingRead.mockResolvedValue([{ id: 'alias-parent', productId: 'parent', ...stillDraft }, { id: 'listing-child', productId: 'child', ...stillDraft }])
  m.excluded.mockResolvedValue(new Set())
  const facts = await readPublicationFacts('parent', scope)
  expect(facts.products.map(p => p.id)).toEqual(['parent', 'child'])
  expect(facts.issues.filter(i => i.severity === 'error')).toEqual([])
  expect(m.resolve.mock.calls.every(([r]) => r.productIds.join(',') === 'parent,child')).toBe(true)
})
it.each([
  ['an operator-paused LIVE row', { listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'LIVE-ITEM', syncPaused: true }],
  ['a paused DRAFT row a creator left published', { ...stillDraft, isPublished: true }],
])('still refuses %s with the same sentence as before', async (_, lock) => {
  m.listingRead.mockResolvedValue([{ id: 'alias-parent', productId: 'parent', ...stillDraft }, { id: 'listing-child', productId: 'child', ...lock }])
  m.excluded.mockResolvedValue(new Set())
  const facts = await readPublicationFacts('parent', scope)
  expect(facts.issues.filter(i => i.severity === 'error')).toEqual([{ severity: 'error', message: PAUSED }])
})
it('still refuses a paused still-draft that is deliberately held — only the pause is lifted for a draft', async () => {
  m.listingRead.mockResolvedValue([{ id: 'alias-parent', productId: 'parent', ...stillDraft, presenceIntent: 'HELD' }, { id: 'listing-child', productId: 'child', ...stillDraft }])
  m.excluded.mockResolvedValue(new Set())
  expect((await readPublicationFacts('parent', scope)).issues).toContainEqual(expect.objectContaining({ severity: 'error', message: expect.stringContaining('deliberately held') }))
})

// P1 (`value-verdict.ts`) — the publish review blocks only what the channel itself would reject, with the channel's rule;
// report 2 I-9, report 5 I-2, report 6 §2a: every cell error used to be a block.
describe('the publish verdict per cell', () => {
  const found = (rule: string, message: string) => ({ rule, message })
  const cells = {
    season: { label: 'Season', value: 'Tutte le stagioni', errors: ['Season contains an unaccepted value. Allowed values: Estate · Inverno · Tutte le stagione.'],
      findings: [found('offList', 'Season contains an unaccepted value. Allowed values: Estate · Inverno · Tutte le stagione.')] },
    title: { label: 'Title', value: 'x'.repeat(94), errors: ['Title exceeds 80 characters (94).'], findings: [found('length', 'Title exceeds 80 characters (94).')] },
    brand: { label: 'Brand', value: null, errors: ["Field 'Brand' is required."], findings: [found('nexus', "Field 'Brand' is required.")] },
    condition: { label: 'Condition', value: null, errors: ["Field 'Condition' is required."], findings: [found('required', "Field 'Condition' is required.")] },
    legacy: { label: 'Legacy', value: 'x', errors: ['A sentence with no finding'] },
  }
  const severities = async (channel: string) => {
    m.resolve.mockImplementation(async ({ productIds }: any) => ({ products: productIds.map((productId: string) => ({ productId, sku: productId.toUpperCase(), cells })), missingProductIds: [], catalogue: {} }))
    m.languages.mockResolvedValue(['it'])
    const facts = await readPublicationFacts('parent', { ...scope, channel })
    return Object.fromEntries(facts.issues.filter(i => i.productId === 'parent').map(i => [i.field, i.severity]))
  }
  it('eBay: an off-list value and a Nexus-only requirement warn; over 80 characters, a channel requirement and an unexplained error block', async () => {
    expect(await severities('EBAY')).toEqual({ season: 'warning', title: 'error', brand: 'warning', condition: 'error', legacy: 'error' })
  })
  it('Amazon: an off-list value blocks (a closed enum); the Nexus-only requirement still warns', async () => {
    expect(await severities('AMAZON')).toMatchObject({ season: 'error', brand: 'warning' })
  })
  it('the message keeps the channel\'s words', async () => {
    m.resolve.mockImplementation(async ({ productIds }: any) => ({ products: productIds.map((productId: string) => ({ productId, sku: productId.toUpperCase(), cells: { title: cells.title } })), missingProductIds: [], catalogue: {} }))
    const facts = await readPublicationFacts('parent', { ...scope, channel: 'EBAY' })
    expect(facts.issues).toContainEqual(expect.objectContaining({ field: 'title', severity: 'error', message: 'Title: Title exceeds 80 characters (94).' }))
  })
})
