import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => {
  const data: Record<string, any[]> = {}
  function matches(row: any, where: any = {}): boolean {
    return Object.entries(where).every(([key, value]: [string, any]) => {
      if (key === 'OR') return value.some((clause: any) => matches(row, clause))
      if (key === 'AND') return value.every((clause: any) => matches(row, clause))
      if (key === 'product') return matches(data.product.find(p => p.id === row.productId), value)
      if (value && typeof value === 'object') {
        if ('path' in value) return value.path.reduce((v: any, part: string) => v?.[part], row[key]) === value.equals
        if ('in' in value) return value.in.includes(row[key])
        if ('gte' in value) return row[key] >= value.gte
        if ('lt' in value) return row[key] < value.lt
      }
      return row[key] === value
    })
  }
  const model = (name: string) => ({
    findFirst: vi.fn(async ({ where }: any) => data[name]?.find(row => matches(row, where)) ?? null),
    findUnique: vi.fn(async ({ where }: any) => data[name]?.find(row => matches(row, where)) ?? null),
    findMany: vi.fn(async ({ where, take, cursor, skip }: any) => {
      const rows = (data[name] ?? []).filter(row => matches(row, where))
      const from = cursor ? rows.findIndex(row => row.id === cursor.id) + (skip ?? 0) : 0
      return rows.slice(from, take ? from + take : undefined)
    }),
    count: vi.fn(async ({ where }: any) => (data[name] ?? []).filter(row => matches(row, where)).length),
    aggregate: vi.fn(async () => ({ _sum: { available: 17 } })),
    groupBy: vi.fn(async () => []),
  })
  const db = Object.fromEntries(['product', 'marketplace', 'channelListing', 'productListingAlias', 'productEvent', 'auditLog', 'outboundSyncQueue', 'stockLevel', 'productImage', 'listingImage', 'productVariation', 'amazonImageFeedJob', 'channelLiveImage', 'digitalAsset', 'sharedListingMembership'].map(name => [name, model(name)])) as any
  db.$queryRaw = vi.fn(async () => [{ currency: 'EUR', units: 2n, revenue: 40, orders: 1n }])
  return { data, db, account: vi.fn(async (_channel: string, id?: string) => {
    if (!id || !['a', 'b'].includes(id)) throw new Error('Inactive account')
    return id
  }) }
})
vi.mock('../images/amazon-slot-taxonomy.service.js', () => ({ resolveSlotTaxonomy: vi.fn(async () => ({ slots: ['MAIN', 'PT01'], source: 'schema' })) }))
vi.mock('../ebay-family-axes.service.js', () => ({ resolveFamilyAxes: vi.fn(async () => ({ axes: [], warnings: [], suppressed: [] })) }))
vi.mock('../../db.js', () => ({ default: fixture.db }))
vi.mock('../connection-resolver.service.js', () => ({ resolveChannelConnectionId: fixture.account }))
import Fastify from 'fastify'
import mediaRoutes from '../../routes/images/images-workspace.routes.js'
import { resolveWorkspaceDestination, resolveWorkspaceListing } from './workspace-destination.js'
import { getWorkspaceActivity, getWorkspacePerformance } from './workspace-observations.js'
import { getProductSyncQueue } from './sync-queue.service.js'
import { getCellHistory } from './cell-history.service.js'

const input = { productId: 'p', channel: 'EBAY', marketplace: 'IT', accountId: 'b' }
beforeEach(() => {
  vi.clearAllMocks()
  fixture.data.product = [{ id: 'p', parentId: null, deletedAt: null, sku: 'P' }, { id: 'child', parentId: 'p', deletedAt: null, sku: 'C' }, { id: 'foreign', parentId: null, deletedAt: null, sku: 'F' }]
  fixture.data.marketplace = [{ id: 'market', channel: 'EBAY', code: 'IT', isActive: true, currency: 'EUR' }]
  fixture.data.channelListing = ['a', 'b'].flatMap(account => ['', 'alt'].map(aliasKey => ({ id: `${account}-${aliasKey || 'primary'}`, productId: 'p', channel: 'EBAY', marketplace: 'IT', channelConnectionId: account, aliasKey, version: 3, price: account === 'a' ? 900 : 25, priceOverride: null })))
  fixture.data.productListingAlias = [{ id: 'alt', productId: 'p', channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'b', status: 'ACTIVE' }]
  for (const model of ['productImage', 'listingImage', 'productVariation', 'amazonImageFeedJob', 'channelLiveImage', 'digitalAsset', 'sharedListingMembership']) fixture.data[model] = []
  fixture.data.productEvent = []
  fixture.data.auditLog = []
  fixture.data.outboundSyncQueue = []
})

