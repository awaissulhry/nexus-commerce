/**
 * MCP full control T3 (docs/mcp-full-control/sections/03-content.md §3, §6 step 3) — the content read tools, run through
 * the door Claude uses (callTool), on PostgreSQL with the production schema and business-isolation policies (PGlite):
 *
 *   product-content     the shared text in the primary language and in another one (with the fallback said), a listing's
 *                       own pin against a listing that follows the shared text, the review states (reviewed, AI draft,
 *                       outdated), a variation that only repeats its parent, a cell that cannot be edited and why;
 *                       never a write token; a deleted product and another business's product are not found
 *   translation-status  per product × language × field: missing, ai-draft, outdated, reviewed, source; a variation
 *                       counts its parent's text; a deleted product or another business's refuses the call
 *   content-guidelines  (T4) the glossary and brand voice for a brand, market and language, most specific winning; the
 *                       voice's operator memo never shown; another business's rules never shown
 *   content-gaps        (T9) the recorded readiness rows that are not ready: missing required fields by name, untranslated
 *                       fields; an `absent` row (requirements could not be checked) and a row being rebuilt are said so,
 *                       and products or listings with nothing recorded are counted — "not recorded" is never complete;
 *                       pages with a keyset cursor; another business's rows never show
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
// As db.ts wraps it: inside a transaction, `prisma.x` is that transaction's client (the sheet reads in one).
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property) }) }
})
vi.mock('../../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))

import { callTool, type UserPrincipal } from '../call-tool.js'

const A = LEGACY_WORKSPACE_ID
const B = 'mcp_content_business_bravo'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const readerIn = (workspaceId: string): UserPrincipal => ({
  kind: 'user',
  userId: 'u-content',
  label: 'Content reader',
  permissions: { isOwner: false, permissions: new Set(['ai.run', FEATURES.productsView, FEATURES.listingsView]) },
  workspace: business(workspaceId),
  via: 'claude',
})

type Data = Record<string, any>
async function call(tool: string, args: Record<string, unknown>, workspaceId = A): Promise<{ ok: boolean; error?: string; data?: Data }> {
  return (await inside(() => callTool(readerIn(workspaceId), tool, args), workspaceId)).visible as { ok: boolean; error?: string; data?: Data }
}
async function read(tool: string, args: Record<string, unknown>): Promise<Data> {
  const out = await call(tool, args)
  expect(out.ok, out.error).toBe(true)
  return out.data!
}
const db = () => database.client
const ids = { parent: '', child: '', other: '', deleted: '', bravo: '', amazonDe: '', ebayDe: '' }

beforeAll(async () => {
  database = await formulaDatabase()
  // Business profiles on, as production runs: with them off there is one business and nothing to keep apart.
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  const owner = await db().userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active' } })
  await db().workspace.create({ data: { id: B, name: 'Bravo content business', createdByUserId: owner.id, creationKey: randomUUID() } })
  await inside(async () => {
    for (const [channel, code, language] of [['AMAZON', 'IT', 'it'], ['AMAZON', 'DE', 'de'], ['EBAY', 'DE', 'de'], ['EBAY', 'IT', 'it']] as const) {
      await db().marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency: 'EUR', region: 'EU', language, languages: [language], marketplaceId: `TEST_${channel}_${code}` } })
    }
    // Amazon's cached rules for the jacket's product type on DE: a title, bullets, a colour from a list (required) and a
    // fit that cannot change on a listing Amazon already has.
    const attribute = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: 'array', maxItems: 1, items: { type: 'object', properties }, ...extra })
    await db().categorySchema.create({ data: { channel: 'AMAZON', marketplace: 'DE', productType: 'TEST_JACKET', schemaVersion: 'content-fixture', expiresAt: new Date('2099-01-01'), schemaDefinition: {
      type: 'object', required: ['item_name', 'color'], properties: {
        item_name: attribute({ value: { type: 'string', maxLength: 150 } }),
        product_description: attribute({ value: { type: 'string', maxLength: 2000 } }),
        bullet_point: attribute({ value: { type: 'string', maxLength: 500 } }, { maxItems: 5 }),
        color: attribute({ value: { type: 'string', enum: ['Nero', 'Rosso'] } }),
        fit_type: attribute({ value: { type: 'string', editable: false } }),
      },
    } } })
    const amazon = await db().channelConnection.create({ data: { channelType: 'AMAZON', isActive: true } as never })
    const ebay = await db().channelConnection.create({ data: { channelType: 'EBAY', isActive: true } as never })
    const parent = await db().product.create({ data: {
      sku: 'TEST-CT-JACKET', name: 'Giacca moto', basePrice: '100.00', isParent: true, productType: 'TEST_JACKET',
      description: 'Giacca da moto in pelle.', bulletPoints: ['Pelle', 'Protezioni'], keywords: ['giacca'],
    } })
    ids.parent = parent.id
    ids.child = (await db().product.create({ data: { sku: 'TEST-CT-JACKET-S', name: 'Giacca moto S', basePrice: '100.00', parentId: parent.id, productType: 'TEST_JACKET' } })).id
    // Reviewed German shared text for the title only: the description has none in German.
    await db().productTranslation.create({ data: { productId: parent.id, language: 'de', name: 'Motorradjacke', source: 'manual', reviewedAt: new Date() } })
    // French: a machine draft nobody reviewed. Spanish: reviewed, but written against an older source text.
    await db().productTranslation.create({ data: { productId: parent.id, language: 'fr', name: 'Veste moto', source: 'ai-gemini', reviewedAt: null } })
    await db().productTranslation.create({ data: { productId: parent.id, language: 'es', name: 'Chaqueta moto', source: 'manual', reviewedAt: new Date(), sourceHash: 'an-older-source' } })
    // Amazon DE: the parent's listing has its own German title (a pin). eBay DE: the parent's listing follows the shared text.
    const listing = (productId: string, channel: string, market: string, accountId: string) => db().channelListing.create({ data: {
      productId, channel, marketplace: market, region: 'EU', channelMarket: `${channel}_${market}`, channelConnectionId: accountId,
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: `FIXTURE-${channel}-${productId}`,
    } as never })
    ids.amazonDe = (await listing(parent.id, 'AMAZON', 'DE', amazon.id)).id
    await listing(ids.child, 'AMAZON', 'DE', amazon.id)
    ids.ebayDe = (await listing(parent.id, 'EBAY', 'DE', ebay.id)).id
    await db().channelListingTranslation.create({ data: { channelListingId: ids.amazonDe, language: 'de', name: 'Amazon-Titel' } })

    // The glossary: an all-brand row (Giacca, not Giubbotto), the brand's own row (it says Giubbotto), German, another brand.
    for (const [brand, marketplace, language, preferred, avoid, context] of [
      [null, 'IT', 'it', 'Giacca', ['Giubbotto', 'Bomber'], 'Every brand says Giacca.'],
      ['Test Brand', 'IT', 'it', 'Giubbotto', ['Giaccone'], 'Test Brand says Giubbotto.'],
      [null, 'DE', 'de', 'Jacke', ['Blouson'], null],
      ['Other Brand', 'IT', 'it', 'Casco', ['Elmetto'], null],
    ] as const) {
      await db().terminologyPreference.create({ data: { brand, marketplace, language, preferred, avoid: [...avoid], context } })
    }
    // The brand voice: one for everyone, one for the IT market, one for the brand on IT in Italian (with a memo).
    await db().brandVoice.create({ data: { body: 'Plain words for everyone.' } })
    await db().brandVoice.create({ data: { marketplace: 'IT', body: 'Tono tecnico per il mercato italiano.' } })
    await db().brandVoice.create({ data: { brand: 'Test Brand', marketplace: 'IT', language: 'it', body: 'Test Brand: brevi frasi tecniche.', notes: 'OPERATOR-MEMO-ONLY' } })

    ids.other = (await db().product.create({ data: { sku: 'TEST-CT-GLOVE', name: 'Guanti', basePrice: '20.00', description: 'Guanti estivi.' } })).id
    ids.deleted = (await db().product.create({ data: { sku: 'TEST-CT-GONE', name: 'Giacca vecchia', basePrice: '10.00', deletedAt: new Date() } })).id
  })
  await withWorkspace(business(B), async () => {
    await db().marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'eBay IT', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'TEST_B_EBAY_IT' } })
    ids.bravo = (await db().product.create({ data: { sku: 'TEST-CT-BRAVO', name: 'Bravo jacket', basePrice: '10.00', description: 'Bravo text.' } })).id
    await db().terminologyPreference.create({ data: { brand: null, marketplace: 'IT', language: 'it', preferred: 'BRAVO-WORD', avoid: ['BRAVO-AVOID'] } })
    await db().brandVoice.create({ data: { marketplace: 'IT', body: 'BRAVO voice.' } })
  })
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

const rowOf = (data: Data, id: string) => data.rows.find((row: Data) => row.id === id)
const WRITE_TOKENS = /"(writeField|writeTarget|writeVerb|contentAddress|contentAcknowledgement|contentVersion)"/

describe('product-content — the shared text', () => {
  it('in the primary language: the source text, the required title, and a variation that only repeats its parent', async () => {
    const data = await read('product-content', { product: ids.parent })
    expect(data).toMatchObject({ product: { id: ids.parent, sku: 'TEST-CT-JACKET' }, language: 'it', primaryLanguage: 'it', scope: 'shared' })
    expect(data.fields.map((f: Data) => f.field)).toEqual(expect.arrayContaining(['title', 'description', 'bulletPoints', 'keywords']))
    expect(rowOf(data, ids.parent).cells).toMatchObject({
      title: { value: 'Giacca moto', layer: 'source', review: 'source', required: true },
      description: { value: 'Giacca da moto in pelle.', layer: 'source', review: 'source' },
      bulletPoints: { value: ['Pelle', 'Protezioni'], layer: 'source' },
    })
    const child = rowOf(data, ids.child)
    expect(child).toMatchObject({ sku: 'TEST-CT-JACKET-S', role: 'child' })
    // Its own title is shown; its description is the parent's, said once, not repeated.
    expect(child.cells.title).toMatchObject({ value: 'Giacca moto S', layer: 'source' })
    expect(child.cells.description).toMatchObject({ sameAsParent: true, fromParent: true, layer: 'source' })
    expect(child.cells.description).not.toHaveProperty('value')
  })

  it('in another language: shared German text is reviewed; a field with no German text says it shows the Italian', async () => {
    const data = await read('product-content', { product: ids.parent, language: 'DE' })
    expect(data.language).toBe('de')
    const cells = rowOf(data, ids.parent).cells
    expect(cells.title).toMatchObject({ value: 'Motorradjacke', layer: 'language', review: 'reviewed' })
    expect(cells.title).not.toHaveProperty('language')
    expect(cells.description).toMatchObject({ value: 'Giacca da moto in pelle.', layer: 'source', language: 'it', review: 'missing' })
    // The variation has no German text of its own: it reads its parent's (the same value, said once).
    expect(rowOf(data, ids.child).cells.title).toMatchObject({ sameAsParent: true, layer: 'language', review: 'reviewed', fromParent: true })
  })

  it('an AI draft nobody reviewed, and reviewed text whose source changed since', async () => {
    expect(rowOf(await read('product-content', { product: ids.parent, language: 'fr' }), ids.parent).cells.title)
      .toMatchObject({ value: 'Veste moto', layer: 'language', review: 'ai-draft' })
    expect(rowOf(await read('product-content', { product: ids.parent, language: 'es' }), ids.parent).cells.title)
      .toMatchObject({ value: 'Chaqueta moto', layer: 'language', review: 'outdated' })
  })

  it('a variation named reads its family, and says which one was asked for', async () => {
    const data = await read('product-content', { product: 'TEST-CT-JACKET-S' })
    expect(data.product.id).toBe(ids.parent)
    expect(data.asked).toEqual({ id: ids.child, sku: 'TEST-CT-JACKET-S' })
  })

  it('only the fields named, and the names it does not know', async () => {
    const data = await read('product-content', { product: ids.parent, fields: ['title', 'Search keywords', 'no-such-field'] })
    expect(data.fields.map((f: Data) => f.field)).toEqual(['title', 'keywords'])
    expect(Object.keys(rowOf(data, ids.parent).cells).sort()).toEqual(['keywords', 'title'])
    expect(data.unknownFields).toEqual(['no-such-field'])
  })
})

describe('product-content — one listing (channel + market)', () => {
  it("Amazon DE's own German title (a pin) against eBay DE, which follows the shared German text", async () => {
    const amazon = await read('product-content', { product: ids.parent, language: 'de', coordinate: { channel: 'amazon', market: 'de' } })
    expect(amazon).toMatchObject({ scope: 'Amazon · DE', coordinate: { channel: 'AMAZON', market: 'DE' } })
    expect(rowOf(amazon, ids.parent)).toMatchObject({ listing: { status: 'ACTIVE', published: true } })
    expect(rowOf(amazon, ids.parent).cells.title).toMatchObject({ value: 'Amazon-Titel', layer: 'pin', followsShared: false, review: 'reviewed' })
    // The variation's Amazon DE listing has no pin: it shows the shared German text.
    expect(rowOf(amazon, ids.child).cells.title).toMatchObject({ value: 'Motorradjacke', followsShared: true, review: 'reviewed' })

    const ebay = await read('product-content', { product: ids.parent, language: 'de', coordinate: { channel: 'EBAY', market: 'DE' } })
    expect(rowOf(ebay, ids.parent).cells.title).toMatchObject({ value: 'Motorradjacke', followsShared: true, review: 'reviewed' })
  })

  it("the channel's limits and options, what is required, and why a cell cannot be edited", async () => {
    const data = await read('product-content', { product: ids.parent, language: 'de', coordinate: { channel: 'AMAZON', market: 'DE' } })
    const field = (name: string) => data.fields.find((f: Data) => f.field === name)
    expect(field('title')).toMatchObject({ maxLength: 150, limitFrom: 'Amazon · DE' })
    expect(field('bulletPoints')).toMatchObject({ maxItems: 5, maxLength: 500 })
    expect(field('color')).toMatchObject({ options: ['Nero', 'Rosso'], optionsOnly: true })
    // The product type is the listing's classification, not its content.
    expect(field('productType')).toBeUndefined()
    const cells = rowOf(data, ids.parent).cells
    expect(cells.color).toMatchObject({ value: null, required: true })
    expect(cells.title.required).toBe(true)
    // Amazon marks the fit read-only on a listing it already has.
    expect(cells.fit_type).toMatchObject({ editable: false, blockedReason: expect.stringMatching(/read-only on an existing listing/) })
    expect(cells.title).not.toHaveProperty('editable')
  })

  it('a market where the channel is not set up is refused by name', async () => {
    const out = await call('product-content', { product: ids.parent, coordinate: { channel: 'EBAY', market: 'FR' } })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/FR/)
  })
})

describe('product-content — never a write token; deleted and other business = not found', () => {
  it('no answer carries a write token (writeField, writeTarget, contentAddress, the acknowledgement)', async () => {
    for (const args of [
      { product: ids.parent }, { product: ids.parent, language: 'de' },
      { product: ids.parent, language: 'de', coordinate: { channel: 'AMAZON', market: 'DE' } },
      { product: ids.parent, language: 'de', coordinate: { channel: 'EBAY', market: 'DE' } },
    ]) {
      const text = JSON.stringify(await read('product-content', args))
      expect(text).not.toMatch(WRITE_TOKENS)
      expect(text).not.toContain('attr_')
    }
  })

  it('a deleted product is not found, by id and by SKU', async () => {
    for (const product of [ids.deleted, 'TEST-CT-GONE']) {
      expect(await call('product-content', { product })).toEqual({ ok: false, error: 'Product not found' })
    }
  })

  it("another business's product is not found, by id and by SKU — and is found inside that business (control)", async () => {
    for (const product of [ids.bravo, 'TEST-CT-BRAVO']) {
      expect(await call('product-content', { product })).toEqual({ ok: false, error: 'Product not found' })
      expect(await call('translation-status', { products: [product], languages: ['it'] })).toMatchObject({ ok: false, error: expect.stringMatching(/^Product not found/) })
    }
    const own = await call('product-content', { product: 'TEST-CT-BRAVO' }, B)
    expect(own.ok, own.error).toBe(true)
    expect(rowOf(own.data!, ids.bravo).cells.title.value).toBe('Bravo jacket')
  })
})

describe('translation-status', () => {
  it('per product, language and field: source, reviewed, missing, ai-draft, outdated', async () => {
    const data = await read('translation-status', { products: [ids.parent], languages: ['it', 'de', 'fr', 'es', 'en'] })
    expect(data).toMatchObject({ primaryLanguage: 'it', languages: ['it', 'de', 'fr', 'es', 'en'], fields: ['title', 'description', 'bulletPoints', 'keywords'] })
    const [jacket] = data.products
    expect(jacket).toMatchObject({ id: ids.parent, sku: 'TEST-CT-JACKET', complete: ['it'] })
    expect(jacket.gaps).toEqual({
      de: { description: 'missing', bulletPoints: 'missing', keywords: 'missing' },
      fr: { title: 'ai-draft', description: 'missing', bulletPoints: 'missing', keywords: 'missing' },
      es: { title: 'outdated', description: 'missing', bulletPoints: 'missing', keywords: 'missing' },
      en: { title: 'missing', description: 'missing', bulletPoints: 'missing', keywords: 'missing' },
    })
    expect(data.totals).toEqual({
      it: { source: 4 }, de: { reviewed: 1, missing: 3 }, fr: { 'ai-draft': 1, missing: 3 }, es: { outdated: 1, missing: 3 }, en: { missing: 4 },
    })
  })

  it("a variation counts its parent's text; products named by SKU; each product once", async () => {
    const data = await read('translation-status', { products: ['TEST-CT-JACKET-S', ids.child, 'TEST-CT-GLOVE'], languages: ['de'] })
    expect(data.products.map((p: Data) => p.sku)).toEqual(['TEST-CT-JACKET-S', 'TEST-CT-GLOVE'])
    expect(data.products[0].gaps.de).toEqual({ description: 'missing', bulletPoints: 'missing', keywords: 'missing' })
    expect(data.products[1].gaps.de).toEqual({ title: 'missing', description: 'missing', bulletPoints: 'missing', keywords: 'missing' })
  })

  it("by default, every language of the business's active markets", async () => {
    expect((await read('translation-status', { products: [ids.other] })).languages).toEqual(['de', 'it'])
  })

  it('a deleted product, or a language that is not one, refuses the call', async () => {
    expect(await call('translation-status', { products: [ids.parent, 'TEST-CT-GONE'] })).toEqual({ ok: false, error: 'Product not found: TEST-CT-GONE' })
    expect(await call('translation-status', { products: [ids.parent], languages: ['d3'] })).toMatchObject({ ok: false, error: expect.stringMatching(/not a language/) })
  })
})

describe('content-guidelines (T4)', () => {
  it("for a brand, market and language: the brand's own rows win, and the closest brand voice — never its memo", async () => {
    const data = await read('content-guidelines', { brand: 'Test Brand', market: 'it', language: 'IT' })
    expect(data.scope).toEqual({ brand: 'Test Brand', market: 'IT', language: 'it' })
    expect(data.glossary).toEqual([
      { preferred: 'Giubbotto', avoid: ['Giaccone'], context: 'Test Brand says Giubbotto.', brand: 'Test Brand', market: 'IT', language: 'it' },
      // The all-brand row stays, without the word this brand prefers.
      { preferred: 'Giacca', avoid: ['Bomber'], context: 'Every brand says Giacca.', brand: null, market: 'IT', language: 'it' },
    ])
    expect(data.brandVoice).toEqual({ text: 'Test Brand: brevi frasi tecniche.', appliesTo: { brand: 'Test Brand', market: 'IT', language: 'it' } })
    expect(JSON.stringify(data)).not.toContain('OPERATOR-MEMO-ONLY')
  })

  it('with no brand: every brand\'s rows, each naming its brand, and the market\'s voice', async () => {
    const data = await read('content-guidelines', { market: 'IT' })
    expect(data.glossary.map((row: Data) => [row.brand, row.preferred])).toEqual([['Other Brand', 'Casco'], ['Test Brand', 'Giubbotto'], [null, 'Giacca']])
    expect(data.brandVoice).toMatchObject({ text: 'Tono tecnico per il mercato italiano.', appliesTo: { brand: null, market: 'IT', language: null } })
  })

  it('one language only; a scope with nothing set says so; the all-brand voice is the last fallback', async () => {
    const german = await read('content-guidelines', { language: 'de' })
    expect(german.glossary).toEqual([{ preferred: 'Jacke', avoid: ['Blouson'], context: null, brand: null, market: 'DE', language: 'de' }])
    const none = await read('content-guidelines', { market: 'FR' })
    expect(none).toMatchObject({ glossary: [], glossaryNote: expect.any(String) })
    expect(none.brandVoice).toMatchObject({ text: 'Plain words for everyone.' })
  })

  it("another business's glossary and voice never show — and do inside it (control)", async () => {
    const text = JSON.stringify(await read('content-guidelines', { market: 'IT' }))
    expect(text).not.toContain('BRAVO')
    const own = await call('content-guidelines', { market: 'IT' }, B)
    expect(own.ok, own.error).toBe(true)
    expect(JSON.stringify(own.data)).toContain('BRAVO-WORD')
    expect(own.data!.brandVoice.text).toBe('BRAVO voice.')
  })
})

describe('content-gaps (T9)', () => {
  const rowsFor: Record<string, string> = {}
  beforeAll(async () => {
    const { readinessCoordinateKey } = await import('../../pim/readiness-model.js')
    const shared = { channel: null, market: null, accountId: null, aliasId: null }
    const amazonDe = { channel: 'AMAZON', market: 'DE', accountId: 'TEST-ACCOUNT', aliasId: null }
    const ebayDe = { channel: 'EBAY', market: 'DE', accountId: 'TEST-EBAY', aliasId: null }
    const row = (key: string, productId: string, coordinate: typeof shared | typeof amazonDe, language: string, label: string, data: Record<string, unknown>) =>
      db().readinessIndex.create({ data: {
        productId, ...coordinate, coordinateKey: readinessCoordinateKey(coordinate), language, label, pct: null,
        requiredFilled: 0, requiredTotal: 0, missing: [], computedAt: new Date('2026-10-01T08:00:00Z'), ...data,
      } as never }).then((created) => { rowsFor[key] = created.id })
    await inside(async () => {
      await row('sharedIt', ids.parent, shared, 'it', 'Shared product', { state: 'ready', pct: 100, requiredFilled: 2, requiredTotal: 2 })
      await row('sharedDe', ids.parent, shared, 'de', 'Shared product', { state: 'warn', pct: 100, requiredFilled: 1, requiredTotal: 1,
        missing: [{ productId: ids.parent, field: 'description', label: 'Description', reason: 'de content is missing; showing it fallback.', kind: 'language-fallback' }] })
      // Two required values empty, one of them named (a row written before every empty one was flagged).
      await row('amazonParent', ids.parent, amazonDe, 'de', 'Amazon · DE', { state: 'blocked', pct: 33, requiredFilled: 1, requiredTotal: 3,
        missing: [{ productId: ids.parent, field: 'color', label: 'Color', reason: 'Required and empty', requiredEmpty: true }] })
      await row('amazonChild', ids.child, amazonDe, 'de', 'Amazon · DE', { state: 'absent', note: 'Category metadata is incomplete: AMAZON:TEST_JACKET' })
      await row('ebayChild', ids.child, ebayDe, 'de', 'eBay · DE', { state: 'ready', pct: 100, requiredFilled: 3, requiredTotal: 3, pendingSince: new Date('2026-10-01T09:00:00Z') })
    })
    await withWorkspace(business(B), async () => {
      await row('bravo', ids.bravo, shared, 'it', 'Shared product', { state: 'blocked', requiredFilled: 0, requiredTotal: 1,
        missing: [{ productId: ids.bravo, field: 'description', label: 'BRAVO-FIELD', reason: 'Required and empty', requiredEmpty: true }] })
    })
  }, 60_000)

  const keysOf = (data: Data) => data.items.map((item: Data) => Object.keys(rowsFor).find((key) =>
    rowsFor[key] && item.productId === (key.endsWith('Child') ? ids.child : ids.parent) && item.channel === ({ sharedIt: 'SHARED', sharedDe: 'SHARED', amazonParent: 'AMAZON', amazonChild: 'AMAZON', ebayChild: 'EBAY' } as Record<string, string>)[key]
      && item.language === (key === 'sharedIt' ? 'it' : 'de')))

  it('every row that is not ready, and a ready row being rebuilt: what is missing, by name', async () => {
    const data = await read('content-gaps', {})
    expect(data.total).toBe(4)
    expect(keysOf(data).sort()).toEqual(['amazonChild', 'amazonParent', 'ebayChild', 'sharedDe'])
    const item = (key: string) => data.items[keysOf(data).indexOf(key)]
    expect(item('amazonParent')).toMatchObject({
      sku: 'TEST-CT-JACKET', channel: 'AMAZON', market: 'DE', accountId: 'TEST-ACCOUNT', language: 'de', label: 'Amazon · DE', state: 'blocked',
      recorded: true, required: { filled: 1, total: 3 }, missingRequired: ['Color'], unnamedEmpty: 1,
    })
    expect(item('sharedDe')).toMatchObject({ channel: 'SHARED', state: 'warn', recorded: true, untranslated: ['Description'] })
    expect(item('sharedDe')).not.toHaveProperty('missingRequired')
    expect(item('ebayChild')).toMatchObject({ state: 'ready', checking: { since: '2026-10-01T09:00:00.000Z', note: expect.any(String) } })
  })

  it("'absent' is not recorded — never complete: no counts, and why", async () => {
    const data = await read('content-gaps', { state: 'absent' })
    expect(data.items).toEqual([expect.objectContaining({ sku: 'TEST-CT-JACKET-S', state: 'absent', recorded: false, note: 'Category metadata is incomplete: AMAZON:TEST_JACKET' })])
    expect(data.items[0]).not.toHaveProperty('required')
  })

  it('filters: a channel and market, the shared text, a language, a state', async () => {
    expect(keysOf(await read('content-gaps', { channel: 'amazon', market: 'de' })).sort()).toEqual(['amazonChild', 'amazonParent'])
    expect(keysOf(await read('content-gaps', { channel: 'SHARED' }))).toEqual(['sharedDe'])
    expect(keysOf(await read('content-gaps', { state: 'checking' }))).toEqual(['ebayChild'])
    expect(keysOf(await read('content-gaps', { state: 'blocked' }))).toEqual(['amazonParent'])
    // Italian is recorded and ready: nothing missing, and it says nothing about "not recorded".
    const italian = await read('content-gaps', { language: 'it' })
    expect(italian).toMatchObject({ items: [], total: 0 })
    expect(italian).not.toHaveProperty('nothingRecorded')
    expect(await call('content-gaps', { channel: 'SHARED', market: 'IT' })).toMatchObject({ ok: false, error: expect.stringMatching(/no market/) })
  })

  it('what was never recorded is said, never read as complete', async () => {
    // Etsy: nothing recorded at all.
    const etsy = await read('content-gaps', { channel: 'ETSY' })
    expect(etsy).toMatchObject({ items: [], total: 0, nothingRecorded: expect.stringMatching(/not known whether anything is missing/) })
    // eBay DE: the parent's listing has no row (only the variation's does).
    expect((await read('content-gaps', { channel: 'EBAY', market: 'DE' })).notRecorded).toMatchObject({ listings: 1 })
    // Shared: the variation and the gloves have no shared row.
    expect((await read('content-gaps', { channel: 'SHARED' })).notRecorded).toMatchObject({ products: 2 })
  })

  it('pages with a cursor: every row once, in one order; a cursor from other filters is refused', async () => {
    const first = await read('content-gaps', { limit: 3 })
    expect(first.items).toHaveLength(3)
    expect(first.nextCursor).toEqual(expect.any(String))
    const second = await read('content-gaps', { limit: 3, cursor: first.nextCursor })
    expect(second).toMatchObject({ nextCursor: null, total: 4 })
    const all = [...keysOf(first), ...keysOf(second)]
    expect(all.sort()).toEqual(['amazonChild', 'amazonParent', 'ebayChild', 'sharedDe'])
    expect(keysOf(await read('content-gaps', { limit: 100 }))).toEqual([...keysOf(first), ...keysOf(second)])
    expect(await call('content-gaps', { limit: 3, cursor: first.nextCursor, state: 'blocked' })).toMatchObject({ ok: false, error: expect.stringMatching(/cursor/) })
  })

  it("another business's rows never show — and do inside it (control)", async () => {
    expect(JSON.stringify(await read('content-gaps', { limit: 100 }))).not.toContain('BRAVO')
    const own = await call('content-gaps', {}, B)
    expect(own.ok, own.error).toBe(true)
    expect(own.data!.items).toEqual([expect.objectContaining({ sku: 'TEST-CT-BRAVO', missingRequired: ['BRAVO-FIELD'] })])
  })
})
