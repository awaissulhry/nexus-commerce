/**
 * P4.3d — the send-time oversell clamp is capped by the ROUTED locations.
 *
 * Two propositions, tested apart:
 *   A. `routedAvailable` returns the same rows `resolveIntendedQuantity` follows,
 *      and says when NOTHING routed rather than calling that zero;
 *   B. the clamp's ceiling and the intended quantity agree on every shape — which
 *      is the property the old code could not have, because the two numbers were
 *      derived in two files from two different row sets.
 */
import { describe, expect, it } from 'vitest'
import {
  resolveIntendedQuantity,
  routedAvailable,
  routedLedgerRows,
  syncLedgerOf,
} from './sync-control-core.js'

const ledger = (rows: Array<[code: string, available: number, routes: string[]]>) =>
  syncLedgerOf(rows.map(([locationCode, available, syncRoutes]) => ({ locationCode, available, syncRoutes })))

// IT-MAIN serves Italy only; GB-MAIN serves Britain only; EU-ANY routes everywhere.
const TWO_MARKETS = ledger([['IT-MAIN', 10, ['AMAZON:IT']], ['GB-MAIN', 40, ['AMAZON:UK']]])

describe('P4.3d routedAvailable', () => {
  it('sums only the locations routed to this market — not every warehouse the product holds', () => {
    // The whole ledger is 50. Italy may promise 10 of it.
    expect(TWO_MARKETS.reduce((s, r) => s + r.available, 0)).toBe(50)
    expect(routedAvailable({ ledger: TWO_MARKETS, channel: 'AMAZON', marketplace: 'IT', sourceLocationCodes: [] }))
      .toEqual({ available: 10, routed: true, locationCodes: ['IT-MAIN'] })
    expect(routedAvailable({ ledger: TWO_MARKETS, channel: 'AMAZON', marketplace: 'UK', sourceLocationCodes: [] }))
      .toEqual({ available: 40, routed: true, locationCodes: ['GB-MAIN'] })
  })

  it('an empty syncRoutes routes everywhere — the state every location is in today', () => {
    const open = ledger([['IT-MAIN', 10, []], ['GB-MAIN', 40, []]])
    expect(routedAvailable({ ledger: open, channel: 'AMAZON', marketplace: 'IT', sourceLocationCodes: [] }).available).toBe(50)
  })

  it("the listing's own source pin narrows it further", () => {
    const open = ledger([['IT-MAIN', 10, []], ['GB-MAIN', 40, []]])
    expect(routedAvailable({ ledger: open, channel: 'AMAZON', marketplace: 'IT', sourceLocationCodes: ['IT-MAIN'] }))
      .toEqual({ available: 10, routed: true, locationCodes: ['IT-MAIN'] })
  })

  it('NOTHING routed is reported as routed:false, never as available:0', () => {
    // These two facts must stay apart: "no location serves this market" is not
    // "this market has nothing to sell". Capping an unknown to 0 and sending it
    // is the scoped-Zero incident.
    const result = routedAvailable({ ledger: TWO_MARKETS, channel: 'AMAZON', marketplace: 'DE', sourceLocationCodes: [] })
    expect(result.routed).toBe(false)
    expect(result.available).toBe(0)
    // And a market that IS routed but genuinely holds nothing says routed: true.
    const empty = routedAvailable({ ledger: ledger([['IT-MAIN', 0, ['AMAZON:IT']]]), channel: 'AMAZON', marketplace: 'IT', sourceLocationCodes: [] })
    expect(empty).toEqual({ available: 0, routed: true, locationCodes: ['IT-MAIN'] })
  })

  it('routedLedgerRows is what the resolver filters with — the same rows, not a copy of the rule', () => {
    expect(routedLedgerRows({ ledger: TWO_MARKETS, channel: 'AMAZON', marketplace: 'IT', sourceLocationCodes: [] }))
      .toEqual([{ locationCode: 'IT-MAIN', available: 10, syncRoutes: ['AMAZON:IT'] }])
  })
})

describe('P4.3d: the ceiling and the intended quantity agree', () => {
  const intended = (marketplace: string, stockBuffer: number, sourceLocationCodes: string[] = []) =>
    resolveIntendedQuantity({
      channel: 'AMAZON', marketplace, isFba: false, followMasterQuantity: true,
      syncPaused: false, pinnedQuantity: null, stockBuffer, sourceLocationCodes,
      ledger: TWO_MARKETS, uncountedIsZero: true,
    })

  const ceiling = (marketplace: string, stockBuffer: number, sourceLocationCodes: string[] = []) => {
    const routed = routedAvailable({ ledger: TWO_MARKETS, channel: 'AMAZON', marketplace, sourceLocationCodes })
    return Math.max(0, routed.available - Math.max(0, stockBuffer))
  }

  it.each([
    ['IT', 0, 10],
    ['IT', 3, 7],
    ['IT', 99, 0],
    ['UK', 0, 40],
    ['UK', 5, 35],
  ])('%s with a buffer of %i: both say %i', (marketplace, buffer, expected) => {
    const resolution = intended(marketplace, buffer)
    expect(resolution.kind).toBe('FOLLOW')
    expect((resolution as { quantity: number }).quantity).toBe(expected)
    expect(ceiling(marketplace, buffer)).toBe(expected)
  })

  it('🔴 the OLD ceiling was the whole ledger, so it never caught a cross-market overshoot', () => {
    // A pinned or stale row promising 40 units on the Italian listing.
    const oldCeiling = TWO_MARKETS.reduce((s, r) => s + r.available, 0) // sellableAvailable
    expect(oldCeiling).toBe(50)
    expect(Math.min(40, oldCeiling)).toBe(40) // the old clamp let all 40 through
    expect(Math.min(40, ceiling('IT', 0))).toBe(10) // the routed clamp holds it to Italy's 10
  })

  it('a PINNED quantity is still capped by what its market is routed', () => {
    const pinned = resolveIntendedQuantity({
      channel: 'AMAZON', marketplace: 'IT', isFba: false, followMasterQuantity: false,
      syncPaused: false, pinnedQuantity: 40, stockBuffer: 0, sourceLocationCodes: [],
      ledger: TWO_MARKETS, uncountedIsZero: true,
    })
    // The resolver does not route a pin — that is deliberate, it is the operator's number.
    expect(pinned).toEqual({ kind: 'PINNED', quantity: 40 })
    // The clamp is what holds it to the truth, and only a ROUTED ceiling can.
    expect(ceiling('IT', 0)).toBe(10)
  })

  it('an unrouted market: the resolver answers UNCOUNTED, and the ceiling reports routed:false', () => {
    const resolution = resolveIntendedQuantity({
      channel: 'AMAZON', marketplace: 'DE', isFba: false, followMasterQuantity: true,
      syncPaused: false, pinnedQuantity: null, stockBuffer: 0, sourceLocationCodes: [],
      ledger: TWO_MARKETS, uncountedIsZero: false,
    })
    expect(resolution).toEqual({ kind: 'UNCOUNTED' })
    expect(routedAvailable({ ledger: TWO_MARKETS, channel: 'AMAZON', marketplace: 'DE', sourceLocationCodes: [] }).routed).toBe(false)
  })
})
