import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Attribute parity P3 — which rule sets a business USES, on an in-process PostgreSQL (PGlite) with the real schema,
 * the real row policy and the real reads (the listing query is raw SQL over `platformAttributes`). Then the fill loop,
 * with the provider mocked: no network.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import {
  collectSchemaCoverage, collectSchemaTargets, fillSchemaTargets, inUsePairs, planSchemaDownload,
  MAX_DOWNLOADS_PER_REQUEST, type SchemaTarget,
} from './schema-coverage.service.js'

const OTHER = 'p3-other-business'
const as = (workspaceId: string) => <T>(work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const legacy = as(LEGACY_WORKSPACE_ID)
const other = as(OTHER)
const HOUR = 3_600_000
const short = (pairs: SchemaTarget[]) => pairs.map(p => `${p.channel} ${p.marketplace} ${p.productType} ${p.status}`)

let seq = 0
async function product(productType: string | null, extra: { deletedAt?: Date } = {}) {
  seq++
  return (await prisma.product.create({ data: { sku: `P3-${seq}`, name: `P3 ${seq}`, basePrice: 10, productType, ...extra } })).id
}
async function listing(productId: string, channel: string, marketplace: string, platformAttributes: Record<string, unknown>) {
  await prisma.channelListing.create({ data: { productId, channel, marketplace, channelMarket: `${channel}_${marketplace}`, region: 'EU', platformAttributes: platformAttributes as never } })
}
async function market(channel: string, code: string, isActive = true) {
  await prisma.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, region: 'EU', currency: 'EUR', language: 'en', isActive } })
}
async function cached(channel: string, marketplace: string, productType: string, expiresInMs: number) {
  await prisma.categorySchema.create({ data: { channel, marketplace, productType, schemaVersion: `v-${productType}`, schemaDefinition: {}, expiresAt: new Date(Date.now() + expiresInMs) } })
}

beforeAll(async () => {
  await legacy(async () => {
    await market('AMAZON', 'IT'); await market('AMAZON', 'BE'); await market('AMAZON', 'US', false)
    await market('EBAY', 'IT'); await market('EBAY', 'DE'); await market('ETSY', 'GLOBAL')

    const jacket = await product('OUTERWEAR')                 // in the bundled Amazon list → recognised
    await listing(jacket, 'AMAZON', 'IT', { productType: 'coat' }) // a listing's own type is in use (upper-cased)
    await product('MOTORCYCLE_ACCESSORY')                     // not bundled, but cached for IT → recognised
    await product('EBAY_LISTING_SHELL')                       // placeholder → never an Amazon type
    await product('MY_OWN_LABEL')                             // free text nobody recognises → not asked for
    await product('HELMET', { deletedAt: new Date() })        // deleted → not in use

    const gloves = await prisma.category.create({ data: { slug: 'gloves' } })
    await prisma.categoryChannelMapping.create({ data: { categoryId: gloves.id, channel: 'AMAZON', marketplace: 'IT', channelCategoryId: 'GLOVES' } })
    await prisma.categoryChannelMapping.create({ data: { categoryId: gloves.id, channel: 'EBAY', marketplace: 'IT', channelCategoryId: '177101' } })
    await prisma.categoryChannelMapping.create({ data: { categoryId: gloves.id, channel: 'EBAY', marketplace: '*', channelCategoryId: '999999' } }) // no site → skipped
    await prisma.categoryChannelMapping.create({ data: { categoryId: gloves.id, channel: 'ETSY', marketplace: '*', channelCategoryId: '1429' } })

    await listing(await product(null), 'EBAY', 'IT', { categoryId: 177104 })   // a number in the JSON
    await listing(await product(null), 'EBAY', 'DE', { categoryId: '260979' })
    await listing(await product(null, { deletedAt: new Date() }), 'EBAY', 'IT', { categoryId: '111111' })
    await listing(await product(null), 'ETSY', 'GLOBAL', { taxonomy_id: 2838 })

    await cached('AMAZON', 'IT', 'OUTERWEAR', 12 * HOUR)
    await cached('AMAZON', 'BE', 'OUTERWEAR', -HOUR)                // past expiresAt → stale
    await cached('AMAZON', 'IT', 'MOTORCYCLE_ACCESSORY', 12 * HOUR)
    await cached('AMAZON', 'IT', 'JEWELRY', 12 * HOUR)              // opened once, used by nothing
    await cached('EBAY', 'EBAY_IT', '177104', 12 * HOUR)            // the legacy spelling serves IT
  })
  // Another business: its markets, products and listings are never this business's targets.
  await legacy(() => prisma.workspace.create({ data: { id: OTHER, name: 'Other business', createdByUserId: 'p3', creationKey: 'p3-other' } }))
  await other(async () => {
    await market('AMAZON', 'FR')
    await listing(await product('SHOES'), 'AMAZON', 'FR', { productType: 'SHOES' })
  })
}, 60_000)
afterAll(async () => { await state.db?.close() })

