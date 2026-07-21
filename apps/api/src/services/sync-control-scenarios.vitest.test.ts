/**
 * SC.6 — the owner's control scenarios as PERMANENT regression tests.
 *
 * These encode the two examples that gated the whole Sync Control program,
 * plus the standing invariants (FBA untouchable, kill-switch precedence,
 * UNCOUNTED never zeroes). If any of these break, the program's promise is
 * broken — do not weaken them to make a refactor pass.
 */
import { describe, it, expect } from 'vitest'
import {
  resolveIntendedQuantity,
  resolveMembershipIntended,
  type RoutedLedgerRow,
  type SyncControlInputs,
} from './sync-control-core.js'
import { policyFor, type PolicyMap } from './sync-control-policy.service.js'

const base = (over: Partial<SyncControlInputs>): SyncControlInputs => ({
  channel: 'AMAZON',
  marketplace: 'IT',
  isFba: false,
  followMasterQuantity: true,
  syncPaused: false,
  pinnedQuantity: null,
  stockBuffer: 0,
  sourceLocationCodes: [],
  channelPolicy: null,
  ledger: [],
  ...over,
})

// Owner example 1: "inventories sent from a certain location to just the IT
// market on Amazon and all markets on eBay."
describe("SC.6 — owner example 1: location routes to AMAZON:IT + all of eBay", () => {
  const ledger: RoutedLedgerRow[] = [
    { locationCode: 'MAIN', available: 40, syncRoutes: [] }, // unrouted → everywhere
    { locationCode: 'OUTLET', available: 10, syncRoutes: ['AMAZON:IT', 'EBAY'] },
  ]

  it('AMAZON:IT sees both locations (40+10)', () => {
    const r = resolveIntendedQuantity(base({ channel: 'AMAZON', marketplace: 'IT', ledger }))
    expect(r).toMatchObject({ kind: 'FOLLOW', quantity: 50, routedLocations: ['MAIN', 'OUTLET'] })
  })
  it('AMAZON:DE sees only MAIN (40) — OUTLET routes away from it', () => {
    const r = resolveIntendedQuantity(base({ channel: 'AMAZON', marketplace: 'DE', ledger }))
    expect(r).toMatchObject({ kind: 'FOLLOW', quantity: 40, routedLocations: ['MAIN'] })
  })
  it('every eBay market sees both (channel-wide EBAY token)', () => {
    for (const m of ['EBAY_IT', 'EBAY_DE']) {
      const r = resolveMembershipIntended({ marketplace: m, followPool: true, stockBuffer: 0, ledger })
      expect(r).toMatchObject({ kind: 'FOLLOW', quantity: 50 })
    }
  })
})

// Owner example 2: "all the inventories synced in real time, except for a
// certain product or a certain variant."
describe('SC.6 — owner example 2: everything real-time except one variant', () => {
  const ledger: RoutedLedgerRow[] = [{ locationCode: 'MAIN', available: 25, syncRoutes: [] }]

  it('the excepted variant is PAUSED (frozen, never pushed)', () => {
    const r = resolveIntendedQuantity(base({ syncPaused: true, ledger }))
    expect(r).toEqual({ kind: 'PAUSED', via: 'LISTING' })
  })
  it('its siblings keep following the pool untouched', () => {
    const r = resolveIntendedQuantity(base({ ledger }))
    expect(r).toMatchObject({ kind: 'FOLLOW', quantity: 25 })
  })
  it('shared eBay variant excepted via followPool=false, siblings unaffected', () => {
    expect(resolveMembershipIntended({ marketplace: 'EBAY_IT', followPool: false, stockBuffer: 0, ledger }))
      .toEqual({ kind: 'PAUSED', via: 'LISTING' })
    expect(resolveMembershipIntended({ marketplace: 'EBAY_IT', followPool: true, stockBuffer: 0, ledger }))
      .toMatchObject({ kind: 'FOLLOW', quantity: 25 })
  })
})

describe('SC.6 — standing invariants', () => {
  const ledger: RoutedLedgerRow[] = [{ locationCode: 'MAIN', available: 30, syncRoutes: [] }]

  it('FBA wins over EVERYTHING — no combination of controls makes an FBA listing pushable', () => {
    const r = resolveIntendedQuantity(base({
      isFba: true, ledger,
      syncPaused: true, followMasterQuantity: false, pinnedQuantity: 99,
      channelPolicy: { pushesPaused: true },
    }))
    expect(r).toEqual({ kind: 'FBA_EXCLUDED' })
  })
  it('kill-switch (policy) outranks listing-level controls', () => {
    const r = resolveIntendedQuantity(base({ ledger, channelPolicy: { pushesPaused: true }, followMasterQuantity: false, pinnedQuantity: 7 }))
    expect(r).toEqual({ kind: 'PAUSED', via: 'POLICY' })
  })
  it('empty ledger = UNCOUNTED, never a zero push', () => {
    const r = resolveIntendedQuantity(base({ ledger: [] }))
    expect(r).toEqual({ kind: 'UNCOUNTED' })
    expect(JSON.stringify(r)).not.toContain('"quantity":0')
  })
  it('buffer subtracts but never goes negative', () => {
    expect(resolveIntendedQuantity(base({ ledger, stockBuffer: 5 }))).toMatchObject({ quantity: 25 })
    expect(resolveIntendedQuantity(base({ ledger, stockBuffer: 100 }))).toMatchObject({ quantity: 0 })
  })
  it("policyFor: exact market row beats channel-wide '*' row", () => {
    const policies: PolicyMap = new Map([
      ['AMAZON:*', { pushesPaused: true, newListingDefaultMode: 'FOLLOW' }],
      ['AMAZON:IT', { pushesPaused: false, newListingDefaultMode: 'FOLLOW' }],
    ])
    expect(policyFor(policies, 'AMAZON', 'IT')).toMatchObject({ pushesPaused: false })
    expect(policyFor(policies, 'AMAZON', 'DE')).toMatchObject({ pushesPaused: true })
    expect(policyFor(policies, 'EBAY', 'EBAY_IT')).toBeNull()
  })
})
