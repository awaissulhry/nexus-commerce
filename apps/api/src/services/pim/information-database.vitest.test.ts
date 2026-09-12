import { beforeAll, afterAll, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
// This isolated server uses routes whose request types are augmented by app startup.
import type {} from '../../lib/auth/guards.js'
import type {} from '@fastify/multipart'
import type {} from '@fastify/cookie'
import type {} from '@fastify/rate-limit'
const fixture = vi.hoisted(() => ({ database: null as any, mode: '' }))
vi.mock('@nexus/database', async () => { const { formulaDatabase } = await import('../../test-support/formula-database.js'); fixture.database = await formulaDatabase(); return { default: fixture.database.client } })
vi.mock('../../lib/queue.js', () => ({ addJobSafely: vi.fn().mockResolvedValue({ enqueued: false }), resolveRedisTarget: () => null, outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: null }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
vi.mock('../categories/seller-schema.service.js', async () => {
  const { amazonSpecFromDefinition } = await import('./channel-specs/amazon.js')
  const attribute = (type = 'string', extra = {}) => ({ type: 'array', items: { type: 'object', properties: { value: { type, ...extra } }, required: ['value'] } })
  return { amazonSellerSpec: async (_account: string, marketplace: string, productType: string) => amazonSpecFromDefinition({ marketplace, productType, fetchedAt: new Date(), schemaVersion: 'controlled-fixture', schemaDefinition: {
    type: 'object', properties: { item_name: attribute(), description: attribute(), bullet_point: attribute(), brand: attribute(), mode: attribute('string', { enum: ['standard', 'restricted'] }), rating: attribute('number', { minimum: 0 }), enabled: attribute('boolean'),
      department: attribute('string', { enum: ['mens', 'womens'] }) }, required: ['item_name', 'brand'],
    allOf: [{ if: { required: ['mode'], properties: { mode: { contains: { required: ['value'], properties: { value: { const: 'restricted' } } } } } }, then: { properties: { description: attribute('string', { maxUtf8ByteLength: 6 }) } } },
      { if: { required: ['mode'], properties: { mode: { contains: { properties: { value: { const: 'standard' } } } } } }, then: { required: ['department'] } }],
  } }) }
})
vi.mock('../etsy/read-client.js', () => ({ etsyReader: async (accountId: string) => ({ shopId: accountId === 'etsy-b' ? 2 : 1, get: async (path: string) => {
  if (path.includes('shipping-profiles')) return { count: 1, results: [{ shipping_profile_id: accountId === 'etsy-b' ? 201 : 101, title: `${accountId} Standard shipping` }] }
  if (path.includes('sections')) return { count: 1, results: [{ shop_section_id: 301, title: 'Jackets' }] }
  if (path.includes('policies/return')) return { count: 1, results: [{ return_policy_id: 401, accepts_returns: true, accepts_exchanges: false, return_deadline: 30 }] }
  return { count: 1, results: [{ readiness_state_id: 501, readiness_state: 'ready_to_ship', processing_days_display_label: '1–3 days' }] }
} }) }))
vi.mock('../shopify/admin-client.js', async importOriginal => ({ ...await importOriginal<any>(), shopifyAdmin: async (accountId: string) => ({ graphql: async () => { throw new Error(`Unconfigured Shopify fixture request for ${accountId}`) } }) }))
vi.mock('../shopify/linked-products-gateway.js', async importOriginal => ({ ...await importOriginal<any>(), readLinkedStoreSchema: async () => (await import('../../test-support/information-shopify-fixture.js')).informationShopifySchema }))
vi.mock('../shopify/information-gateway.js', async importOriginal => ({ ...await importOriginal<any>(), readInformation: async (_graphql: any, ids: string[], _schema: any, locale: string) => (await import('../../test-support/information-shopify-fixture.js')).shopifyFixtureSnapshot(ids, locale) }))
import prisma from '../../db.js'
import productRoutes from '../../routes/products.routes.js'
import formulaRoutes from '../../routes/cell-formula.routes.js'
import globalRoutes from '../../routes/pim-global.routes.js'
import studioRoutes from '../../routes/product-studio.routes.js'
import { estyRoutes } from '../../routes/etsy.js'
import { dictionaryCorrectionPreview, applyDictionaryCorrection } from './information-dictionary-correction.js'
const app = Fastify()
const request = async (method: any, url: string, payload?: any) => app.inject({ method, url, ...(payload ? { payload } : {}) })
const sheet = async (channel?: string, accountId?: string, locale = 'it') => {
  const response = await request('GET', `/api/products/store-demo/studio/sheet?scope=${channel ? 'channel' : 'master'}&market=${['ETSY', 'SHOPIFY'].includes(channel ?? '') ? 'GLOBAL' : 'IT'}&locale=${locale}${channel ? `&channel=${channel}&accountId=${accountId}` : ''}`)
  expect(response.statusCode, response.body).toBe(200); return response.json()
}
const property = (id = 200, values = [{ value_id: 1, name: 'Black' }, { value_id: 2, name: 'Red' }]) => ({ property_id: id, name: 'color', display_name: 'Colour', is_required: true, supports_attributes: true, supports_variations: false, is_multivalued: true, max_values_allowed: 2, scales: [], selected_values: [], possible_values: values })
beforeAll(async () => {
  await prisma.productFamily.create({ data: { id: 'information-family', code: 'information_jackets', label: 'Jackets' } })
  await prisma.attributeGroup.create({ data: { id: 'information-group', code: 'information_fixture', label: 'Specifications' } })
  for (const [code, type, extra] of [
    ['care_instructions', 'textarea', {}], ['fabric_type', 'textarea', {}], ['manufacturer_warranty', 'textarea', {}], ['color', 'select', {}], ['size', 'text', {}],
    ['batteries_included', 'boolean', {}], ['battery_type', 'text', { requiredWhen: { field: 'batteries_included', equals: true } }],
    ['released_on', 'date', {}], ['thermal_rating', 'number', { shape: 'measure', unitOptions: ['celsius', 'fahrenheit'], minimum: -50, maximum: 60 }],
  ] as const) {
    await prisma.customAttribute.create({ data: { id: `dict-${code}`, code, label: code.replace(/_/g, ' '), type, groupId: 'information-group', validation: extra as any } })
    await prisma.familyAttribute.create({ data: { attributeId: `dict-${code}`, familyId: 'information-family', channels: [] } })
  }
  await prisma.attributeOption.createMany({ data: [{ attributeId: 'dict-color', code: 'black', label: 'Black', metadata: { labels: { de: 'Schwarz', it: 'Nero' } } }, { attributeId: 'dict-color', code: 'red', label: 'Red', metadata: { labels: { de: 'Rot', it: 'Rosso' } } }] })
  const preview = await dictionaryCorrectionPreview(prisma as any, ['information-family'])
  await applyDictionaryCorrection(prisma as any, ['information-family'], preview.fingerprint)
  await prisma.product.createMany({ data: [
    { id: 'store-demo', sku: 'INFO-JACKET', name: 'Information jacket', isParent: true, basePrice: 50, brand: 'Nexus', familyId: 'information-family', productType: 'JACKET', localizedContent: { it: { title: 'Giacca', description: 'Descrizione completa' }, en: { title: 'English jacket' } }, categoryAttributes: { care_instructions: 'Lavare a mano', batteries_included: false, material_composition: [{ material: 'cotton', percentage: 80 }, { material: 'polyester', percentage: 20 }] } },
    ...['one', 'two'].map((id, i) => ({ id: `row-${id}`, sku: `INFO-${id.toUpperCase()}`, name: `${id} jacket`, parentId: 'store-demo', basePrice: 50, brand: 'Nexus', familyId: 'information-family', productType: 'JACKET', variantAttributes: { color: i ? 'red' : 'black', size: i ? 'L' : 'M' }, localizedContent: { it: { title: `Giacca ${id}`, description: 'Descrizione completa' } } })),
  ] })
  for (const channel of ['AMAZON', 'EBAY', 'ETSY', 'SHOPIFY']) {
    const marketplace = ['ETSY', 'SHOPIFY'].includes(channel ?? '') ? 'GLOBAL' : 'IT'
    await prisma.marketplace.create({ data: { channel, code: marketplace, name: `${channel} ${marketplace}`, region: ['ETSY', 'SHOPIFY'].includes(channel) ? 'GLOBAL' : 'EU', currency: 'EUR', language: ['ETSY', 'SHOPIFY'].includes(channel) ? 'en' : 'it' } })
    for (const account of ['a', 'b']) {
      const accountId = `${channel.toLowerCase()}-${account}`
      await prisma.channelConnection.create({ data: { id: accountId, channelType: channel, isPrimary: account === 'a', isActive: true } })
      for (const position of [0, 1, 2]) {
        const aliasKey = position ? `${accountId}-${position}` : ''
        if (aliasKey) await prisma.productListingAlias.create({ data: { id: aliasKey, productId: 'store-demo', channel: channel as any, marketplace, channelConnectionId: accountId, label: `Listing ${position}`, position } })
        for (const productId of ['store-demo', 'row-one', 'row-two']) await prisma.channelListing.create({ data: { id: `${accountId}-${position}-${productId}`, productId, channel: channel as any, marketplace, region: ['ETSY', 'SHOPIFY'].includes(channel) ? 'GLOBAL' : 'EU', channelMarket: `${channel}_${marketplace}`, channelConnectionId: accountId, aliasId: aliasKey || null, aliasKey,
          title: `${accountId} ${position} title`, platformAttributes: channel === 'ETSY' ? { language: 'en', title: `${accountId} listing ${position}`, taxonomy_id: 1, who_made: 'i_did', when_made: '2020_2026', is_supply: false, etsyProperties: { 200: { values: ['Black'] } } } : channel === 'EBAY' ? { categoryId: '100', itemSpecifics: { Colour: 'Black' }, conditionId: '1000' } : { productType: 'JACKET' } } })
      }
    }
  }
  for (const account of ['a', 'b']) for (const position of [0, 1, 2]) {
    const remote = (account === 'a' ? 100 : 200) + position
    for (const [index, productId] of ['store-demo', 'row-one', 'row-two'].entries()) await prisma.channelListing.update({ where: { id: `shopify-${account}-${position}-${productId}` }, data: { externalListingId: String(remote), platformAttributes: index ? { variantId: String(remote * 10 + index) } : {} } })
  }
  for (const [category, values] of [['1', [{ value_id: 1, name: 'Black' }, { value_id: 2, name: 'Red' }]], ['2', [{ value_id: 3, name: 'Blue' }]]] as const) await prisma.categorySchema.create({ data: { channel: 'ETSY', marketplace: 'GLOBAL', productType: category, schemaVersion: 'fixture', schemaDefinition: { count: 1, results: [property(200, values as any)] }, expiresAt: new Date('2099-01-01') } })
  await prisma.categorySchema.create({ data: { channel: 'EBAY', marketplace: 'IT', productType: '100', schemaVersion: 'fixture', schemaDefinition: { aspects: [{ id: 'Colour', label: 'Colour', localizedName: 'Colour', englishName: 'Colour', kind: 'select', options: ['Black', 'Red'], enumMode: 'strict', required: true, variantEligible: true }], conditions: [{ id: '1000', label: 'New' }] }, expiresAt: new Date('2099-01-01') } })
  await app.register(productRoutes, { prefix: '/api' }); await app.register(globalRoutes, { prefix: '/api' }); await app.register(formulaRoutes, { prefix: '/api' }); await app.register(studioRoutes, { prefix: '/api' }); await app.register(estyRoutes, { prefix: '/api' });
  const { shopifyLinkedProductsRoutes } = await import('../../routes/images/shopify-linked-products.routes.js')
  await app.register(shopifyLinkedProductsRoutes, { prefix: '/api' }); await app.ready()
}, 60_000)

afterAll(async () => {
  if (process.env.INFORMATION_BROWSER_FIXTURE === '1') {
    await app.listen({ host: '127.0.0.1', port: 4116 })
    process.stdout.write('Information disposable API ready at http://127.0.0.1:4116\n')
    await new Promise<void>(resolve => process.once('SIGINT', resolve))
  }
  await app.close(); await fixture.database.close()
}, process.env.INFORMATION_BROWSER_FIXTURE === '1' ? 3_600_000 : 30_000)

it('reads the real common sheet for all five scopes with exact aliases and accounts', async () => {
  const master = await sheet()
  expect(master.columns.some((column: any) => column.key === 'material_composition')).toBe(true)
  expect(master.rows).toHaveLength(3)
  for (const channel of ['AMAZON', 'EBAY', 'ETSY', 'SHOPIFY']) for (const suffix of ['a', 'b']) {
    const data = await sheet(channel, `${channel.toLowerCase()}-${suffix}`, channel === 'ETSY' ? 'de' : channel === 'SHOPIFY' ? 'en' : 'it')
    expect(data.scope.connectionId).toBe(`${channel.toLowerCase()}-${suffix}`)
    expect(data.rows).toHaveLength(9)
    expect(data.aliases).toHaveLength(3)
  }
})
it('routes unavailable Etsy requirements to the actual category selector', async () => {
  const original = await prisma.channelListing.findUniqueOrThrow({ where: { id: 'etsy-a-0-store-demo' } })
  await prisma.channelListing.update({ where: { id: original.id }, data: { platformAttributes: { ...(original.platformAttributes as object), taxonomy_id: null } } })
  try {
    const data = await sheet('ETSY', 'etsy-a')
    const row = data.rows.find((row: any) => row.id === 'store-demo' && !row.aliasId)
    const issue = row.readiness.issues.find((issue: any) => issue.label === 'Channel requirements')
    expect(issue).toMatchObject({ key: 'taxonomy_id' })
    expect(data.columns.some((column: any) => column.key === issue.key)).toBe(true)
  } finally { await prisma.channelListing.update({ where: { id: original.id }, data: { platformAttributes: original.platformAttributes as any } }) }
})
it('refuses legacy Shared localized writes without changing source text or versions', async () => {
  const current = await prisma.product.findUniqueOrThrow({ where: { id: 'store-demo' } })
  const response = await request('PATCH', '/api/products/store-demo/global', { expectedVersion: current.version, patch: { de: { care_instructions: 'Handwäsche', title: 'Deutsche Jacke' } } })
  expect(response.statusCode, response.body).toBe(409)
  expect(response.json().error).toContain('legacy and read-only')
  expect(await prisma.product.findUniqueOrThrow({ where: { id: 'store-demo' } })).toEqual(current)
  const conflict = await request('PATCH', '/api/products/store-demo/global', { expectedVersion: current.version, patch: { de: { title: 'Wrong version' } } })
  expect(conflict.statusCode).toBe(409)
})
it('refuses Amazon conditional serialized byte errors before saving while permitting an incomplete draft', async () => {
  const payload = { marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'IT', accountId: 'amazon-b', aliasKey: 'amazon-b-1', locale: 'it' }], changes: [{ id: 'row-one', field: 'attr_mode', value: ['restricted'], target: 'channel' }] }
  const response = await request('PATCH', '/api/products/bulk', payload)
  expect(JSON.stringify(response.json())).toContain('maxUtf8ByteLength')
  const row = await prisma.channelListing.findUniqueOrThrow({ where: { id: 'amazon-b-1-row-one' } })
  expect(row.overrideData).not.toMatchObject({ mode: 'restricted' })
})
it('counts conditional requirements in the actual sheet and alias summary before and after filling them', async () => {
  const destination = { marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'IT', accountId: 'amazon-b', aliasKey: 'amazon-b-2', locale: 'it' }] }
  const mode = await request('PATCH', '/api/products/bulk', { ...destination, changes: [{ id: 'row-two', field: 'attr_mode', value: ['standard'], target: 'channel' }] })
  expect(mode.json().errors ?? [], mode.body).toEqual([])
  const before = await sheet('AMAZON', 'amazon-b')
  const rowBefore = before.rows.find((row: any) => row.id === 'row-two' && row.aliasId === 'amazon-b-2')
  const department = before.columns.find((column: any) => Object.values(column.channels ?? {}).some((facts: any) => facts.attribute === 'department'))
  expect(rowBefore.completeness.required.missing, JSON.stringify({ mode: rowBefore.values.mode, department: rowBefore.values[department.key] })).toContainEqual(expect.objectContaining({ key: department.key }))
  expect(rowBefore.values[department.key].mapped).toMatchObject({ requiredByRule: true, mappingErrors: [] })
  const saved = await request('PATCH', '/api/products/bulk', { ...destination, changes: [{ id: 'row-two', field: department.writeField, value: ['mens'], target: 'channel' }] })
  expect(saved.json().errors ?? [], saved.body).toEqual([])
  const after = await sheet('AMAZON', 'amazon-b')
  const rowAfter = after.rows.find((row: any) => row.id === 'row-two' && row.aliasId === 'amazon-b-2')
  expect(rowAfter.values[department.key].mapped.requiredByRule).toBe(true)
  expect(rowAfter.completeness.required.total).toBe(rowBefore.completeness.required.total)
  expect(rowAfter.completeness.required.filled).toBe(rowBefore.completeness.required.filled + 1)
  expect(after.aliases.find((alias: any) => alias.id === 'amazon-b-2').readiness.percent).toBeGreaterThan(before.aliases.find((alias: any) => alias.id === 'amazon-b-2').readiness.percent)
})
it('writes Etsy stable value IDs and explicit empty lists on one alias, then reloads the selected category contract', async () => {
  const payload = { marketplaceContexts: [{ channel: 'ETSY', marketplace: 'GLOBAL', accountId: 'etsy-b', aliasKey: 'etsy-b-2', locale: 'de' }], changes: [{ id: 'row-one', field: 'attr_property_200', value: ['2'], target: 'channel' }] }
  const response = await request('PATCH', '/api/products/bulk', payload)
  expect(response.statusCode, response.body).toBe(200); expect(response.json().errors ?? [], response.body).toEqual([])
  const target = await prisma.channelListing.findUniqueOrThrow({ where: { id: 'etsy-b-2-row-one' } })
  expect(target.platformAttributes).toMatchObject({ etsyProperties: { 200: { values: ['2'] } } })
  const other = await prisma.channelListing.findUniqueOrThrow({ where: { id: 'etsy-b-1-row-one' } })
  expect(other.platformAttributes).toMatchObject({ etsyProperties: { 200: { values: ['Black'] } } })
  const currentSheet = await sheet('ETSY', 'etsy-b', 'de')
  const tagsColumn = currentSheet.columns.find((column: any) => Object.values(column.channels ?? {}).some((facts: any) => facts.key === 'tags'))
  const tagsCell = currentSheet.rows.find((row: any) => row.id === 'row-one' && row.aliasId === 'etsy-b-2').values[tagsColumn.key]
  const empty = await request('PATCH', '/api/products/bulk', { ...payload, changes: [{ id: 'row-one', field: tagsCell.writeField, value: [], target: 'channel' }] })
  expect(empty.json().errors ?? [], empty.body).toEqual([])
  expect((await prisma.channelListing.findUniqueOrThrow({ where: { id: target.id } })).platformAttributes).toMatchObject({ _etsyInformationLocales: { de: { tags: [] } } })
})

