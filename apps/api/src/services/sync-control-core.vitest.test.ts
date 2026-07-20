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
  ledger: [row('IT-MAIN', 10)],
  ...over,
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
    const r = resolveIntendedQuantity(base({ ledger: [row('IT-MAIN', 7), row('B', 5)], stockBuffer: 3 }))
    expect(r).toEqual({ kind: 'FOLLOW', quantity: 9, routedAvailable: 12, routedLocations: ['IT-MAIN', 'B'] })
    expect(resolveIntendedQuantity(base({ ledger: [row('A', 2)], stockBuffer: 5 }))).toMatchObject({ quantity: 0 })
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
        ledger: [row('X', 4, ['AMAZON:IT', 'EBAY']), row('Y', 6, ['AMAZON:DE'])],
      }),
    )
    expect(r).toMatchObject({ kind: 'FOLLOW', quantity: 4, routedLocations: ['X'] })
  })

  it('UNCOUNTED when stock exists ONLY in unrouted locations (never manufacture a zero)', () => {
    const r = resolveIntendedQuantity(
      base({ marketplace: 'FR', ledger: [row('X', 9, ['AMAZON:IT'])] }),
    )
    expect(r).toEqual({ kind: 'UNCOUNTED' })
  })

  it('UNCOUNTED on a fully empty ledger (P0 parity)', () => {
    expect(resolveIntendedQuantity(base({ ledger: [] }))).toEqual({ kind: 'UNCOUNTED' })
  })

  it('counted-to-zero still follows honestly (rows exist, sum 0)', () => {
    expect(resolveIntendedQuantity(base({ ledger: [row('IT-MAIN', 0)] }))).toMatchObject({
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

  it('membership routing honors location tokens (EBAY_IT ≡ IT)', () => {
    expect(
      resolveMembershipIntended({
        marketplace: 'EBAY_IT',
        followPool: true,
        stockBuffer: 0,
        ledger: [row('X', 7, ['EBAY:IT'])],
      }),
    ).toMatchObject({ kind: 'FOLLOW', quantity: 7 })
  })
})

describe('SC.0 — token validation helper (future UI)', () => {
  it('flags empty, over-long, and unknown-channel tokens', () => {
    const problems = validateServesTokens(['', 'AMAZON:IT:X', 'ETSY:IT', 'AMAZON:IT'])
    expect(problems).toHaveLength(3)
    expect(validateServesTokens(['AMAZON', 'EBAY:DE'])).toEqual([])
  })
})
