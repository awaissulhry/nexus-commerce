import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * One Amazon family can mix product types: a parent and its jacket rows of type OUTERWEAR, and its pants rows of type
 * PANTS. `resolveBatch` resolves each row against its own type's field catalogue, and each row must be JUDGED against
 * that same catalogue when its message is built.
 *
 * 🔴 WHAT THIS GUARDS. `resolveBatch` built one catalogue per type but returned only the first one, and
 * `prepareAmazonPublication` judged every row against it: a PANTS row was refused with "<OUTERWEAR field>: resolution is
 * missing", sent none of its own PANTS fields, and a channel-wide rule for a PANTS field (absent from the OUTERWEAR
 * schema) refused the PANTS rows with "A saved mapping no longer exists in the category schema". Now each row is judged
 * against its own type's catalogue, and a family of one type builds exactly what it built before.
 *
 * The real builder on PGlite, the pattern of `studio-publication-send-price.vitest.test.ts`: `readPublicationFacts` →
 * `prepareAmazonPublication`, built and never sent. Every id is invented.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
// The cached category schemas below are fresh, so no provider call is made — any fetch is a failure of the fixture.
vi.stubGlobal('fetch', vi.fn(async (url: unknown) => { throw new Error(`network refused in a gate: ${String(url)}`) }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { readPublicationFacts } from './studio-publication-plan.js'
import { prepareAmazonPublication } from './studio-publication-amazon.js'
import { resolveBatch } from './mapping/resolve-batch.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const MP = 'TEST_MARKET_UK'
const one = { type: 'array', maxItems: 1, selectors: ['marketplace_id'],
  items: { type: 'object', properties: { value: { type: 'string', maxLength: 40 }, marketplace_id: { const: MP } } } }
const THEME = { items: { properties: { name: { enum: ['SIZE'] } } } }
// Each type has two fields the other's schema lacks: a product detail its mapping rule fills (OUTERWEAR `collar_style`,
// PANTS `inseam`) and a listing setting its listing stores (OUTERWEAR `lining_type`, PANTS `rise_style`).
const SCHEMAS = {
  OUTERWEAR: { __propertyGroups: { product_details: { title: 'Product details', propertyNames: ['collar_style'] } },
    properties: { size: { title: 'Size' }, variation_theme: THEME, collar_style: one, lining_type: one } },
  PANTS: { __propertyGroups: { product_details: { title: 'Product details', propertyNames: ['inseam'] } },
    properties: { size: { title: 'Size' }, variation_theme: THEME, inseam: one, rise_style: one } },
}
// Each type's own rule, in its own category overlay.
const OVERLAYS = { OUTERWEAR: { collar_style: { source: 'collar' } }, PANTS: { inseam: { source: 'inseam' } } }
let account = '', marketId = ''

const setMapping = (mapping: { fields: Record<string, unknown>; byProductType: Record<string, unknown> }) =>
  scoped(() => prisma.marketplace.update({ where: { id: marketId }, data: { schemaMapping: { version: 1, ...mapping } } as never }))

beforeAll(() => scoped(async () => {
  marketId = (await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'UK', name: 'Amazon UK', currency: 'GBP', region: 'EU', language: 'en', languages: ['en'], marketplaceId: MP,
    schemaMapping: { version: 1, fields: {}, byProductType: OVERLAYS } } as never })).id
  for (const [productType, schemaDefinition] of Object.entries(SCHEMAS)) {
    await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: 'UK', productType, schemaVersion: 'v1', expiresAt: new Date(Date.now() + 86_400_000), schemaDefinition } })
  }
  account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'mixed-types', isActive: true, externalAccountId: 'TEST-SELLER',
    authStatus: 'connected', managedBy: 'oauth', region: 'EU' } as never })).id
}), 60_000)
afterAll(async () => { await state.db?.close() })

type Child = { suffix: string; productType: 'OUTERWEAR' | 'PANTS'; size: string }
const OWN = { OUTERWEAR: { facts: { collar: 'Mandarin' }, stored: { lining_type: 'Mesh' } }, PANTS: { facts: { inseam: '32' }, stored: { rise_style: 'Mid' } } }

/** A LIVE family `FAM-<n>` (invented ASINs, so partial updates): a parent of type OUTERWEAR, then one child per entry. */
async function family(n: number, children: Child[]) {
  const prefix = `FAM-${n}`
  const live = (productId: string, row: number, extra: Record<string, unknown>) => prisma.channelListing.create({ data: { productId, channel: 'AMAZON', marketplace: 'UK',
    channelMarket: 'AMAZON_UK', region: 'EU', channelConnectionId: account, externalListingId: `B0FX${n}${String(row).padStart(5, '0')}`, listingStatus: 'ACTIVE',
    isPublished: true, ...extra } as never })
  const parent = await prisma.product.create({ data: { sku: prefix, name: prefix, basePrice: 10, productType: 'OUTERWEAR', isParent: true, variationAxes: ['Size'], fulfillmentMethod: 'FBM' } as never })
  await live(parent.id, 0, { variationTheme: 'SIZE' })
  const ids: Record<string, string> = { [prefix]: parent.id }
  for (const [index, child] of children.entries()) {
    const sku = `${prefix}-${child.suffix}`
    const row = await prisma.product.create({ data: { sku, name: sku, basePrice: 10, productType: child.productType, parentId: parent.id, fulfillmentMethod: 'FBM',
      categoryAttributes: OWN[child.productType].facts } as never })
    await live(row.id, index + 1, { followMasterPrice: true, pricingRule: 'FIXED', price: 9, overrideData: { size: child.size, ...OWN[child.productType].stored } })
    ids[sku] = row.id
  }
  return ids
}