describe('collectSchemaCoverage — in use, not cached', () => {
  it('pairs every in-use Amazon type with every ACTIVE Amazon market, marked cached / stale / missing', async () => {
    const pairs = await legacy(() => collectSchemaCoverage(prisma, { channel: 'AMAZON' }))
    expect(short(pairs)).toEqual([
      'AMAZON BE COAT missing', 'AMAZON BE GLOVES missing', 'AMAZON BE MOTORCYCLE_ACCESSORY missing', 'AMAZON BE OUTERWEAR stale',
      'AMAZON IT COAT missing', 'AMAZON IT GLOVES missing', 'AMAZON IT MOTORCYCLE_ACCESSORY cached', 'AMAZON IT OUTERWEAR cached',
    ])
    // Never: the inactive US market, a placeholder, unrecognised free text, a deleted product's type, a type only cached.
    const types = new Set(pairs.map(p => p.productType))
    for (const excluded of ['EBAY_LISTING_SHELL', 'MY_OWN_LABEL', 'HELMET', 'JEWELRY']) expect(types.has(excluded)).toBe(false)
    expect(pairs.some(p => p.marketplace === 'US')).toBe(false)
    expect(pairs.find(p => p.productType === 'OUTERWEAR' && p.marketplace === 'IT')?.fetchedAt).toBeInstanceOf(Date)
  })

  it('an eBay category stays on the site it came from — never crosses markets; a site-less mapping is skipped', async () => {
    const pairs = await legacy(() => collectSchemaCoverage(prisma, { channel: 'EBAY' }))
    expect(short(pairs)).toEqual(['EBAY DE 260979 missing', 'EBAY IT 177101 missing', 'EBAY IT 177104 cached'])
    expect(await legacy(() => collectSchemaCoverage(prisma, { channel: 'EBAY', market: 'DE' })).then(short)).toEqual(['EBAY DE 260979 missing'])
    // The prefixed spelling narrows to the same market.
    expect(await legacy(() => collectSchemaCoverage(prisma, { channel: 'EBAY', market: 'EBAY_IT' })).then(short)).toEqual(['EBAY IT 177101 missing', 'EBAY IT 177104 cached'])
  })

  it('Etsy taxonomy ids from listings and mappings, on the one GLOBAL market', async () => {
    expect(await legacy(() => collectSchemaCoverage(prisma, { channel: 'ETSY' })).then(short)).toEqual(['ETSY GLOBAL 1429 missing', 'ETSY GLOBAL 2838 missing'])
  })

  it('🔴 per business: each business sees only its own markets, products and listings', async () => {
    const mine = await legacy(() => collectSchemaCoverage(prisma))
    expect(mine.some(p => p.marketplace === 'FR' || p.productType === 'SHOES')).toBe(false)
    // Positive control: the other business's pair is real and visible from inside that business.
    expect(await other(() => collectSchemaCoverage(prisma)).then(short)).toEqual(['AMAZON FR SHOES missing'])
  })

  it('the nightly targets add every other cached coordinate, deduplicated across spellings', async () => {
    const targets = await legacy(() => collectSchemaTargets(prisma))
    expect(short(targets.slice(-1))).toEqual(['AMAZON IT JEWELRY cached'])
    const keys = targets.map(t => `${t.channel}|${t.marketplace}|${t.productType}`)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.filter(k => k.endsWith('|177104'))).toEqual(['EBAY|IT|177104'])
    expect(targets).toHaveLength(8 + 3 + 2 + 1)
  })
})

const target = (productType: string, status: SchemaTarget['status'], channel: SchemaTarget['channel'] = 'AMAZON', marketplace = 'BE'): SchemaTarget =>
  ({ channel, marketplace, productType, status, fetchedAt: null, expiresAt: null })

