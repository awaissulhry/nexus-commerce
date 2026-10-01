/**
 * SC.0 — derivation-core scenario battery. Every precedence rule and routing
 * edge the Sync Control program depends on, locked before any engine adoption.
 */
import { describe, it, expect } from 'vitest'
import {
  resolveIntendedQuantity,
  resolveMembershipIntended,
  locationServes,
  normalizeMarket,
  validateServesTokens,
  syncLedgerOf,
  KNOWN_CHANNELS,
  QUANTITY_PUSH_CHANNELS,
  type SyncControlInputs,
  type RoutedLedgerRow,
} from './sync-control-core.js'

const row = (locationCode: string, available: number, serves: string[] = []): RoutedLedgerRow => ({
  locationCode,
  available,
  syncRoutes: serves,
})

const base = (over: Partial<SyncControlInputs> = {}): SyncControlInputs => ({
  channel: 'AMAZON',
  marketplace: 'IT',
  isFba: false,
  followMasterQuantity: true,
  syncPaused: false,
  pinnedQuantity: null,
  stockBuffer: 0,
  sourceLocationCodes: [],
  channelPolicy: null,
  ledger: syncLedgerOf([row('IT-MAIN', 10)]),
  ...over,
})

describe('Shared stock — a product that left a pool (uncountedIsZero)', () => {
  it('an empty own ledger is 0, never UNCOUNTED — a listing never keeps the pool\'s last number', () => {
    expect(resolveIntendedQuantity(base({ ledger: syncLedgerOf([]), uncountedIsZero: true }))).toEqual({ kind: 'FOLLOW', quantity: 0, routedAvailable: 0, routedLocations: [] })
    // Positive control: the same ledger without the flag is still the P0 guard.
    expect(resolveIntendedQuantity(base({ ledger: syncLedgerOf([]) }))).toEqual({ kind: 'UNCOUNTED' })
  })
  it('own rows that route nowhere for this market are 0 too; own stock that is counted is used as is', () => {
    expect(resolveIntendedQuantity(base({ marketplace: 'FR', ledger: syncLedgerOf([row('X', 9, ['AMAZON:IT'])]), uncountedIsZero: true }))).toMatchObject({ kind: 'FOLLOW', quantity: 0 })
    expect(resolveIntendedQuantity(base({ ledger: syncLedgerOf([row('IT-MAIN', 4)]), stockBuffer: 1, uncountedIsZero: true }))).toMatchObject({ kind: 'FOLLOW', quantity: 3 })
  })
  it('every rule above FOLLOW still wins: FBA, policy, pause and pin are untouched by the flag', () => {
    expect(resolveIntendedQuantity(base({ ledger: syncLedgerOf([]), uncountedIsZero: true, isFba: true }))).toEqual({ kind: 'FBA_EXCLUDED' })
    expect(resolveIntendedQuantity(base({ ledger: syncLedgerOf([]), uncountedIsZero: true, syncPaused: true }))).toEqual({ kind: 'PAUSED', via: 'LISTING' })
    expect(resolveIntendedQuantity(base({ ledger: syncLedgerOf([]), uncountedIsZero: true, followMasterQuantity: false, pinnedQuantity: 2 }))).toEqual({ kind: 'PINNED', quantity: 2 })
  })
  it('a shared eBay variant follows the same rule', () => {
    expect(resolveMembershipIntended({ marketplace: 'IT', followPool: true, stockBuffer: 0, ledger: syncLedgerOf([]), uncountedIsZero: true })).toMatchObject({ kind: 'FOLLOW', quantity: 0 })
    expect(resolveMembershipIntended({ marketplace: 'IT', followPool: true, stockBuffer: 0, ledger: syncLedgerOf([]) })).toEqual({ kind: 'UNCOUNTED' })
  })
})