it('validates and saves eBay category options on an additional-account alias without changing siblings', async () => {
  const data = await sheet('EBAY', 'ebay-b')
  const column = data.columns.find((col: any) => Object.values(col.channels ?? {}).some((facts: any) => facts.attribute === 'aspect_Colour'))
  expect(column).toBeDefined()
  const row = data.rows.find((row: any) => row.id === 'row-one' && row.aliasId === 'ebay-b-1')
  const payload = { marketplaceContexts: [{ channel: 'EBAY', marketplace: 'IT', accountId: 'ebay-b', aliasKey: 'ebay-b-1', locale: 'it' }], changes: [{ id: 'row-one', field: row.values[column.key].writeField, value: 'Red', target: 'channel' }] }
  const saved = await request('PATCH', '/api/products/bulk', payload)
  expect(saved.json().errors ?? [], saved.body).toEqual([])
  const reread = await sheet('EBAY', 'ebay-b')
  expect(reread.rows.find((row: any) => row.id === 'row-one' && row.aliasId === 'ebay-b-1').values[column.key].value).toBe('Red')
  expect(reread.rows.find((row: any) => row.id === 'row-one' && row.aliasId === 'ebay-b-2').values[column.key].value).toBe('Black')
  const invalid = await request('PATCH', '/api/products/bulk', { ...payload, changes: [{ ...payload.changes[0], value: 'Unlisted colour' }] })
  expect(invalid.json().errors.length, invalid.body).toBeGreaterThan(0)
  expect((await sheet('EBAY', 'ebay-b')).rows.find((row: any) => row.id === 'row-one' && row.aliasId === 'ebay-b-1').values[column.key].value).toBe('Red')
})