describe('workspace destination isolation', () => {
  it('keeps the named alternate account without a primary lookup', async () => {
    expect(await resolveWorkspaceDestination(input)).toMatchObject({ accountId: 'b', aliasKey: null, listing: null })
    expect(fixture.account).toHaveBeenCalledWith('EBAY', 'b')
  })
  it('derives an omitted account from the exact listing', async () => {
    expect(await resolveWorkspaceDestination({ ...input, accountId: undefined, listingId: 'b-alt' })).toMatchObject({ accountId: 'b', aliasKey: 'alt', listing: { id: 'b-alt' } })
  })
  it.each([{ accountId: 'a', listingId: 'b-primary' }, { marketplace: 'DE' }, { accountId: '' }, { accountId: 'inactive' }, { listingId: 'missing' }, { listingId: '' }])('refuses incompatible or unavailable scope %j', async patch => {
    await expect(resolveWorkspaceDestination({ ...input, ...patch })).rejects.toThrow()
  })
  it('does not infer primary for an unattributed listing', async () => {
    fixture.data.channelListing[2].channelConnectionId = null
    await expect(resolveWorkspaceDestination({ ...input, accountId: undefined, listingId: 'b-primary' })).rejects.toThrow('no account attribution')
    expect(fixture.account).not.toHaveBeenCalled()
  })
  it('refuses a foreign product even if channel/account/market match', async () => {
    fixture.data.channelListing[2].productId = 'foreign'
    await expect(resolveWorkspaceDestination({ ...input, listingId: 'b-primary' })).rejects.toThrow('does not belong')
    await expect(resolveWorkspaceListing('p', 'b-primary', 'b')).rejects.toThrow('does not belong')
  })
  it('rejects an archived alias without falling back to the root', async () => {
    fixture.data.productListingAlias[0].status = 'ARCHIVED'
    await expect(resolveWorkspaceDestination({ ...input, listingId: 'b-alt' })).rejects.toThrow('customization is unavailable')
  })
})

describe('the same destination reaches observations', () => {
  it('filters account and listing events before paging; unscoped and other-account events stay out', async () => {
    const event = (id: string, accountId?: string, aliasKey = '') => ({ id, aggregateType: 'Product', aggregateId: 'p', metadata: { channel: 'EBAY', marketplace: 'IT', accountId, aliasKey }, data: { fields: [{ field: 'title', value: id }] } })
    fixture.data.productEvent = [event('foreign', 'a'), event('unknown'), event('primary', 'b'), event('selected', 'b', 'alt'), { id: 'listing-event', aggregateType: 'ChannelListing', aggregateId: 'b-alt', metadata: { channel: 'EBAY', marketplace: 'IT', accountId: 'b', aliasKey: 'alt' } }, { id: 'old-owner', aggregateType: 'ChannelListing', aggregateId: 'b-alt', metadata: { channel: 'EBAY', marketplace: 'IT', accountId: 'a', aliasKey: 'alt' } }]
    const result = await getWorkspaceActivity({ ...input, listingId: 'b-alt' })
    expect(result.events.map(row => row.id)).toEqual(['selected', 'listing-event'])
  })
  it('keeps shared activity separate from listing changes', async () => {
    fixture.data.productEvent = [
      { id: 'shared', aggregateType: 'Product', aggregateId: 'p', metadata: { layer: 'master' } },
      { id: 'channel', aggregateType: 'Product', aggregateId: 'p', metadata: { layer: 'channel', accountId: 'b' } },
    ]
    expect((await getWorkspaceActivity({ ...input, scope: 'master' })).events.map(row => row.id)).toEqual(['shared'])
  })
  it('returns only the exact listing price, retains stock ownership and refuses to infer alias sales', async () => {
    const result = await getWorkspacePerformance({ ...input, listingId: 'b-alt', days: 30 })
    expect(result.prices).toEqual([{ id: 'b-alt', aliasKey: 'alt', price: 25, currency: 'EUR' }])
    expect(result.inventoryAvailable).toBe(17)
    expect(result.sales).toBeNull()
    expect(fixture.db.$queryRaw).not.toHaveBeenCalled()
  })
  it('binds order sales to product, account and market, without a SKU-only fallback', async () => {
    const result = await getWorkspacePerformance({ ...input, days: 30 })
    expect(result.sales).toEqual([{ currency: 'EUR', units: 2, revenue: 40, orders: 1 }])
    const sql = fixture.db.$queryRaw.mock.calls[0][0]
    expect(sql.values.slice(0, 4)).toEqual(['p', 'b', 'EBAY', 'IT'])
    expect(sql.strings.join('')).not.toContain('sku')
  })
  it('uses account/listing filters for queue counts as well as returned rows', async () => {
    const row = (id: string, channelListingId: string, accountId?: string) => ({ payload: { accountId }, id, productId: 'p', channelListingId, targetChannel: 'EBAY', targetRegion: 'IT', createdAt: new Date(), updatedAt: new Date(), isDead: true, syncStatus: 'FAILED', retryCount: 3, maxRetries: 3 })
    fixture.data.outboundSyncQueue = [row('a-result', 'a-primary', 'a'), row('b-result', 'b-alt', 'b'), row('b-primary-result', 'b-primary', 'b'), row('old-owner-result', 'b-alt', 'a'), row('unknown-owner-result', 'b-alt')]
    const result = await getProductSyncQueue({ ...input, listingId: 'b-alt' })
    expect(result.counts.all).toBe(1)
    expect(result.rows.map(row => row.id)).toEqual(['b-result'])
  })
  it('does not show another account or alias in field history', async () => {
    fixture.data.auditLog = ['a', 'b'].flatMap(accountId => ['', 'alt'].map(aliasKey => ({ entityType: 'Product', entityId: 'p', createdAt: new Date(), userId: 'editor', metadata: { channel: 'EBAY', marketplace: 'IT', accountId, aliasKey, layer: 'channel' }, before: { field: 'title', value: 'before' }, after: { field: 'title', value: `${accountId}:${aliasKey}` } })))
    const result = await getCellHistory({ ...input, aliasKey: 'alt', fieldKey: 'title' })
    expect(result.entries.map(row => row.next)).toEqual(['b:alt'])
  })
})