describe('SC.0 — precedence (each rule beats everything below it)', () => {
  it('1. FBA beats EVERYTHING — pause, pin, policy, routing can never produce a push', () => {
    expect(
      resolveIntendedQuantity(
        base({
          isFba: true,
          syncPaused: true,
          followMasterQuantity: false,
          pinnedQuantity: 99,
          channelPolicy: { pushesPaused: true },
        }),
      ),
    ).toEqual({ kind: 'FBA_EXCLUDED' })
  })

  it('2. channel policy pause beats listing state', () => {
    expect(
      resolveIntendedQuantity(base({ channelPolicy: { pushesPaused: true }, followMasterQuantity: false, pinnedQuantity: 5 })),
    ).toEqual({ kind: 'PAUSED', via: 'POLICY' })
  })

  it('3. listing pause beats pin', () => {
    expect(
      resolveIntendedQuantity(base({ syncPaused: true, followMasterQuantity: false, pinnedQuantity: 5 })),
    ).toEqual({ kind: 'PAUSED', via: 'LISTING' })
  })

  it('4. pinned freezes at the value (null preserved for never-materialized pins)', () => {
    expect(resolveIntendedQuantity(base({ followMasterQuantity: false, pinnedQuantity: 7 }))).toEqual({
      kind: 'PINNED',
      quantity: 7,
    })
    expect(resolveIntendedQuantity(base({ followMasterQuantity: false }))).toEqual({
      kind: 'PINNED',
      quantity: null,
    })
  })

  it('5. follow sums routed available minus buffer, floored at 0', () => {
    const r = resolveIntendedQuantity(base({ ledger: syncLedgerOf([row('IT-MAIN', 7), row('B', 5)]), stockBuffer: 3 }))
    expect(r).toEqual({ kind: 'FOLLOW', quantity: 9, routedAvailable: 12, routedLocations: ['IT-MAIN', 'B'] })
    expect(resolveIntendedQuantity(base({ ledger: syncLedgerOf([row('A', 2)]), stockBuffer: 5 }))).toMatchObject({ quantity: 0 })
  })
})

describe('SC.0 — routing (Layer A: servesMarketplaces)', () => {
  it("empty list serves ALL (dormant-field default = today's behavior)", () => {
    expect(locationServes([], 'AMAZON', 'IT')).toBe(true)
  })

  it('channel-wide token: EBAY serves every eBay market', () => {
    expect(locationServes(['EBAY'], 'EBAY', 'EBAY_IT')).toBe(true)
    expect(locationServes(['EBAY'], 'EBAY', 'DE')).toBe(true)
    expect(locationServes(['EBAY'], 'AMAZON', 'IT')).toBe(false)
  })

  it("the owner's example: location X → AMAZON:IT + all eBay", () => {
    const serves = ['AMAZON:IT', 'EBAY']
    expect(locationServes(serves, 'AMAZON', 'IT')).toBe(true)
    expect(locationServes(serves, 'AMAZON', 'DE')).toBe(false)
    expect(locationServes(serves, 'EBAY', 'EBAY_IT')).toBe(true)
    expect(locationServes(serves, 'EBAY', 'EBAY_DE')).toBe(true)
    expect(locationServes(serves, 'SHOPIFY', 'DEFAULT')).toBe(false)
  })

  it('market normalization: EBAY_IT ≡ IT for channel EBAY; case-insensitive', () => {
    expect(normalizeMarket('EBAY', 'EBAY_IT')).toBe('IT')
    expect(normalizeMarket('AMAZON', 'it')).toBe('IT')
    expect(locationServes(['ebay:it'], 'EBAY', 'EBAY_IT')).toBe(true)
  })

  it('wildcard market token CHANNEL:* = channel-wide', () => {
    expect(locationServes(['AMAZON:*'], 'AMAZON', 'ES')).toBe(true)
  })

  it('bare MARKET token routes that market on ANY channel (ATP-style, owner-friendly)', () => {
    expect(locationServes(['IT'], 'AMAZON', 'IT')).toBe(true)
    expect(locationServes(['IT'], 'EBAY', 'EBAY_IT')).toBe(true)
    expect(locationServes(['IT'], 'AMAZON', 'DE')).toBe(false)
    // a bare token equal to a channel name reads as channel-wide, not market
    expect(locationServes(['EBAY'], 'EBAY', 'EBAY_DE')).toBe(true)
  })

  it('malformed tokens match nothing (never accidentally widen or mute)', () => {
    expect(locationServes(['AMAZON:IT:EXTRA'], 'AMAZON', 'IT')).toBe(false)
    expect(locationServes([''], 'AMAZON', 'IT')).toBe(false)
    // but a malformed token alongside a valid one doesn't break the valid one
    expect(locationServes(['???:', 'AMAZON:IT'], 'AMAZON', 'IT')).toBe(true)
  })

  it('routed follow: only rows whose location serves this channel+market count', () => {
    const r = resolveIntendedQuantity(
      base({
        marketplace: 'IT',
        ledger: syncLedgerOf([row('X', 4, ['AMAZON:IT', 'EBAY']), row('Y', 6, ['AMAZON:DE'])]),
      }),
    )
    expect(r).toMatchObject({ kind: 'FOLLOW', quantity: 4, routedLocations: ['X'] })
  })

  it('UNCOUNTED when stock exists ONLY in unrouted locations (never manufacture a zero)', () => {
    const r = resolveIntendedQuantity(
      base({ marketplace: 'FR', ledger: syncLedgerOf([row('X', 9, ['AMAZON:IT'])]) }),
    )
    expect(r).toEqual({ kind: 'UNCOUNTED' })
  })

  it('UNCOUNTED on a fully empty ledger (P0 parity)', () => {
    expect(resolveIntendedQuantity(base({ ledger: syncLedgerOf([]) }))).toEqual({ kind: 'UNCOUNTED' })
  })

  it('counted-to-zero still follows honestly (rows exist, sum 0)', () => {
    expect(resolveIntendedQuantity(base({ ledger: syncLedgerOf([row('IT-MAIN', 0)]) }))).toMatchObject({
      kind: 'FOLLOW',
      quantity: 0,
    })
  })

  it('listing sourceLocationCodes override intersects the routed set (dark Layer B)', () => {
    const ledger = [row('A', 3), row('B', 5)]
    expect(resolveIntendedQuantity(base({ ledger, sourceLocationCodes: ['B'] }))).toMatchObject({
      quantity: 5,
      routedLocations: ['B'],
    })
    // override pointing at an unrouted/unknown location → UNCOUNTED, not zero
    expect(resolveIntendedQuantity(base({ ledger, sourceLocationCodes: ['Z'] }))).toEqual({
      kind: 'UNCOUNTED',
    })
  })

  it('negative buffer is treated as 0 (never inflates)', () => {
    expect(resolveIntendedQuantity(base({ stockBuffer: -5 }))).toMatchObject({ quantity: 10 })
  })
})

