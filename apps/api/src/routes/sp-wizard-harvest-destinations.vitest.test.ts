/**
 * PB-6a (C1) — the SP Super Wizard's harvest rule, through the real launch route on PGlite (production schema; sandbox,
 * so nothing leaves Nexus): every winner lands in the campaign of its OWN theme. The Advanced structure has three Exact
 * campaigns (Brand, Competitor, Category); the rule used to send every Exact graduation to the last one written
 * (Exact | Category), so a brand winner left its slot. Now:
 *   · a match type ONE campaign hosts stays a rule-level destination (PAT → PRODUCT);
 *   · one several host lands per source in the host of the source's theme (`theme`, else the theme word in its name);
 *   · a source with no theme (Auto) takes the Category host, the conservative default (spec §2.4); a source whose host
 *     cannot be told gets none for it — refused by name at graduation, never the last one written;
 *   · the theme is a slot token after the product group's name: a group named "Brand Category …" changes nothing;
 *   · PB-6b — unless every host of that match type has a theme, none twice: then the themeless source (Auto) gets the
 *     intent router over them, with the Brand and Competitor campaigns' keywords as its words (a brand term → Brand, …);
 *   · the rule is v2 (its ticks are literal) and names no constant bid.
 * Values are made up (public repo).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { formulaDatabase } from '../test-support/formula-database.js'
import { seedAdsFixture } from '../test-support/ads-fixtures.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', async () => {
  const { contextualDatabase } = await import('../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
// On PGlite's single connection the queue row's account lookup cannot run beside the open enqueue transaction.
vi.mock('../services/outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
vi.mock('../services/advertising/ads-cache.js', () => ({ cached: async (_k: string, _t: number, work: () => Promise<unknown>) => work(), peekCached: async () => undefined, putCached: () => undefined, flushAdsCache: async () => undefined }))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
let app: FastifyInstance

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await seedAdsFixture(database.client)
    await database.client.product.create({ data: { sku: 'TEST-SKU-PB6A', name: 'Test jacket', basePrice: '99.00' } })
    await database.client.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Amazon IT', region: 'EU', currency: 'EUR', language: 'en' } })
  })
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(business, done) })
  const { default: routes } = await import('./advertising.routes.js')
  await app.register(routes)
  await app.ready()
}, 180_000)
afterAll(async () => { await app?.close(); await database?.close() }, 30_000)

const SPW = '/advertising/campaign-builder/sp-super-wizard/launch'
type Json = Record<string, any>

/** The Advanced structure as the wizard names it: Auto, Broad / Phrase / Exact × Brand / Competitor / Category, PAT. */
function advanced(g: string) {
  const campaigns: Json[] = [{ id: 'w-auto', name: `${g}-SP-Auto`, kind: 'auto', bidEur: 0.5, budgetEur: 8 }]
  for (const m of ['Broad', 'Phrase', 'Exact']) for (const k of ['Brand', 'Competitor', 'Category']) {
    campaigns.push({ id: `w-${m}-${k}`, name: `${g}-SP-Keyword-${k}-${m}`, kind: 'keyword', matchType: m, bidEur: 0.5, budgetEur: 8, keywords: [`test ${k.toLowerCase()} jacket`] })
  }
  campaigns.push({ id: 'w-pat', name: `${g}-SP-PAT`, kind: 'pat', bidEur: 0.5, budgetEur: 8, productTargets: [{ asin: 'B0TESTPAT1' }] })
  return campaigns
}
const harvestRows = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, { st: true, tE: true, nE: true }]))

async function launch(g: string, campaigns: Json[], rows: Record<string, Json>) {
  const res = await app.inject({ method: 'POST', url: SPW, payload: {
    market: 'IT', productGroupName: g, products: [{ sku: 'TEST-SKU-PB6A' }], campaigns,
    rules: { harvest: { ruleName: `${g} harvest`, automate: false, rows } },
  } })
  expect(res.statusCode, res.payload).toBe(200)
  const groups = await inside(() => database.client.adGroup.findMany({ where: { campaign: { name: { startsWith: `${g}-` } } }, select: { id: true, campaign: { select: { name: true } } } }))
  const agOf = (name: string) => groups.find((x: Json) => x.campaign.name === name)!.id as string
  const rule = await inside(() => database.client.automationRule.findFirstOrThrow({ where: { name: `${g} harvest` } }))
  const action = (rule.actions as Json[])[0]
  const sourceOf = (name: string) => (action.sources as Json[]).find((s) => s.adGroupId === agOf(name))
  return { action, agOf, sourceOf }
}

