/**
 * P0 item 8 (2026-09-30) — a channel field list the sheet reports missing (`meta.schemaMissing`) is loaded by the
 * sheet's "Load eBay fields" action (`POST /categories/schema/download`), and the next sheet read shows the columns.
 *
 * The sheet reads field lists from the per-business cache only (`channel-specs/index.ts`), so a business, market or
 * category nobody had downloaded showed no item specifics at all (the second business's eBay 57988 locally; Motovento
 * eBay DE in production). The action fetches through the channel gateway with the RICH writer
 * (`CategorySchemaService.fetchAndCacheEbay`: cardinality, mode, max length), never the thin flat-file writer.
 *
 * Real route, real schema service, real eBay category service and real gateway, on an in-process PostgreSQL (PGlite)
 * with the production row policies. Only the transport is fake: `fetch` answers as eBay would, the gateway's account
 * check and ledger are the shared stand-ins, and the seller token is a constant. Ids are invented.
 * Run: npx vitest run src/services/categories/schema-download-sheet.vitest.test.ts (and with NEXUS_WORKSPACES_ENABLED=1).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

vi.setConfig({ testTimeout: 60_000 })
const state = vi.hoisted(() => ({ db: null as any, ebay: 'ok' as 'ok' | 'down', calls: [] as Array<{ url: string; auth: string | null }>,
  // W3 PR-A — Amazon's SP-API client, faked: it answers in the locale it is asked for.
  amazonBody: '{"properties":{"color":{"type":"string","enum":["red"],"enumNames":["Rosso"]}}}', amazonCalls: [] as Array<{ locale: string; marketplaceIds: string[]; productType: string }> }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(async () => []), refreshInTransaction: vi.fn() },
  FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
vi.mock('../pim/readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))
vi.mock('../gateway/account.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('../gateway/ledger.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: async () => 'seller-token' } }))
// The route module builds these at import; neither is reached by an eBay download. The Amazon client answers the
// Amazon download below (W3 PR-A) as SP-API would: the definition's envelope in the locale it is asked for.
vi.mock('../marketplaces/amazon.service.js', async () => {
  const { createHash } = await import('node:crypto')
  const checksum = createHash('md5').update(state.amazonBody).digest('base64')
  return { AmazonService: class {
    isConfigured() { return true }
    getClient() {
      return { callAPI: async (req: { path: { productType: string }; query: { locale: string; marketplaceIds: string[] } }) => {
        state.amazonCalls.push({ locale: req.query.locale, marketplaceIds: req.query.marketplaceIds, productType: req.path.productType })
        return { productType: req.path.productType, locale: req.query.locale, schema: { link: { resource: `https://schemas.example/${req.path.productType}`, verb: 'GET' }, checksum } }
      } }
    }
  } }
})
vi.mock('../listing-wizard/product-types.service.js', () => ({ ProductTypesService: class {} }))

/** eBay's two answers for leaf 57988 on EBAY_IT: the aspects (one open single, one closed multi) and the conditions. */
vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input)
  const headers = new Headers(init?.headers)
  state.calls.push({ url, auth: headers.get('authorization') })
  if (url.startsWith('https://schemas.example/')) return new Response(state.amazonBody)
  if (state.ebay === 'down') return new Response('{"errors":[{"message":"Service unavailable"}]}', { status: 503 })
  if (url.includes('/commerce/taxonomy/v1/category_tree/101/get_item_aspects_for_category?category_id=57988')) {
    return Response.json({ aspects: [
      { localizedAspectName: 'Marca', aspectConstraint: { aspectDataType: 'STRING', aspectMode: 'FREE_TEXT', aspectRequired: true, aspectUsage: 'RECOMMENDED', itemToAspectCardinality: 'SINGLE', aspectMaxLength: 65 },
        aspectValues: [{ localizedValue: 'Xavia' }] },
      { localizedAspectName: 'Caratteristiche', aspectConstraint: { aspectDataType: 'STRING', aspectMode: 'SELECTION_ONLY', aspectRequired: false, aspectUsage: 'RECOMMENDED', itemToAspectCardinality: 'MULTI' },
        aspectValues: [{ localizedValue: 'Impermeabile' }, { localizedValue: 'Traspirante' }] },
    ] })
  }
  if (url.includes('/sell/metadata/v1/marketplace/EBAY_IT/get_item_condition_policies')) {
    return Response.json({ itemConditionPolicies: [{ categoryId: '57988', itemConditions: [{ conditionId: '1000', conditionDescription: 'New' }] }] })
  }
  throw new Error(`unexpected request in a test: ${url}`)
}))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { gatewayLedger } from '../../test-support/gateway-stubs.js'
import { __rateTest } from '../gateway/rate.js'
import { getStudioSheet } from '../pim/studio-sheet.service.js'
import categoriesRoutes from '../../routes/categories.routes.js'