describe('SC.0 — membership wrapper (per-variant eBay control)', () => {
  const ledger = [row('IT-MAIN', 12)]

  it('followPool=true follows the routed pool', () => {
    expect(
      resolveMembershipIntended({ marketplace: 'EBAY_IT', followPool: true, stockBuffer: 2, ledger }),
    ).toMatchObject({ kind: 'FOLLOW', quantity: 10 })
  })

  it('followPool=false excludes exactly this variant (PAUSED via LISTING)', () => {
    expect(
      resolveMembershipIntended({ marketplace: 'EBAY_IT', followPool: false, stockBuffer: 0, ledger }),
    ).toEqual({ kind: 'PAUSED', via: 'LISTING' })
  })

  it('channel policy pause reaches memberships too', () => {
    expect(
      resolveMembershipIntended({
        marketplace: 'EBAY_IT',
        followPool: true,
        stockBuffer: 0,
        channelPolicy: { pushesPaused: true },
        ledger,
      }),
    ).toEqual({ kind: 'PAUSED', via: 'POLICY' })
  })

  // Shared stock plan step 3 — "Fixed number" for a shared eBay variant (pinnedQuantity).
  it('a fixed number is PINNED at exactly that number, whatever the pool and the buffer', () => {
    expect(resolveMembershipIntended({ marketplace: 'EBAY_IT', followPool: true, pinnedQuantity: 2, stockBuffer: 5, ledger })).toEqual({ kind: 'PINNED', quantity: 2 })
    expect(resolveMembershipIntended({ marketplace: 'EBAY_IT', followPool: true, pinnedQuantity: 30, stockBuffer: 0, ledger: syncLedgerOf([]) })).toEqual({ kind: 'PINNED', quantity: 30 })
  })

  it('a fixed number of 0 is a real fixed number (not "follow"); null and absent follow the pool', () => {
    expect(resolveMembershipIntended({ marketplace: 'EBAY_IT', followPool: true, pinnedQuantity: 0, stockBuffer: 0, ledger })).toEqual({ kind: 'PINNED', quantity: 0 })
    expect(resolveMembershipIntended({ marketplace: 'EBAY_IT', followPool: true, pinnedQuantity: null, stockBuffer: 0, ledger })).toMatchObject({ kind: 'FOLLOW', quantity: 12 })
    expect(resolveMembershipIntended({ marketplace: 'EBAY_IT', followPool: true, stockBuffer: 0, ledger })).toMatchObject({ kind: 'FOLLOW', quantity: 12 })
  })

  it('the listing precedence holds for a fixed variant: policy and Excluded beat the fixed number', () => {
    expect(resolveMembershipIntended({ marketplace: 'EBAY_IT', followPool: false, pinnedQuantity: 2, stockBuffer: 0, ledger })).toEqual({ kind: 'PAUSED', via: 'LISTING' })
    expect(resolveMembershipIntended({ marketplace: 'EBAY_IT', followPool: true, pinnedQuantity: 2, stockBuffer: 0, channelPolicy: { pushesPaused: true }, ledger })).toEqual({ kind: 'PAUSED', via: 'POLICY' })
  })

  it('a fixed variant ignores "left a pool" too (the operator chose the number)', () => {
    expect(resolveMembershipIntended({ marketplace: 'EBAY_IT', followPool: true, pinnedQuantity: 4, stockBuffer: 0, ledger: syncLedgerOf([]), uncountedIsZero: true })).toEqual({ kind: 'PINNED', quantity: 4 })
  })

  it('membership routing honors location tokens (EBAY_IT ≡ IT)', () => {
    expect(
      resolveMembershipIntended({
        marketplace: 'EBAY_IT',
        followPool: true,
        stockBuffer: 0,
        ledger: syncLedgerOf([row('X', 7, ['EBAY:IT'])]),
      }),
    ).toMatchObject({ kind: 'FOLLOW', quantity: 7 })
  })
})

