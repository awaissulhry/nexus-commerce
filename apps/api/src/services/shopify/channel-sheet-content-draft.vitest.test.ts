import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ContentAddress } from '@nexus/shared/content-language'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import type { formulaDatabase } from '../../test-support/formula-database.js'

// The content writer, SQL stores, resolver and publication loader/validator are real.
// No provider or outbound queue is part of this local storage-to-validation proof.
const state = vi.hoisted(() => ({ db: null as Awaited<ReturnType<typeof formulaDatabase>> | null, schema: null as ShopifyStoreSchema | null }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
vi.mock('../pim/readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn(), { reconcileFamilyReadiness: vi.fn() }))
vi.mock('../pim/channel-specs/shopify.js', async original => ({ ...await original<object>(),
  loadShopifyProductSpec: async (account: string, locale?: string) => (await import('../pim/channel-specs/store.js')).shopifyProductSpec(state.schema, account, locale),
}))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { writeContent } from '../pim/content-write.js'
import { inDatabaseTransaction } from '../../lib/database-context.js'
import { contentDestination, readContent } from './content-workspace.service.js'
import { informationContentState, validateListingInformationOverrides } from './listing-information-plan.js'
import { shopifyProductSpec } from '../pim/channel-specs/store.js'
import { resolveBatch } from '../pim/mapping/resolve-batch.service.js'
import { cellFindings, publishVerdict } from '../pim/value-verdict.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const schema: ShopifyStoreSchema = { revision: 'synthetic-content', definitions: [], types: [], metaobjectDefinitions: [],
  locales: [{ locale: 'en', primary: true, published: true }, { locale: 'it', primary: false, published: true }],
  native: { scopes: ['read_products', 'write_products', 'read_translations', 'write_translations'], enums: {},
    inputs: { product: ['title', 'descriptionHtml', 'vendor', 'productType', 'tags', 'seo', 'status', 'handle', 'templateSuffix', 'category'] } } }
let accountId: string, serial = 0
beforeAll(async () => scoped(async () => {
  state.schema = schema
  await prisma.marketplace.create({ data: { channel: 'SHOPIFY', code: 'GLOBAL', name: 'Synthetic store', currency: 'EUR', region: 'GLOBAL', language: 'en', languages: ['en'] } })
  accountId = (await prisma.channelConnection.create({ data: { channelType: 'SHOPIFY', isActive: true, accountLabel: 'Synthetic content proof' } })).id
}), 60_000)
afterAll(async () => { await state.db?.close() })

describe('blank Shopify title through its actual common content path', () => {
  it('keeps a valid channel pin valid when a different source address is blanked', async () => scoped(async () => {
    state.schema = schema
    await prisma.marketplace.updateMany({ where: { channel: 'SHOPIFY', code: 'GLOBAL' }, data: { language: 'en', languages: ['en', 'it'] } })
    const product = await prisma.product.create({ data: { sku: `PSE-CONTENT-${++serial}`, name: 'Rain jacket', description: 'Lined jacket.', basePrice: 89.95 } })
    const listing = await prisma.channelListing.create({ data: { productId: product.id, channel: 'SHOPIFY', channelMarket: 'SHOPIFY_GLOBAL', marketplace: 'GLOBAL', region: 'GLOBAL', channelConnectionId: accountId } })
    await writeContent({ productId: product.id, address: { tier: 'pin', language: 'en', coordinate: { channel: 'SHOPIFY', market: 'GLOBAL', accountId } }, values: { title: 'Pinned rain jacket' }, label: 'Name', state: 'reviewed', queueOutbound: false })
    await writeContent({ productId: product.id, address: { tier: 'source' }, values: { title: '' }, label: 'Name', state: 'reviewed', queueOutbound: false })
    const destination = await contentDestination(product.id, { accountId, listingId: listing.id, market: 'GLOBAL' })
    const saved = await inDatabaseTransaction(prisma, () => readContent(prisma, destination, schema.locales, schema))
    expect(saved.family.name).toBe('')
    const titleSpec = shopifyProductSpec(schema, accountId).fields.find(field => field.shopifyField?.id === 'title')!
    expect(informationContentState(saved.listings[0], titleSpec)).toEqual({ state: 'stored', value: 'Pinned rain jacket' })
    expect(() => validateListingInformationOverrides(saved.listings, accountId, schema, false)).not.toThrow()
  }))
  it('still refuses a real stored translation in a language the store has not enabled', async () => scoped(async () => {
    const product = await prisma.product.create({ data: { sku: `PSE-CONTENT-${++serial}`, name: 'Rain jacket', description: 'Lined jacket.', basePrice: 89.95 } })
    const listing = await prisma.channelListing.create({ data: { productId: product.id, channel: 'SHOPIFY', channelMarket: 'SHOPIFY_GLOBAL', marketplace: 'GLOBAL', region: 'GLOBAL', channelConnectionId: accountId } })
    await writeContent({ productId: product.id, address: { tier: 'language', language: 'de' }, values: { title: 'Jacke' }, label: 'Name', state: 'reviewed', queueOutbound: false })
    const destination = await contentDestination(product.id, { accountId, listingId: listing.id, market: 'GLOBAL' })
    const saved = await inDatabaseTransaction(prisma, () => readContent(prisma, destination, schema.locales, schema))
    expect(() => validateListingInformationOverrides(saved.listings, accountId, schema, false)).toThrow('This language is not enabled in the selected Shopify store.')
    expect((await prisma.productTranslation.findFirstOrThrow({ where: { productId: product.id, language: 'de' } })).name).toBe('Jacke')
  }))
  for (const tier of ['source', 'language', 'pin'] as const) {
    it.each(['', '   ', null, 'New rain jacket'])(`${tier} stores %j and the matching publish validator sees that exact draft`, async value => scoped(async () => {
      const primary = tier === 'source' ? 'it' : 'en'
      const currentSchema = { ...schema, locales: schema.locales.map(locale => ({ ...locale, primary: locale.locale === primary })) }
      state.schema = currentSchema
      await prisma.marketplace.updateMany({ where: { channel: 'SHOPIFY', code: 'GLOBAL' }, data: { language: primary, languages: [primary, primary === 'it' ? 'en' : 'it'] } })
      const product = await prisma.product.create({ data: { sku: `PSE-CONTENT-${++serial}`, name: 'Rain jacket', description: 'Lined jacket with an adjustable hood.', basePrice: 89.95 } })
      const listing = await prisma.channelListing.create({ data: { productId: product.id, channel: 'SHOPIFY', channelMarket: 'SHOPIFY_GLOBAL',
        marketplace: 'GLOBAL', region: 'GLOBAL', channelConnectionId: accountId, externalListingId: '10', followMasterTitle: true } })
      const destination = await contentDestination(product.id, { accountId, listingId: listing.id, market: 'GLOBAL' })
      // PGlite has one connection. Bind the same real transaction for readers which use the contextual client.
      const read = () => inDatabaseTransaction(prisma, () => readContent(prisma, destination, currentSchema.locales, currentSchema))
      const original = await read()
      expect(() => validateListingInformationOverrides(original.listings, accountId, currentSchema, false)).not.toThrow()
      const address: ContentAddress = tier === 'source' ? { tier } : tier === 'language' ? { tier, language: 'en' } : { tier, language: 'en', coordinate: { channel: 'SHOPIFY', market: 'GLOBAL', accountId } }
      await writeContent({ productId: product.id, address, values: { title: value }, expectedVersion: tier === 'pin' ? listing.version : product.version,
        label: 'Name', state: 'reviewed', queueOutbound: false })
      const saved = await read()
      if (tier === 'source') expect(saved.family.name).toBe(value ?? '')
      else if (tier === 'language') {
        expect(saved.family.name).toBe('Rain jacket')
        expect((await prisma.productTranslation.findFirstOrThrow({ where: { productId: product.id, language: 'en' } })).name).toBe(value)
      } else {
        expect(saved.family.name).toBe('Rain jacket')
        const pin = await prisma.channelListingTranslation.findFirstOrThrow({ where: { channelListingId: listing.id, language: 'en' } })
        expect(pin.name).toBe(value)
        expect(pin.follows).not.toContain('title')
      }
      const titleSpec = shopifyProductSpec(currentSchema, accountId).fields.find(field => field.shopifyField?.id === 'title')!
      const actual = informationContentState(saved.listings[0], titleSpec)
      if (tier === 'source' && (value === '' || value === null)) {
        // Empty source resolves as absent/computed. This is not an explicit listing override.
        expect(actual).toEqual({ state: 'inherited', value: undefined })
      } else {
        expect(actual).toEqual({ state: 'stored', value })
        if (value === 'New rain jacket') expect(() => validateListingInformationOverrides(saved.listings, accountId, currentSchema, false)).not.toThrow()
        else expect(() => validateListingInformationOverrides(saved.listings, accountId, currentSchema, false)).toThrow(/Title: (Product title is required\.|Enter a value for this field\.)/)
      }
      // The full publication fact path checks required mapped fields even when no explicit override exists.
      const resolved = await resolveBatch({ channel: 'SHOPIFY', marketplace: 'GLOBAL', channelConnectionId: accountId,
        productIds: [product.id], aliasKey: '', locale: primary, includeCatalogue: true })
      const title = resolved.products.find(row => row.productId === product.id)!.cells.title
      expect(title).toBeTruthy()
      const findings = cellFindings(title)
      expect(title.value).toBe(tier === 'source' && (value === '' || value === null) ? null : value)
      if (value === 'New rain jacket') expect(findings).toEqual([])
      else {
        // Native Shopify validation is reported as a schema finding; its exact required-title reason still blocks.
        expect(findings).toEqual([{ rule: 'schema', message: title.value === null ? 'Enter a value for this field.' : 'Product title is required.' }])
        expect(findings.every(finding => publishVerdict('SHOPIFY', finding) === 'block')).toBe(true)
      }
    }))
  }
})
