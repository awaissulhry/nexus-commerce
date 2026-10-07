/**
 * Step 2 "Sells from" — REGRESSION: with no lists anywhere, every number is what it was before Step 2.
 *
 * One loader feeds every push (`loadSyncLedgers` → `sellsFrom` → `resolveIntendedQuantity` / `routedAvailable`), so a
 * slip there moves every listing of every business. This test pins the pre-Step-2 routing filter as a frozen copy
 * (`before`, below: routes ∩ the listing's own codes) and walks a grid of locations, routes, channels, markets, buffers,
 * pauses and listing codes through the real loader with NO list on any market: every quantity, every routed sum, every
 * UNCOUNTED and every send-time ceiling must match. Policy rows that only pause (no list) and lists kept on an
 * account's row (not read as a market list) must not change a number either.
 *
 * The listing's OWN codes changed meaning on purpose (they replace the routes now); the grid keeps only own codes whose
 * locations route to the market, where "intersect" and "replace" agree. A code that does not route there is covered
 * by sync-control-core.vitest.test.ts ("replace the routed set").
 */
import { describe, expect, it, vi } from 'vitest'
import { locationServes, resolveIntendedQuantity, routedAvailable, type RoutedLedgerRow } from './sync-control-core.js'
import { ledgerInputs, loadSyncLedgers } from './stock-pool/sync-ledgers.js'
import { loadChannelPolicies, policyFor } from './sync-control-policy.service.js'

/** The routing filter exactly as it was before Step 2 (sync-control-core.ts at 3a716b5ea). */
function before(ledger: ReadonlyArray<RoutedLedgerRow>, channel: string, marketplace: string, sourceLocationCodes: string[]) {
  const norm = (s: string) => s.trim().toUpperCase()
  const override = new Set(sourceLocationCodes.map(norm).filter(Boolean))
  return ledger.filter((row) => locationServes(row.syncRoutes, channel, marketplace) && (override.size === 0 || override.has(norm(row.locationCode))))
}

const LOCATIONS = [
  { code: 'IT-MAIN', syncRoutes: [] as string[], isDefault: true },
  { code: 'MI-3PL', syncRoutes: ['AMAZON:DE', 'EBAY'] },
  { code: 'RM-SHOP', syncRoutes: ['IT'] },
  { code: 'NORTH', syncRoutes: ['SHOPIFY', 'AMAZON:*'] },
]
const PRODUCTS: Array<{ id: string; stock: Record<string, [number, number]> }> = [
  { id: 'all-four', stock: { 'IT-MAIN': [10, 8], 'MI-3PL': [4, 4], 'RM-SHOP': [2, 1], NORTH: [7, 7] } },
  { id: 'main-only', stock: { 'IT-MAIN': [5, 5] } },
  { id: 'counted-zero', stock: { 'IT-MAIN': [0, 0] } },
  { id: 'unrouted-only', stock: { 'MI-3PL': [6, 6] } },
  { id: 'never-counted', stock: {} },
]
const COORDS: Array<[string, string]> = [
  ['AMAZON', 'IT'], ['AMAZON', 'DE'], ['AMAZON', 'FR'], ['AMAZON', 'GB'],
  ['EBAY', 'IT'], ['EBAY', 'EBAY_DE'], ['SHOPIFY', 'GLOBAL'], ['ETSY', 'GLOBAL'], ['WOOCOMMERCE', 'IT'],
]

function fakeDb(policies: Array<Record<string, unknown>>) {
  const levels = PRODUCTS.flatMap((p) => Object.entries(p.stock).map(([code, [quantity, available]]) => {
    const l = LOCATIONS.find((x) => x.code === code)!
    return {
      productId: p.id, quantity, available,
      location: { type: 'WAREHOUSE', code, syncRoutes: l.syncRoutes, isActive: true, warehouse: l.isDefault ? { isDefault: true, isActive: true } : null },
    }
  }))
  return {
    stockLevel: { findMany: vi.fn(async () => levels) },
    stockPoolLink: { findMany: vi.fn(async () => []) },
    syncChannelPolicy: {
      // What the database answers the loader: the non-empty lists of rows with no account.
      findMany: vi.fn(async (query?: { where?: Record<string, unknown> }) => query?.where
        ? policies.filter((p) => p.channelConnectionId == null && ((p.sourceLocationCodes as string[] | undefined) ?? []).length > 0)
        : policies),
    },
    $queryRaw: vi.fn(async () => []),
  }
}

