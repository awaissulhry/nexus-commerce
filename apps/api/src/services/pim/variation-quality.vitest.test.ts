import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import prisma from '../../db.js'
import { localDatabaseVerdict } from './variation-local-db.vitest-helper.js'
import { resolveVariationProjection, type ResolveVariationInput } from './variation-rules.service.js'
import { limitsFor, vocabularyFor } from './family-projection-limits.js'
import { variationCollisionGroups } from './variation-collisions.js'
import { simulateVariationRule } from './variation-rule-view.service.js'
import type { StoredVariationRule } from './variation-rule-store.js'
import { getInformationSheet } from './information-sheet.js'
import { getProjectionRead, writeProjectionMapping, validateProjectionChange, type ProjectionRead } from './family-projection.service.js'
import { emptyShopifyContent } from '@nexus/shared/shopify-content'
import { applyShopifyVariationProjection } from '../shopify/content-workspace.service.js'
import { buildShopifyProductOptions } from '../shopify/content-publisher.js'

// The Shopify provider-enrichment boundary is separate from local variation storage. No remote calls in this suite.
vi.mock('../shopify/channel-sheet.service.js', () => ({ enrichShopifyChannelSheet: async (page: unknown) => page }))

const facts = (channel = 'SHOPIFY'): ResolveVariationInput => ({
  coordinate: { channel, market: 'GLOBAL', accountId: 'account', aliasKey: '', label: channel },
  family: { familyAxes: ['Color', 'Size'], axisLabels: { color: 'Color', size: 'Size' }, productVersion: 1, productTheme: 'Color,Size', childIds: ['a','b'], variants: [
    { id: 'a', sku: 'A', included: true, axisValues: { Color: 'Red', Size: 'S' } }, { id: 'b', sku: 'B', included: true, axisValues: { Color: 'Blue', Size: 'M' } },
  ] },
  listing: { version: 1, variationTheme: null, variationMapping: null, platformAttributes: {}, externalListingId: null, listingStatus: 'DRAFT' },
  rule: null, schema: {}, limits: limitsFor(channel), vocabulary: vocabularyFor(channel),
})

