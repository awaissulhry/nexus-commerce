import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const fixture = vi.hoisted(() => {
  const state = { products: [] as any[], images: [] as any[], master: [] as any[], transactions: [] as any[], listings: [] as any[], aliases: [] as any[], seq: 0 }
  const match = (row: any, where: any): boolean => Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
    if (key === 'NOT') return !match(row, value)
    if (value && typeof value === 'object' && 'in' in value) return value.in.includes(row[key])
    return value === undefined || row[key] === value
  })
  const db: any = {
    channelListing: {
      findMany: async ({ where }: any) => structuredClone(state.listings.filter(row => match(row, where))),
      findFirst: async ({ where }: any) => structuredClone(state.listings.find(row => match(row, where)) ?? null),
      updateMany: async ({ where, data }: any) => { const rows = state.listings.filter(row => match(row, where)); for (const row of rows) Object.assign(row, data, { version: row.version + data.version.increment }); return { count: rows.length } },
    },
    productListingAlias: {
      findMany: async ({ where }: any) => structuredClone(state.aliases.filter(row => match(row, where))),
      findFirst: async ({ where }: any) => structuredClone(state.aliases.find(row => match(row, where)) ?? null),
    },
    product: { findFirst: async ({ where }: any) => structuredClone(state.products.find(row => match(row, where)) ?? null),
      update: async ({ where, data }: any) => Object.assign(state.products.find(row => match(row, where)), data) },
    productImage: { findMany: async ({ where }: any) => structuredClone(state.master.filter(row => match(row, where))) },
    listingImage: {
      findMany: async ({ where }: any) => structuredClone(state.images.filter(row => match(row, where))),
      count: async ({ where }: any) => state.images.filter(row => match(row, where)).length,
      update: async ({ where, data }: any) => Object.assign(state.images.find(row => match(row, where)), data),
      create: async ({ data }: any) => { const row = { id: `new-${++state.seq}`, locked: false, ...structuredClone(data) }; state.images.push(row); return row },
      deleteMany: async ({ where }: any) => { state.images = state.images.filter(row => !match(row, where)); return {} },
    },
  }
  db.$transaction = async (fn: any, options: any) => {
    state.transactions.push(options)
    const snapshot = structuredClone({ products: state.products, images: state.images, listings: state.listings })
    try { return await fn(db) } catch (error) { Object.assign(state, snapshot); throw error }
  }
  return { state, db, destination: vi.fn(), axes: vi.fn(), spec: vi.fn() }
})
vi.mock('../../db.js', () => ({ default: fixture.db }))
vi.mock('../../services/pim/workspace-destination.js', async original => ({ ...await original<object>(), resolveWorkspaceDestination: fixture.destination }))
vi.mock('../../services/ebay-family-axes.service.js', () => ({ resolveFamilyAxes: fixture.axes }))
vi.mock('../../services/pim/channel-specs/index.js', () => ({ loadEbaySpec: fixture.spec }))
vi.mock('../../lib/auth/session.js', () => ({ validateSession: vi.fn(), truncateIp: () => 'fixture' }))
vi.mock('../../lib/auth/audit.js', () => ({ writeAuthAudit: vi.fn() }))
vi.mock('../../lib/auth/rbac.js', () => ({ resolvePermissions: async (user: any) => ({ permissions: new Set(user.id === 'editor' ? ['products.view', 'products.images.edit'] : ['products.view']) }), hasPermission: (resolved: any, permission: string) => resolved.permissions.has(permission) }))
import { rbacHook } from '../../lib/auth/rbac-hook.js'
import { WorkspaceScopeError } from '../../services/pim/workspace-destination.js'
import { ebayMediaWorkspaceRoutes } from './ebay-media-workspace.routes'

