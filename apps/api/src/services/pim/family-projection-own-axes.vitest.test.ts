/**
 * Sheet pop-up P3, slice A1 (QUALITY-PLAN-2026-09-28 §4) — channel-only axes through the REAL save path.
 *
 * `writeProjectionMapping` on an eBay · IT DRAFT listing: an axis from the category's variation list (Scollatura, values in
 * its eBay column) and an axis under the operator's own name (values from a Shared per-variant attribute, `fit`). Then the
 * refusals (219451 name, unknown source, not a variation aspect, name too long, Amazon), and what the publishers read back
 * (`loadStoredVariationProjection`).
 *
 * On an in-process PostgreSQL (PGlite) with the generated schema and the production row policies. Every id is invented.
 * Run: DATABASE_URL=postgresql://nexus@127.0.0.1:1/nexus_unit_test npx vitest run src/services/pim/family-projection-own-axes.vitest.test.ts
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
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
/** A controlled Amazon product type: two variation attributes and the theme enum that combines them. */
const DEFINITION = vi.hoisted(() => {
  const attribute = () => ({ type: 'array', minUniqueItems: 1, maxUniqueItems: 1, items: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } })
  return { type: 'object', properties: { item_name: attribute(), color: attribute(), size: attribute(),
    variation_theme: { type: 'array', minUniqueItems: 1, maxUniqueItems: 1, items: { type: 'object', properties: { name: { type: 'string', enum: ['COLOR', 'SIZE', 'COLOR/SIZE'] } }, required: ['name'] } } } }
})
vi.mock('../categories/seller-schema.service.js', async () => {
  const { amazonSpecFromDefinition } = await import('./channel-specs/amazon.js')
  return { amazonSellerSpec: async (_account: string, marketplace: string, productType: string) => amazonSpecFromDefinition({ marketplace, productType, fetchedAt: new Date(), schemaVersion: 'fixture', schemaDefinition: DEFINITION }) }
})

import Fastify from 'fastify'
import { ownAxisKey } from '@nexus/shared/variation-mapping'
import studioRoutes from '../../routes/product-studio.routes.js'
import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { getProjectionRead, sharedOwnAxisSources, writeProjectionMapping } from './family-projection.service.js'
import { loadStoredVariationProjection } from './stored-variation-projection.js'
import { VT_COPY } from './variation-rules.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const NECK = ownAxisKey({ from: 'channel', field: 'scollatura' })
const FIT = ownAxisKey({ from: 'shared', field: 'fit' })
const ebay = { productId: 'own-demo', channel: 'EBAY', market: 'IT', accountId: 'ebay-own', includeOrder: false }
const amazon = { productId: 'own-demo', channel: 'AMAZON', market: 'IT', accountId: 'amazon-own', includeOrder: false }
const VARIANTS = [
  { id: 'own-a', colore: 'Nero', fit: 'Slim', neck: 'V' },
  { id: 'own-b', colore: 'Rosso', fit: 'Slim', neck: 'Tondo' },
  { id: 'own-c', colore: 'Nero', fit: 'Regular', neck: '' },
]
const version = async (read = ebay) => (await scoped(() => getProjectionRead(read))).version
const save = async (mapping: Array<{ axisKey: string; target: string }>, read = ebay) =>
  scoped(async () => writeProjectionMapping({ ...read, expectedVersion: await version(read), mapping: mapping.map((m, order) => ({ ...m, order })) }))