describe('variation contract regressions', () => {
  it('distinguishes absent, omitted and explicitly empty axes on Shopify', () => {
    const input = facts()
    input.listing!.variationMapping = { axes: [{ axisKey: 'Color', target: 'Finish', order: 0 }] }
    const saved = resolveVariationProjection(input)
    expect(saved.axes.filter(a => a.included).map(a => a.channelName)).toEqual(['Finish'])
    expect(saved.dropped).toEqual(['size'])
    expect(saved.addableAxes.map(a => a.familyKey)).toEqual(['Size'])
    expect(saved.collisions!.unresolved).toBe(0)
    input.listing!.variationMapping = { axes: [] }
    expect(resolveVariationProjection(input).axes.some(a => a.included)).toBe(false)
    expect(resolveVariationProjection(input).source.kind).toBe('override')
    input.listing!.variationMapping = null
    expect(resolveVariationProjection(input).axes.filter(a => a.included)).toHaveLength(2)
  })
  it('applies eBay rule mappings and lets an explicit target win over the canonical aspect', () => {
    const input = facts('EBAY')
    input.schema.ebay = { categoryId: 'fixture', aspects: ['Color','Size','Neckline'].map(name => ({ name, englishName: name, variantEligible: true, required: false })) }
    input.rule = { label: 'Only color', category: 'fixture', mapping: [{ axisKey: 'Color', target: 'Neckline', included: true }] }
    expect(resolveVariationProjection(input).axes.filter(a => a.included).map(a => a.target)).toEqual(['Neckline'])
    input.listing!.platformAttributes = { _variationAxes: ['Color'], _axisNameLabels: { Color: 'Size' }, _variationAxesMode: 'override' }
    expect(resolveVariationProjection(input).axes.filter(a => a.included).map(a => a.target)).toEqual(['Size'])
    input.listing!.platformAttributes = { _variationAxesMode: 'inherit' }
    expect(resolveVariationProjection(input).source.kind).toBe('rule')
  })
  it('preserves Shopify values and assignments while changing names in an initialized document', () => {
    const input = facts(); input.listing!.variationMapping = { axes: [{ axisKey: 'Size', target: 'Fit', order: 0 }, { axisKey: 'Color', target: 'Finish', order: 1 }] }
    const stored = emptyShopifyContent(['Color', 'Size']); stored.assignments.push({ id: 'red', name: 'Red images', priority: 0, target: { kind: 'options', values: { Color: 'Red' } }, values: {} })
    const projected = applyShopifyVariationProjection(stored, resolveVariationProjection(input))
    expect(projected.axes).toEqual(['Size','Color'])
    expect(projected.assignments).toEqual(stored.assignments)
    expect(buildShopifyProductOptions(projected.axes, [{ options: { Color: 'Red', Size: 'S' } }], projected.optionNames)).toEqual([
      { name: 'Fit', position: 1, values: [{ name: 'S' }] }, { name: 'Finish', position: 2, values: [{ name: 'Red' }] },
    ])
  })
  it('measures tuples without delimiter collisions and includes pre-existing duplicates', () => {
    const rows = [ { included: true, axisValues: { Color: 'a␟b', Size: 'c' } }, { included: true, axisValues: { Color: 'a', Size: 'b␟c' } } ]
    expect(variationCollisionGroups(['Color','Size'], rows)).toEqual([])
    expect(variationCollisionGroups(['Color'], facts().family.variants!)).toEqual([])
    rows[1].axisValues = { ...rows[0].axisValues }
    expect(variationCollisionGroups(['Color','Size'], rows)[0].members).toHaveLength(2)
  })
  it('distinguishes a loaded schema with no themes from an unreadable schema', () => {
    const input = facts('AMAZON'); input.schema.amazon = { facts: { properties: {}, themes: [], deprecated: [] }, fetchedAt: null }
    expect(resolveVariationProjection(input).candidates?.state).toBe('no-theme')
    input.schema.amazon = null
    expect(resolveVariationProjection(input).candidates?.state).toBe('unavailable')
  })
  it('uses cached Etsy property codes and states the draft delivery limit', () => {
    const input = facts('ETSY')
    input.schema.etsy = { available: true, fetchedAt: null, properties: [{ code: 'property_200', label: 'Primary color', axisKey: 'Color' }, { code: 'property_100', label: 'Size', axisKey: 'Size' }] }
    let cell = resolveVariationProjection(input)
    expect(cell.axes.filter(a => a.included).map(a => a.target)).toEqual(['property_200', 'property_100'])
    expect(cell.deliveryNote).toContain('Publishing Etsy variation properties is not available yet')
    input.listing!.variationMapping = { axes: [{ axisKey: 'Color', target: 'invented_property', order: 0 }] }
    cell = resolveVariationProjection(input)
    expect(cell.axes[0].unbound).toBeDefined()
    expect(cell.dropped).toEqual(['size'])
    input.schema.etsy = { available: false, fetchedAt: null, properties: [] }
    expect(resolveVariationProjection(input).candidates?.state).toBe('unavailable')
  })
  it('refuses reset, target and theme changes under the same live lock', () => {
    const read = { coordinate: { channel: 'AMAZON' }, version: 1, mapping: [{ axisKey: 'Color', target: 'color', order: 0 }], theme: { value: 'COLOR', options: [{ code: 'COLOR' }, { code: 'SIZE' }] }, locked: { reason: 'Live theme is locked', orderChangeAllowed: false }, collisions: null, targetOptionsState: 'ok' } as unknown as ProjectionRead
    for (const next of [{ ...read, theme: { ...read.theme!, value: 'SIZE' } }, { ...read, mapping: [{ axisKey: 'Color', target: 'size', axisLabel: 'Color', order: 0 }] }]) expect(() => validateProjectionChange(read, next, undefined)).toThrow('Live theme is locked')
  })
})