describe('PB-6a — the wizard lands each winner in its own theme\'s campaign', () => {
  it('Advanced: Broad | Brand → Exact | Brand, Phrase | Competitor → Exact | Competitor; Auto through the router; PAT stays rule-level', async () => {
    const g = 'TADV'
    const { action, agOf, sourceOf } = await launch(g, advanced(g), harvestRows(['w-auto', 'w-Broad-Brand', 'w-Broad-Competitor', 'w-Phrase-Competitor', 'w-Phrase-Category']))
    expect(action).toMatchObject({ type: 'harvest_and_negate', v: 2, mode: 'harvest', control: 'manual' })
    expect(action).not.toHaveProperty('graduationBidEur')
    // Three campaigns take Exact: no rule-level Exact destination (it was Exact | Category, the last one written).
    expect(action.destinations).toEqual({ PRODUCT: agOf(`${g}-SP-PAT`) })
    expect(sourceOf(`${g}-SP-Keyword-Brand-Broad`).destinations.EXACT).toBe(agOf(`${g}-SP-Keyword-Brand-Exact`))
    expect(sourceOf(`${g}-SP-Keyword-Competitor-Broad`).destinations.EXACT).toBe(agOf(`${g}-SP-Keyword-Competitor-Exact`))
    expect(sourceOf(`${g}-SP-Keyword-Competitor-Phrase`).destinations.EXACT).toBe(agOf(`${g}-SP-Keyword-Competitor-Exact`))
    expect(sourceOf(`${g}-SP-Keyword-Category-Phrase`).destinations.EXACT).toBe(agOf(`${g}-SP-Keyword-Category-Exact`))
    // PB-6b — Auto has no theme, but each Exact host has one: its winners go through the intent router, by their words.
    expect(sourceOf(`${g}-SP-Auto`).destinations.EXACT).toEqual({
      router: 'intent',
      BRAND: agOf(`${g}-SP-Keyword-Brand-Exact`), COMPETITOR: agOf(`${g}-SP-Keyword-Competitor-Exact`), CATEGORY: agOf(`${g}-SP-Keyword-Category-Exact`),
      // No product names a brand here: the Brand keywords, and the word they share that no other keyword uses.
      brand: ['test brand jacket', 'brand'], competitor: ['test competitor jacket'],
    })
    expect(sourceOf(`${g}-SP-Auto`).destinations.PHRASE).toMatchObject({ router: 'intent', BRAND: agOf(`${g}-SP-Keyword-Brand-Phrase`) })
    expect(sourceOf(`${g}-SP-Auto`)).toMatchObject({ graduate: ['EXACT'], negate: ['EXACT'], harvestFrom: true })
  })

  it('a product group named with theme words: the theme is still the slot token', async () => {
    const g = 'Brand Category Gear'
    const { sourceOf, agOf } = await launch(g, advanced(g), harvestRows(['w-Broad-Competitor', 'w-Phrase-Brand']))
    expect(sourceOf(`${g}-SP-Keyword-Competitor-Broad`).destinations.EXACT).toBe(agOf(`${g}-SP-Keyword-Competitor-Exact`))
    expect(sourceOf(`${g}-SP-Keyword-Brand-Phrase`).destinations.EXACT).toBe(agOf(`${g}-SP-Keyword-Brand-Exact`))
  })

  it('PB-6b — the router\'s brand words: the product\'s brand, else the word every Brand keyword shares', async () => {
    const { resolveDestination } = await import('../services/advertising/ads-harvest-route.js')
    const shaped = (g: string, brandKeywords: string[]) => {
      const campaigns: Json[] = [{ id: 'w-auto', name: `${g}-SP-Auto`, kind: 'auto', bidEur: 0.5, budgetEur: 8 }]
      for (const [k, keywords] of [['Brand', brandKeywords], ['Competitor', ['rivalco jacket']], ['Category', ['leather jacket', 'motorbike jacket']]] as const) {
        campaigns.push({ id: `w-Exact-${k}`, name: `${g}-SP-Keyword-${k}-Exact`, kind: 'keyword', matchType: 'Exact', bidEur: 0.5, budgetEur: 8, keywords })
      }
      return campaigns
    }
    // A product that names its brand: a bare brand search and a long one both go to the Brand campaign.
    await inside(() => database.client.product.create({ data: { sku: 'TEST-SKU-PB6B-BR', name: 'Test branded jacket', basePrice: '99.00', brand: 'TestBrand' } }))
    const g = 'TBRD'
    const res = await app.inject({ method: 'POST', url: SPW, payload: {
      market: 'IT', productGroupName: g, products: [{ sku: 'TEST-SKU-PB6B-BR' }], campaigns: shaped(g, ['testbrand leather jacket']),
      rules: { harvest: { ruleName: `${g} harvest`, automate: false, rows: harvestRows(['w-auto']) } },
    } })
    expect(res.statusCode, res.payload).toBe(200)
    const rule = await inside(() => database.client.automationRule.findFirstOrThrow({ where: { name: `${g} harvest` } }))
    const router = ((rule.actions as Json[])[0].sources as Json[])[0].destinations.EXACT
    expect(router.brand).toEqual(['TestBrand', 'testbrand leather jacket'])
    expect(resolveDestination('testbrand', router)?.intent).toBe('BRAND')
    expect(resolveDestination('testbrand leather jacket', router)?.intent).toBe('BRAND')
    expect(resolveDestination('leather jacket', router)?.intent).toBe('CATEGORY')

    // No product brand: the word every Brand keyword holds and no other keyword uses.
    const t = 'TTOK'
    const { sourceOf } = await launch(t, shaped(t, ['testbrand jacket', 'testbrand leather jacket']), harvestRows(['w-auto']))
    const tokens = sourceOf(`${t}-SP-Auto`).destinations.EXACT
    expect(tokens.brand).toEqual(['testbrand jacket', 'testbrand leather jacket', 'testbrand'])
    expect(resolveDestination('testbrand', tokens)?.intent).toBe('BRAND')
    expect(resolveDestination('waterproof jacket', tokens)?.intent).toBe('CATEGORY')
  })

  it('names without a theme word: no Exact destination; a `theme` in the payload tells it', async () => {
    const g = 'TAMB'
    const campaigns = [
      { id: 'w-src', name: `${g}-SP-Research`, kind: 'keyword', matchType: 'Broad', bidEur: 0.5, budgetEur: 8, keywords: ['test jacket'] },
      { id: 'w-x1', name: `${g}-SP-Exact-One`, kind: 'keyword', matchType: 'Exact', bidEur: 0.5, budgetEur: 8, keywords: ['test jacket'] },
      { id: 'w-x2', name: `${g}-SP-Exact-Two`, kind: 'keyword', matchType: 'Exact', bidEur: 0.5, budgetEur: 8, keywords: ['test jacket blue'] },
    ]
    const blind = await launch(g, campaigns, harvestRows(['w-src']))
    expect(blind.action.destinations).toEqual({ BROAD: blind.agOf(`${g}-SP-Research`) })
    expect(blind.sourceOf(`${g}-SP-Research`).destinations).toEqual({ EXACT: null })

    const t = 'TTHM'
    const themed = [
      { ...campaigns[0], name: `${t}-SP-Research`, theme: 'brand' },
      { ...campaigns[1], name: `${t}-SP-Exact-One`, theme: 'Brand' },
      { ...campaigns[2], name: `${t}-SP-Exact-Two`, theme: 'category' },
    ]
    const told = await launch(t, themed, harvestRows(['w-src']))
    expect(told.sourceOf(`${t}-SP-Research`).destinations).toEqual({ EXACT: told.agOf(`${t}-SP-Exact-One`) })
  })
})