const url = '/api/products/p/images-workspace/ebay?market=IT&accountId=b&listingId=listing-b'
let app: FastifyInstance
beforeAll(async () => {
  vi.stubEnv('NEXUS_RBAC_MODE', 'enforce')
  app = Fastify()
  app.addHook('onRequest', async request => {
    request.__sessionLoaded = true
    if (request.headers.authorization) request.authUser = { id: request.headers.authorization, permissionsVersion: 1, roleKeys: [] } as any
  })
  app.addHook('preHandler', rbacHook)
  await app.register(ebayMediaWorkspaceRoutes, { prefix: '/api' }); await app.ready()
})
afterAll(async () => { await app.close(); vi.unstubAllEnvs() })
beforeEach(() => {
  vi.clearAllMocks()
  fixture.state.products = [{ id: 'p', deletedAt: null, imageAxisPreference: 'Colour' }]
  fixture.state.master = ['a', 'b', 'c'].map((id, i) => ({ id, productId: 'p', url: `https://images.example/${id}.jpg`, alt: `Image ${id}`, width: 1600, height: 1200, mediaType: 'IMAGE', sortOrder: i }))
  fixture.state.images = [{ id: 'gallery-a', productId: 'p', scope: 'PLATFORM', platform: 'EBAY', marketplace: null, variationId: null, amazonSlot: null,
    mediaType: 'IMAGE', variantGroupKey: null, variantGroupValue: null, position: 0, role: 'MAIN', url: fixture.state.master[0].url, locked: false }]
  fixture.state.transactions = []
  fixture.state.aliases = [{ id: 'alt', productId: 'p', channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'b', label: 'Summer collection', status: 'ACTIVE' }]
  fixture.state.listings = [
    { id: 'primary', productId: 'p', channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'b', aliasKey: '', externalListingId: null, version: 1, platformAttributes: { categoryId: '123', unrelated: 'keep' } },
    { id: 'listing-b', productId: 'p', channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'b', aliasKey: 'alt', externalListingId: '987', version: 1, platformAttributes: { categoryId: '456', unrelated: 'keep' } },
  ]
  fixture.destination.mockImplementation(async (input: any) => {
    const listing = fixture.state.listings.find(l => l.id === input.listingId)
    return { productId: 'p', familyId: 'p', accountId: input.accountId ?? 'b', marketplace: input.marketplace, aliasKey: listing?.aliasKey ?? null,
      listing: listing ? { id: listing.id, productId: 'p', aliasKey: listing.aliasKey, version: listing.version } : null }
  })
  fixture.axes.mockResolvedValue({ axes: [{ name: 'Colour', key: 'color', values: ['Blue', 'Red'] }], warnings: [] })
  fixture.spec.mockResolvedValue({ fields: [] })
})
async function read() { const res = await app.inject({ url, headers: { authorization: 'viewer' } }); expect(res.statusCode, res.body).toBe(200); return res.json() }
async function save(body: any, user = 'editor') { return app.inject({ method: 'PUT', url, headers: { authorization: user }, payload: body }) }