it('creates no history for refused legacy translations and retains exact listing attribution', async () => {
  const { getCellHistory } = await import('./cell-history.service.js')
  const before = await prisma.product.findUniqueOrThrow({ where: { id: 'row-two' } })
  const global = await request('PATCH', '/api/products/row-two/global', { patch: { 'pt-BR': { title: 'Casaco brasileiro', bulletPoints: ['Primeiro', 'Segundo'] } } })
  expect(global.statusCode, global.body).toBe(409)
  expect(await prisma.product.findUniqueOrThrow({ where: { id: 'row-two' } })).toEqual(before)
  const history = await getCellHistory({ productId: 'row-two', fieldKey: 'name', locale: 'pt-BR' })
  expect(history.entries).toEqual([])
  expect((await getCellHistory({ productId: 'row-two', fieldKey: 'name', locale: 'de' })).entries).toEqual([])
  const slots = await getCellHistory({ productId: 'row-two', fieldKey: 'bulletPoints_2', locale: 'pt-br' })
  expect(slots.entries).toEqual([])
  const exact = await getCellHistory({ productId: 'row-one', fieldKey: 'property_200', channel: 'ETSY', marketplace: 'GLOBAL', accountId: 'etsy-b', aliasKey: 'etsy-b-2', locale: 'de' })
  expect(exact.entries.length).toBeGreaterThan(0)
  expect((await getCellHistory({ productId: 'row-one', fieldKey: 'property_200', channel: 'ETSY', marketplace: 'GLOBAL', accountId: 'etsy-a', aliasKey: '', locale: 'de' })).entries).toEqual([])
})
it('gives a nonlocalizable field one formula and preserves its authoring language across views', async () => {
  const first = await request('PUT', '/api/pim/formulas/product/row-two', { scope: 'master', market: 'IT', locale: 'it', fieldKey: 'manufacturer', expr: 'upper($brand)' })
  expect(first.statusCode, first.body).toBe(200)
  const second = await request('PUT', '/api/pim/formulas/product/row-two', { scope: 'master', market: 'IT', locale: 'de', fieldKey: 'manufacturer', expr: 'lower($brand)' })
  expect(second.statusCode, second.body).toBe(200)
  expect(second.json().formula.locale).toBe('it')
  expect(await prisma.cellFormula.count({ where: { productId: 'row-two', fieldKey: 'manufacturer' } })).toBe(1)
  const read = await request('POST', '/api/pim/formulas/batch', { scope: 'master', market: 'IT', locale: 'de', productIds: ['row-two'] })
  expect(read.statusCode, read.body).toBe(200)
  expect(JSON.stringify(read.json())).toContain('lower($brand)')
  const fallback = await request('POST', '/api/pim/formulas/preview', { productId: 'row-one', scope: 'master', market: 'IT', locale: 'de', fieldKey: 'description', expr: 'upper($name)' })
  expect(fallback.json()).toMatchObject({ ok: false, error: expect.stringContaining('needs current de content') })
})
it('saves typed family facts and revalidates category changes without deleting historical properties', async () => {
  const changed = await request('PATCH', '/api/products/bulk', { changes: [
    { id: 'row-one', field: 'attr_batteries_included', value: false },
    { id: 'row-one', field: 'attr_released_on', value: '2026-09-11' },
    { id: 'row-one', field: 'attr_thermal_rating', value: { value: 0, unit: 'celsius' } },
  ], marketplaceContexts: [{ marketplace: 'IT', locale: 'it' }] })
  expect(changed.json().errors ?? [], changed.body).toEqual([])
  const row = (await sheet()).rows.find((r: any) => r.id === 'row-one')
  expect(row.values.batteries_included.value).toBe(false)
  expect(row.values.thermal_rating.value).toEqual({ value: 0, unit: 'celsius' })
  expect(row.values.released_on.value).toBe('2026-09-11')
  const before = await prisma.channelListing.findUniqueOrThrow({ where: { id: 'etsy-b-2-row-one' } })
  const category = await request('PATCH', '/api/products/bulk', { marketplaceContexts: [{ channel: 'ETSY', marketplace: 'GLOBAL', accountId: 'etsy-b', aliasKey: 'etsy-b-2', locale: 'de' }], changes: [{ id: 'row-one', field: 'attr_taxonomy_id', value: 2, target: 'channel' }] })
  expect(category.json().errors ?? [], category.body).toEqual([])
  const after = await prisma.channelListing.findUniqueOrThrow({ where: { id: before.id } })
  expect((after.platformAttributes as any).etsyProperties).toEqual((before.platformAttributes as any).etsyProperties)
  const selected = (await sheet('ETSY', 'etsy-b', 'de')).rows.find((r: any) => r.id === 'row-one' && r.aliasId === 'etsy-b-2')
  expect(selected.values.property_200_1.mapped.errors.join(' ')).toMatch(/allowed|enum|value/i)
})
it('resolves every product in a channel family larger than 250 IDs', async () => {
  await prisma.product.create({ data: { id: 'large-information', sku: 'INFO-LARGE', name: 'Large family', basePrice: 50, isParent: true, productType: 'JACKET', familyId: 'information-family', brand: 'Nexus' } })
  await prisma.product.createMany({ data: Array.from({ length: 251 }, (_, i) => ({ id: `large-information-${i}`, sku: `INFO-LARGE-${i}`, name: `Large variant ${i}`, basePrice: 50, parentId: 'large-information', productType: 'JACKET', familyId: 'information-family', brand: 'Nexus' })) })
  await prisma.channelListing.createMany({ data: ['large-information', ...Array.from({ length: 251 }, (_, i) => `large-information-${i}`)].map(productId => ({ productId, channel: 'AMAZON', marketplace: 'IT', region: 'EU', channelMarket: 'AMAZON_IT', channelConnectionId: 'amazon-a', platformAttributes: { productType: 'JACKET' } })) })
  const response = await request('GET', '/api/products/large-information/studio/sheet?scope=channel&channel=AMAZON&market=IT&locale=it&accountId=amazon-a')
  expect(response.statusCode, response.body.slice(0,500)).toBe(200)
  const rows = response.json().rows
  expect(rows).toHaveLength(252)
  expect(rows.filter((row: any) => row.values.name.mapped)).toHaveLength(252)
  expect(new Set(rows.map((row: any) => row.id)).size).toBe(252)
}, 30_000)