const attributes = (message: { attributes?: Record<string, unknown>; patches?: any[] }) =>
  (message.attributes ?? Object.fromEntries((message.patches ?? []).filter((p: any) => p.op === 'replace').map((p: any) => [p.path.replace('/attributes/', ''), p.value]))) as Record<string, any>
const publish = (parentId: string, options: { full?: boolean } = {}) => scoped(async () => {
  const facts = await readPublicationFacts(parentId, { channel: 'AMAZON', marketplace: 'UK', accountId: account })
  return { facts, publication: await prepareAmazonPublication(facts, options.full ? { fullProductIds: new Set(facts.products.map(p => p.id)) } : {}) }
})
const bySku = (publication: Awaited<ReturnType<typeof prepareAmazonPublication>>) => Object.fromEntries(publication.feed.messages.map(message => [message.sku, message]))
const CROSS_TYPE = /resolution is missing|saved mapping no longer exists/
const value = (text: string) => [{ value: text, marketplace_id: MP }]

describe('🔴 a mixed Amazon family: each row is judged against its own product type', () => {
  const CHILDREN: Child[] = [
    { suffix: 'J-M', productType: 'OUTERWEAR', size: 'M' }, { suffix: 'J-L', productType: 'OUTERWEAR', size: 'L' },
    { suffix: 'P-48', productType: 'PANTS', size: '48' }, { suffix: 'P-50', productType: 'PANTS', size: '50' },
  ]
  const JACKETS = ['FAM-1-J-M', 'FAM-1-J-L'], PANTS = ['FAM-1-P-48', 'FAM-1-P-50']

  it('every row is built with its own product type and its own fields; no row is refused for the other type\'s field', async () => {
    await setMapping({ fields: {}, byProductType: OVERLAYS })
    const ids = await scoped(() => family(1, CHILDREN))
    const { facts, publication } = await publish(ids['FAM-1'], { full: true })
    expect((publication.issues ?? []).filter(issue => CROSS_TYPE.test(issue.message))).toEqual([])
    expect(publication.issues ?? []).toEqual([])
    expect(publication.products.map(p => p.sku).sort()).toEqual(['FAM-1', ...JACKETS, ...PANTS].sort())
    const messages = bySku(publication)
    for (const sku of ['FAM-1', ...JACKETS]) expect(messages[sku].productType).toBe('OUTERWEAR')
    for (const sku of PANTS) expect(messages[sku].productType).toBe('PANTS')
    for (const sku of JACKETS) {
      expect(attributes(messages[sku])).toMatchObject({ collar_style: value('Mandarin'), lining_type: value('Mesh') })
      expect(attributes(messages[sku])).not.toHaveProperty('inseam')
      expect(attributes(messages[sku])).not.toHaveProperty('rise_style')
    }
    for (const sku of PANTS) {
      expect(attributes(messages[sku])).toMatchObject({ inseam: value('32'), rise_style: value('Mid'),
        child_parent_sku_relationship: [expect.objectContaining({ parent_sku: 'FAM-1' })] })
      expect(attributes(messages[sku])).not.toHaveProperty('collar_style')
      expect(attributes(messages[sku])).not.toHaveProperty('lining_type')
    }
    // A Full update may remove only the roots this row's own catalogue manages.
    for (const sku of JACKETS) expect(publication.full?.[ids[sku]]?.managedRoots).toEqual(['collar_style', 'lining_type', 'size'])
    for (const sku of PANTS) expect(publication.full?.[ids[sku]]?.managedRoots).toEqual(['inseam', 'rise_style', 'size'])
    // resolveBatch answers each row's own catalogue.
    expect(Object.keys(facts.resolved[0].catalogues ?? {}).sort()).toEqual(['OUTERWEAR', 'PANTS'])
  })

  it('a channel-wide rule for a PANTS-only field no longer refuses the PANTS rows; the OUTERWEAR rows keep their own refusal, as in a family of one type', async () => {
    await setMapping({ fields: { inseam: { source: 'inseam' } }, byProductType: { OUTERWEAR: OVERLAYS.OUTERWEAR } })
    const ids = await scoped(() => family(2, CHILDREN.map(child => ({ ...child }))))
    const { publication } = await publish(ids['FAM-2'])
    const refused = (sku: string) => (publication.issues ?? []).filter(issue => issue.sku === sku && CROSS_TYPE.test(issue.message)).map(issue => issue.message)
    for (const sku of ['FAM-2-P-48', 'FAM-2-P-50']) {
      expect(refused(sku)).toEqual([])
      expect(attributes(bySku(publication)[sku]).inseam).toEqual(value('32'))
    }
    // The OUTERWEAR schema has no `inseam`: judged against its own catalogue, the rule is a saved mapping without a field.
    for (const sku of ['FAM-2', 'FAM-2-J-M', 'FAM-2-J-L']) expect(refused(sku)).toEqual([`${sku}: A saved mapping no longer exists in the category schema. Review it before publishing.`])
  })
})

