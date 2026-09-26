/**
 * CX (main-session ruling 2026-09-26) — the remaining `offers[0]` lookups take the ONE FIXED_PRICE offer of the market
 * (ebayFixedPriceOfferOf), like the quantity path: getOffers lists an auction offer beside the fixed-price one when
 * both exist, and `offers[0]` then priced or read the auction.
 *
 *   A. EbayService.updatePrice / updateVariantPrice (the legacy price writers, market EBAY_MARKETPLACE_ID);
 *   B. the status-reconcile job (each listing reads the fixed-price offer of ITS market).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => ({ read: vi.fn(), send: vi.fn(), offers: [] as Array<Record<string, unknown>>, listings: [] as Array<Record<string, unknown>>, update: vi.fn() }))
vi.mock('./listing-push-controls.js', () => ({ readPushControls: s.read }))
vi.mock('./outbound-api-call-log.service.js', () => ({ recordApiCall: (_input: unknown, run: () => unknown) => run() }))
vi.mock('./pim/market-currency.js', () => ({ marketCurrency: async () => 'EUR' }))
vi.mock('./gateway/account.js', () => import('../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('./gateway/ledger.js', () => import('../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../db.js', () => ({ default: { channelListing: { findMany: vi.fn(async () => s.listings), update: (...a: unknown[]) => s.update(...a) } } }))
vi.mock('./connection-resolver.service.js', () => ({ resolveConnection: vi.fn(async () => ({ id: 'conn-A' })) }))
vi.mock('./ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: vi.fn(async () => 'fixture') } }))
vi.mock('../lib/cron/clustered.js', () => ({ default: { validate: () => true, schedule: () => ({ stop() {} }) } }))
vi.mock('../utils/cron-observability.js', () => ({ recordCronRun: async (_n: string, fn: () => Promise<unknown>) => fn() }))

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { asResponse } from '../test-support/gateway-stubs.js'
import { EbayService } from './marketplaces/ebay.service.js'
import { runEbayStatusReconcile } from '../jobs/ebay-status-reconcile.job.js'

const offer = (offerId: string, format: string, extra: Record<string, unknown> = {}) => ({ offerId, sku: 'SKU', marketplaceId: 'EBAY_IT', format, status: 'PUBLISHED', ...extra })
const writes = () => s.send.mock.calls.filter(([, init]) => ['PUT', 'PATCH', 'DELETE'].includes(String((init as RequestInit | undefined)?.method)))
  .map(([url, init]) => `${(init as RequestInit).method} ${new URL(String(url)).pathname}`)

beforeEach(() => {
  vi.clearAllMocks()
  s.read.mockResolvedValue([{}])
  s.offers = [offer('au-1', 'AUCTION'), offer('fp-1', 'FIXED_PRICE')]
  s.send.mockImplementation(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname
    if (path === '/sell/inventory/v1/offer') return { ok: true, status: 200, json: async () => ({ offers: s.offers }) }
    if (path === '/sell/inventory/v1/inventory') return { ok: true, status: 200, json: async () => ({ inventoryItems: [{ sku: 'SKU' }] }) }
    if (init.method && init.method !== 'GET') return { ok: true, status: 204, json: async () => ({}) }
    return { ok: false, status: 500, text: async () => 'unexpected' }
  })
  vi.stubGlobal('fetch', (...args: unknown[]) => asResponse(s.send(...args)))
  vi.stubEnv('NEXUS_ENABLE_EBAY_PUBLISH', 'true'); vi.stubEnv('EBAY_PUBLISH_MODE', 'live')
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('A — EbayService price writers price the fixed-price offer, never the auction listed first', () => {
  const service = new EbayService()
  beforeEach(() => { vi.spyOn(service as any, 'getAccessToken').mockResolvedValue('fixture') })
  it('updatePrice', async () => {
    await service.updatePrice('SKU', 19.9, 'product')
    expect(writes()).toEqual(['PUT /sell/inventory/v1/offer/fp-1'])
  })
  it('updateVariantPrice', async () => {
    await service.updateVariantPrice('SKU', 19.9, 'product')
    expect(writes()).toEqual(['PATCH /sell/inventory/v1/offer/fp-1'])
  })
  it('only an auction offer → nothing is priced (refused), never the auction', async () => {
    s.offers = [offer('au-1', 'AUCTION')]
    await expect(service.updatePrice('SKU', 19.9, 'product')).rejects.toThrow(/fixed-price/i)
    await expect(service.updateVariantPrice('SKU', 19.9, 'product')).rejects.toThrow(/fixed-price/i)
    expect(writes()).toEqual([])
  })
})

describe('B — the status reconcile reads the fixed-price offer of each listing\'s own market', () => {
  beforeEach(() => { vi.stubEnv('NEXUS_ENABLE_EBAY_STATUS_RECONCILE_CRON', '1') })
  it('an auction PUBLISHED first and the fixed-price offer UNPUBLISHED: the listing becomes DRAFT, not ACTIVE', async () => {
    s.offers = [offer('au-1', 'AUCTION', { status: 'PUBLISHED' }), offer('fp-1', 'FIXED_PRICE', { status: 'UNPUBLISHED' })]
    s.listings = [{ id: 'L-IT', listingStatus: 'ACTIVE', externalListingId: '1', marketplace: 'IT', product: { sku: 'SKU' } }]
    await runEbayStatusReconcile()
    expect(s.update.mock.calls.map((c) => [c[0].where.id, c[0].data.listingStatus])).toEqual([['L-IT', 'DRAFT']])
  })
  it('a listing on another market than the fixed-price offer reads no offer there (DRAFT); a listing with no known market is left alone', async () => {
    s.offers = [offer('fp-1', 'FIXED_PRICE', { status: 'PUBLISHED' })]
    s.listings = [
      { id: 'L-IT', listingStatus: 'DRAFT', externalListingId: '1', marketplace: 'IT', product: { sku: 'SKU' } },
      { id: 'L-DE', listingStatus: 'ACTIVE', externalListingId: '2', marketplace: 'DE', product: { sku: 'SKU' } },
      { id: 'L-XX', listingStatus: 'ACTIVE', externalListingId: '3', marketplace: 'GLOBAL', product: { sku: 'SKU' } },
    ]
    await runEbayStatusReconcile()
    expect(s.update.mock.calls.map((c) => [c[0].where.id, c[0].data.listingStatus]).sort()).toEqual([['L-DE', 'DRAFT'], ['L-IT', 'ACTIVE']])
  })
})

describe('census — no eBay source file picks offers[0]', () => {
  it('every eBay offer lookup goes through ebayFixedPriceOfferOf', () => {
    const SRC = join(import.meta.dirname, '..')
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? walk(path) : /ebay/i.test(name) && /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : []
    })
    const files = walk(SRC)
    expect(files.length).toBeGreaterThan(50) // positive control: the walk saw the eBay sources
    const offenders = files.flatMap((file) => readFileSync(file, 'utf8').split('\n').map((line, i) => ({ file: relative(SRC, file), line: i + 1, text: line.trim() })))
      .filter((l) => /offers\??\.?\[0\]/.test(l.text) && !l.text.startsWith('//') && !l.text.startsWith('*'))
    expect(offenders).toEqual([])
  })
})