beforeAll(() => scoped(async () => {
  await prisma.productFamily.create({ data: { id: 'own-family', code: 'own_jackets', label: 'Jackets' } })
  await prisma.attributeGroup.create({ data: { id: 'own-group', code: 'own_fixture', label: 'Specifications' } })
  for (const [code, type] of [['color', 'select'], ['fit', 'text']] as const) {
    await prisma.customAttribute.create({ data: { id: `own-${code}`, code, label: code, type, groupId: 'own-group', scope: 'per_variant' } as never })
    await prisma.familyAttribute.create({ data: { attributeId: `own-${code}`, familyId: 'own-family', channels: [] } })
  }
  await prisma.product.create({ data: { id: 'own-demo', sku: 'OWN-JACKET', name: 'Own axes jacket', isParent: true, basePrice: 50, familyId: 'own-family', productType: 'OUTERWEAR', variationAxes: ['Colore'] } as never })
  for (const v of VARIANTS) {
    await prisma.product.create({ data: { id: v.id, sku: `OWN-JACKET-${v.id.slice(-1).toUpperCase()}`, name: v.id, parentId: 'own-demo', basePrice: 50, familyId: 'own-family', productType: 'OUTERWEAR',
      categoryAttributes: { variations: { Colore: v.colore }, fit: v.fit } } as never })
  }
  for (const channel of ['EBAY', 'AMAZON'] as const) {
    await prisma.marketplace.create({ data: { channel, code: 'IT', name: `${channel} IT`, region: 'EU', currency: 'EUR', language: 'it', ...(channel === 'AMAZON' ? { marketplaceId: 'FAKE-IT-ID' } : {}) } as never })
    const accountId = `${channel.toLowerCase()}-own`
    await prisma.channelConnection.create({ data: { id: accountId, externalAccountId: accountId, channelType: channel, isPrimary: true, isActive: true } })
    for (const id of ['own-demo', ...VARIANTS.map(v => v.id)]) {
      const variant = VARIANTS.find(v => v.id === id)
      await prisma.channelListing.create({ data: { id: `${accountId}-${id}`, productId: id, channel, marketplace: 'IT', region: 'EU', channelMarket: `${channel}_IT`, channelConnectionId: accountId, aliasKey: '', listingStatus: 'DRAFT',
        platformAttributes: channel === 'EBAY'
          ? { categoryId: '100', conditionId: '1000', itemSpecifics: variant ? { Colore: variant.colore, ...(variant.neck ? { Scollatura: variant.neck } : {}) } : {} }
          : { productType: 'OUTERWEAR' } } as never })
    }
  }
  await prisma.categorySchema.create({ data: { channel: 'EBAY', marketplace: 'IT', productType: '100', schemaVersion: 'fixture', expiresAt: new Date('2099-01-01'), schemaDefinition: { aspects: [
    { id: 'Colore', label: 'Colore', localizedName: 'Colore', englishName: 'Color', kind: 'select', options: ['Nero', 'Rosso'], enumMode: 'open', required: false, variantEligible: true },
    { id: 'Scollatura', label: 'Scollatura', localizedName: 'Scollatura', englishName: 'Scollatura', kind: 'select', options: ['V', 'Tondo'], enumMode: 'open', required: false, variantEligible: true },
    { id: 'Marca', label: 'Marca', localizedName: 'Marca', englishName: 'Brand', kind: 'text', required: true, variantEligible: false },
  ], conditions: [{ id: '1000', label: 'Nuovo' }] } } })
  await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: 'IT', productType: 'OUTERWEAR', schemaVersion: 'fixture', schemaDefinition: DEFINITION as never, expiresAt: new Date('2099-01-01') } })
}), 60_000)

afterAll(async () => { await state.db?.close?.() })

