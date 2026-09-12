import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
const { aspects, conditions } = vi.hoisted(() => ({ aspects: vi.fn(), conditions: vi.fn() }))
vi.mock('../marketplaces/amazon.service.js', () => ({ AmazonService: class {} }))
vi.mock('../ebay-category.service.js', () => ({ EbayCategoryService: class {
  getCategoryAspectsRich = aspects
  getItemConditionPolicies = conditions
} }))
import { CategorySchemaService } from './schema-sync.service.js'
const prisma = { categorySchema: { upsert: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() }, schemaChange: { create: vi.fn() } }
const service = new CategorySchemaService(prisma as never, {} as never)
beforeEach(() => {
  vi.resetAllMocks()
  aspects.mockResolvedValue([{ name: 'Taglia', englishName: 'Size', dataType: 'STRING', mode: 'SELECTION_ONLY', usage: 'RECOMMENDED', required: false, values: ['S'], cardinality: 'SINGLE', variantEligible: true, maxLength: 50 }])
  conditions.mockResolvedValue([{ conditionId: '2990', conditionDescription: 'Pre-owned - Excellent' }])
  prisma.categorySchema.upsert.mockImplementation(async args => args.create)
})
afterEach(() => vi.unstubAllGlobals())
it('refreshes an exact category and stores normalized conditions with a content fingerprint', async () => {
  const row = await service.getSchema({ channel: 'EBAY', marketplace: 'EBAY_IT', productType: '177104' }, { force: true })
  expect(aspects).toHaveBeenCalledWith('177104', 'IT', { forceRefresh: true, throwOnError: true })
  expect(conditions).toHaveBeenCalledWith('177104', 'IT', { forceRefresh: true, throwOnError: true })
  expect(row.schemaVersion).toMatch(/^[a-f0-9]{64}$/)
  expect(row.schemaDefinition.conditions[0].value).toBe('PRE_OWNED_EXCELLENT')
  expect(row.schemaDefinition.aspects[0]).toMatchObject({ enumMode: 'strict', required: false, recommended: true, localizedName: 'Taglia' })
})
it('preserves the usable cache when either provider request fails', async () => {
  conditions.mockRejectedValue(new Error('Authentication expired'))
  await expect(service.getSchema({ channel: 'EBAY', marketplace: 'IT', productType: '177104' }, { force: true })).rejects.toThrow('Authentication expired')
  expect(prisma.categorySchema.upsert).not.toHaveBeenCalled()
})
it('refuses a missing category before contacting eBay', async () => {
  await expect(service.getSchema({ channel: 'EBAY', marketplace: 'IT', productType: '*' }, { force: true })).rejects.toThrow('leaf category')
  expect(aspects).not.toHaveBeenCalled()
})

it('uses the normalized eBay coordinate for cache reads as well as writes', async () => {
  prisma.categorySchema.findFirst.mockResolvedValue({ id: 'cached' })
  expect(await service.getSchema({ channel: 'EBAY', marketplace: 'EBAY_IT', productType: '177104' })).toEqual({ id: 'cached' })
  expect(prisma.categorySchema.findFirst.mock.calls[0][0].where.marketplace).toBe('IT')
  expect(aspects).not.toHaveBeenCalled()
})

const query = { channel: 'AMAZON' as const, marketplace: 'IT', productType: 'COAT' }
function amazonFixture(body: string) {
  const callAPI = vi.fn().mockResolvedValue({ productType: 'COAT', productTypeVersion: { version: 'RELEASE_1' }, requirementsEnforced: 'ENFORCED', schema: {
    link: { resource: 'https://schemas.example/coat', verb: 'GET' }, checksum: createHash('md5').update(body).digest('base64'),
  } })
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(body)))
  return { callAPI, service: new CategorySchemaService(prisma as never, { isConfigured: () => true, getClient: async () => ({ callAPI }) } as never) }
}

it('rotates fingerprints when Amazon changes contents under an unchanged provider version', async () => {
  const first = amazonFixture('{"properties":{"title":{"type":"string"}}}')
  const initial = await first.service.refreshSchema(query)
  const second = amazonFixture('{"properties":{"title":{"type":"string","maxLength":80}}}')
  prisma.categorySchema.findFirst.mockResolvedValue(initial)
  const changed = await second.service.refreshSchema(query)
  expect(changed.schemaVersion).not.toBe(initial.schemaVersion)
  expect(changed.schemaDefinition.__schemaProvenance).toMatchObject({ scope: 'marketplace', providerVersion: 'RELEASE_1' })
  expect(second.callAPI.mock.calls[0][0].query).toMatchObject({ requirementsEnforced: 'ENFORCED', marketplaceIds: ['APJ6JRA9NG5V4'] })
  expect(second.callAPI.mock.calls[0][0].query).not.toHaveProperty('sellerId')
})

it('preserves cached rows and change history when checksum validation fails', async () => {
  const fixture = amazonFixture('{"properties":{"title":{}}}')
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"properties":{"tampered":{}}}')))
  await expect(fixture.service.refreshSchema(query)).rejects.toThrow('checksum mismatch')
  expect(prisma.categorySchema.upsert).not.toHaveBeenCalled()
  expect(prisma.categorySchema.update).not.toHaveBeenCalled()
  expect(prisma.schemaChange.create).not.toHaveBeenCalled()
})

it('renews unchanged content without rotating its fingerprint or logging false changes', async () => {
  const fixture = amazonFixture('{"properties":{"title":{}}}')
  const initial = await fixture.service.refreshSchema(query)
  prisma.categorySchema.findUnique.mockResolvedValue({ ...initial, id: 'existing' })
  prisma.categorySchema.update.mockImplementation(async args => ({ ...initial, ...args.data }))
  const renewed = await fixture.service.refreshSchema(query)
  expect(renewed.schemaVersion).toBe(initial.schemaVersion)
  expect(prisma.categorySchema.upsert).toHaveBeenCalledTimes(1)
  expect(prisma.schemaChange.create).not.toHaveBeenCalled()
})