describe('eBay Media registered route and persistence', () => {
  it('permits viewers to inspect, rejects anonymous reads and viewer writes', async () => {
    expect((await app.inject(url)).statusCode).toBe(401)
    const data = await read()
    expect((await save({ expectedRevision: data.revision, draft: data.draft }, 'viewer')).statusCode).toBe(403)
    expect(data.publication.available).toBe(false)
  })
  it('validates the explicit account, market and listing before reading galleries', async () => {
    fixture.destination.mockRejectedValue(new WorkspaceScopeError('Foreign listing'))
    expect((await app.inject({ url, headers: { authorization: 'viewer' } })).statusCode).toBe(409)
    expect(fixture.state.transactions).toEqual([])
    expect(fixture.destination).toHaveBeenCalledWith({ productId: 'p', channel: 'EBAY', marketplace: 'IT', accountId: 'b', listingId: 'listing-b' })
  })
  it('saves and rereads ordering while keeping source images and unrelated assignments', async () => {
    fixture.state.images.push({ ...fixture.state.images[0], id: 'other-market', scope: 'MARKETPLACE', marketplace: 'DE' })
    const before = await read(); before.draft.galleries[0].assetIds = ['product:b', 'product:a']
    const response = await save({ expectedRevision: before.revision, draft: before.draft })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().draft.galleries[0].assetIds).toEqual(['product:b', 'product:a'])
    expect((await read()).draft.galleries[0].assetIds).toEqual(['product:b', 'product:a'])
    expect(fixture.state.master).toHaveLength(3)
    expect(fixture.state.images.find(row => row.id === 'other-market')?.position).toBe(0)
    expect(fixture.state.transactions).toContainEqual(expect.objectContaining({ isolationLevel: 'Serializable' }))
  })
  it('allows reuse in several galleries and preserves them when the active grouping changes', async () => {
    const before = await read()
    before.draft.galleries.push({ axis: 'Colour', value: 'Blue', assetIds: ['product:a', 'product:b'] })
    expect((await save({ expectedRevision: before.revision, draft: before.draft })).statusCode).toBe(200)
    const next = await read(); next.draft.axis = null
    expect((await save({ expectedRevision: next.revision, draft: next.draft })).statusCode).toBe(200)
    expect((await read()).draft.galleries.find((g: any) => g.value === 'Blue').assetIds).toEqual(['product:a', 'product:b'])
  })
  it('rejects a stale snapshot without overwriting another editor’s cover', async () => {
    const before = await read()
    fixture.state.images[0].url = fixture.state.master[2].url
    const response = await save({ expectedRevision: before.revision, draft: before.draft })
    expect(response.statusCode).toBe(409); expect(fixture.state.images[0].url).toContain('/c.jpg')
  })
  it('rejects foreign images and unknown variation values', async () => {
    const before = await read(); before.draft.galleries[0].assetIds.push('product:foreign')
    expect((await save({ expectedRevision: before.revision, draft: before.draft })).statusCode).toBe(422)
    before.draft.galleries[0].assetIds.pop()
    before.draft.galleries.push({ axis: 'Colour', value: 'Made up', assetIds: ['product:a'] })
    expect((await save({ expectedRevision: before.revision, draft: before.draft })).statusCode).toBe(422)
    expect(fixture.state.images).toHaveLength(1)
  })
  it('keeps locked shared assignments intact when a listing creates its own draft', async () => {
    fixture.state.images[0].locked = true
    const before = await read(); before.draft.galleries[0].assetIds = ['product:b']
    expect((await save({ expectedRevision: before.revision, draft: before.draft })).statusCode).toBe(200)
    expect(fixture.state.images).toHaveLength(1); expect(fixture.state.images[0].id).toBe('gallery-a')
    expect(fixture.state.images[0].locked).toBe(true)
  })
  it('does not turn missing axis evidence into invented groups', async () => {
    fixture.axes.mockRejectedValue(new Error('offline'))
    const data = await read(); expect(data.axes).toEqual([]); expect(data.warnings[0]).toContain('could not be verified')
  })
  it('stores a separate draft without relabeling shared publication evidence', async () => {
    fixture.state.images[0].publishStatus = 'PUBLISHED'
    const before = await read(); before.draft.axis = null
    expect((await save({ expectedRevision: before.revision, draft: before.draft })).statusCode).toBe(200)
    expect(fixture.state.images[0].publishStatus).toBe('PUBLISHED')
    expect(fixture.state.products[0].imageAxisPreference).toBe('Colour')
    expect(fixture.state.listings[1].platformAttributes.unrelated).toBe('keep')
    expect(fixture.state.listings[1].platformAttributes._mediaGalleryDraft.axis).toBe(null)
  })
  it('isolates primary, aliases, other accounts and other markets across save and reload', async () => {
    fixture.state.listings.push({ ...fixture.state.listings[0], id: 'other-account', channelConnectionId: 'c' }, { ...fixture.state.listings[0], id: 'other-market', marketplace: 'DE' })
    const untouched = structuredClone(fixture.state.listings.filter(l => l.id !== 'listing-b'))
    const before = await read(); before.draft.galleries[0].assetIds = ['product:b']
    const saved = await save({ expectedRevision: before.revision, draft: before.draft })
    expect(saved.statusCode, saved.body).toBe(200)
    expect(saved.json().destination).toMatchObject({ listingId: 'listing-b', aliasKey: 'alt', inherited: false })
    expect(fixture.state.listings.filter(l => l.id !== 'listing-b')).toEqual(untouched)
    const primary = await app.inject({ url: url.replace('listing-b', 'primary'), headers: { authorization: 'viewer' } })
    expect(primary.json().draft.galleries[0].assetIds).toEqual(['product:a'])
    expect((await read()).draft.galleries[0].assetIds).toEqual(['product:b'])
    expect((await read()).destination.listings.map((l: any) => l.id)).toEqual(['primary', 'listing-b'])
  })
  it('uses dynamic English category labels without renaming stored fields or values', async () => {
    fixture.axes.mockResolvedValue({ axes: [{ name: 'Colore', key: 'color', values: ['Blu', 'Rosso'] }, { name: 'Trama speciale', key: 'custom', values: ['A', 'B'] }], warnings: [] })
    fixture.spec.mockResolvedValue({ fields: [{ label: 'Trama speciale', englishLabel: 'Special weave' }] })
    const before = await read()
    expect(before.axes.map((a: any) => a.label)).toEqual(['Color', 'Special weave'])
    expect(fixture.spec).toHaveBeenCalledWith('IT', ['456'])
    expect(fixture.axes).toHaveBeenCalledWith('p', 'IT', { channelConnectionId: 'b', aliasKey: 'alt' })
    before.draft.axis = 'Colore'; before.draft.galleries.push({ axis: 'Colore', value: 'Blu', assetIds: ['product:a'] })
    expect((await save({ expectedRevision: before.revision, draft: before.draft })).statusCode).toBe(200)
    expect((await read()).draft).toMatchObject({ axis: 'Colore', galleries: expect.arrayContaining([expect.objectContaining({ axis: 'Colore', value: 'Blu' })]) })
  })
  it('refreshes groups for the selected alias and conflicts when variation evidence changes', async () => {
    fixture.axes.mockImplementation(async (_p: string, _m: string, scope: any) => ({ axes: [{ name: scope.aliasKey ? 'Colore' : 'Taglia', key: scope.aliasKey ? 'color' : 'size', values: scope.aliasKey ? ['Blu', 'Rosso'] : ['M', 'L'] }], warnings: [] }))
    const before = await read()
    const primary = await app.inject({ url: url.replace('listing-b', 'primary'), headers: { authorization: 'viewer' } })
    expect(primary.json().axes[0]).toMatchObject({ name: 'Taglia', label: 'Size', values: ['M', 'L'] })
    expect(before.axes[0].label).toBe('Color')
    fixture.axes.mockResolvedValue({ axes: [{ name: 'Colore', key: 'color', values: ['Blu', 'Verde'] }], warnings: [] })
    expect((await save({ expectedRevision: before.revision, draft: before.draft })).statusCode).toBe(409)
    expect((await read()).axes[0].values).toEqual(['Blu', 'Verde'])
  })
  it('never saves into an arbitrary alias when the primary is missing', async () => {
    fixture.state.listings = fixture.state.listings.filter(l => l.aliasKey)
    const unselected = url.replace('&listingId=listing-b', '')
    const before = (await app.inject({ url: unselected, headers: { authorization: 'viewer' } })).json()
    expect(before.destination.listingId).toBe(null)
    expect((await app.inject({ method: 'PUT', url: unselected, headers: { authorization: 'editor' }, payload: { expectedRevision: before.revision, draft: before.draft } })).statusCode).toBe(422)
  })
  it('starts from the selected listing’s own image URLs, including an explicit empty gallery', async () => {
    fixture.state.listings[1].platformAttributes.imageUrls = [fixture.state.master[2].url]
    const before = await read()
    expect(before.draft.galleries[0].assetIds).toEqual(['product:c'])
    fixture.state.listings[1].platformAttributes.imageUrls = []
    expect((await read()).draft.galleries[0].assetIds).toEqual([])
    expect(fixture.state.images).toHaveLength(1)
  })
  it('does not confuse display-name updates with changed gallery identity', async () => {
    const before = await read()
    fixture.spec.mockResolvedValue({ fields: [{ label: 'Colour', englishLabel: 'Color' }] })
    const after = await read()
    expect(after.revision).toBe(before.revision)
    expect(after.draft).toEqual(before.draft)
  })
  it('persists 24 common photos and independent variation photos, preserving the default cover', async () => {
    fixture.state.master = Array.from({ length: 25 }, (_, i) => ({ ...fixture.state.master[0], id: `photo-${i}`, url: `https://images.example/${i}.jpg` }))
    const before = await read()
    before.draft.galleries = [{ axis: null, value: null, assetIds: fixture.state.master.slice(0, 24).map(row => `product:${row.id}`) }, { axis: 'Colour', value: 'Blue', assetIds: ['product:photo-24'] }]
    before.draft.axis = 'Colour'
    const saved = await save({ expectedRevision: before.revision, draft: before.draft })
    expect(saved.statusCode, saved.body).toBe(200)
    const after = await read()
    expect(after.draft.galleries[0].assetIds).toHaveLength(24)
    expect(after.draft.galleries[0].assetIds[0]).toBe('product:photo-0')
    expect(after.draft.galleries[1].assetIds).toEqual(['product:photo-24'])
    after.draft.galleries[1].assetIds = fixture.state.master.slice(0, 13).map(row => `product:${row.id}`)
    expect((await save({ expectedRevision: after.revision, draft: after.draft })).statusCode).toBe(422)
    expect((await read()).draft.galleries[0].assetIds).toEqual(before.draft.galleries[0].assetIds)
  })
  it('rejects malformed saved drafts and cross-listing revisions without overwriting them', async () => {
    const before = await read()
    expect((await app.inject({ method: 'PUT', url: url.replace('listing-b', 'primary'), headers: { authorization: 'editor' }, payload: { expectedRevision: before.revision, draft: before.draft } })).statusCode).toBe(409)
    fixture.state.listings[1].platformAttributes._mediaGalleryDraft = { version: 99 }
    expect((await app.inject({ url, headers: { authorization: 'viewer' } })).statusCode).toBe(422)
    expect(fixture.state.listings[1].platformAttributes._mediaGalleryDraft).toEqual({ version: 99 })
  })
  it('conflicts on concurrent listing metadata edits and preserves those edits', async () => {
    const before = await read()
    fixture.state.listings[1].platformAttributes.unrelated = 'new data'
    fixture.state.listings[1].version++
    expect((await save({ expectedRevision: before.revision, draft: before.draft })).statusCode).toBe(409)
    expect(fixture.state.listings[1].platformAttributes.unrelated).toBe('new data')
  })
})