describe('eBay · IT draft — channel-only axes through writeProjectionMapping', () => {
  it('offers the unused variation aspect with its fill count, and the Shared per-variant attribute as a value source', async () => {
    const read = await scoped(() => getProjectionRead(ebay))
    // the label is the aspect's English name from the site's own dictionary (`englishEbayAspectLabel`)
    expect(read.variation?.ownCandidates).toEqual([{ axisKey: NECK, name: 'Scollatura', label: 'Neckline', filled: 2, of: 3 }])
    expect(read.variation?.ownNames).toEqual({ allowed: true, maxLength: 40, reason: null })
    // Colore alone cannot tell own-a from own-c: the measured starting point
    expect(read.variation?.collisions?.unresolved).toBe(2)
    const sources = await scoped(() => sharedOwnAxisSources('own-demo', 'IT'))
    expect(sources.map(s => [s.field, s.filled, s.of, s.values])).toEqual([['fit', 3, 3, ['Slim', 'Regular']]])
  })

  it('saves an axis from the eBay list: stored under its key and eBay name, bound, with its gap and no collision', async () => {
    // A1b — the readiness index had no eBay row for this family before (nothing produced it yet): the measured start
    const indexBefore = await scoped(() => prisma.readinessIndex.findMany({ where: { productId: 'own-demo', channel: 'EBAY', market: 'IT' } }))
    expect(indexBefore).toEqual([])
    const read = await save([{ axisKey: 'Colore', target: 'Colore' }, { axisKey: NECK, target: 'Scollatura' }])
    // …and the save produced it in the same transaction: the scope header and the catalogue filters see the gap at once
    const index = await scoped(() => prisma.readinessIndex.findMany({ where: { productId: 'own-demo', channel: 'EBAY', market: 'IT' } }))
    expect(index.length).toBeGreaterThan(0)
    expect(index.map(row => row.state)).toEqual(['blocked'])
    // the index keeps the fact (`missing[].kind`, what the catalogue filters narrow on) and the row's own sentence
    expect(index.flatMap(row => row.missing as Array<{ kind?: string; field?: string; reason?: string }>).filter(item => item.kind === 'value-missing'))
      .toEqual([expect.objectContaining({ field: 'variation_theme', reason: '1 variant has no value for an axis on eBay · IT: OWN-JACKET-C (Neckline).' })])
    // Shared is not a projection: its rows are untouched by a channel save
    expect(await scoped(() => prisma.readinessIndex.count({ where: { productId: 'own-demo', channel: null } }))).toBe(0)
    const listing = await scoped(() => prisma.channelListing.findUniqueOrThrow({ where: { id: 'ebay-own-own-demo' } }))
    const bag = listing.platformAttributes as Record<string, any>
    expect(bag._variationAxes).toEqual(['Colore', NECK])
    expect(bag._axisNameLabels).toMatchObject({ [NECK]: 'Scollatura' })
    const neck = read.variation!.axes.find(a => a.familyKey === NECK)!
    expect(neck).toMatchObject({ channelName: 'Scollatura', included: true, own: { from: 'channel', field: 'scollatura', custom: false } })
    expect(neck.unbound).toBeUndefined()
    expect(read.variation!.collisions!.unresolved).toBe(0)
    expect(read.variation!.valueGaps).toMatchObject({ unresolved: 1, skus: ['OWN-JACKET-C'] })
    expect(read.variation!.ownCandidates).toEqual([])
  })

  it('saves an axis under the operator\'s own name with values from the Shared attribute; publishers read the same values', async () => {
    const read = await save([{ axisKey: 'Colore', target: 'Colore' }, { axisKey: FIT, target: 'Vestibilità' }])
    const fit = read.variation!.axes.find(a => a.familyKey === FIT)!
    expect(fit).toMatchObject({ channelName: 'Vestibilità', own: { from: 'shared', field: 'fit', custom: true } })
    expect(read.variation!.collisions!.unresolved).toBe(0)
    expect(read.variation!.valueGaps!.unresolved).toBe(0)
    const stored = await scoped(() => loadStoredVariationProjection({ productId: 'own-demo', channel: 'EBAY', market: 'IT', accountId: 'ebay-own' }))
    expect(stored.cell.axes.filter(a => a.included).map(a => a.channelName)).toEqual(['Colore', 'Vestibilità'])
    expect(Object.fromEntries((stored.input.family.variants ?? []).map(v => [v.id, v.axisValues[FIT]]))).toEqual({ 'own-a': 'Slim', 'own-b': 'Slim', 'own-c': 'Regular' })
  })

  it('refuses before storing: a 219451 name, a name too long, a column that is not a variation aspect, an unknown attribute', async () => {
    const before = (await scoped(() => prisma.channelListing.findUniqueOrThrow({ where: { id: 'ebay-own-own-demo' } }))).version
    await expect(save([{ axisKey: 'Colore', target: 'Colore' }, { axisKey: FIT, target: 'Marca' }])).rejects.toThrow(VT_COPY.ebayNotForVariations('Marca'))
    await expect(save([{ axisKey: 'Colore', target: 'Colore' }, { axisKey: FIT, target: 'x'.repeat(41) }])).rejects.toThrow(VT_COPY.ownNameTooLong('eBay', 'specific', 40))
    await expect(save([{ axisKey: 'Colore', target: 'Colore' }, { axisKey: ownAxisKey({ from: 'channel', field: 'marca' }), target: 'Marca' }])).rejects.toThrow(/is not a variation specific/)
    await expect(save([{ axisKey: 'Colore', target: 'Colore' }, { axisKey: ownAxisKey({ from: 'shared', field: 'nothing' }), target: 'Stile' }])).rejects.toThrow('nothing is not a per-variant attribute this family can take values from.')
    await expect(save([{ axisKey: 'Colore', target: 'Colore' }, { axisKey: NECK, target: 'Neckline' }])).rejects.toThrow('Scollatura keeps its eBay name, Scollatura.')
    expect((await scoped(() => prisma.channelListing.findUniqueOrThrow({ where: { id: 'ebay-own-own-demo' } }))).version).toBe(before)
  })

  it('Reset to Shared is refused while the Shared axes alone would collide, and clears the channel-only axes once they do not', async () => {
    const reset = async () => scoped(async () => writeProjectionMapping({ ...ebay, expectedVersion: await version(), reset: true }))
    await expect(reset()).rejects.toThrow(/2 variants cannot be told apart on eBay · IT/)
    expect(((await scoped(() => prisma.channelListing.findUniqueOrThrow({ where: { id: 'ebay-own-own-demo' } }))).platformAttributes as Record<string, unknown>)._variationAxes).toEqual(['Colore', FIT])
    // own-c becomes Bianco on Shared and on its eBay listing: Colore alone now tells every variant apart
    await scoped(async () => {
      await prisma.product.update({ where: { id: 'own-c' }, data: { categoryAttributes: { variations: { Colore: 'Bianco' }, fit: 'Regular' } } as never })
      await prisma.channelListing.update({ where: { id: 'ebay-own-own-c' }, data: { platformAttributes: { categoryId: '100', conditionId: '1000', itemSpecifics: { Colore: 'Bianco' } } } as never })
    })
    await reset()
    // A1b — the reset rebuilt the index too: no value gap and no error left on eBay · IT
    const index = await scoped(() => prisma.readinessIndex.findMany({ where: { productId: 'own-demo', channel: 'EBAY', market: 'IT' } }))
    expect(index.flatMap(row => row.missing as Array<{ kind?: string }>).some(item => item.kind === 'value-missing' || item.kind === 'collision')).toBe(false)
    const bag = (await scoped(() => prisma.channelListing.findUniqueOrThrow({ where: { id: 'ebay-own-own-demo' } }))).platformAttributes as Record<string, unknown>
    expect(bag._variationAxes).toBeUndefined()
    expect(bag._variationAxesMode).toBe('inherit')
  })
})