describe('fillSchemaTargets — sequential, one failure never stops the run', () => {
  it('downloads missing, refreshes cached and stale, counts per channel, and continues after a failure', async () => {
    const getSchema = vi.fn(async (q: { productType: string }) => { if (q.productType === 'COAT') throw new Error('Access to requested resource is denied'); return {} })
    const refreshSchema = vi.fn(async () => ({}))
    const { results, counts } = await fillSchemaTargets(
      [target('COAT', 'missing'), target('GLOVES', 'missing'), target('OUTERWEAR', 'stale'), target('PANTS', 'cached'), target('177104', 'missing', 'EBAY', 'IT'), target('SUIT', 'missing', 'AMAZON', 'IT')],
      { service: { getSchema, refreshSchema } as never, refreshCached: true, throttleMs: 0, skip: t => t.channel === 'AMAZON' && t.marketplace === 'IT' },
    )
    expect(results.map(r => `${r.target.productType}:${r.outcome}`)).toEqual(['COAT:failed', 'GLOVES:added', 'OUTERWEAR:refreshed', 'PANTS:refreshed', '177104:added', 'SUIT:skipped'])
    expect(results[0].error).toBe('Access to requested resource is denied')
    expect(counts).toEqual({ AMAZON: { added: 1, refreshed: 2, failed: 1, skipped: 1 }, EBAY: { added: 1, refreshed: 0, failed: 0, skipped: 0 } })
    // Missing → the ordinary caching read (not forced); cached → the forced refresh.
    expect(getSchema).toHaveBeenCalledWith({ channel: 'AMAZON', marketplace: 'BE', productType: 'GLOVES' })
    expect(getSchema.mock.calls.every(c => c.length === 1)).toBe(true)
    expect(refreshSchema.mock.calls.map(c => (c as any)[0].productType)).toEqual(['OUTERWEAR', 'PANTS'])
  })

  it('without refreshCached a cached pair is reported `already` and costs no provider call', async () => {
    const getSchema = vi.fn(async () => ({})); const refreshSchema = vi.fn(async () => ({}))
    const { results } = await fillSchemaTargets([target('OUTERWEAR', 'cached'), target('COAT', 'missing')], { service: { getSchema, refreshSchema } as never, throttleMs: 0 })
    expect(results.map(r => r.outcome)).toEqual(['already', 'added'])
    expect(refreshSchema).not.toHaveBeenCalled(); expect(getSchema).toHaveBeenCalledTimes(1)
  })
})

describe('planSchemaDownload', () => {
  const pairs = [target('COAT', 'missing'), target('OUTERWEAR', 'cached')]
  it('refuses a listed type that is not in use there (and a placeholder), and normalises Amazon spelling', () => {
    expect(planSchemaDownload('AMAZON', pairs, ['coat', 'HELMET', 'EBAY_LISTING_SHELL']).notInUse).toEqual(['HELMET', 'EBAY_LISTING_SHELL'])
    const plan = planSchemaDownload('AMAZON', pairs, ['coat'])
    expect(plan).toEqual({ notInUse: [], targets: [pairs[0]], remaining: 0 })
  })
  it('without a list takes every in-use pair, and defers missing ones past the cap', () => {
    const many = Array.from({ length: MAX_DOWNLOADS_PER_REQUEST + 3 }, (_, i) => target(`T${i}`, 'missing'))
    const plan = planSchemaDownload('AMAZON', [...many, target('OUTERWEAR', 'cached')])
    expect(plan.remaining).toBe(3)
    expect(plan.targets.filter(t => t.status === 'missing')).toHaveLength(MAX_DOWNLOADS_PER_REQUEST)
    expect(plan.targets.some(t => t.productType === 'OUTERWEAR')).toBe(true)
  })
})

describe('inUsePairs — pure rules', () => {
  it('a market row that is inactive contributes nothing, even when listings and caches name it', () => {
    const pairs = inUsePairs({
      markets: [{ channel: 'EBAY', code: 'IT' }],
      cached: [], productTypes: [],
      listings: [{ channel: 'EBAY', marketplace: 'DE', category: '260979' }, { channel: 'EBAY', marketplace: 'IT', category: 'not-a-number' }],
      mappings: [],
    })
    expect(pairs).toEqual([])
  })
})