// Real local PostgreSQL writes on owned temporary records. No provider, queue, or existing catalog edit.
describe('local variation save and concurrency', () => {
  const prefix = `vt-quality-${randomUUID()}`
  const rootId = `${prefix}-parent`, childIds = [`${prefix}-red`, `${prefix}-blue`]
  const category = prefix.replaceAll('-', '_').toUpperCase()
  let accountId = '', ebayAccountId = '', amazonAccountId = '', marketplaceId = ''
  async function fixtureRule(rule: StoredVariationRule | null) {
    if (!marketplaceId) return
    const market = await prisma.marketplace.findUniqueOrThrow({ where: { id: marketplaceId }, select: { schemaMapping: true } })
    const mapping = structuredClone(market.schemaMapping ?? {}) as Record<string, any>
    const rules = { ...mapping.variationsByProductType }
    if (rule) rules[category] = rule; else delete rules[category]
    mapping.variationsByProductType = rules
    const changed = await prisma.marketplace.updateMany({ where: { id: marketplaceId, schemaMapping: { equals: market.schemaMapping as never } }, data: { schemaMapping: mapping as never } })
    expect(changed.count).toBe(1)
  }
  beforeAll(async () => {
    expect(localDatabaseVerdict(process.env.DATABASE_URL).ok).toBe(true)
    const [{ name }] = await prisma.$queryRawUnsafe<Array<{name: string}>>('SELECT current_database()::text AS name')
    expect(name).toBe('nexus_development')
    accountId = (await prisma.channelConnection.findFirstOrThrow({ where: { channelType: 'SHOPIFY' }, select: { id: true } })).id
    await prisma.product.create({ data: { id: rootId, sku: prefix, name: 'Temporary variation quality fixture', isParent: true, basePrice: 1, variationAxes: ['Color','Size'], variationTheme: 'Color,Size' } })
    await prisma.product.createMany({ data: childIds.map((id, i) => ({ id, sku: id, name: id, parentId: rootId, basePrice: 1, variantAttributes: { Color: i ? 'Blue' : 'Red', Size: i ? 'M' : 'S' } })) })
    await prisma.channelListing.createMany({ data: [rootId,...childIds].map(productId => ({ productId, channel: 'SHOPIFY', channelMarket: 'SHOPIFY_GLOBAL', marketplace: 'GLOBAL', region: 'GLOBAL', channelConnectionId: accountId, syncPaused: true, isPublished: false })) })
    ebayAccountId = (await prisma.channelConnection.findFirstOrThrow({ where: { channelType: 'EBAY', isPrimary: true }, select: { id: true } })).id
    for (const marketplace of ['IT','DE']) await prisma.channelListing.createMany({ data: [rootId,...childIds].map(productId => ({ productId, channel: 'EBAY', channelMarket: `EBAY_${marketplace}`, marketplace, region: marketplace, channelConnectionId: ebayAccountId, syncPaused: true, isPublished: false, platformAttributes: { categoryId: marketplace === 'IT' ? '177104' : '177117', itemSpecifics: { [marketplace === 'IT' ? 'Colore' : 'Farbe']: productId === childIds[1] ? 'Blue' : 'Red', [marketplace === 'IT' ? 'Taglia' : 'Größe']: productId === childIds[1] ? 'M' : 'S' } } })) })
  }, 30000)
  afterAll(async () => {
    await fixtureRule(null)
    await prisma.categorySchema.deleteMany({ where: { productType: category } })
    await prisma.channelListing.deleteMany({ where: { productId: { in: [rootId,...childIds] } } })
    await prisma.product.deleteMany({ where: { id: { in: childIds } } })
    await prisma.product.deleteMany({ where: { id: rootId } })
    await prisma.$disconnect()
  }, 30000)
  it('keeps eBay overrides and reset within the addressed market', async () => {
    const scope = { productId: rootId, channel: 'EBAY', market: 'IT', accountId: ebayAccountId, includeOrder: false }
    const before = await getProjectionRead(scope)
    const other = await getProjectionRead({ ...scope, market: 'DE' })
    const saved = await writeProjectionMapping({ ...scope, expectedVersion: before.version, mapping: [{ axisKey: 'Color', target: 'Colore' }] })
    expect(saved.mapping.filter(m => m.target).map(m => m.target)).toEqual(['Colore'])
    expect(saved.affectsAllMarkets).toBe(false)
    const untouched = await getProjectionRead({ ...scope, market: 'DE' })
    expect(untouched.version).toBe(other.version)
    expect(untouched.mapping).toEqual(other.mapping)
    expect((await prisma.product.findUniqueOrThrow({ where: { id: rootId }, select: { variationTheme: true } })).variationTheme).toBe('Color,Size')
    const reset = await writeProjectionMapping({ ...scope, expectedVersion: saved.version, reset: true })
    expect(reset.variation?.source.kind).toBe('derived')
    expect(reset.mapping.filter(m => m.target)).toHaveLength(2)
  }, 120000)
  it('round-trips omission, detects stale writes, resets, and allows only one concurrent winner', async () => {
    const scope = { productId: rootId, channel: 'SHOPIFY', market: 'GLOBAL', accountId, includeOrder: false }
    const initial = await getProjectionRead(scope)
    await expect(writeProjectionMapping({ ...scope, expectedVersion: initial.version, mapping: [{ axisKey: 'Color', target: 'x'.repeat(256) }] })).rejects.toThrow('255 characters')
    const saved = await writeProjectionMapping({ ...scope, expectedVersion: initial.version, mapping: [{ axisKey: 'Color', target: 'Finish' }] })
    expect(saved.mapping.filter(m => m.target).map(m => m.target)).toEqual(['Finish'])
    expect(saved.variation?.source.kind).toBe('override')
    expect(saved.variation?.dropped).toEqual(['size'])
    const same = await writeProjectionMapping({ ...scope, expectedVersion: saved.version, mapping: [{ axisKey: 'Color', target: 'Finish' }] })
    expect(same.version).toBe(saved.version)
    await expect(writeProjectionMapping({ ...scope, expectedVersion: initial.version, reset: true })).rejects.toMatchObject({ code: 'version_conflict' })
    const reset = await writeProjectionMapping({ ...scope, expectedVersion: saved.version, reset: true })
    expect(reset.mapping.filter(m => m.target)).toHaveLength(2)
    expect(reset.variation?.source.kind).toBe('derived')
    const attempts = await Promise.allSettled(['Finish','Shade'].map(target => writeProjectionMapping({ ...scope, expectedVersion: reset.version, mapping: [{ axisKey: 'Color', target }] })))
    expect(attempts.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = attempts.find(r => r.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ code: 'version_conflict', statusCode: 409 })
    const readback = await getProjectionRead(scope)
    expect(readback.version).toBe(reset.version + 1)
    expect(readback.mapping.filter(m => m.target)).toHaveLength(1)
  }, 120000)
  it('loads a saved category rule into sheet and projection and simulates actual combinations', async () => {
    amazonAccountId = (await prisma.channelConnection.findFirstOrThrow({ where: { channelType: 'AMAZON', isPrimary: true }, select: { id: true } })).id
    marketplaceId = (await prisma.marketplace.findFirstOrThrow({ where: { channel: 'AMAZON', code: 'IT' }, select: { id: true } })).id
    const schema = await prisma.categorySchema.findFirstOrThrow({ where: { channel: 'AMAZON', marketplace: 'IT', productType: 'OUTERWEAR' }, orderBy: { fetchedAt: 'desc' }, select: { schemaDefinition: true } })
    await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: 'IT', productType: category, schemaVersion: prefix, schemaDefinition: schema.schemaDefinition as never, expiresAt: new Date('2099-01-01') } })
    await prisma.product.update({ where: { id: rootId }, data: { productType: category } })
    await prisma.channelListing.createMany({ data: [rootId,...childIds].map(productId => ({ productId, channel: 'AMAZON', channelMarket: 'AMAZON_IT', marketplace: 'IT', region: 'IT', channelConnectionId: amazonAccountId, syncPaused: true, isPublished: false, platformAttributes: { productType: category } })) })
    const rule: StoredVariationRule = { theme: 'COLOR/SIZE', axes: [{ axisKey: 'color', target: 'color', order: 0, included: true }, { axisKey: 'size', target: 'size', order: 1, included: true }], label: 'Temporary quality rule', collisions: { resolver: 'exclude', foldInto: null, foldSeparator: ' / ' }, split: { mode: 'one', axisKey: null } }
    await fixtureRule(rule)
    const scope = { productId: rootId, channel: 'AMAZON', market: 'IT', accountId: amazonAccountId, includeOrder: false }
    const [projection, sheet] = await Promise.all([getProjectionRead(scope), getInformationSheet({ ...scope, scope: 'channel', includeMapping: true })])
    expect(projection.variation?.source).toMatchObject({ kind: 'rule', ruleLabel: rule.label, category })
    const cell = sheet.rows.find(r => r.id === rootId)!.values.variation_theme.value as any
    expect(cell.theme).toEqual(projection.variation?.theme)
    expect(cell.axes).toEqual(projection.variation?.axes)
    expect(cell.collisions).toEqual(projection.variation?.collisions)
    const colorOnly: StoredVariationRule = { ...rule, theme: 'COLOR', axes: [rule.axes[0]] }
    const unique = await simulateVariationRule({ channel: 'AMAZON', market: 'IT', categoryId: category, rule: colorOnly })
    expect(unique).toMatchObject({ follow: 1, total: 1, wouldCollide: 0 })
    await prisma.product.update({ where: { id: childIds[1] }, data: { variantAttributes: { Color: 'Red', Size: 'M' } } })
    const collide = await simulateVariationRule({ channel: 'AMAZON', market: 'IT', categoryId: category, rule: colorOnly })
    expect(collide).toMatchObject({ follow: 1, total: 1, wouldCollide: 1 })
    await expect(writeProjectionMapping({ ...scope, expectedVersion: projection.version, theme: 'NOT_A_THEME' })).rejects.toMatchObject({ statusCode: 400 })
    await expect(writeProjectionMapping({ ...scope, expectedVersion: projection.version, mapping: [{ axisKey: 'Color', target: 'invented_attribute' }] })).rejects.toMatchObject({ statusCode: 400 })
  }, 120000)

})
