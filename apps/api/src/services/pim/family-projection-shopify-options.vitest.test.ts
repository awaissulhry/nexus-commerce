/**
 * Sheet pop-up P3b, slice A4 (QUALITY-PLAN-2026-09-28 §4.11) — Shopify's own options through the REAL save path.
 *
 * `writeProjectionMapping` on a Shopify · GLOBAL DRAFT listing: an option under the operator's own name with values from a
 * Shared per-variant attribute (`fit`), saved and read back; the refusals (a 4th option, an unknown source, a channel column
 * source); a product already on Shopify (the Owner's D1 a: options AND order locked); and what the Shopify publisher reads
 * (`readContent`: the draft's options and each variant's value) — the same values the sheet cell counts.
 *
 * On an in-process PostgreSQL (PGlite) with the generated schema and the production row policies. Every id is invented.
 * Run: DATABASE_URL=postgresql://nexus@127.0.0.1:1/nexus_unit_test npx vitest run src/services/pim/family-projection-shopify-options.vitest.test.ts
 * and again with NEXUS_WORKSPACES_ENABLED=1.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60_000 })
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
/** A stand-in Shopify admin client: an EMPTY made-up store (no metafield definitions, one language). No real call is made. */
vi.mock('../shopify/admin-client.js', () => {
  const page = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }
  const types = { inputFields: [] }, values = { enumValues: [] }
  const graphql = async (query: string, variables: Record<string, any> = {}) => {
    /* a live product's information read (the D1 test): a made-up product with no metafields, media or variants */
    if (query.includes('NexusInformationContext')) return { shop: { currencyCode: 'EUR', ianaTimezone: 'Europe/Rome' } }
    if (query.includes('NexusInformationProduct(')) return { product: { id: variables.id, title: 'Made-up jacket', handle: 'made-up-jacket', descriptionHtml: '', tags: [], vendor: '', productType: '', seo: { title: null, description: null } } }
    if (query.includes('NexusLinkedOwner(')) return { node: { id: variables.id, title: 'Made-up jacket', metafields: page } }
    if (query.includes('NexusInformationMedia(')) return { product: { media: page } }
    if (query.includes('NexusInformationVariants')) return { product: { variants: page } }
    if (query.includes('NexusLinkedEntryDefinitions')) return { metaobjectDefinitions: page }
    if (query.includes('NexusLinkedDefinitions')) return { metafieldDefinitions: page }
    if (query.includes('NexusLinkedSettings')) return { shopLocales: [{ locale: 'en', primary: true, published: true }], metafieldDefinitionTypes: [], shop: { id: 'gid://shopify/Shop/1', currencyCode: 'EUR' },
      currentAppInstallation: { app: { id: 'gid://shopify/App/1' }, accessScopes: [] }, productInput: types, variantInput: types, inventoryInput: types, measurementInput: types,
      statusEnum: values, countryEnum: values, weightEnum: values, unitPriceEnum: values, inventoryPolicyEnum: values }
    throw new Error(`The stand-in Shopify store has no answer for: ${query.slice(0, 60)}`)
  }
  return { shopifyAdmin: async () => ({ domain: 'made-up-store.myshopify.com', graphql }) }
})
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))

import { ownAxisKey } from '@nexus/shared/variation-mapping'
import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { activeDatabaseTransaction, inDatabaseTransaction } from '../../lib/database-context.js'
import { getProjectionRead, sharedOwnAxisSources, writeProjectionMapping } from './family-projection.service.js'
import { VT_COPY } from './variation-rules.service.js'
import { contentDestination, readContent } from '../shopify/content-workspace.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const FIT = ownAxisKey({ from: 'shared', field: 'fit' })
const LINING = ownAxisKey({ from: 'shared', field: 'lining' })
const HOOD = ownAxisKey({ from: 'shared', field: 'hood' })
const shopify = { productId: 'shopt-demo', channel: 'SHOPIFY', market: 'GLOBAL', accountId: 'shopify-shopt', includeOrder: false }
/** Four made-up variants: Colore alone collides (two Nero, two Rosso); Colore + fit tells them apart. */
const VARIANTS = [
  { id: 'shopt-a', colore: 'Nero', fit: 'Slim', lining: 'Mesh', hood: 'Yes' },
  { id: 'shopt-b', colore: 'Nero', fit: 'Regular', lining: 'Mesh', hood: 'No' },
  { id: 'shopt-c', colore: 'Rosso', fit: 'Slim', lining: 'Fleece', hood: 'Yes' },
  { id: 'shopt-d', colore: 'Rosso', fit: 'Regular', lining: 'Fleece', hood: 'No' },
]
const version = async () => (await scoped(() => getProjectionRead(shopify))).version
const save = async (mapping: Array<{ axisKey: string; target: string }>) =>
  scoped(async () => writeProjectionMapping({ ...shopify, expectedVersion: await version(), mapping: mapping.map((m, order) => ({ ...m, order })) }))