describe('the actual media workspace route', () => {
  it('keeps shared gallery ownership and hides unaccounted publication results', async () => {
    fixture.data.listingImage = [
      { id: 'shared', productId: 'p', scope: 'GLOBAL', platform: null, marketplace: null, publishStatus: 'PUBLISHED' },
      { id: 'ebay', productId: 'p', scope: 'PLATFORM', platform: 'EBAY', marketplace: null, publishStatus: 'PUBLISHED' },
      { id: 'amazon', productId: 'p', scope: 'PLATFORM', platform: 'AMAZON', marketplace: null },
      { id: 'de', productId: 'p', scope: 'MARKETPLACE', platform: 'EBAY', marketplace: 'DE' },
    ]
    const app = Fastify(); await app.register(mediaRoutes)
    const response = await app.inject('/products/p/images-workspace?scope=channel&channel=EBAY&market=IT&accountId=b&listingId=b-alt')
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().listing.map((row: any) => [row.id, row.publishStatus])).toEqual([['shared', 'UNATTRIBUTED'], ['ebay', 'UNATTRIBUTED']])
    expect(fixture.db.channelListing.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ channelConnectionId: 'b', marketplace: 'IT', aliasKey: 'alt' }) }))
    expect(fixture.db.amazonImageFeedJob.findMany).not.toHaveBeenCalled()
    expect(fixture.db.channelLiveImage.findMany).not.toHaveBeenCalled()
    await app.close()
  })
  it('refuses a foreign gallery-row update before its transaction', async () => {
    fixture.data.listingImage = [{ id: 'foreign-image', productId: 'foreign' }]
    const app = Fastify(); await app.register(mediaRoutes)
    const response = await app.inject({ method: 'POST', url: '/products/p/images-workspace/bulk-save', payload: { upserts: [{ id: 'foreign-image', scope: 'GLOBAL', url: 'https://fixture.invalid/new.jpg' }] } })
    expect(response.statusCode, response.body).toBe(409)
    expect(fixture.data.listingImage[0].productId).toBe('foreign')
    await app.close()
  })
})

