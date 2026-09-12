import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

// In-memory catalog + HTTP marketplace boundary. Canonical resolution, family row construction,
// Trading XML construction, account/alias validation and route handlers all run their real code.
const fixture = vi.hoisted(() => {
  const state = { tables: {} as Record<string, any[]>, calls: [] as any[], writes: [] as any[], race: null as (() => void) | null, remote: new Map<string, string>(), fail: new Set<string>(), afterRevision: null as (() => void) | null }
  const copy = <T>(value: T): T => structuredClone(value)
  const matches = (row: any, where: any): boolean => Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
    if (value === undefined) return true
    if (key === 'OR') return value.some((w: any) => matches(row, w))
    if (key === 'AND') return (Array.isArray(value) ? value : [value]).every((w: any) => matches(row, w))
    if (key === 'NOT') return !(Array.isArray(value) ? value : [value]).some((w: any) => matches(row, w))
    if (key === 'channel_code') return matches(row, value)
    const item = key === 'product' ? state.tables.product.find(p => p.id === row.productId) : row[key]
    if (value instanceof Date) return +new Date(item) === +value
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if ('path' in value) return JSON.stringify(value.path.reduce((v: any, k: string) => v?.[k], item)) === JSON.stringify(value.equals)
      if ('equals' in value) return JSON.stringify(item ?? {}) === JSON.stringify(value.equals ?? {})
      if ('in' in value) return value.in.includes(item)
      if ('gt' in value) return item > value.gt
      if ('lt' in value) return item < value.lt
      if ('not' in value) return item !== value.not
      return matches(item, value)
    }
    return item === value
  })
  const db: any = {}
  const models = ['product', 'channelListing', 'channelConnection', 'productListingAlias', 'sharedListingMembership', 'productCategory', 'marketplace', 'categorySchema', 'categoryChannelMapping', 'categoryClosure', 'listingImage', 'productImage', 'ebayDescriptionTheme', 'fieldValueMap', 'sizeScaleMap', 'fieldLinkGroup', 'bulkOperation']
  for (const model of models) {
    const findMany = async (query: any = {}) => {
      state.calls.push({ model, query: copy(query) })
      let rows = (state.tables[model] ?? []).filter(r => matches(r, query.where))
      const sorts = !query.orderBy ? [] : Array.isArray(query.orderBy) ? query.orderBy : [query.orderBy]
      rows = [...rows].sort((a, b) => { for (const sort of sorts) for (const [key, direction] of Object.entries(sort)) { if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * (direction === 'desc' ? -1 : 1) } return 0 })
      if (query.take) rows = rows.slice(0, query.take)
      const result = copy(rows.map(row => model === 'product' && query.include ? { ...row, images: [], channelListings: state.tables.channelListing.filter(l => l.productId === row.id && matches(l, query.include.channelListings?.where)) } : row))
      if (model === 'product' && query.include) for (const product of result) for (const l of product.channelListings) if (typeof l.price === 'number') { const value = l.price; l.price = { toNumber: () => value } }
      return result
    }
    db[model] = {
      findMany, findFirst: async (q: any) => (await findMany(q))[0] ?? null, findUnique: async (q: any) => (await findMany(q))[0] ?? null,
      count: async (q: any) => (await findMany(q)).length,
      create: async ({ data }: any) => { const row = copy({ id: `job-${state.tables[model].length}`, ...data }); state.tables[model].push(row); state.writes.push({ model, row: copy(row) }); return copy(row) },
      updateMany: async ({ where, data }: any) => {
        const rows = (state.tables[model] ?? []).filter(r => matches(r, where))
        for (const row of rows) {
          for (const [key, v] of Object.entries(data) as any) row[key] = v && typeof v === 'object' && 'increment' in v ? (row[key] ?? 0) + v.increment : copy(v)
          state.writes.push({ model, id: row.id, data: copy(data) })
        }
        return { count: rows.length }
      },
    }
  }
  db.$transaction = async (fn: any) => {
    state.race?.(); state.race = null
    const before = copy(state.tables)
    try { return await fn(db) } catch (e) { state.tables = before; throw e }
  }
  return { state, db, models }
})
vi.mock('../lib/queue.js', () => ({}))
vi.mock('./listing-wizard/ebay-publish.adapter.js', () => ({ EbayPublishAdapter: class {} }))
vi.mock('./ai/providers/index.js', () => ({ getProvider: vi.fn(), isAiKillSwitchOn: vi.fn() }))
vi.mock('./ai/model-resolver.service.js', () => ({ resolveModelForFeature: vi.fn() }))
vi.mock('./compliance-resolver.service.js', () => ({ resolveComplianceById: vi.fn(), complianceBlockers: vi.fn() }))
vi.mock('./listing-activation-sync.service.js', () => ({ syncActivatedListings: vi.fn() }))
vi.mock('./ebay-membership-reconcile.service.js', () => ({ parseLiveVariations: vi.fn() }))
vi.mock('./ebay-account.service.js', () => ({ ebayAccountService: {} }))
vi.mock('./ebay-itemid-relink.service.js', () => ({ relinkEbayItemId: vi.fn() }))
vi.mock('./ebay-inventory-drift.service.js', () => ({ collectInventoryDrift: vi.fn() }))
vi.mock('./pim/studio-sheet.service.js', () => ({ UnknownProductError: class extends Error {} }))
vi.mock('../db.js', () => ({ default: fixture.db }))
vi.mock('./ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: vi.fn(async (id: string) => `token-${id}`) } }))
vi.mock('./pim/schema-mapping.service.js', () => ({ getMappingForMarketplace: async () => fixture.state.tables.marketplace[0].schemaMapping, getRulesFor: (m: any) => m.fields }))
vi.mock('./pim/value-map.service.js', () => ({ loadValueMapLookup: async () => () => null, loadSizeScaleLookup: async () => () => null }))
vi.mock('./pim/mapping/category-mapping.service.js', () => ({ resolveCategoriesForProducts: async () => ({}), categoryForListing: (v: any) => v }))
vi.mock('./pim/mapping/field-catalogue.service.js', () => ({ getFieldCatalogue: async () => ({ fields: ['title', 'description', 'descriptionThemeId'].map(fieldKey => ({ fieldKey, sheetKey: fieldKey, shape: 'scalar', kind: 'text', label: fieldKey, helpText: null, group: 'content', groupOrder: 1, priority: 'optional', prioritySource: 'channelSchema', maxLength: null, maxBytes: null, options: null, optionLabels: null, selectionOnly: false, editable: true, rule: null, ruleKind: 'attribute', ruleSummary: '', ruleRef: null, overlay: false, status: 'unmapped', channelStore: fieldKey === 'descriptionThemeId' ? { kind: 'platformAttributes', path: [fieldKey] } : { kind: 'listingColumn', column: fieldKey, followFlag: fieldKey === 'title' ? 'followMasterTitle' : 'followMasterDescription' } })) }) }))
vi.mock('./ebay-trading-api.service.js', async importOriginal => ({ ...await importOriginal<any>(), callTradingApi: vi.fn(async (operation: string, xml: string, ctx: any) => {
  const id = /<ItemID>(.*?)<\/ItemID>/.exec(xml)?.[1] ?? ''
  fixture.state.calls.push({ operation, xml, ctx })
  if (operation === 'GetItem') return { raw: fixture.state.remote.get(id) ?? '', ack: 'Success' }
  if (fixture.state.fail.has(id)) throw new Error('Temporary marketplace error')
  let live = fixture.state.remote.get(id)!
  if (xml.includes('<Description>')) live = live.replace(/<Description>[\s\S]*?<\/Description>/, /<Description>[\s\S]*?<\/Description>/.exec(xml)![0])
  else live = live.replace(/<VariationSpecificsSet>[\s\S]*?<\/VariationSpecificsSet>/, /<VariationSpecificsSet>[\s\S]*?<\/VariationSpecificsSet>/.exec(xml)![0])
  fixture.state.remote.set(id, live); fixture.state.afterRevision?.(); fixture.state.afterRevision = null
  return { raw: '<Ack>Success</Ack>', ack: 'Success' }
}) }))

import { readPresentationOrder, savePresentationOrder, presentationDestination } from './ebay-presentation-order.service.js'
import { executePresentationPublication, reviewPresentationPublication, readPresentationDescription } from './ebay-presentation-publication.service.js'
import { buildEbayFamilyRows, pushVariationGroup } from './ebay-variation-push.service.js'
import { parseVariationSpecificsSet } from './ebay-variation-add.service.js'
import { mappingToken } from './pim/mapping/revision-token.js'
import themeRoutes from '../routes/ebay-description-themes.routes.js'
import publicationRoutes from '../routes/ebay-description-push.routes.js'

const destination = { productId: 'f1', marketplace: 'IT', accountId: 'b', aliasKey: 'alt' }
const parent = (id: string, parentId: string | null = null, color = '', size = '') => ({ id, sku: id.toUpperCase(), name: id, parentId, deletedAt: null, isParent: !parentId, productType: 'VARIATION', variationTheme: 'Color,Size', familyId: 'clothes', categoryAttributes: {}, variantAttributes: parentId ? { Color: color, Size: size } : {}, localizedContent: {}, imageAxisPreference: 'Color', variationAxes: [], brand: 'Fixture', images: [] })
const listing = (productId: string, channelConnectionId = 'b', marketplace = 'IT', aliasKey = 'alt', externalListingId = '100') => ({ id: `${productId}-${channelConnectionId}-${marketplace}-${aliasKey}`, productId, channelConnectionId, marketplace, region: marketplace, channel: 'EBAY', aliasKey, externalListingId, version: 1, platformAttributes: { keep: 'untouched' } as any, flatFileSnapshot: {}, title: `${productId} ${channelConnectionId} ${marketplace} ${aliasKey}`, titleOverride: `${productId} ${channelConnectionId} ${marketplace} ${aliasKey}`, description: '<p>Selected body</p>', descriptionOverride: '<p>Selected body</p>', followMasterTitle: false, followMasterDescription: false, quantity: 4, price: 20, updatedAt: new Date('2026-09-06T00:00:00Z') })
const live = () => '<GetItemResponse><Item><ListingStatus>Active</ListingStatus><Description><![CDATA[<p>Old</p>]]></Description><Variations><VariationSpecificsSet><NameValueList><Name>Color</Name><Value>Black</Value><Value>Red</Value></NameValueList><NameValueList><Name>Size</Name><Value>S</Value><Value>XL</Value></NameValueList></VariationSpecificsSet></Variations></Item></GetItemResponse>'
beforeEach(() => {
  fixture.state.tables = Object.fromEntries(fixture.models.map(m => [m, []])); fixture.state.calls = []; fixture.state.writes = []; fixture.state.race = null; fixture.state.fail.clear(); fixture.state.remote.clear(); fixture.state.afterRevision = null
  const t = fixture.state.tables
  t.product = [parent('f1'), parent('v1', 'f1', 'Red', 'S'), parent('v2', 'f1', 'Black', 'XL'), parent('f2'), parent('w1', 'f2', 'Blue', 'M'), parent('w2', 'f2', 'Black', 'XL')]
  t.channelConnection = [{ id: 'a', channelType: 'EBAY', isActive: true, isPrimary: true }, { id: 'b', channelType: 'EBAY', isActive: true, isPrimary: false }]
  t.productListingAlias = [{ id: 'alt', productId: 'f1', channelConnectionId: 'b', marketplace: 'IT', channel: 'EBAY', status: 'ACTIVE', updatedAt: new Date() }]
  t.channelListing = [listing('f1'), listing('v1'), listing('v2'), listing('f1', 'a', 'IT', '', '101'), listing('f1', 'b', 'IT', '', '102'), listing('f1', 'b', 'DE', '', '103'), listing('f2', 'b', 'IT', '', '200')]
  t.marketplace = [{ id: 'it', channel: 'EBAY', code: 'IT', schemaMapping: { fields: {}, presentationRules: [{ id: 'rule', name: 'Family default', version: 1, priority: 10, scope: { familyId: 'clothes', accountId: 'b' }, themeId: 'theme', order: { axes: ['Size', 'Color'], values: { Size: ['XL', 'S'], Color: ['Red', 'Black'] } } }] } }]
  t.ebayDescriptionTheme = [{ id: 'theme', name: 'Shared theme', active: true, version: 1, isDefault: true, html: '<article>{{title}} {{body}}</article>' }]
  t.sharedListingMembership = [{ id: 'm', itemId: '100', channelConnectionId: 'b', marketplace: 'IT', parentSku: 'F1', productId: 'v1', sku: 'V1', status: 'ACTIVE', variationSpecifics: { Color: 'Red', Size: 'S' }, flatFileSnapshot: {} }, { id: 'm2', itemId: '100', channelConnectionId: 'b', marketplace: 'IT', parentSku: 'F1', productId: 'v2', sku: 'V2', status: 'ACTIVE', variationSpecifics: { Color: 'Black', Size: 'XL' }, flatFileSnapshot: {} }, { id: 'foreign', itemId: '999', channelConnectionId: 'a', marketplace: 'IT', parentSku: 'F1', productId: 'w1', sku: 'W1', status: 'ACTIVE', variationSpecifics: { Color: 'Blue', Size: 'M' }, flatFileSnapshot: {} }]
  for (const id of ['100', '101', '102', '103', '200']) fixture.state.remote.set(id, live())
})

const save = async (change: any, input = destination) => { const view = await readPresentationOrder(input); return savePresentationOrder({ ...input, expectedToken: view.token, expectedVersion: view.version, change }, 'operator') }
const revisions = () => fixture.state.calls.filter(c => c.operation === 'ReviseFixedPriceItem')

describe('product presentation destination workflow', () => {
  it('reads real family axes and canonical rules; writes/reset exactly one listing with legacy per-property compatibility', async () => {
    const before = structuredClone(fixture.state.tables)
    let view = await readPresentationOrder({ ...destination, productId: 'v1' })
    expect(view.productId).toBe('f1'); expect(view.axes.map(a => a.name)).toEqual(['Size', 'Color']); expect(view.axes[0].values).toEqual(['XL', 'S']); expect(view.membershipCount).toBe(2)
    view = await save({ values: { Size: ['S', 'XL'] } })
    expect(view.version).toBe(2); expect(view.explicitValues).toEqual(['__dim1__']); expect(view.axes.find(a => a.name === 'Color')!.values).toEqual(['Red', 'Black'])
    expect(fixture.state.tables.channelListing.slice(1)).toEqual(before.channelListing.slice(1)); expect(fixture.state.tables.product).toEqual(before.product); expect(fixture.state.tables.ebayDescriptionTheme).toEqual(before.ebayDescriptionTheme)
    fixture.state.tables.marketplace[0].schemaMapping.presentationRules[0].order.values.Size = ['S', 'XL']
    view = await save({ reset: true }); expect(view.explicitAxes).toBe(false); expect(view.explicitValues).toEqual([]); expect(view.axes[0].values).toEqual(['S', 'XL']); expect(revisions()).toHaveLength(0)
  })
  it('refuses missing product coordinates and unobserved account writes', async () => {
    for (const productId of [undefined, null, '', ' ']) await expect(presentationDestination({ ...destination, productId } as any)).rejects.toThrow(/explicit product/)
    await expect(presentationDestination({ ...destination, aliasKey: null } as any)).rejects.toThrow(/valid listing/)
    const view = await readPresentationOrder(destination)
    await expect(savePresentationOrder({ ...destination, accountId: undefined, expectedVersion: view.version, expectedToken: view.token, change: { reset: true } }, 'operator')).rejects.toThrow(/account observed/)
    expect(fixture.state.writes).toEqual([])
  })
  it('uses only the selected live membership, including shared SKUs outside the product tree', async () => {
    fixture.state.tables.sharedListingMembership[1] = { ...fixture.state.tables.sharedListingMembership[1], productId: 'w1', sku: 'W1', variationSpecifics: { Color: 'Blue', Size: 'M' } }
    const view = await readPresentationOrder(destination)
    expect(view.axes.find(a => a.name === 'Color')!.values).toEqual(['Red', 'Blue'])
    expect(view.axes.find(a => a.name === 'Size')!.values).toEqual(['S', 'M'])
    expect(fixture.state.writes).toEqual([])
  })
  it('resolves conflicts per property and restores current inherited values from legacy overrides', async () => {
    const rule = fixture.state.tables.marketplace[0].schemaMapping.presentationRules[0]
    fixture.state.tables.marketplace[0].schemaMapping.presentationRules.push({ ...rule, id: 'conflict', name: 'Competing default', order: { axes: ['Color', 'Size'], values: { Color: ['Black', 'Red'], Size: ['XL', 'S'] } } })
    let view = await readPresentationOrder(destination)
    expect(view.conflicts).toHaveLength(2)
    await expect(reviewPresentationPublication([destination], 'order', 'operator')).rejects.toThrow(/Axis order/)
    view = await save({ axes: ['Size', 'Color'], values: { Color: ['Red', 'Black'] } })
    expect(view.conflicts).toEqual([])
    fixture.state.tables.channelListing[0].platformAttributes._axisSortOrder = { Size: ['S', 'XL'] }
    view = await readPresentationOrder(destination)
    expect(view.axes[0].values).toEqual(['S', 'XL'])
    view = await save({ values: { Size: null } })
    expect(view.axes[0].values).toEqual(['XL', 'S'])
    expect(view.explicitAxes).toBe(true); expect(view.explicitValues).toEqual(['__dim0__'])
    view = await save({ axes: null })
    expect(view.conflicts).toHaveLength(1)
    expect(revisions()).toHaveLength(0)
  })
  it('rejects foreign/inactive aliases and accounts without falling back; no writes', async () => {
    await expect(presentationDestination({ ...destination, accountId: 'a' })).rejects.toThrow(/alias|scope/i)
    fixture.state.tables.channelConnection[1].isActive = false
    await expect(presentationDestination(destination)).rejects.toThrow(/active|connection/i)
    expect(fixture.state.writes).toEqual([])
  })
  it('rejects stale observed saves, transaction races, and newly joined family values', async () => {
    const view = await readPresentationOrder(destination)
    fixture.state.tables.product.push(parent('v3', 'f1', 'Green', 'M'))
    await expect(savePresentationOrder({ ...destination, expectedVersion: view.version, expectedToken: view.token, change: { reset: true } }, 'operator')).rejects.toThrow(/changed/)
    fixture.state.tables.sharedListingMembership.push({ ...fixture.state.tables.sharedListingMembership[0], id: 'm3', productId: 'v3', sku: 'V3', variationSpecifics: { Color: 'Green', Size: 'M' } })
    const fresh = await readPresentationOrder(destination)
    expect(fresh.axes.find(a => a.name === 'Color')!.values).toContain('Green')
    fixture.state.race = () => { fixture.state.tables.channelListing[0].version++ }
    await expect(savePresentationOrder({ ...destination, expectedVersion: fresh.version, expectedToken: fresh.token, change: { reset: true } }, 'operator')).rejects.toThrow(/changed/)
    expect(fixture.state.writes).toEqual([])
  })
  it('uses the real Trading adapter payload in canonical preview order, exact ItemID and account token; retry is idempotent', async () => {
    const preview = await readPresentationOrder(destination)
    const review = await reviewPresentationPublication([destination], 'order', 'operator')
    expect(revisions()).toHaveLength(0)
    const result = await executePresentationPublication(review.jobId, 'operator')
    expect(result!.outcomes[0]).toMatchObject({ status: 'applied', stamped: true })
    expect(revisions()).toHaveLength(1); expect(revisions()[0].ctx.oauthToken).toBe('token-b'); expect(revisions()[0].xml).toContain('<ItemID>100</ItemID>')
    const actual = parseVariationSpecificsSet(revisions()[0].xml)
    expect(Object.keys(actual)).toEqual(preview.axes.map(a => a.name)); expect(Object.values(actual)).toEqual(preview.axes.map(a => a.values))
    await executePresentationPublication(review.jobId, 'operator'); expect(revisions()).toHaveLength(1)
    expect(await executePresentationPublication(review.jobId, 'another-operator')).toBeNull()
    expect(fixture.state.tables.channelListing.slice(1).every(l => !l.platformAttributes.presentationPush)).toBe(true)
  })
  it('invalidates rule, family membership and theme changes after review before any marketplace write', async () => {
    for (const mutate of [() => fixture.state.tables.marketplace[0].schemaMapping.presentationRules[0].version++, () => fixture.state.tables.sharedListingMembership[0].status = 'REMOVED', () => fixture.state.tables.ebayDescriptionTheme[0].version++]) {
      const review = await reviewPresentationPublication([destination], 'order', 'operator'); mutate()
      expect((await executePresentationPublication(review.jobId, 'operator'))!.outcomes[0]).toMatchObject({ status: 'error', message: expect.stringMatching(/changed/) })
    }
    expect(revisions()).toHaveLength(0)
  })
  it('checkpoints partial failures and retries only the failed destination', async () => {
    const second = { productId: 'f2', marketplace: 'IT', accountId: 'b', aliasKey: '' }
    const review = await reviewPresentationPublication([destination, second], 'order', 'operator')
    fixture.state.fail.add('200')
    const first = await executePresentationPublication(review.jobId, 'operator')
    expect(first!.outcomes.map(o => o.status)).toEqual(['applied', 'error'])
    fixture.state.fail.delete('200')
    const next = await executePresentationPublication(review.jobId, 'operator')
    expect(next!.outcomes.map(o => o.status)).toEqual(['applied', 'applied'])
    expect(revisions().filter(c => c.xml.includes('<ItemID>100</ItemID>'))).toHaveLength(1)
  })
  it('recovers an expired attempt whose marketplace write succeeded before its checkpoint', async () => {
    const review = await reviewPresentationPublication([destination], 'order', 'operator')
    await executePresentationPublication(review.jobId, 'operator')
    const job = fixture.state.tables.bulkOperation.find(j => j.id === review.jobId)
    job.status = 'PRESENTATION_RUNNING'; job.expiresAt = new Date(Date.now() - 1); job.changes.outcomes = []
    const result = await executePresentationPublication(review.jobId, 'operator')
    expect(result!.outcomes[0]).toMatchObject({ status: 'unchanged', stamped: true }); expect(revisions()).toHaveLength(1)
  })
  it('never stamps newer local content after the reviewed payload was submitted', async () => {
    const review = await reviewPresentationPublication([destination], 'order', 'operator')
    fixture.state.afterRevision = () => { fixture.state.tables.channelListing[0].version++ }
    expect((await executePresentationPublication(review.jobId, 'operator'))!.outcomes[0].status).toBe('superseded')
    expect(fixture.state.tables.channelListing[0].platformAttributes.presentationPush).toBeUndefined()
  })
  it('previews/publishes the selected theme and description without assigning a shared definition, with read-back and scoped staleness', async () => {
    const before = structuredClone(fixture.state.tables)
    const preview = await readPresentationDescription(destination)
    expect(preview.html).toContain('f1 b IT alt'); expect(preview.stale).toBe(true)
    const review = await reviewPresentationPublication([destination], 'description', 'operator')
    expect((await executePresentationPublication(review.jobId, 'operator'))!.outcomes[0]).toMatchObject({ status: 'applied', stamped: true })
    expect(revisions()[0].xml).toContain(preview.html); expect(revisions()[0].xml).not.toContain('<Variations>')
    expect((await readPresentationDescription(destination)).stale).toBe(false)
    expect(fixture.state.tables.ebayDescriptionTheme).toEqual(before.ebayDescriptionTheme); expect(fixture.state.tables.channelListing.slice(1)).toEqual(before.channelListing.slice(1))
    fixture.state.tables.ebayDescriptionTheme[0].version++; expect((await readPresentationDescription(destination)).stale).toBe(true)
  })
  it('keeps Inventory-managed review excluded and refuses an actual unreviewed full Inventory push of a new product order', async () => {
    await save({ reset: true })
    fixture.state.tables.channelListing[0].platformAttributes.__offerIds = { EBAY_IT: 'offer' }
    const review = await reviewPresentationPublication([destination], 'description', 'operator')
    expect(review.targets).toEqual([]); expect(review.excluded[0].status).toBe('inventory-managed')
    const rows = await buildEbayFamilyRows('f1', 'IT', { channelConnectionId: 'b', aliasKey: 'alt' })
    await expect(pushVariationGroup('f1', rows, 'IT', 'token-b', 'b', {}, 'https://fixture.invalid', 'EBAY_IT', async (_s: string, q: number) => q)).rejects.toThrow(/Full Inventory/)
    expect(revisions()).toHaveLength(0)
  })
  it('exposes exact-account usage/staleness and durable review routes through the registered plugins', async () => {
    const app = Fastify(); await app.register(themeRoutes); await app.register(publicationRoutes)
    const usage = await app.inject({ method: 'GET', url: '/ebay/description-themes/usage?marketplace=IT&accountId=b&aliasKey=alt&productId=f1' })
    expect(usage.statusCode).toBe(200); expect(usage.json()).toMatchObject({ total: 1, byThemeId: { theme: 1 }, scope: 'selected listing' })
    const preview = await app.inject({ method: 'GET', url: '/ebay/presentation-description?marketplace=IT&accountId=b&aliasKey=alt&productId=f1' })
    expect(preview.statusCode).toBe(200); expect(preview.json()).toMatchObject({ listingId: 'f1-b-IT-alt', stale: true, html: expect.stringContaining('f1 b IT alt') })
    const status = await app.inject({ method: 'GET', url: '/ebay/description-themes/staleness?marketplace=IT&accountId=b&aliasKey=alt&productIds=f1' })
    expect(status.statusCode).toBe(200); expect(status.json().products[0]).toMatchObject({ listingId: 'f1-b-IT-alt', stale: true })
    const denied = await app.inject({ method: 'POST', url: '/ebay/description-push', payload: { productIds: ['f1'] } }); expect(denied.statusCode).toBe(409)
    const review = await app.inject({ method: 'POST', url: '/ebay/presentation-publications/review', payload: { destinations: [destination], operation: 'order' } }); expect(review.statusCode).toBe(200)
    const run = await app.inject({ method: 'POST', url: `/ebay/presentation-publications/${review.json().jobId}/execute` }); expect(run.statusCode).toBe(200); expect(run.json().outcomes[0].status).toBe('applied')
    await app.close()
  })
  it('includes Date values in revision tokens, including alias lifecycle changes', () => {
    expect(mappingToken({ updatedAt: new Date(1) })).not.toBe(mappingToken({ updatedAt: new Date(2) }))
  })
})

it.skipIf(process.env.NEXUS_SESSION_THREE_BROWSER !== '1')('serves the isolated presentation browser fixture on 4103', async () => {
  const { writeFile } = await import('node:fs/promises')
  const { resolveBatch } = await import('./pim/mapping/resolve-batch.service.js')
  const { default: cockpitRoutes } = await import('../routes/ebay-cockpit.routes.js')
  const t = fixture.state.tables
  t.productListingAlias.push({ id: 'alt-a', productId: 'f1', channelConnectionId: 'a', marketplace: 'IT', channel: 'EBAY', status: 'ACTIVE', updatedAt: new Date() })
  t.channelListing.push(listing('f1', 'a', 'IT', 'alt-a', '110'), listing('f1', 'a', 'DE', '', '111'), listing('f2', 'a', 'IT', '', '201'))
  fixture.state.remote.set('110', live()); fixture.state.remote.set('111', live()); fixture.state.remote.set('201', live())
  const app = Fastify()
  app.addHook('onRequest', async request => { (request as any).authUser = { id: 'operator' } })
  await app.register(cockpitRoutes, { prefix: '/api' }); await app.register(themeRoutes, { prefix: '/api' }); await app.register(publicationRoutes, { prefix: '/api' })
  app.get('/api/auth/csrf', async () => ({ csrfToken: 'isolated-presentation' }))
  app.get('/api/auth/me', async () => ({ user: { id: 'operator', displayName: 'Session 3 fixture', email: 'fixture@example.test', roleKeys: ['owner'] }, isOwner: true, permissions: ['products.view', 'products.edit', 'channels.sync'] }))
  app.get('/api/products/:id', async (request: any, reply) => t.product.find(p => p.id === request.params.id) ?? reply.code(404).send({ error: 'Isolated fixture product not found' }))
  app.get('/api/products/:id/readiness', async () => ({ scope: 'EBAY', marketplaces: [], states: [], total: 0 }))
  app.get('/api/products/:id/children', async (request: any) => ({ children: t.product.filter(p => p.parentId === request.params.id) }))
  app.get('/api/marketplaces/grouped', async () => ({ EBAY: [{ id: 'it', code: 'IT', channel: 'EBAY', name: 'eBay Italy', language: 'it' }, { id: 'de', code: 'DE', channel: 'EBAY', name: 'eBay Germany', language: 'de' }] }))
  app.get('/api/connections', async () => ({ connections: t.channelConnection.map(c => ({ ...c, channel: c.channelType, accountLabel: `Fixture account ${c.id}` })) }))
  app.get('/api/products/:id/studio/sheet', async (request: any) => {
    const id = request.params.id, marketplace = request.query.market ?? 'IT', accountId = request.query.accountId ?? 'a'
    const listings = t.channelListing.filter(l => l.productId === id && l.marketplace === marketplace && l.channelConnectionId === accountId)
    const product = t.product.find(p => p.id === id)
    const rows = []
    for (const l of listings) {
      const mapped = await resolveBatch({ channel: 'EBAY', marketplace, channelConnectionId: accountId, aliasKey: l.aliasKey, productIds: [id], fieldKeys: ['descriptionThemeId'], includeCatalogue: false })
      const cell = mapped.products[0]?.cells.descriptionThemeId
      rows.push({ ...product, version: 1, aliasId: l.aliasKey || null, rowKind: 'parent', childCount: t.product.filter(p => p.parentId === id).length, listing: { ...l, listingStatus: 'ACTIVE', isPublished: true, offerActive: true, follows: {} }, readiness: { state: 'ready', issues: [] }, values: { descriptionThemeId: { value: cell?.value ?? null, mapped: cell, editable: true, inherited: !Object.hasOwn(l.platformAttributes, 'descriptionThemeId'), pinned: Object.hasOwn(l.platformAttributes, 'descriptionThemeId'), writeTarget: 'channelListing', writeVerb: 'channel', writeField: 'descriptionThemeId', source: 'default', layer: 'master' } } })
    }
    return { scope: { kind: 'channel', channel: 'EBAY', marketplace, label: `eBay ${marketplace}`, connectionId: accountId, locale: marketplace === 'IT' ? 'it' : 'de' }, family: { ...product, variationAxes: ['Color', 'Size'] }, columns: [], rows, aliases: listings.map((l, i) => ({ id: l.aliasKey || null, label: l.aliasKey ? 'Alternate fixture listing' : 'Primary listing', position: i, externalListingId: l.externalListingId, rowIds: [id], readiness: { state: 'ready', errors: 0, warnings: 0 } })), meta: { schemaMissing: [], schemaAge: [], droppedKeys: [], tookMs: 0 }, readiness: {} }
  })
  // Isolated adapter for the coordinator-owned sheet contract; that writer is verified in its
  // own integration suite. This browser fixture records the exact request and affected listing.
  app.patch('/api/products/bulk', async (request: any, reply) => {
    const { changes, marketplaceContexts, expectedVersion } = request.body
    const context = marketplaceContexts?.[0]
    const change = changes?.[0]
    const l = t.channelListing.find(l => l.productId === change?.id && l.marketplace === context?.marketplace && l.channelConnectionId === context?.accountId && l.aliasKey === context?.aliasKey)
    if (!l || l.version !== expectedVersion || change.target !== 'channel' || change.field !== 'descriptionThemeId') return reply.code(409).send({ error: 'Isolated assignment destination/version refused' })
    if (change.intent === 'reset') delete l.platformAttributes.descriptionThemeId; else l.platformAttributes.descriptionThemeId = change.value
    l.version++; fixture.state.writes.push({ model: 'channelListing', id: l.id, assignment: structuredClone(request.body) })
    return { success: true, currentVersion: l.version, versionOf: 'channelListing', results: [{ id: l.productId, success: true }] }
  })
  app.get('/api/fixture/evidence', async () => ({ products: t.product, listings: t.channelListing, themes: t.ebayDescriptionTheme, writes: fixture.state.writes, marketplaceCalls: fixture.state.calls.filter(c => c.operation) }))
  app.setNotFoundHandler(async request => ({ fixture: true, path: request.url, data: [], items: [], profiles: [], connections: [], alerts: [], notifications: [], count: 0, total: 0 }))
  const port = Number(process.env.NEXUS_SESSION_THREE_PORT ?? 4103)
  await app.listen({ host: '127.0.0.1', port })
  await writeFile('/tmp/nexus-session-three-presentation-ready.json', JSON.stringify({ port, pid: process.pid }))
  await new Promise<void>(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve) })
  await app.close()
}, 3_600_000)