it('saves Shopify native and typed definition drafts to exact product/variant owners on additional-account aliases', async () => {
  const data = await sheet('SHOPIFY', 'shopify-b', 'en')
  const parent = data.rows.find((row: any) => row.id === 'store-demo' && row.aliasId === 'shopify-b-1')
  const variant = data.rows.find((row: any) => row.id === 'row-one' && row.aliasId === 'shopify-b-1')
  const flag = data.columns.find((col: any) => col.shopifyField?.definition?.key === 'flag').key
  const price = data.columns.find((col: any) => col.shopifyField?.id === 'price').key
  expect(variant.values[price].shopifyWrite.ownerId).toBe('gid://shopify/ProductVariant/2011')
  const title = data.columns.find((col: any) => col.shopifyField?.id === 'title').key
  expect(variant.values[title].writable).toBe(false)
  expect(variant.listing.isPublished).toBe(false)
  expect(data.aliases.every((alias: any) => alias.isPublished === false)).toBe(true)
  expect(variant.completeness.required.total).toBe(0)
  expect(variant.readiness.issues.some((issue: any) => issue.key === title)).toBe(false)
  const { saveShopifySheetCells } = await import('../shopify/channel-sheet.service.js')
  const scope = { accountId: 'shopify-b', listingId: 'shopify-b-1-store-demo', market: 'GLOBAL' as const, locale: 'en' }
  const cells = [{ colId: title, ...parent.values[title].shopifyWrite, value: 'Saved Shopify alias', intent: 'set' }, { colId: flag, ...parent.values[flag].shopifyWrite, value: 'true', intent: 'set' }]
  const response = await request('POST', '/api/products/store-demo/shopify-linked/cells?' + new URLSearchParams(scope), { cells })
  expect(response.statusCode, response.body).toBe(200)
  const saved = response.json()
  expect(saved.ok, response.body).toBe(true)
  const { getCellHistory } = await import('./cell-history.service.js')
  const history = await getCellHistory({ productId: 'store-demo', fieldKey: title, channel: 'SHOPIFY', marketplace: 'GLOBAL', accountId: 'shopify-b', aliasKey: 'shopify-b-1', locale: 'en' })
  expect(history.entries[0].next).toBe('Saved Shopify alias')
  const reread = await sheet('SHOPIFY', 'shopify-b', 'en')
  expect(reread.rows.flatMap((row: any) => row.readiness.issues).filter((issue: any) => issue.severity === 'error')).toEqual([])
  expect(reread.rows.find((row: any) => row.id === 'store-demo' && row.aliasId === 'shopify-b-1').values[title].value).toBe('Saved Shopify alias')
  expect(reread.rows.find((row: any) => row.id === 'store-demo' && row.aliasId === 'shopify-b-2').values[title].value).not.toBe('Saved Shopify alias')
  const conflict = await saveShopifySheetCells('store-demo', scope, { cells: [{ ...cells[0], value: 'Stale overwrite' }] }, null)
  expect(conflict.ok).toBe(false)
  expect(conflict.cells[title].reason).toContain('Another editor')
})