it.skipIf(process.env.NEXUS_WORKSPACE_SCOPE_BROWSER !== '1')('serves the isolated scope browser fixture', async () => {
  const { writeFile } = await import('node:fs/promises')
  fixture.data.product[0] = { ...fixture.data.product[0], name: 'Scope fixture jacket', status: 'ACTIVE', isParent: true, productType: 'PRODUCT' }
  fixture.data.marketplace.push({ id: 'de', channel: 'EBAY', code: 'DE', isActive: true, currency: 'EUR' })
  fixture.data.channelListing.push({ ...fixture.data.channelListing[2], id: 'b-DE', marketplace: 'DE', price: 44 })
  fixture.data.productEvent = ['a', 'b'].map(accountId => ({ id: `event-${accountId}`, aggregateType: 'Product', aggregateId: 'p', eventType: 'BULK_OP_APPLIED', createdAt: new Date(), metadata: { layer: 'channel', channel: 'EBAY', marketplace: 'IT', accountId, aliasKey: '' }, data: { fields: [{ field: 'title', value: `Account ${accountId} title` }] } }))
  const app = Fastify()
  const calls: string[] = []
  let hold: ((value?: unknown) => void) | undefined
  let delayNext = false
  app.addHook('onRequest', async request => { calls.push(request.url) })
  await app.register(mediaRoutes, { prefix: '/api' })
  app.get('/api/auth/csrf', async () => ({ csrfToken: 'isolated-scope' }))
  app.get('/api/auth/me', async () => ({ user: { id: 'fixture', displayName: 'Scope fixture', email: 'fixture@example.test', roleKeys: ['owner'] }, isOwner: true, permissions: ['products.view', 'products.edit', 'products.images.edit'] }))
  app.get('/api/products/:id', async (request: any, reply) => fixture.data.product.find(p => p.id === request.params.id) ?? reply.code(404).send({ error: 'Fixture product not found' }))
  app.get('/api/marketplaces/grouped', async () => ({ EBAY: fixture.data.marketplace.map(m => ({ ...m, name: `eBay ${m.code}`, language: m.code === 'IT' ? 'it' : 'de' })) }))
  app.get('/api/connections', async () => ({ connections: ['a', 'b'].map(id => ({ id, channel: 'EBAY', isActive: true, isPrimary: id === 'a', accountLabel: `Fixture account ${id}` })) }))
  const destinationInput = (request: any) => ({ productId: request.params.id, channel: request.query.channel, marketplace: request.query.market, accountId: request.query.accountId, listingId: request.query.listingId })
  app.get('/api/products/:id/studio/destination', async (request: any, reply) => {
    try { return await resolveWorkspaceDestination(destinationInput(request)) } catch (e: any) { return reply.code(e.statusCode ?? 409).send({ error: e.message }) }
  })
  app.get('/api/products/:id/studio/performance', async (request: any, reply) => {
    try {
      const result = await getWorkspacePerformance({ ...destinationInput(request), days: Number(request.query.days ?? 30) })
      if (delayNext) { delayNext = false; await new Promise(resolve => { hold = resolve }) }
      return result
    } catch (e: any) { return reply.code(e.statusCode ?? 409).send({ error: e.message }) }
  })
  app.get('/api/products/:id/studio/activity', async (request: any) => getWorkspaceActivity({ ...destinationInput(request), scope: request.query.scope }))
  app.get('/api/products/:id/sync-queue', async (request: any) => getProductSyncQueue({ ...destinationInput(request), filter: request.query.filter }))
  app.get('/api/products/:id/readiness', async () => ({ scopes: [] }))
  app.get('/api/products/:id/studio/sheet', async (request: any) => {
    const id = request.params.id, accountId = request.query.accountId, market = request.query.market
    const product = fixture.data.product.find(p => p.id === id)
    const listings = fixture.data.channelListing.filter(l => l.productId === id && l.marketplace === market && l.channelConnectionId === accountId)
    return { scope: { kind: 'channel', channel: 'EBAY', marketplace: market, locale: market === 'IT' ? 'it' : 'de', label: `eBay ${market}`, connectionId: accountId },
      family: product, groups: [], columns: [{ key: 'title', label: 'Title', type: 'text', group: 'information', editable: true, requiredBy: [], constraints: {} }],
      aliases: listings.map((l, index) => ({ id: l.aliasKey || null, label: l.aliasKey ? 'Alternate listing' : 'Primary listing', position: index, rowIds: [id], readiness: { state: 'ready', errors: 0, warnings: 0 } })),
      rows: listings.map(l => ({ ...product, rowId: `${l.aliasKey || 'primary'}:${id}`, aliasId: l.aliasKey || null, rowKind: 'parent', listing: l, readiness: { state: 'ready', issues: [] }, values: { title: { value: `Account ${accountId} · ${market} · ${l.aliasKey || 'primary'}`, editable: true, writeField: 'ebay_title', writeTarget: 'channelListing', writeVerb: 'channel', inherited: false } } })),
      meta: { tookMs: 0, schemaMissing: [], schemaAge: [], droppedKeys: [] } }
  })
  app.post('/api/fixture/delay', async () => { delayNext = true; return { delayed: true } })
  app.post('/api/fixture/release', async () => { hold?.(); hold = undefined; return { released: true } })
  app.get('/api/fixture/evidence', async () => ({ calls, listings: fixture.data.channelListing, held: !!hold }))
  app.setNotFoundHandler(async request => ({ fixture: true, path: request.url, data: [], items: [], profiles: [], connections: [], alerts: [], notifications: [], count: 0, total: 0 }))
  await app.listen({ host: '127.0.0.1', port: 4104 })
  await writeFile('/tmp/nexus-workspace-scope-fixture-ready.json', JSON.stringify({ pid: process.pid, port: 4104 }))
  await new Promise<void>(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve) })
  hold?.(); await app.close()
}, 3_600_000)
