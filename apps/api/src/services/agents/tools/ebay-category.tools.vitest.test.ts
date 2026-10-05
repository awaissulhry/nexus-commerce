/**
 * MCP phase 3 T3 — `ebay-categories`, through the door Claude uses (callTool), on PostgreSQL with the production schema
 * and the business-isolation policies (PGlite). eBay itself is stood in for at the service boundary the tool calls
 * (`EbayCategoryService`, whose every call goes through the channel gateway): no test may reach a marketplace.
 *
 *   query        eBay's suggestions on the business's market, at most 10, each leaf flag checked against Nexus's copy
 *                of eBay's tree; eBay unreachable → that copy searched instead; no copy → said in words
 *   categoryId   loaded in Nexus → the cached definition, no eBay call; not loaded → read live through the service's
 *                own calls (its cache respected: no forceRefresh) and NOTHING stored; a non-leaf refused; bounded lists;
 *                one item specific with its values searched
 *   market       the business's own eBay codes (EBAY_IT read as IT, GB as UK); a switched-off or unknown one refused
 *   business     each business reads its own loaded categories, and has its own service instance (its own eBay token)
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURES as F } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'
import type { EbayAspectRich } from '../../ebay-category.service.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
// As db.ts wraps it: inside a transaction, `prisma.x` is that transaction's client.
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

// eBay, at the service the tool calls. Records every call and every instance (one per business).
const ebay = vi.hoisted(() => ({
  down: false,
  instances: 0,
  searches: [] as Array<{ market: unknown; query: string; options: unknown }>,
  aspectReads: [] as Array<{ categoryId: string; market: unknown; options: unknown }>,
  conditionReads: [] as Array<{ categoryId: string; market: unknown; options: unknown }>,
  aspects: [] as unknown[],
  conditionsDown: false,
}))
vi.mock('../../ebay-category.service.js', () => ({
  EbayCategoryService: class {
    constructor() { ebay.instances++ }
    async searchCategories(market: unknown, query: string, options: unknown) {
      ebay.searches.push({ market, query, options })
      if (ebay.down) throw new Error('network: fetch failed')
      // eBay answers more than the tool may show: the tool bounds it.
      return Array.from({ length: 12 }, (_, i) => ({
        productType: i === 0 ? '177104' : i === 1 ? '6000' : String(900000 + i),
        displayName: i === 0 ? 'Moto › Abbigliamento › Giacche' : i === 1 ? 'Moto › Abbigliamento' : `Moto › Altro ${i}`,
        bundled: false, matchPercentage: 90 - i,
      }))
    }
    async getCategoryAspectsRich(categoryId: string, market: unknown, options: unknown) {
      ebay.aspectReads.push({ categoryId, market, options })
      if (ebay.down) throw new Error('network: fetch failed')
      return ebay.aspects
    }
    async getItemConditionPolicies(categoryId: string, market: unknown, options: unknown) {
      ebay.conditionReads.push({ categoryId, market, options })
      if (ebay.down || ebay.conditionsDown) throw new Error('eBay returned no condition policy for category ' + categoryId)
      return [{ conditionId: '1000', conditionDescription: 'Nuovo con etichette' }, { conditionId: '3000', conditionDescription: 'Usato' }]
    }
  },
}))

import { callTool, type UserPrincipal } from '../call-tool.js'
import { ebayCategoryDefinition } from '../../categories/ebay-category-definition.js'

const A = LEGACY_WORKSPACE_ID
const B = 'ebay_categories_business_bravo'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace(business(workspaceId), work)
const reader = (workspaceId = A): UserPrincipal => ({
  kind: 'user', userId: 'u-ebay-categories', label: 'Category reader', permissions: { isOwner: false, permissions: new Set([F.listingsView, F.aiRun]) },
  workspace: business(workspaceId), via: 'claude',
})
type Data = Record<string, any>
const db = () => database.client

async function call(args: Record<string, unknown>, workspaceId = A) {
  return (await inside(workspaceId, () => callTool(reader(workspaceId), 'ebay-categories', args))).visible as { ok: boolean; error?: string; data?: Data }
}
async function read(args: Record<string, unknown>, workspaceId = A) {
  const out = await call(args, workspaceId)
  expect(out.ok, out.error).toBe(true)
  return out.data!
}
const rich = (over: Partial<EbayAspectRich> & { name: string }): EbayAspectRich => ({
  dataType: 'STRING', mode: 'FREE_TEXT', usage: 'OPTIONAL', required: false, cardinality: 'SINGLE', variantEligible: false, values: [], ...over,
})
/** What Nexus stores for a category ("Load eBay fields"), built by the writer's own builder. */
const loadedRow = (market: string, categoryId: string, aspects: EbayAspectRich[]) => ({
  channel: 'EBAY', marketplace: market, productType: categoryId, schemaVersion: randomUUID(),
  schemaDefinition: ebayCategoryDefinition(aspects, [{ conditionId: '1000', conditionDescription: 'Nuovo con etichette' }]) as never,
  expiresAt: new Date(Date.now() + 86_400_000),
})
const counts = (workspaceId = A) => inside(workspaceId, async () => ({
  schemas: await db().categorySchema.count(), taxonomies: await db().marketplaceTaxonomy.count(), nodes: await db().marketplaceTaxonomyNode.count(),
}))

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  const owner = await db().userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active' } })
  await db().workspace.create({ data: { id: B, name: 'Bravo categories business', createdByUserId: owner.id, creationKey: randomUUID() } })
  const market = (code: string, isActive = true) => db().marketplace.create({
    data: { channel: 'EBAY', code, name: `eBay ${code}`, currency: code === 'UK' ? 'GBP' : 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: code === 'UK' ? 'EBAY_GB' : `EBAY_${code}`, isActive } as never,
  })
  await inside(A, async () => {
    await market('IT'); await market('UK'); await market('DE', false)
    // Loaded in Nexus on IT: 177104 (a person used "Load eBay fields").
    await db().categorySchema.create({ data: loadedRow('IT', '177104', [
      rich({ name: 'Colore', englishName: 'Colour', usage: 'RECOMMENDED', cardinality: 'MULTI', variantEligible: true, values: ['Nero', 'Rosso', 'Blu'] }),
      rich({ name: 'Marca', englishName: 'Brand', required: true, usage: 'REQUIRED', mode: 'SELECTION_ONLY', values: ['Xavia', 'Dainese', 'Alpinestars'] }),
      rich({ name: 'Taglia', englishName: 'Size', variantEligible: true, expectedRequiredByDate: '2027-01-15T00:00:00.000Z' }),
    ]) })
    // Nexus's copy of eBay IT's tree: a branch, two leaves under it.
    const source = await db().marketplaceTaxonomy.create({ data: { channel: 'EBAY', marketplace: 'IT' } })
    const snapshot = await db().marketplaceTaxonomySnapshot.create({ data: { sourceId: source.id, status: 'SUCCEEDED', nodeCount: 3 } })
    await db().marketplaceTaxonomyNode.createMany({ data: [
      { snapshotId: snapshot.id, externalId: '6000', parentId: null, name: 'Abbigliamento', path: 'Moto › Abbigliamento', assignable: false },
      { snapshotId: snapshot.id, externalId: '177104', parentId: '6000', name: 'Giacche', path: 'Moto › Abbigliamento › Giacche', assignable: true },
      { snapshotId: snapshot.id, externalId: '177105', parentId: '6000', name: 'Pantaloni', path: 'Moto › Abbigliamento › Pantaloni', assignable: true },
    ] })
    await db().marketplaceTaxonomy.update({ where: { id: source.id }, data: { activeSnapshotId: snapshot.id, lastSyncedAt: new Date(), nextSyncAt: new Date(Date.now() + 86_400_000) } })
  })
  await inside(B, async () => {
    await market('IT')
    // Business B loaded 177105 on IT (A has not), with its own words: A must never read them.
    await db().categorySchema.create({ data: loadedRow('IT', '177105', [rich({ name: 'BRAVO-ONLY-ASPECT', required: true, usage: 'REQUIRED' })]) })
  })
}, 120_000)