describe('Step 2 — no lists → every number unchanged', () => {
  const policyRowsWithoutMarketLists = [
    // pauses only: no list
    { channel: 'EBAY', marketplace: 'DE', channelConnectionId: null, pushesPaused: true, newListingDefaultMode: 'FOLLOW', sourceLocationCodes: [] },
    { channel: 'SHOPIFY', marketplace: '*', channelConnectionId: null, pushesPaused: false, newListingDefaultMode: 'PAUSED', sourceLocationCodes: [] },
    // a list on ONE account's row is not a market list (lists are business-wide): it must change nothing
    { channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'acct-1', pushesPaused: false, newListingDefaultMode: 'FOLLOW', sourceLocationCodes: ['MI-3PL'] },
  ]

  for (const [label, policies] of [['no policy rows', []], ['pause-only rows and an account row with a list', policyRowsWithoutMarketLists]] as const) {
    it(`${label}: every quantity, routed sum, UNCOUNTED and ceiling matches the pre-Step-2 filter`, async () => {
      const db = fakeDb(policies as Array<Record<string, unknown>>)
      const ledgers = await loadSyncLedgers(db as never, PRODUCTS.map((p) => p.id))
      const policyMap = await loadChannelPolicies(db as never)
      let compared = 0
      for (const product of PRODUCTS) {
        const ledger = ledgers.get(product.id)!
        expect(ledger.ledger.marketSources).toBeUndefined()
        for (const [channel, marketplace] of COORDS) {
          const routedNow = before(ledger.ledger, channel, marketplace, [])
          const ownCodeChoices: string[][] = [[], ...routedNow.map((r) => [r.locationCode]), routedNow.map((r) => r.locationCode)]
          for (const own of ownCodeChoices) {
            for (const stockBuffer of [0, 3]) {
              for (const syncPaused of [false, true]) {
                const inputs = ledgerInputs(ledger, own)
                const got = resolveIntendedQuantity({
                  channel, marketplace, isFba: false, followMasterQuantity: true, syncPaused, pinnedQuantity: null, stockBuffer,
                  channelPolicy: policyFor(policyMap, channel, marketplace, 'acct-1'), ...inputs,
                })
                const rows = before(ledger.ledger, channel, marketplace, own)
                const sum = rows.reduce((s, r) => s + r.available, 0)
                const paused = syncPaused || (policies.length > 0 && channel === 'EBAY' && marketplace.endsWith('DE'))
                const want = paused ? { kind: 'PAUSED' }
                  : rows.length === 0 ? { kind: 'UNCOUNTED' }
                  : { kind: 'FOLLOW', quantity: Math.max(0, sum - stockBuffer), routedAvailable: sum }
                expect(got, `${product.id} ${channel}:${marketplace} own=[${own}] buffer=${stockBuffer} paused=${syncPaused}`).toMatchObject(want)
                if (got.kind === 'FOLLOW') expect([...got.routedLocations].sort()).toEqual(rows.map((r) => r.locationCode).sort())
                const ceiling = routedAvailable({ ledger: inputs.ledger, channel, marketplace, sourceLocationCodes: inputs.sourceLocationCodes })
                expect(ceiling.available).toBe(sum)
                expect(ceiling.routed).toBe(rows.length > 0)
                compared++
              }
            }
          }
        }
      }
      expect(compared).toBeGreaterThan(300)
    })
  }

  it('the channel-wide pause still reaches a market (policyFor reads pause rows exactly as before)', async () => {
    const policyMap = await loadChannelPolicies(fakeDb(policyRowsWithoutMarketLists) as never)
    expect(policyFor(policyMap, 'EBAY', 'EBAY_DE')).toMatchObject({ pushesPaused: true })
    expect(policyFor(policyMap, 'SHOPIFY', 'GLOBAL')).toMatchObject({ pushesPaused: false, newListingDefaultMode: 'PAUSED' })
    expect(policyFor(policyMap, 'AMAZON', 'IT')).toBeNull()
  })
})