const refusal = (work: Promise<unknown>) => work.then(() => 'saved', (error: Error) => error.message)

beforeAll(() => scoped(async () => {
  await prisma.productFamily.create({ data: { id: 'shopt-family', code: 'shopt_jackets', label: 'Jackets' } })
  await prisma.attributeGroup.create({ data: { id: 'shopt-group', code: 'shopt_fixture', label: 'Specifications' } })
  for (const [code, type] of [['color', 'select'], ['fit', 'text'], ['lining', 'text'], ['hood', 'text']] as const) {
    await prisma.customAttribute.create({ data: { id: `shopt-${code}`, code, label: code, type, groupId: 'shopt-group', scope: 'per_variant' } as never })
    await prisma.familyAttribute.create({ data: { attributeId: `shopt-${code}`, familyId: 'shopt-family', channels: [] } })
  }
  await prisma.product.create({ data: { id: 'shopt-demo', sku: 'SHOPT-JACKET', name: 'Shopify options jacket', isParent: true, basePrice: 50, familyId: 'shopt-family', productType: 'OUTERWEAR', variationAxes: ['Colore'] } as never })
  for (const v of VARIANTS) {
    await prisma.product.create({ data: { id: v.id, sku: `SHOPT-JACKET-${v.id.slice(-1).toUpperCase()}`, name: v.id, parentId: 'shopt-demo', basePrice: 50, familyId: 'shopt-family', productType: 'OUTERWEAR',
      categoryAttributes: { variations: { Colore: v.colore }, fit: v.fit, lining: v.lining, hood: v.hood } } as never })
  }
  await prisma.marketplace.create({ data: { channel: 'SHOPIFY', code: 'GLOBAL', name: 'Shopify GLOBAL', region: 'GLOBAL', currency: 'EUR', language: 'en' } as never })
  await prisma.channelConnection.create({ data: { id: 'shopify-shopt', externalAccountId: 'shopify-shopt', channelType: 'SHOPIFY', isPrimary: true, isActive: true } })
  for (const id of ['shopt-demo', ...VARIANTS.map(v => v.id)]) {
    await prisma.channelListing.create({ data: { id: `shopify-shopt-${id}`, productId: id, channel: 'SHOPIFY', marketplace: 'GLOBAL', region: 'GLOBAL', channelMarket: 'SHOPIFY_GLOBAL', channelConnectionId: 'shopify-shopt', aliasKey: '', listingStatus: 'DRAFT' } as never })
  }
}), 60_000)

afterAll(async () => { await state.db?.close?.() })

