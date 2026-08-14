/**
 * SQP.5 — a market with zero ACTIVE listings is DORMANT, not skipped, and restores itself.
 *
 * The rule is one predicate, but getting it wrong is silent in both directions: skip a live market and
 * the feed quietly stops; keep a dead one and a quarter of the nightly budget buys nothing. These pin
 * the predicate and the self-restoring property.
 */
import { describe, it, expect } from 'vitest'

/** The decision the job makes per market, extracted so it can be asserted without a database. */
export function marketState(args: { activeListings: number; asinsHeld: number }):
  'dormant' | 'skipped' | 'eligible' {
  // 🔴 SKIPPED first. A market holding no ASINs at all (IE/NL/PL/SE/UK — sandbox connections) is
  // structurally absent, not awaiting a listing-sync fix, and labelling it "dormant, self-restoring"
  // invites someone to wait for something that was never running.
  if (args.asinsHeld === 0) return 'skipped'
  if (args.activeListings === 0) return 'dormant'
  return 'eligible'
}

describe('marketState', () => {
  it('calls FR dormant — 0 ACTIVE of 133 listings, measured 2026-08-15', () => {
    expect(marketState({ activeListings: 0, asinsHeld: 113 })).toBe('dormant')
  })

  it('keeps IT, DE and ES eligible', () => {
    expect(marketState({ activeListings: 137, asinsHeld: 250 })).toBe('eligible')
    expect(marketState({ activeListings: 99, asinsHeld: 208 })).toBe('eligible')
    expect(marketState({ activeListings: 19, asinsHeld: 121 })).toBe('eligible')
  })

  it('🔴 RESTORES ITSELF the moment one listing goes active', () => {
    // The cost of stopping FR is that it accumulates no history until listing sync is fixed, and a
    // diary note is how that becomes permanent. One active listing is enough to resume.
    expect(marketState({ activeListings: 1, asinsHeld: 113 })).toBe('eligible')
  })

  it('does not conflate dormant with skipped — they have different causes and different fixes', () => {
    // dormant = listings exist but none are ACTIVE (listing sync). skipped = we hold no ASINs at all.
    expect(marketState({ activeListings: 0, asinsHeld: 113 })).toBe('dormant')
    expect(marketState({ activeListings: 5, asinsHeld: 0 })).toBe('skipped')
  })

  it('🔴 calls a market with NO ASINs skipped, not dormant, even though ACTIVE is also 0', () => {
    // Exercising the deployed decision showed this mislabelling 5 sandbox markets as "dormant,
    // self-restoring". They hold no listings at all; there is no sync to wait for.
    expect(marketState({ activeListings: 0, asinsHeld: 0 })).toBe('skipped')
  })

  it('reserves dormant for the FR shape: listings exist, none of them active', () => {
    expect(marketState({ activeListings: 0, asinsHeld: 113 })).toBe('dormant')
  })
})
