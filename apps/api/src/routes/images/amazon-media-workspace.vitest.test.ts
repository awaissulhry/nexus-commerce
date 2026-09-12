import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import JSZip from 'jszip'
import sharp from 'sharp'

const fixture = vi.hoisted(() => {
  const state = { products: [] as any[], listings: [] as any[], aliases: [] as any[], assets: [] as any[], runs: [] as any[], seq: 0 }
  const match = (row: any, where: any): boolean => Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
    if (key === 'OR') return value.some((v: any) => match(row, v))
    if (key === 'AND') return value.every((v: any) => match(row, v))
    if (key === 'product') return match(state.products.find(p => p.id === row.productId), value)
    if (value instanceof Date) return row[key] instanceof Date && row[key].getTime() === value.getTime()
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('in' in value) return value.in.includes(row[key])
      if ('lt' in value) return row[key] < value.lt
      if ('gt' in value) return row[key] > value.gt
    }
    return row?.[key] === value
  })
  const attach = (row: any) => row ? structuredClone({ ...row, product: state.products.find(p => p.id === row.productId) }) : null
  const market = (code: string) => ({ id: code, code, channel: 'AMAZON', name: `Amazon ${code}`, marketplaceId: `${code}-ID`, region: 'EU', language: code.toLowerCase(), currency: 'EUR', isActive: true })
  const markets = [market('IT'), market('DE')]
  const db: any = {
    product: { findFirst: async ({ where }: any) => structuredClone(state.products.find(p => match(p, where)) ?? null), findUnique: async ({ where }: any) => structuredClone(state.products.find(p => match(p, where)) ?? null) },
    channelListing: {
      findUnique: async ({ where }: any) => attach(state.listings.find(l => match(l, where))),
      findUniqueOrThrow: async ({ where }: any) => { const row = state.listings.find(l => match(l, where)); if (!row) throw new Error('Missing listing'); return attach(row) },
      findFirst: async ({ where }: any) => attach(state.listings.find(l => match(l, where))),
      findMany: async ({ where, take }: any) => state.listings.filter(l => match(l, where)).slice(0, take).map(attach),
      updateMany: async ({ where, data }: any) => { const rows = state.listings.filter(l => match(l, where)); for (const row of rows) Object.assign(row, data, { version: row.version + data.version.increment }); return { count: rows.length } },
    },
    productImage: { findMany: async ({ where }: any) => structuredClone(state.assets.filter(a => match(a, where))) },
    productListingAlias: {
      findMany: async ({ where }: any) => structuredClone(state.aliases.filter(a => match(a, where))),
      findFirst: async ({ where }: any) => structuredClone(state.aliases.find(a => match(a, where)) ?? null),
    },
    marketplace: { findFirst: async ({ where }: any) => markets.find(m => match(m, where)), findMany: async () => markets },
    amazonMediaRun: {
      create: async ({ data }: any) => { const row = { id: `run-${++state.seq}`, createdAt: new Date(), updatedAt: new Date(), ...structuredClone(data) }; state.runs.push(row); return structuredClone(row) },
      findFirst: async ({ where }: any) => structuredClone(state.runs.find(r => match(r, where)) ?? null),
      findUnique: async ({ where }: any) => structuredClone(state.runs.find(r => match(r, where)) ?? null),
      findMany: async ({ where, take }: any) => structuredClone(state.runs.filter(r => match(r, where)).slice(0, take)),
      update: async ({ where, data }: any) => { const row = state.runs.find(r => match(r, where)); Object.assign(row, structuredClone(data), { updatedAt: new Date() }); return structuredClone(row) },
      updateMany: async ({ where, data }: any) => { const rows = state.runs.filter(r => match(r, where)); for (const row of rows) Object.assign(row, structuredClone(data), { updatedAt: new Date() }); return { count: rows.length } },
    },
  }
  db.$transaction = async (fn: any) => {
    const before = structuredClone(state)
    try { return await fn(db) } catch (e) { Object.assign(state, before); throw e }
  }
  return { state, db, observe: vi.fn(), patch: vi.fn(), client: vi.fn(), download: vi.fn(), match }
})