beforeEach(() => {
  ebay.down = false
  ebay.conditionsDown = false
  ebay.searches = []
  ebay.aspectReads = []
  ebay.conditionReads = []
  ebay.aspects = [
    rich({ name: 'Materiale', englishName: 'Material', required: true, usage: 'REQUIRED', values: ['Pelle', 'Tessuto'] }),
    rich({ name: 'Stile', englishName: 'Style' }),
  ]
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('ebay-categories — query', { timeout: 30_000 }, () => {
  it("eBay's suggestions on the business's market, at most 10, leaf checked against Nexus's copy of the tree", async () => {
    const data = await read({ market: 'it', query: 'giacca moto' })
    expect(ebay.searches).toEqual([{ market: 'IT', query: 'giacca moto', options: { throwOnError: true, limit: 10 } }])
    expect(data).toMatchObject({ market: 'IT', site: 'EBAY_IT', query: 'giacca moto', source: 'eBay suggestions' })
    expect(data.categories).toHaveLength(10)
    expect(data.categories[0]).toEqual({ id: '177104', name: 'Giacche', path: 'Moto › Abbigliamento › Giacche', leaf: true, match: 90 })
    // Nexus's copy says 6000 is a branch: not a category a listing can use.
    expect(data.categories[1]).toMatchObject({ id: '6000', leaf: false })
    // Not in the copy: eBay suggests leaf categories.
    expect(data.categories[2]).toMatchObject({ id: '900002', name: 'Altro 2', path: 'Moto › Altro 2', leaf: true })
    expect(data.note).toMatch(/set-listing-fields values\.categoryId/)
    expect(ebay.aspectReads).toEqual([])
  })

  it("eBay unreachable: Nexus's own copy of eBay's tree is searched instead, and said", async () => {
    ebay.down = true
    const data = await read({ market: 'IT', query: 'giacche' })
    expect(data.source).toMatch(/Nexus's copy of eBay's category tree/)
    expect(data.ebayError).toBe('network: fetch failed')
    expect(data.categories).toEqual([{ id: '177104', name: 'Giacche', path: 'Moto › Abbigliamento › Giacche', leaf: true }])
    // No copy of the UK tree: said in words, nothing read.
    expect(await call({ market: 'UK', query: 'jacket' })).toEqual({
      ok: false, error: "eBay could not be reached (network: fetch failed), and Nexus has no copy of eBay UK's category tree to search instead. Nothing was read.",
    })
  })
})

describe('ebay-categories — categoryId', { timeout: 30_000 }, () => {
  it('loaded in Nexus: the cached definition, required first, with no eBay call', async () => {
    const before = await counts()
    const data = await read({ market: 'IT', categoryId: '177104' })
    expect(ebay.aspectReads).toEqual([])
    expect(ebay.conditionReads).toEqual([])
    expect(data).toMatchObject({
      market: 'IT', site: 'EBAY_IT', category: { id: '177104', name: 'Giacche', path: 'Moto › Abbigliamento › Giacche', leaf: true },
      loadedInNexus: true, itemSpecificsTotal: 3, requiredCount: 1,
    })
    expect(data.source).toMatch(/^Nexus: the details loaded/)
    expect(data.loadedAt).toEqual(expect.any(String))
    expect(data.itemSpecifics).toEqual([
      { name: 'Marca', englishName: 'Brand', requirement: 'required', type: 'text', multiValue: false, variationAxis: false, valuesOnly: true, maxLength: 65, values: ['Xavia', 'Dainese', 'Alpinestars'], valuesTotal: 3 },
      { name: 'Colore', englishName: 'Colour', requirement: 'recommended', type: 'text', multiValue: true, variationAxis: true, valuesOnly: false, maxLength: 65, values: ['Nero', 'Rosso', 'Blu'], valuesTotal: 3 },
      { name: 'Taglia', englishName: 'Size', requirement: 'recommended', requiredFrom: '2027-01-15', type: 'text', multiValue: false, variationAxis: true, valuesOnly: false, maxLength: 65, values: [], valuesTotal: 0 },
    ])
    expect(data.conditions).toEqual([{ value: 'NEW', conditionId: '1000', name: 'New with tags', siteName: 'Nuovo con etichette' }])
    expect(data.note).toMatch(/product-content/)
    expect(await counts()).toEqual(before)
  })

  it('not loaded: read live through the service (its cache kept), and NOTHING stored in Nexus', async () => {
    const before = await counts()
    const data = await read({ market: 'IT', categoryId: '177105' })
    expect(ebay.aspectReads).toEqual([{ categoryId: '177105', market: 'IT', options: { throwOnError: true } }])
    expect(ebay.conditionReads).toEqual([{ categoryId: '177105', market: 'IT', options: { throwOnError: true } }])
    expect(data).toMatchObject({ category: { id: '177105', name: 'Pantaloni', leaf: true }, loadedInNexus: false, requiredCount: 1 })
    expect(data.source).toBe('eBay, read live: Nexus stored nothing')
    expect(data.itemSpecifics.map((s: Data) => s.name)).toEqual(['Materiale', 'Stile'])
    expect(data.conditions).toEqual([
      { value: 'NEW', conditionId: '1000', name: 'New with tags', siteName: 'Nuovo con etichette' },
      { value: 'USED_EXCELLENT', conditionId: '3000', name: 'Used', siteName: 'Usato' },
    ])
    expect(data.note).toMatch(/a person opens the product's eBay sheet .*Load eBay fields/)
    expect(await counts()).toEqual(before)
  })

  it('the condition list unreadable: the item specifics still come back, and the gap is said', async () => {
    ebay.conditionsDown = true
    const data = await read({ market: 'IT', categoryId: '177105' })
    expect(data.conditions).toBeNull()
    expect(data.conditionsNote).toMatch(/could not be read \(eBay returned no condition policy for category 177105\)/)
    expect(data.itemSpecifics).toHaveLength(2)
  })

  it('a branch of the tree is refused before any eBay call; eBay down on a category not loaded is said', async () => {
    expect(await call({ market: 'IT', categoryId: '6000' })).toEqual({
      ok: false, error: 'eBay IT category 6000 (Moto › Abbigliamento) is not a leaf category: a listing needs one of the categories below it. Search with query to find one. Nothing was read.',
    })
    expect(ebay.aspectReads).toEqual([])
    ebay.down = true
    expect(await call({ market: 'IT', categoryId: '177105' })).toEqual({
      ok: false, error: 'eBay IT category 177105: Nexus has not loaded it, and eBay could not be read (network: fetch failed). Nothing was read.',
    })
  })

  it('bounded: 60 item specifics and 25 values each, with what was left out counted', async () => {
    ebay.aspects = Array.from({ length: 70 }, (_, i) => rich({ name: `Aspetto ${i}`, values: Array.from({ length: 300 }, (_, v) => `Valore ${v}`) }))
    const data = await read({ market: 'UK', categoryId: '12345' })
    expect(data).toMatchObject({ market: 'UK', site: 'EBAY_GB', category: { id: '12345', name: null, path: null, leaf: null }, itemSpecificsTotal: 70, moreItemSpecifics: 10 })
    expect(data.itemSpecifics).toHaveLength(60)
    expect(data.itemSpecifics[0]).toMatchObject({ values: expect.any(Array), moreValues: 275, valuesTotal: 300 })
    expect(data.itemSpecifics[0].values).toHaveLength(25)
  })

  it('one item specific by its English name, its values searched; an unknown one names the real ones', async () => {
    const data = await read({ market: 'IT', categoryId: '177104', specific: 'brand', valueSearch: 'ese' })
    expect(data.itemSpecifics).toEqual([expect.objectContaining({ name: 'Marca', values: ['Dainese'], valuesTotal: 3 })])
    expect(await call({ market: 'IT', categoryId: '177104', specific: 'Lining' })).toEqual({
      ok: false, error: 'Category 177104 has no item specific "Lining". Its item specifics: Colore, Marca, Taglia. Nothing was read.',
    })
  })
})

describe('ebay-categories — market and arguments', { timeout: 30_000 }, () => {
  it("takes the business's own codes: eBay's site id and GB are read as the business's code", async () => {
    expect((await read({ market: 'EBAY_IT', query: 'giacca' })).market).toBe('IT')
    expect(await read({ market: 'gb', categoryId: '12345' })).toMatchObject({ market: 'UK', site: 'EBAY_GB' })
    expect(ebay.aspectReads.at(-1)).toMatchObject({ categoryId: '12345', market: 'UK' })
  })

  it('a switched-off or unknown market, and a wrong mix of arguments, are refused in words', async () => {
    expect(await call({ market: 'DE', query: 'giacca' })).toEqual({ ok: false, error: 'eBay DE is switched off in this business. Its eBay markets: IT, UK. Nothing was read.' })
    expect(await call({ market: 'FR', query: 'giacca' })).toEqual({ ok: false, error: 'There is no eBay market FR in this business. Its eBay markets: IT, UK (business-overview lists them). Nothing was read.' })
    expect(await call({ market: 'IT' })).toMatchObject({ ok: false, error: expect.stringMatching(/^Give query .* or categoryId .*, not both/) })
    expect(await call({ market: 'IT', query: 'giacca', categoryId: '177104' })).toMatchObject({ ok: false, error: expect.stringMatching(/not both/) })
    expect(await call({ market: 'IT', query: 'giacca', specific: 'Marca' })).toMatchObject({ ok: false, error: expect.stringMatching(/go with categoryId/) })
    expect(await call({ market: 'IT', categoryId: '177104', valueSearch: 'x' })).toMatchObject({ ok: false, error: expect.stringMatching(/goes with specific/) })
    expect(ebay.searches).toEqual([])
  })
})

describe('ebay-categories — each business its own', { timeout: 30_000 }, () => {
  it("reads only the business's own loaded categories, with its own service instance", async () => {
    // B loaded 177105; from A it is not loaded (read live), and B's words never come back.
    const fromA = await read({ market: 'IT', categoryId: '177105' })
    expect(fromA.loadedInNexus).toBe(false)
    expect(JSON.stringify(fromA)).not.toContain('BRAVO')
    const fromB = await read({ market: 'IT', categoryId: '177105' }, B)
    expect(fromB).toMatchObject({ loadedInNexus: true, itemSpecifics: [expect.objectContaining({ name: 'BRAVO-ONLY-ASPECT', requirement: 'required' })] })
    // A's tree copy is A's: B has none, so B knows no name for it.
    expect(fromB.category).toEqual({ id: '177105', name: null, path: null, leaf: null })
  })

  it('one service per business: the eBay token one resolves never serves the other, and each keeps its cache', async () => {
    await read({ market: 'IT', query: 'giacca' })
    const created = ebay.instances
    await read({ market: 'IT', query: 'giacca' })
    expect(ebay.instances).toBe(created)
    await read({ market: 'IT', query: 'giacca' }, B)
    expect(ebay.instances).toBe(created + 1)
    await read({ market: 'IT', query: 'giacca' }, B)
    expect(ebay.instances).toBe(created + 1)
  })
})