describe('Shopify · GLOBAL draft — own options through writeProjectionMapping', () => {
  it('offers own names up to 255 characters, and the Shared per-variant attributes as value sources', async () => {
    const read = await scoped(() => getProjectionRead(shopify))
    expect(read.variation?.ownNames).toEqual({ allowed: true, maxLength: 255, reason: null })
    // Colore alone cannot tell the variants apart: the measured starting point
    expect(read.variation?.collisions?.unresolved).toBe(4)
    const sources = await scoped(() => sharedOwnAxisSources('shopt-demo', 'GLOBAL'))
    expect(sources.map(s => s.field).sort()).toEqual(['fit', 'hood', 'lining'])
  })

  it('saves an option under the operator\'s own name: stored under its key, bound, its values read, no collision', async () => {
    const read = await save([{ axisKey: 'Colore', target: 'Color' }, { axisKey: FIT, target: 'Fit' }])
    const listing = await scoped(() => prisma.channelListing.findUniqueOrThrow({ where: { id: 'shopify-shopt-shopt-demo' } }))
    expect((listing.variationMapping as { axes: Array<{ axisKey: string; target: string }> }).axes.map(a => [a.axisKey, a.target])).toEqual([['Colore', 'Color'], [FIT, 'Fit']])
    const fit = read.variation!.axes.find(a => a.familyKey === FIT)!
    expect(fit).toMatchObject({ channelName: 'Fit', included: true, own: { from: 'shared', field: 'fit', custom: true } })
    expect(fit.unbound).toBeUndefined()
    expect(read.variation!.collisions!.unresolved).toBe(0)
    expect(read.variation!.valueGaps!.unresolved).toBe(0)
    expect(read.variation!.valueSummary![FIT]).toMatchObject({ filled: 4, of: 4 })
    expect([...read.variation!.valueSummary![FIT].values].sort()).toEqual(['Regular', 'Slim'])
  })

  it('🔴 the Shopify publisher reads the same option and the same values the cell counts (readContent)', async () => {
    const data = await scoped(async () => {
      const destination = await contentDestination('shopt-demo', { accountId: 'shopify-shopt', market: 'GLOBAL' })
      // The in-process database has ONE connection: a plain `$transaction` would leave readContent's own global-client
      // reads waiting for it. The content transaction routes them into the same transaction, as the save path does.
      return inDatabaseTransaction(prisma, () => readContent(activeDatabaseTransaction()!, destination))
    })
    expect(data.draft.axes).toEqual(['Colore', FIT])
    expect(data.draft.optionNames).toMatchObject({ Colore: 'Color', [FIT]: 'Fit' })
    const cell = await scoped(() => getProjectionRead(shopify))
    for (const v of VARIANTS) {
      const variant = data.variants.find(x => x.id === v.id)!
      expect(variant.options[FIT]).toBe(v.fit)
    }
    expect([...new Set(data.variants.map(v => v.options[FIT]))].sort()).toEqual([...cell.variation!.valueSummary![FIT].values].sort())
    // no publish check stops it (no raw key in any sentence either)
    expect(data.errors).toEqual([])
  })

  it('the publish checks (the preview) refuse an option value longer than Shopify takes, naming the option — never its key', async () => {
    const readErrors = () => scoped(async () => {
      const destination = await contentDestination('shopt-demo', { accountId: 'shopify-shopt', market: 'GLOBAL' })
      return (await inDatabaseTransaction(prisma, () => readContent(activeDatabaseTransaction()!, destination))).errors
    })
    const long = 'x'.repeat(256)
    await scoped(() => prisma.product.update({ where: { id: 'shopt-b' }, data: { categoryAttributes: { variations: { Colore: 'Nero' }, fit: long, lining: 'Mesh', hood: 'No' } } }))
    try {
      expect(await readErrors()).toContain('SHOPT-JACKET-B: the Fit value is longer than Shopify’s 255 characters. Shorten it on the Shared product.')
    } finally {
      await scoped(() => prisma.product.update({ where: { id: 'shopt-b' }, data: { categoryAttributes: { variations: { Colore: 'Nero' }, fit: 'Regular', lining: 'Mesh', hood: 'No' } } }))
    }
    // positive control: back to its own value, no check stops it
    expect(await readErrors()).toEqual([])
  })

  it('refuses a 4th option, an unknown source and a channel column source — each with its sentence, nothing saved', async () => {
    const before = await version()
    expect(await refusal(save([{ axisKey: 'Colore', target: 'Color' }, { axisKey: FIT, target: 'Fit' }, { axisKey: LINING, target: 'Lining' }, { axisKey: HOOD, target: 'Hood' }])))
      .toBe('This channel takes at most 3 variation axes.')
    expect(await refusal(save([{ axisKey: 'Colore', target: 'Color' }, { axisKey: ownAxisKey({ from: 'shared', field: 'nope' }), target: 'Nope' }])))
      .toBe('nope is not a per-variant attribute this family can take values from.')
    expect(await refusal(save([{ axisKey: 'Colore', target: 'Color' }, { axisKey: ownAxisKey({ from: 'channel', field: 'fit' }), target: 'Fit' }])))
      .toMatch(/^Fit is not a variation option on Shopify/)
    expect(await version()).toBe(before)
    // positive control: three options ARE taken
    const three = await save([{ axisKey: 'Colore', target: 'Color' }, { axisKey: FIT, target: 'Fit' }, { axisKey: LINING, target: 'Lining' }])
    expect(three.variation!.axes.filter(a => a.included).map(a => a.channelName)).toEqual(['Color', 'Fit', 'Lining'])
  })

  it('a product already on Shopify (the Owner\'s D1 a): options AND their order are locked, with the sentence', async () => {
    await scoped(() => prisma.channelListing.update({ where: { id: 'shopify-shopt-shopt-demo' }, data: { externalListingId: '9900000000001', listingStatus: 'ACTIVE' } }))
    const read = await scoped(() => getProjectionRead(shopify))
    const sentence = 'Live on Shopify GLOBAL (9900000000001). Nexus cannot change the options of a product already on Shopify yet, so its options and their order are locked here.'
    expect(read.variation!.locked).toMatchObject({ reason: sentence, orderChangeAllowed: false })
    // a pure reorder is refused too — it could never reach the store
    expect(await refusal(save([{ axisKey: FIT, target: 'Fit' }, { axisKey: 'Colore', target: 'Color' }, { axisKey: LINING, target: 'Lining' }]))).toBe(sentence)
    expect(await refusal(save([{ axisKey: 'Colore', target: 'Color' }, { axisKey: FIT, target: 'Fit' }]))).toBe(sentence)
    expect(VT_COPY.shopifyLock('GLOBAL', '9900000000001')).toBe(sentence)
  })
})