it.skipIf(process.env.NEXUS_AMAZON_MEDIA_BROWSER !== '1')('serves an isolated Amazon Media browser fixture', async () => {
  const server = Fastify()
  const origin = 'http://localhost:3118'
  fixture.state.assets = Array.from({ length: 24 }, (_, i) => ({ id: `image-${i}`, productId: 'p', url: `${origin}/api/fixture/photo/${i}.svg`, alt: i === 1 ? 'Size chart · Italiano' : i === 2 ? 'Size chart · Deutsch' : `Bottle photo ${i + 1}`, width: 1600, height: 1600, mediaType: 'IMAGE', sortOrder: i }))
  const stored = (language: string) => ({ version: 1, draft: { common: { PT01: { assetId: language === 'de' ? 'product:image-2' : 'product:image-1', language }, PS01: { assetId: language === 'de' ? 'product:image-2' : 'product:image-1', language }, PS02: { assetId: 'product:image-3', language: 'zxx' } }, items: {
    [`${language}-blue`]: { MAIN: { assetId: 'product:image-3', language: 'zxx' } }, [`${language}-red`]: { MAIN: { assetId: 'product:image-4', language: 'zxx' } },
  } }, assets: [] })
  fixture.state.listings.find(l => l.id === 'it-p').platformAttributes._amazonMediaWorkspace = stored('it')
  fixture.state.listings.find(l => l.id === 'de-p').platformAttributes._amazonMediaWorkspace = stored('de')
  fixture.state.products[0].id = 'p'
  Object.assign(fixture.state.products[0], { version: 1, brand: 'Studio', description: 'Isolated Amazon image fixture', categoryAttributes: {}, variantsCount: 2, amazonAsin: 'ASIN-p' })
  server.get('/api/auth/me', async () => ({ user: { id: 'editor', displayName: 'Amazon Media fixture', email: 'fixture@example.test', roleKeys: ['owner'] }, isOwner: true, permissions: ['products.view', 'products.images.edit'] }))
  server.get('/api/products/:id', async (request: any) => fixture.state.products.find(p => p.id === request.params.id))
  server.get('/api/products/:id/children', async () => ({ children: fixture.state.products.filter(p => p.parentId === 'p') }))
  server.get('/api/marketplaces/grouped', async () => ({ AMAZON: ['IT', 'DE'].map(code => ({ id: code, code, channel: 'AMAZON', name: `Amazon ${code}`, language: code.toLowerCase(), currency: 'EUR' })) }))
  server.get('/api/connections', async () => ({ connections: [{ id: 'account-a', channel: 'AMAZON', name: 'Media test seller', accountLabel: 'Media test seller', isActive: true, isPrimary: true }] }))
  server.get('/api/products/:id/studio/destination', async (request: any) => amazonMediaDestination({ productId: request.params.id, market: request.query.market, listingId: request.query.listingId, accountId: request.query.accountId ?? 'account-a' }))
  server.get('/api/products/:id/studio/sheet', async () => ({ scope: { kind: 'channel', channel: 'AMAZON', marketplace: 'IT' }, family: fixture.state.products[0], columns: [], rows: [], aliases: [], meta: { schemaMissing: [], schemaAge: [], droppedKeys: [], tookMs: 0 } }))
  server.get('/api/products/:id/studio/readiness', async () => ({ states: [], marketplaces: [] }))
  server.get('/api/fixture/evidence', async () => ({ listings: fixture.state.listings, runs: fixture.state.runs, calls: fixture.patch.mock.calls }))
  server.get('/api/fixture/photo/:id.svg', async (request: any, reply) => {
    const colours = ['#d9e1d5', '#c6d2c4', '#e5e8df', '#91adca', '#d39b91', '#c3c9c5']
    const number = Number(request.params.id)
    const chart = number === 1 || number === 2
    return reply.type('image/svg+xml').send(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1600"><rect width="1600" height="1600" fill="#f5f4f0"/>${chart ? `<text x="800" y="370" text-anchor="middle" fill="#24362a" font-family="sans-serif" font-size="80">${number === 1 ? 'GUIDA ALLE MISURE' : 'GRÖSSENTABELLE'}</text><path d="M250 600 H1350 M250 830 H1350 M250 1060 H1350 M800 550 V1250" stroke="#aeb9ae" stroke-width="4"/><text x="500" y="760" text-anchor="middle" fill="#24362a" font-family="sans-serif" font-size="90">500 ml</text><text x="1060" y="760" text-anchor="middle" fill="#24362a" font-family="sans-serif" font-size="90">24 cm</text>` : `<ellipse cx="800" cy="1375" rx="330" ry="42" fill="#dadbd6"/><rect x="530" y="340" width="540" height="990" rx="135" fill="${colours[number % colours.length]}" stroke="#5d6b60" stroke-width="8"/><rect x="605" y="235" width="390" height="175" rx="32" fill="#36433d"/><path d="M650 445 L650 1145" stroke="#fff" stroke-opacity=".45" stroke-width="30" stroke-linecap="round"/><text x="800" y="840" text-anchor="middle" fill="#24362a" font-family="sans-serif" font-size="64">STUDIO</text>`}</svg>`)
  })
  await server.register((await import('@fastify/multipart')).default)
  server.post('/api/products/:id/images', async (request: any) => { const file = await request.file(); await file.toBuffer(); const asset = { ...fixture.state.assets[0], id: `upload-${++fixture.state.seq}`, alt: file.filename }; fixture.state.assets.push(asset); return asset })
  await server.register(amazonMediaWorkspaceRoutes, { prefix: '/api' })
  server.setNotFoundHandler(async request => ({ fixture: true, path: request.url, data: [], items: [], profiles: [], connections: [], alerts: [], notifications: [], count: 0, total: 0 }))
  await server.listen({ host: '127.0.0.1', port: 4118 })
  console.log('Isolated Amazon Media fixture listening on 4118')
  await new Promise(resolve => setTimeout(resolve, 3_600_000))
  await server.close()
}, 3_650_000)
vi.mock('../../db.js', () => ({ default: fixture.db }))
vi.mock('../../services/connection-resolver.service.js', () => ({ resolveChannelConnectionId: async (_channel: string, id: string) => { if (!['account-a', 'account-b'].includes(id)) throw new Error('Invalid account'); return id } }))
vi.mock('../../services/images/amazon-media-client.js', async original => ({ ...await original<object>(), amazonMediaClient: fixture.client }))
vi.mock('../../services/pim/catalog-source-fetch.js', () => ({ fetchCatalogSource: fixture.download }))
vi.mock('../../lib/auth/session.js', () => ({ validateSession: vi.fn(), truncateIp: () => 'fixture' }))
vi.mock('../../lib/auth/audit.js', () => ({ writeAuthAudit: vi.fn() }))
vi.mock('../../lib/auth/rbac.js', () => ({ resolvePermissions: async (user: any) => ({ permissions: new Set(user.id === 'editor' ? ['products.view', 'products.images.edit'] : ['products.view']) }), hasPermission: (resolved: any, permission: string) => resolved.permissions.has(permission) }))
import { rbacHook } from '../../lib/auth/rbac-hook.js'
import { amazonMediaWorkspaceRoutes } from './amazon-media-workspace.routes'
import { amazonMediaDestination, readAmazonMedia, saveAmazonMedia, refreshAmazonMedia, copyAmazonMarketGallery } from '../../services/images/amazon-media-workspace.service'
import { approveAmazonMediaRun, createAmazonMediaReview, processAmazonMediaRun, readAmazonMediaRun, processPendingAmazonMediaRuns } from '../../services/images/amazon-media-publish.service'

const headers = { authorization: 'editor' }
const base = '/api/products/p/images-workspace/amazon'
const url = `${base}?market=IT&accountId=account-a&listingId=it-p`
let app: FastifyInstance
beforeAll(async () => {
  vi.stubEnv('NEXUS_RBAC_MODE', 'enforce')
  app = Fastify()
  app.addHook('onRequest', async request => { request.__sessionLoaded = true; if (request.headers.authorization) request.authUser = { id: request.headers.authorization, permissionsVersion: 1, roleKeys: [] } as any })
  app.addHook('preHandler', rbacHook)
  await app.register(amazonMediaWorkspaceRoutes, { prefix: '/api' }); await app.ready()
})
afterAll(async () => { await app.close(); vi.unstubAllEnvs() })
beforeEach(() => {
  vi.clearAllMocks()
  fixture.state.seq = 0; fixture.state.runs = []
  fixture.state.products = [
    { id: 'p', sku: 'BOTTLE', name: 'Studio bottle', parentId: null, isParent: true, deletedAt: null, productType: 'BOTTLE', variantAttributes: {} },
    ...['blue', 'red'].map(id => ({ id, sku: `BOTTLE-${id.toUpperCase()}`, name: `Bottle · ${id}`, parentId: 'p', isParent: false, deletedAt: null, productType: 'BOTTLE', variantAttributes: { color: id, capacity: '500 ml' } })),
  ]
  fixture.state.assets = ['photo', 'chart-it', 'chart-de', 'detail'].map((id, index) => ({ id, productId: 'p', url: `https://cdn.example/${id}.jpg`, alt: id, width: 1600, height: 1600, mediaType: 'IMAGE', sortOrder: index }))
  fixture.state.aliases = [{ id: 'summer', productId: 'p', channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'account-a', status: 'ACTIVE', label: 'Summer collection', position: 0 }]
  fixture.state.listings = ['IT', 'DE'].flatMap(market => fixture.state.products.map(p => ({
    id: `${market.toLowerCase()}-${p.id}`, productId: p.id, channel: 'AMAZON', marketplace: market, channelConnectionId: 'account-a', aliasKey: '', version: 1,
    externalListingId: `ASIN-${p.id}`, platformProductId: null, platformAttributes: { untouched: true, attributes: { variation_theme: [{ name: 'COLOR/CAPACITY' }], color: [{ value: p.id }], capacity: [{ value: '500 ml' }] } }, variationTheme: 'COLOR/CAPACITY', flatFileSnapshot: null,
  })))
  fixture.state.listings.push({ ...structuredClone(fixture.state.listings[0]), id: 'summer-p', aliasKey: 'summer', platformAttributes: { sellerSku: 'SUMMER-P', untouched: true } })
  fixture.state.listings.push({ ...structuredClone(fixture.state.listings[1]), id: 'summer-blue', aliasKey: 'summer', platformAttributes: { sellerSku: 'SUMMER-BLUE', untouched: true } })
  fixture.state.listings.push({ ...structuredClone(fixture.state.listings[0]), id: 'other-account', channelConnectionId: 'account-b' })
  fixture.observe.mockImplementation(async (item: any) => ({ checkedAt: new Date().toISOString(), error: null, asin: item.asin, productType: 'BOTTLE', theme: 'COLOR/CAPACITY', attributes: { color: item.productId, capacity: '500 ml' },
    slots: { MAIN: 'https://cdn.example/old.jpg', PT01: 'https://cdn.example/extra.jpg' }, catalog: [], catalogError: null, supported: ['MAIN', 'PT01', 'PT02', 'SWCH'], issues: [] }))
  fixture.patch.mockImplementation(async (_sku, _type, _patches, preview) => ({ status: preview ? 'VALID' : 'ACCEPTED', submissionId: 'submission-1', issues: [] }))
  fixture.client.mockResolvedValue({ observe: fixture.observe, patch: fixture.patch, marketplaceId: 'IT-ID', sellerId: 'seller-a' })
})
const destination = (market = 'IT', listingId = `${market.toLowerCase()}-p`, accountId = 'account-a') => amazonMediaDestination({ productId: 'p', market, listingId, accountId })
describe('PS images and Seller Central export', () => {
  async function safetyDraft() {
    fixture.state.listings.find(l => l.id === 'it-blue').externalListingId = 'B000000001'
    fixture.state.listings.find(l => l.id === 'it-red').externalListingId = 'B000000002'
    const d = await destination(); const w = await readAmazonMedia(d)
    const saved = await saveAmazonMedia(d, w.revision, { common: { PS01: { assetId: 'product:chart-it', language: 'it' } }, items: { 'it-blue': { PS06: { assetId: 'product:detail', language: 'zxx' } } } })
    fixture.download.mockResolvedValue({ buffer: await sharp({ create: { width: 120, height: 180, channels: 3, background: '#fff' } }).png().toBuffer() })
    return { d, w: saved }
  }
  const exportUrl = `${base}/safety-export?market=IT&accountId=account-a&listingId=it-p`
  it('persists safety slots in the exact market and excludes them from API review', async () => {
    const { d, w } = await safetyDraft()
    expect(w.draft.common.PS01?.language).toBe('it')
    expect((await readAmazonMedia(await destination('DE'))).draft.common).toEqual({})
    const complete = await saveAmazonMedia(d, w.revision, { ...w.draft, common: { ...w.draft.common, MAIN: { assetId: 'product:photo', language: 'zxx' } } })
    const run = await createAmazonMediaReview(d, complete.revision, ['it-blue'], 'editor'); await processAmazonMediaRun(run.id)
    const reviewed = await readAmazonMediaRun(d, run.id)
    expect(reviewed.items[0].issues).toEqual([])
    expect(Object.keys(reviewed.items[0].desired)).toEqual(['MAIN'])
    expect(JSON.stringify(fixture.patch.mock.calls)).not.toContain('PS01')
    expect((await readAmazonMedia(d)).draft.common.PS01).toEqual(w.draft.common.PS01)
  })
  it('copies PS images between markets with renewed language review', async () => {
    const { w } = await safetyDraft(); const target = await destination('DE'); const initial = await readAmazonMedia(target)
    const main = { assetId: 'product:photo', language: 'zxx' }
    const current = await saveAmazonMedia(target, initial.revision, { common: {}, items: { 'de-blue': { MAIN: main } } })
    const copied = await copyAmazonMarketGallery(target, current.revision, { sourceMarket: 'IT', sourceListingId: 'it-p', sourceGalleryId: 'it-blue', sourceRevision: w.revision, targetGalleryId: 'de-blue', section: 'safety' })
    expect(copied.draft.items['de-blue'].PS01?.language).toBe('und')
    expect(copied.draft.items['de-blue'].PS06?.language).toBe('zxx')
    expect(copied.draft.items['de-blue'].MAIN).toEqual(main)
  })
  it('still blocks unknown saved image roles instead of treating them as PS export slots', async () => {
    const { d } = await safetyDraft()
    const row = fixture.state.listings.find(l => l.id === 'it-p')
    row.platformAttributes._amazonMediaWorkspace.draft.common.PS07 = { assetId: 'product:detail', language: 'zxx' }
    const w = await readAmazonMedia(d)
    const run = await createAmazonMediaReview(d, w.revision, ['it-blue'], 'editor'); await processAmazonMediaRun(run.id)
    expect((await readAmazonMediaRun(d, run.id)).items[0].issues.join()).toContain('Unsupported gallery slot: PS07')
    expect(fixture.patch).not.toHaveBeenCalled()
  })
  it('exports exact ASIN/slot filenames without a main or an Amazon write', async () => {
    const { w } = await safetyDraft()
    const response = await app.inject({ method: 'POST', url: exportUrl, headers, payload: { expectedRevision: w.revision, listingIds: ['it-blue', 'it-red'] } })
    expect(response.statusCode, response.body.slice(0, 200)).toBe(200)
    expect(response.headers['content-type']).toContain('application/zip')
    const zip = await JSZip.loadAsync(response.rawPayload)
    expect(Object.keys(zip.files)).toEqual(['B000000001.PS01.jpg', 'B000000001.PS06.jpg', 'B000000002.PS01.jpg'])
    const metadata = await sharp(await zip.file('B000000001.PS01.jpg')!.async('nodebuffer')).metadata()
    expect([metadata.format, metadata.width, metadata.height]).toEqual(['jpeg', 120, 180])
    expect(fixture.download).toHaveBeenCalledTimes(2)
    expect(fixture.client).not.toHaveBeenCalled(); expect(fixture.state.runs).toEqual([])
  })
  it('blocks stale revisions and foreign targets before downloading any source', async () => {
    const { w } = await safetyDraft()
    const send = (revision: string, ids: string[]) => app.inject({ method: 'POST', url: exportUrl, headers, payload: { expectedRevision: revision, listingIds: ids } })
    expect((await send('0'.repeat(64), ['it-blue'])).statusCode).toBe(409)
    expect((await send(w.revision, ['de-blue'])).statusCode).toBe(422)
    expect(fixture.download).not.toHaveBeenCalled()
  })
  it('fails the whole archive when an image is unavailable or not a supported image', async () => {
    const { w } = await safetyDraft()
    const send = () => app.inject({ method: 'POST', url: exportUrl, headers, payload: { expectedRevision: w.revision, listingIds: ['it-blue'] } })
    fixture.download.mockRejectedValue(new Error('Source returned HTTP 404'))
    const failed = await send(); expect(failed.statusCode).toBe(422); expect(failed.json().error).toContain('No archive was generated')
    fixture.download.mockResolvedValue({ buffer: Buffer.from('<html>Login required</html>') })
    expect((await send()).statusCode).toBe(422)
  })
  it('refuses an archive if images change during download', async () => {
    const { w } = await safetyDraft()
    const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#fff' } }).png().toBuffer()
    fixture.download.mockImplementation(async () => { fixture.state.listings.find(l => l.id === 'it-p').version++; return { buffer: png } })
    const response = await app.inject({ method: 'POST', url: exportUrl, headers, payload: { expectedRevision: w.revision, listingIds: ['it-blue'] } })
    expect(response.statusCode).toBe(409); expect(response.json().error).toContain('changed during export')
  })
})
async function saved() {
  const d = await destination(); const w = await readAmazonMedia(d)
  return { d, w: await saveAmazonMedia(d, w.revision, { common: { MAIN: { assetId: 'product:photo', language: 'zxx' } }, items: {} }) }
}
async function reviewed(ids = ['it-blue', 'it-red']) {
  const { d, w } = await saved(); const run = await createAmazonMediaReview(d, w.revision, ids, 'editor')
  await processAmazonMediaRun(run.id)
  return { d, w, run: await readAmazonMediaRun(d, run.id) }
}
describe('Amazon Media destination and persistence', () => {
  it('offers active aliases even when the market has no primary listing', async () => {
    fixture.state.listings = fixture.state.listings.filter(l => l.id !== 'it-p')
    const response = await app.inject({ url: `${base}/destinations?market=IT&accountId=account-a`, headers })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().listings).toEqual([{ id: 'summer-p', label: 'Summer collection' }])
  })
  it('prevents legacy image feeds from bypassing a market-managed media draft', async () => {
    await saved()
    const { submitAmazonImageFeed } = await import('../../services/images/amazon-image-feed.service')
    await expect(submitAmazonImageFeed({ productId: 'p', marketplace: 'IT', dryRun: true })).rejects.toThrow('account-scoped Amazon Images')
    await expect(submitAmazonImageFeed({ productId: 'blue', marketplace: 'IT', dryRun: true })).rejects.toThrow('account-scoped Amazon Images')
  })
  it('permits viewer reads but blocks anonymous reads and all viewer effects', async () => {
    expect((await app.inject(url)).statusCode).toBe(401)
    const read = await app.inject({ url, headers: { authorization: 'viewer' } }); expect(read.statusCode, read.body).toBe(200)
    for (const suffix of ['', '/refresh', '/review', '/copy-market', '/safety-export', '/runs/anything/publish']) expect((await app.inject({ method: suffix ? 'POST' : 'PUT', url: `${base}${suffix}?market=IT&accountId=account-a&listingId=it-p`, headers: { authorization: 'viewer' }, payload: { expectedRevision: read.json().revision } })).statusCode).toBe(403)
    expect(fixture.client).not.toHaveBeenCalled()
  })
  it('refuses mismatched account, market and listing before source reads', async () => {
    expect((await app.inject({ url: url.replace('account-a', 'account-b'), headers })).statusCode).toBe(409)
    expect((await app.inject({ url: url.replace('market=IT', 'market=DE'), headers })).statusCode).toBe(409)
  })
  it('isolates market common images, aliases, accounts and explicit SKU empty slots', async () => {
    const { d, w } = await saved()
    const next = await saveAmazonMedia(d, w.revision, { ...w.draft, items: { 'it-blue': { PT01: null } } })
    expect(next.draft.items['it-blue'].PT01).toBeNull()
    for (const target of [await destination('DE'), await destination('IT', 'summer-p'), await destination('IT', 'other-account', 'account-b')]) expect((await readAmazonMedia(target)).draft.common).toEqual({})
    expect(fixture.state.listings[0].platformAttributes.untouched).toBe(true)
    expect(fixture.state.assets).toHaveLength(4)
  })
  it('rejects stale saves, foreign assets, foreign SKUs and unsupported slots', async () => {
    const { d, w } = await saved()
    await saveAmazonMedia(d, w.revision, w.draft)
    await expect(saveAmazonMedia(d, w.revision, w.draft)).rejects.toThrow('changed')
    const current = await readAmazonMedia(d)
    for (const draft of [{ common: { MAIN: { assetId: 'foreign', language: 'zxx' } }, items: {} }, { common: {}, items: { 'de-blue': {} } }, { common: { PS07: null }, items: {} }]) await expect(saveAmazonMedia(d, current.revision, draft)).rejects.toThrow()
  })
  it('preserves malformed stored drafts and rejects deactivated aliases', async () => {
    fixture.state.listings[0].platformAttributes._amazonMediaWorkspace = { version: 8 }
    await expect(readAmazonMedia(await destination())).rejects.toThrow('preserved')
    fixture.state.aliases[0].status = 'ARCHIVED'
    await expect(destination('IT', 'summer-p')).rejects.toThrow('unavailable')
  })
  it('requires an alias seller SKU instead of borrowing the master SKU', async () => {
    delete fixture.state.listings.find(l => l.id === 'summer-p').platformAttributes.sellerSku
    const w = await readAmazonMedia(await destination('IT', 'summer-p'))
    expect(w.items.find(i => i.id === 'summer-p')?.sku).toBe('')
    expect(w.items.find(i => i.id === 'summer-blue')?.sku).toBe('SUMMER-BLUE')
  })
  it('copies only the chosen market gallery and resets localized language approval', async () => {
    const { d, w } = await saved()
    const source = await saveAmazonMedia(d, w.revision, { ...w.draft, common: { ...w.draft.common, PT01: { assetId: 'product:chart-it', language: 'it' } } })
    const target = await destination('DE'); const before = await readAmazonMedia(target)
    const result = await copyAmazonMarketGallery(target, before.revision, { sourceMarket: 'IT', sourceListingId: 'it-p', sourceGalleryId: 'common', sourceRevision: source.revision, targetGalleryId: 'common' })
    expect(result.draft.common.MAIN?.language).toBe('zxx')
    expect(result.draft.common.PT01?.language).toBe('und')
    expect((await readAmazonMedia(d)).draft.common.PT01?.language).toBe('it')
    expect(result.draft.items).toEqual({})
    expect(new Set(result.assets.map(a => a.url)).size).toBe(result.assets.length)
  })
  it('stores per-SKU failures without treating missing Amazon evidence as an empty gallery', async () => {
    const { d, w } = await saved(); fixture.observe.mockRejectedValueOnce(new Error('Amazon unavailable'))
    const refreshed = await refreshAmazonMedia(d, w.revision)
    expect(refreshed.observations['it-p'].error).toBe('Amazon unavailable')
    expect(refreshed.draft).toEqual(w.draft)
    expect(refreshed.observations['it-blue'].slots.MAIN).toContain('old.jpg')
    expect(refreshed.assets.some(a => a.url.endsWith('old.jpg'))).toBe(true)
  })
  it('does not invalidate an unchanged gallery review just because a check timestamp advances', async () => {
    const { d, w } = await saved()
    const first = await refreshAmazonMedia(d, w.revision)
    const second = await refreshAmazonMedia(d, first.revision)
    expect(second.revision).toBe(first.revision)
  })
})
describe('Amazon Media immutable review and publication', () => {
  it('blocks different desired galleries for offers sharing one ASIN in the same market', async () => {
    fixture.state.listings.find(l => l.id === 'it-red').externalListingId = 'ASIN-blue'
    const { d, w } = await saved()
    const changed = await saveAmazonMedia(d, w.revision, { ...w.draft, items: { 'it-red': { MAIN: { assetId: 'product:detail', language: 'zxx' } } } })
    const run = await createAmazonMediaReview(d, changed.revision, ['it-blue', 'it-red'], null); await processAmazonMediaRun(run.id)
    const result = await readAmazonMediaRun(d, run.id)
    expect(result.items.every(i => i.issues.some(issue => issue.includes('share this ASIN')))).toBe(true)
    await expect(approveAmazonMediaRun(d, result.id, changed.revision)).rejects.toThrow('blocking issue')
  })
  it('previews exact replacements and removals without submitting live changes', async () => {
    const { run } = await reviewed()
    expect(run.status).toBe('REVIEW'); expect(run.items).toHaveLength(2)
    expect(run.items[0].changes.map(c => [c.slot, c.after])).toEqual([['MAIN', 'https://cdn.example/photo.jpg'], ['PT01', null]])
    expect(fixture.patch.mock.calls.every(call => call[3] === true)).toBe(true)
  })
  it('blocks the whole review when one SKU fails preflight', async () => {
    fixture.patch.mockResolvedValue({ status: 'INVALID', issues: [{ severity: 'ERROR', code: 'BAD', message: 'Invalid image' }] })
    const { d, w, run } = await reviewed()
    await expect(approveAmazonMediaRun(d, run.id, w.revision)).rejects.toThrow('blocking issue')
    expect(fixture.patch.mock.calls.every(call => call[3] === true)).toBe(true)
  })
  it('persists per-SKU acceptance without claiming publication or touching other markets', async () => {
    const { d, w, run } = await reviewed()
    await approveAmazonMediaRun(d, run.id, w.revision)
    await expect(saveAmazonMedia(d, (await readAmazonMedia(d)).revision, w.draft)).rejects.toThrow('running')
    await processAmazonMediaRun(run.id)
    const receipt = await readAmazonMediaRun(d, run.id)
    expect(receipt.status).toBe('COMPLETE'); expect(receipt.receipts.map(r => r.status)).toEqual(['ACCEPTED', 'ACCEPTED'])
    expect(fixture.patch.mock.calls.filter(c => !c[3]).map(c => c[0])).toEqual(['BOTTLE-BLUE', 'BOTTLE-RED'])
    expect((await readAmazonMedia(await destination('DE'))).draft.common).toEqual({})
    await processAmazonMediaRun(run.id)
    expect(fixture.patch.mock.calls.filter(c => !c[3])).toHaveLength(2)
  })
  it('refuses double approval and stale local revisions', async () => {
    const { d, w, run } = await reviewed()
    await saveAmazonMedia(d, w.revision, w.draft)
    await expect(approveAmazonMediaRun(d, run.id, w.revision)).rejects.toThrow('changed')
    const fresh = await createAmazonMediaReview(d, (await readAmazonMedia(d)).revision, ['it-blue'], null); await processAmazonMediaRun(fresh.id)
    await approveAmazonMediaRun(d, fresh.id, (await readAmazonMedia(d)).revision)
    await expect(approveAmazonMediaRun(d, fresh.id, fresh.revision)).rejects.toThrow('already')
  })
  it('does not overwrite Amazon images changed since review', async () => {
    const { d, w, run } = await reviewed()
    await approveAmazonMediaRun(d, run.id, w.revision)
    fixture.observe.mockImplementation(async (item: any) => ({ asin: item.asin, productType: 'BOTTLE', slots: { MAIN: 'https://cdn.example/changed-externally.jpg' }, supported: ['MAIN', 'PT01'] }))
    await processAmazonMediaRun(run.id)
    expect(fixture.patch.mock.calls.filter(c => !c[3])).toHaveLength(0)
    expect((await readAmazonMediaRun(d, run.id)).receipts[0].message).toContain('changed since')
  })
  it('marks lost write responses unknown and stops the remaining SKUs', async () => {
    const { d, w, run } = await reviewed()
    await approveAmazonMediaRun(d, run.id, w.revision)
    fixture.patch.mockRejectedValue(new Error('Connection lost'))
    await processAmazonMediaRun(run.id)
    const result = await readAmazonMediaRun(d, run.id)
    expect(result.status).toBe('UNKNOWN'); expect(result.receipts.map(r => r.status)).toEqual(['UNKNOWN', 'NOT_SENT'])
    expect(fixture.patch.mock.calls.filter(c => !c[3])).toHaveLength(1)
    await processAmazonMediaRun(run.id)
    expect(fixture.patch.mock.calls.filter(c => !c[3])).toHaveLength(1)
  })
  it('recovers stale SENDING receipts as unknown without replaying PATCH', async () => {
    const { d, w, run } = await reviewed()
    await approveAmazonMediaRun(d, run.id, w.revision)
    const row = fixture.state.runs.find(r => r.id === run.id)
    row.status = 'SUBMITTING'; row.updatedAt = new Date(Date.now() - 20 * 60_000); row.receipts[0].status = 'SENDING'
    await processPendingAmazonMediaRuns()
    expect((await readAmazonMediaRun(d, run.id)).receipts[0].status).toBe('UNKNOWN')
    expect(fixture.patch.mock.calls.filter(c => !c[3])).toHaveLength(0)
  })
  it('refuses receipts belonging to a different account or market', async () => {
    const { run } = await reviewed()
    await expect(readAmazonMediaRun(await destination('DE'), run.id)).rejects.toThrow('does not belong')
    await expect(readAmazonMediaRun(await destination('IT', 'other-account', 'account-b'), run.id)).rejects.toThrow('does not belong')
  })
})