it.skipIf(process.env.NEXUS_EBAY_MEDIA_BROWSER !== '1')('serves the isolated Media browser fixture', async () => {
  const server = Fastify()
  const port = 4117
  const origin = 'http://localhost:3117'
  fixture.state.products[0] = { ...fixture.state.products[0], sku: 'MEDIA-QA', name: 'Studio bottle · isolated Media fixture', isParent: true, parentId: null, status: 'DRAFT', productType: 'PRODUCT' }
  fixture.state.master = ['Front', 'Side', 'Detail', 'Blue', 'Red', 'Dimensions unknown'].map((label, i) => ({
    id: `image-${i}`, productId: 'p', url: `${origin}/api/fixture/photo/${i}.svg`, alt: label,
    width: i === 5 ? null : 1600, height: i === 5 ? null : 1600, mediaType: 'IMAGE', sortOrder: i,
  }))
  fixture.state.images[0].url = fixture.state.master[0].url
  fixture.state.images.push({ ...fixture.state.images[0], id: 'gallery-side', url: fixture.state.master[1].url, position: 1, role: 'GALLERY' })
  fixture.axes.mockImplementation(async (_p: string, _m: string, scope: any) => ({ axes: [{ name: scope.aliasKey ? 'Colore' : 'Taglia', key: scope.aliasKey ? 'color' : 'size', values: scope.aliasKey ? ['Blu', 'Rosso'] : ['M', 'L'] }], warnings: [] }))
  if (process.env.NEXUS_EBAY_MEDIA_LARGE === '1') {
    const values = ['Blu', 'Rosso', 'Verde', 'Nero', 'Bianco', 'Grigio', ...Array.from({ length: 26 }, (_, i) => `Finitura ${String(i + 1).padStart(2, '0')} · Collezione artigianale`)]
    fixture.state.master = Array.from({ length: 80 }, (_, i) => ({
      id: `image-${i}`, productId: 'p', url: `${origin}/api/fixture/photo/${i}.svg`,
      alt: i < 24 ? `Common ${String(i + 1).padStart(2, '0')}` : `Detail ${String(i - 23).padStart(2, '0')}`,
      width: 1600, height: 1600, mediaType: 'IMAGE', sortOrder: i,
    }))
    const images = (indices: number[]) => indices.map(index => { const a = fixture.state.master[index]; return { url: a.url, label: a.alt, width: a.width, height: a.height } })
    fixture.state.listings[1].platformAttributes._mediaGalleryDraft = { version: 1, axis: 'Colore', galleries: [
      { axis: null, value: null, images: images(Array.from({ length: 24 }, (_, i) => i)) },
      ...values.slice(0, 8).map((value, i) => ({ axis: 'Colore', value, images: images([24 + i * 2, 25 + i * 2]) })),
    ] }
    fixture.state.aliases.push({ ...fixture.state.aliases[0], id: 'winter', label: 'Winter collection' })
    fixture.state.listings.push({ ...fixture.state.listings[1], id: 'listing-winter', aliasKey: 'winter', platformAttributes: { ...fixture.state.listings[1].platformAttributes, _mediaGalleryDraft: { version: 1, axis: 'Colore', galleries: [{ axis: null, value: null, images: images([50]) }] } } })
    fixture.axes.mockImplementation(async (_p: string, _m: string, scope: any) => ({ axes: [{ name: scope.aliasKey ? 'Colore' : 'Taglia', key: scope.aliasKey ? 'color' : 'size', values: scope.aliasKey ? values : ['M', 'L'] }], warnings: [] }))
  }
  server.get('/api/auth/me', async () => ({ user: { id: 'fixture', displayName: 'Media fixture', email: 'fixture@example.test', roleKeys: ['owner'] }, isOwner: true, permissions: ['products.view', 'products.images.edit'] }))
  server.get('/api/products/:id', async () => fixture.state.products[0])
  server.get('/api/products/:id/children', async () => ({ children: [] }))
  server.get('/api/marketplaces/grouped', async () => ({ EBAY: [{ id: 'it', code: 'IT', channel: 'EBAY', name: 'eBay Italy', language: 'it', currency: 'EUR' }, { id: 'de', code: 'DE', channel: 'EBAY', name: 'eBay Germany', language: 'de', currency: 'EUR' }] }))
  server.get('/api/connections', async () => ({ connections: [{ id: 'b', channel: 'EBAY', name: 'Media test account', accountLabel: 'Media test account', isActive: true, isPrimary: true }] }))
  server.get('/api/products/:id/studio/destination', async (request: any) => ({ channel: 'EBAY', ...await fixture.destination({ marketplace: request.query.market, listingId: request.query.listingId, accountId: 'b' }) }))
  server.get('/api/products/:id/studio/sheet', async () => ({ scope: { kind: 'channel', channel: 'EBAY', marketplace: 'IT' }, family: fixture.state.products[0], columns: [], rows: [], aliases: [], meta: { schemaMissing: [], schemaAge: [], droppedKeys: [], tookMs: 0 } }))
  server.get('/api/products/:id/studio/readiness', async () => ({ states: [], marketplaces: [] }))
  server.get('/api/fixture/evidence', async () => ({ images: fixture.state.images, master: fixture.state.master, listings: fixture.state.listings, transactions: fixture.state.transactions }))
  server.post('/api/fixture/conflict', async () => { fixture.state.images[0].locked = !fixture.state.images[0].locked; return { changed: true } })
  server.get('/api/fixture/photo/:id.svg', async (request: any, reply) => {
    const colours = ['#d9e1d5', '#c6d2c4', '#e5e8df', '#91adca', '#d39b91', '#c3c9c5']
    return reply.type('image/svg+xml').send(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1600"><rect width="1600" height="1600" fill="#f5f4f0"/><ellipse cx="800" cy="1375" rx="330" ry="42" fill="#dadbd6"/><rect x="530" y="340" width="540" height="990" rx="135" fill="${colours[Number(request.params.id) % colours.length] ?? colours[0]}" stroke="#5d6b60" stroke-width="8"/><rect x="605" y="235" width="390" height="175" rx="32" fill="#36433d"/><path d="M650 445 L650 1145" stroke="#fff" stroke-opacity=".45" stroke-width="30" stroke-linecap="round"/><text x="800" y="840" text-anchor="middle" fill="#24362a" font-family="sans-serif" font-size="64">STUDIO</text></svg>`)
  })
  await server.register((await import('@fastify/multipart')).default)
  server.post('/api/products/:id/images', async (request: any) => {
    const file = await request.file(); await file.toBuffer()
    const asset = { ...fixture.state.master[0], id: `upload-${++fixture.state.seq}`, alt: file.filename }
    fixture.state.master.push(asset); return asset
  })
  await server.register(ebayMediaWorkspaceRoutes, { prefix: '/api' })
  server.setNotFoundHandler(async request => ({ fixture: true, path: request.url, data: [], items: [], profiles: [], connections: [], alerts: [], notifications: [], count: 0, total: 0 }))
  await server.listen({ host: '127.0.0.1', port })
  console.log(`Isolated Media fixture listening on ${port}`)
  await new Promise(resolve => setTimeout(resolve, 3_600_000))
  await server.close()
}, 3_650_000)