const legacy = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] as string[] }
const scoped = <T>(work: () => Promise<T>) => withWorkspace(legacy, work)
const LABEL = 'eBay · IT'
let parentId = '', account = ''

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'EBAY_IT', isActive: true } as never })
  account = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'fields', isActive: true, isPrimary: true, externalAccountId: 'FAKE-EBAY',
    authStatus: 'connected', managedBy: 'oauth' } as never })).id
  parentId = (await prisma.product.create({ data: { sku: 'SD-MESH', name: 'Mesh jacket', basePrice: 10, isParent: true, variationAxes: ['size'] } as never })).id
  const childId = (await prisma.product.create({ data: { sku: 'SD-MESH-L', name: 'Mesh jacket L', basePrice: 10, parentId, variantAttributes: { size: 'L' } } as never })).id
  for (const productId of [parentId, childId]) {
    await prisma.channelListing.create({ data: { productId, channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT', region: 'EU', channelConnectionId: account,
      platformAttributes: { categoryId: '57988' } } })
  }
}), 120_000)
afterAll(async () => { await state.db?.close() }, 30_000)

let app: ReturnType<typeof Fastify>
beforeEach(async () => {
  state.calls = []; gatewayLedger.length = 0; __rateTest.useMemory()
  app = Fastify()
  // As the workspace hook does for a signed-in request.
  app.addHook('onRequest', (_request, _reply, done) => withWorkspace(legacy, done))
  await app.register(categoriesRoutes)
  return async () => { await app.close(); __rateTest.reset() }
})

const readSheet = () => scoped(() => getStudioSheet({ productId: parentId, scope: 'channel', channel: 'EBAY', market: 'IT', locale: 'it', accountId: account } as never))
const aspectColumns = (sheet: Awaited<ReturnType<typeof readSheet>>) => sheet.columns.filter(c => c.channels?.[LABEL]?.attribute?.startsWith('aspect_'))
const loadFields = () => app.inject({ method: 'POST', url: '/categories/schema/download', payload: { channel: 'EBAY', market: 'IT', productTypes: ['57988'] } })

describe('a missing eBay field list, loaded from the sheet', () => {
  it('when eBay cannot be reached: the answer says so, nothing is stored, and the sheet still reports it missing', async () => {
    const before = await readSheet()
    expect(before.meta.schemaMissing).toEqual(['EBAY:57988'])
    expect(aspectColumns(before)).toEqual([])

    state.ebay = 'down'
    const res = await loadFields()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ results: [{ productType: '57988', outcome: 'failed', error: expect.stringContaining('503') }] })
    expect(await scoped(() => prisma.categorySchema.count({ where: { channel: 'EBAY', productType: '57988' } }))).toBe(0)
    expect((await readSheet()).meta.schemaMissing).toEqual(['EBAY:57988'])
  })

  it('when eBay answers: fetched through the gateway, stored rich for THIS business, and the sheet shows the item specifics', async () => {
    state.ebay = 'ok'
    const res = await loadFields()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ channel: 'EBAY', market: 'IT', remaining: 0, results: [{ productType: '57988', outcome: 'added' }] })

    // Through the channel gateway, as the business's own eBay account (hard rule 4): one ledger row per read.
    expect(state.calls.map(c => new URL(c.url).pathname)).toEqual(expect.arrayContaining([
      '/commerce/taxonomy/v1/category_tree/101/get_item_aspects_for_category', '/sell/metadata/v1/marketplace/EBAY_IT/get_item_condition_policies']))
    expect(state.calls.every(c => c.auth === 'Bearer seller-token')).toBe(true)
    expect(gatewayLedger.map(row => ({ connectionId: row.connectionId, outcome: row.outcome }))).toEqual([
      { connectionId: account, outcome: 'sent' }, { connectionId: account, outcome: 'sent' }])

    // The RICH shape (single/multiple, open/closed, cap), in the caller's business cache.
    const stored = await scoped(() => prisma.categorySchema.findFirstOrThrow({ where: { channel: 'EBAY', productType: '57988' } }))
    expect(stored.workspaceId).toBe(LEGACY_WORKSPACE_ID)
    const elsewhere = await withWorkspace({ ...legacy, workspaceId: 'another-business-0001' }, () => prisma.categorySchema.count({ where: { channel: 'EBAY', productType: '57988' } }))
    expect(elsewhere).toBe(0)
    expect((stored.schemaDefinition as { aspects: unknown[] }).aspects).toEqual([
      expect.objectContaining({ localizedName: 'Marca', cardinality: 'SINGLE', enumMode: 'open', maxLength: 65 }),
      expect.objectContaining({ localizedName: 'Caratteristiche', cardinality: 'MULTI', enumMode: 'strict', options: ['Impermeabile', 'Traspirante'] }),
    ])

    const after = await readSheet()
    expect(after.meta.schemaMissing).toEqual([])
    const byLabel = Object.fromEntries(aspectColumns(after).map(c => [c.channels![LABEL].label, c]))
    expect(byLabel.Marca).toMatchObject({ shape: 'scalar', mode: 'open' })
    expect(byLabel.Caratteristiche).toMatchObject({ shape: 'list' })
  })
})