describe('a family of one product type builds exactly what it built before', () => {
  it('one catalogue, the very one `catalogue` holds, and the same messages', async () => {
    await setMapping({ fields: {}, byProductType: OVERLAYS })
    const ids = await scoped(() => family(3, [{ suffix: 'J-M', productType: 'OUTERWEAR', size: 'M' }, { suffix: 'J-L', productType: 'OUTERWEAR', size: 'L' }]))
    const { facts, publication } = await publish(ids['FAM-3'], { full: true })
    expect(publication.issues ?? []).toEqual([])
    expect(publication.feed.messages).toEqual(SINGLE_TYPE_MESSAGES)
    // Byte for byte, key order included.
    expect(JSON.stringify(publication.feed.messages)).toBe(JSON.stringify(SINGLE_TYPE_MESSAGES))
    expect(Object.fromEntries(Object.entries(ids).map(([sku, id]) => [sku, publication.full?.[id]?.managedRoots])))
      .toEqual({ 'FAM-3': ['collar_style'], 'FAM-3-J-M': ['collar_style', 'lining_type', 'size'], 'FAM-3-J-L': ['collar_style', 'lining_type', 'size'] })
    expect(Object.keys(facts.resolved[0].catalogues ?? {})).toEqual(['OUTERWEAR'])
    expect(facts.resolved[0].catalogues?.OUTERWEAR).toBe(facts.resolved[0].catalogue)
  })

  it('resolveBatch returns `catalogues` only to the caller that asks for it', async () => {
    const ids = await scoped(() => family(4, [{ suffix: 'P-48', productType: 'PANTS', size: '48' }]))
    const input = { channel: 'AMAZON', marketplace: 'UK', channelConnectionId: account, aliasKey: '', productIds: Object.values(ids), includeCatalogue: true }
    const plain = await scoped(() => resolveBatch(input))
    expect(plain).not.toHaveProperty('catalogues')
    const asked = await scoped(() => resolveBatch({ ...input, includeCatalogues: true }))
    expect(Object.keys(asked.catalogues ?? {}).sort()).toEqual(['OUTERWEAR', 'PANTS'])
    const { catalogues: _catalogues, ...rest } = asked
    expect(rest).toEqual(plain)
  })
})

// Captured from origin/main before this change (the same fixture): what a family of one type sent then.
const SINGLE_TYPE_MESSAGES: unknown[] = [
  { messageId: 1, sku: 'FAM-3', operationType: 'PARTIAL_UPDATE', productType: 'OUTERWEAR', attributes: {
    parentage_level: [{ value: 'parent', marketplace_id: 'TEST_MARKET_UK' }],
    variation_theme: [{ name: 'SIZE' }],
  } },
  { messageId: 2, sku: 'FAM-3-J-L', operationType: 'PARTIAL_UPDATE', productType: 'OUTERWEAR', attributes: {
    purchasable_offer: [{ currency: 'GBP', our_price: [{ schedule: [{ value_with_tax: 9 }] }], marketplace_id: 'TEST_MARKET_UK' }],
    parentage_level: [{ value: 'child', marketplace_id: 'TEST_MARKET_UK' }],
    child_parent_sku_relationship: [{ parent_sku: 'FAM-3', marketplace_id: 'TEST_MARKET_UK' }],
    size: 'L',
    lining_type: [{ value: 'Mesh', marketplace_id: 'TEST_MARKET_UK' }],
    collar_style: [{ value: 'Mandarin', marketplace_id: 'TEST_MARKET_UK' }],
  } },
  { messageId: 3, sku: 'FAM-3-J-M', operationType: 'PARTIAL_UPDATE', productType: 'OUTERWEAR', attributes: {
    purchasable_offer: [{ currency: 'GBP', our_price: [{ schedule: [{ value_with_tax: 9 }] }], marketplace_id: 'TEST_MARKET_UK' }],
    parentage_level: [{ value: 'child', marketplace_id: 'TEST_MARKET_UK' }],
    child_parent_sku_relationship: [{ parent_sku: 'FAM-3', marketplace_id: 'TEST_MARKET_UK' }],
    size: 'M',
    lining_type: [{ value: 'Mesh', marketplace_id: 'TEST_MARKET_UK' }],
    collar_style: [{ value: 'Mandarin', marketplace_id: 'TEST_MARKET_UK' }],
  } },
]