describe('Amazon · IT — the theme decides', () => {
  it('refuses a channel-only axis with the Owner\'s rule, and stores nothing', async () => {
    const before = (await scoped(() => prisma.channelListing.findUniqueOrThrow({ where: { id: 'amazon-own-own-demo' } }))).version
    await expect(save([{ axisKey: 'Colore', target: 'color' }, { axisKey: FIT, target: 'Fit' }], amazon)).rejects.toThrow(VT_COPY.amazonOwnAxes)
    expect((await scoped(() => prisma.channelListing.findUniqueOrThrow({ where: { id: 'amazon-own-own-demo' } }))).version).toBe(before)
  })
})

describe('GET /products/:id/studio/own-axis-sources — the pop-up\'s "Values from" list', () => {
  it('answers the Shared per-variant attributes with their fill counts, and asks for a market', async () => {
    const app = Fastify()
    // As production's `workspaceHook` does: each request runs inside its business profile (the legacy one here).
    app.addHook('onRequest', (_request, _reply, done) => { withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, done) })
    await app.register(studioRoutes, { prefix: '/api' })
    await app.ready()
    try {
      const ok = await app.inject({ method: 'GET', url: '/api/products/own-a/studio/own-axis-sources?market=it' })
      expect(ok.statusCode, ok.body).toBe(200)
      expect(ok.json()).toEqual({ sources: [{ field: 'fit', label: 'fit', filled: 3, of: 3, values: ['Slim', 'Regular'] }] })
      const missing = await app.inject({ method: 'GET', url: '/api/products/own-demo/studio/own-axis-sources' })
      expect(missing.statusCode).toBe(400)
    } finally { await app.close() }
  })
})