/**
 * W3 PR-A — "Download rules" for Amazon also downloads the English copy: after an added pair, and for an in-use pair
 * already cached but without one (within the request's cap). The answer is unchanged; a second click costs nothing.
 */
describe('Amazon "Download rules" and the English copy', () => {
  beforeAll(() => scoped(async () => {
    await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Amazon Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'APJ6JRA9NG5V4', isActive: true } as never })
    for (const productType of ['COAT', 'OUTERWEAR']) {
      const productId = (await prisma.product.create({ data: { sku: `SD-AMZ-${productType}`, name: productType, basePrice: 10 } as never })).id
      await prisma.channelListing.create({ data: { productId, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU', platformAttributes: { productType } } })
    }
    // OUTERWEAR's rules are already here; COAT's are missing. Neither has an English copy.
    await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: 'IT', productType: 'OUTERWEAR', schemaVersion: 'cached-it',
      schemaDefinition: { properties: { color: { type: 'string' } } }, expiresAt: new Date(Date.now() + 86_400_000) } })
  }), 120_000)
  const download = () => app.inject({ method: 'POST', url: '/categories/schema/download', payload: { channel: 'AMAZON', market: 'IT' } })
  const english = () => scoped(() => prisma.categorySchema.findMany({ where: { channel: 'AMAZON_EN' }, select: { marketplace: true, productType: true, workspaceId: true, schemaDefinition: true }, orderBy: { productType: 'asc' } }))

  it('adds the missing rules with their English copy, fills the cached pair\'s missing copy, and a second click costs nothing', async () => {
    state.amazonCalls = []
    const first = await download()
    expect(first.statusCode).toBe(200)
    expect(first.json()).toEqual({ channel: 'AMAZON', market: 'IT', remaining: 0, results: [{ productType: 'COAT', outcome: 'added' }, { productType: 'OUTERWEAR', outcome: 'already' }] })
    expect(state.amazonCalls).toEqual([
      { productType: 'COAT', locale: 'it_IT', marketplaceIds: ['APJ6JRA9NG5V4'] },
      { productType: 'COAT', locale: 'en_GB', marketplaceIds: ['APJ6JRA9NG5V4'] },
      { productType: 'OUTERWEAR', locale: 'en_GB', marketplaceIds: ['APJ6JRA9NG5V4'] },
    ])
    const copies = await english()
    expect(copies.map(c => `${c.marketplace} ${c.productType}`)).toEqual(['IT COAT', 'IT OUTERWEAR'])
    expect(copies.every(c => c.workspaceId === LEGACY_WORKSPACE_ID && (c.schemaDefinition as any).__schemaProvenance.locale === 'en_GB')).toBe(true)
    // The market rows are still one per pair, in Italian.
    const market = await scoped(() => prisma.categorySchema.findMany({ where: { channel: 'AMAZON' }, select: { productType: true } }))
    expect(market.map(r => r.productType).sort()).toEqual(['COAT', 'OUTERWEAR'])

    state.amazonCalls = []
    const second = await download()
    expect(second.json().results).toEqual([{ productType: 'COAT', outcome: 'already' }, { productType: 'OUTERWEAR', outcome: 'already' }])
    expect(state.amazonCalls).toEqual([])
    expect(await english()).toHaveLength(2)
  })
})