describe('SC.0 — token validation helper (future UI)', () => {
  it('flags empty, over-long, and unknown-channel tokens', () => {
    const problems = validateServesTokens(['', 'AMAZON:IT:X', 'WISH:IT', 'AMAZON:IT'])
    expect(problems).toHaveLength(3)
    expect(validateServesTokens(['AMAZON', 'EBAY:DE'])).toEqual([])
  })
})

// 2026-10-01 — Etsy joins the stock cascade, so Sync Control knows it: its tokens route, its policies pause.
describe('Etsy is a Sync Control channel', () => {
  it('ETSY and ETSY:* are valid routing tokens (they were refused as an unknown channel)', () => {
    expect(validateServesTokens(['ETSY', 'ETSY:GLOBAL', 'ETSY:*'])).toEqual([])
  })
  it('a bare ETSY token routes Etsy only — it is a channel, not a market code read on every channel', () => {
    expect(locationServes(['ETSY'], 'ETSY', 'GLOBAL')).toBe(true)
    expect(locationServes(['ETSY'], 'AMAZON', 'IT')).toBe(false)
    expect(locationServes(['ETSY'], 'EBAY', 'EBAY_IT')).toBe(false)
    expect(locationServes(['ETSY'], 'SHOPIFY', 'GLOBAL')).toBe(false)
    expect(locationServes(['AMAZON:IT', 'EBAY'], 'ETSY', 'GLOBAL')).toBe(false)
  })
  it('an Etsy listing follows the routed ledger like any other: buffer, policy, pause and pin keep their order', () => {
    const etsy = (over: Partial<SyncControlInputs> = {}) => base({ channel: 'ETSY', marketplace: 'GLOBAL', ...over })
    expect(resolveIntendedQuantity(etsy({ stockBuffer: 2 }))).toEqual({ kind: 'FOLLOW', quantity: 8, routedAvailable: 10, routedLocations: ['IT-MAIN'] })
    expect(resolveIntendedQuantity(etsy({ ledger: syncLedgerOf([row('IT-MAIN', 10, ['AMAZON'])]) }))).toEqual({ kind: 'UNCOUNTED' })
    expect(resolveIntendedQuantity(etsy({ channelPolicy: { pushesPaused: true }, syncPaused: true }))).toEqual({ kind: 'PAUSED', via: 'POLICY' })
    expect(resolveIntendedQuantity(etsy({ syncPaused: true, followMasterQuantity: false, pinnedQuantity: 3 }))).toEqual({ kind: 'PAUSED', via: 'LISTING' })
    expect(resolveIntendedQuantity(etsy({ followMasterQuantity: false, pinnedQuantity: 3 }))).toEqual({ kind: 'PINNED', quantity: 3 })
  })
  it('the channels that receive quantity rows are exactly the channels Sync Control knows, Etsy among them', () => {
    expect([...QUANTITY_PUSH_CHANNELS].sort()).toEqual([...KNOWN_CHANNELS].sort())
    expect([...QUANTITY_PUSH_CHANNELS].sort()).toEqual(['AMAZON', 'EBAY', 'ETSY', 'SHOPIFY', 'WOOCOMMERCE'])
  })
})
