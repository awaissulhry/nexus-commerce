/**
 * W4.2 — Pure-function tests for resolveTierPrice.
 *
 * No DB. Run with `npx tsx <file>`.
 */

import {
  resolveTierPrice,
  type TierPriceRow,
} from './tier-pricing.service.js'

const tests: Array<{ name: string; fn: () => void }> = []
function test(name: string, fn: () => void) { tests.push({ name, fn }) }
function eq(a: unknown, b: unknown, msg = '') {
  const x = JSON.stringify(a)
  const y = JSON.stringify(b)
  if (x !== y) throw new Error(`${msg} expected=${y} actual=${x}`)
}

const BASE = 100
const GROUP_RETAIL = 'grp-retail'
const GROUP_WHOLESALE = 'grp-wholesale'

const t = (
  minQty: number,
  price: number,
  customerGroupId: string | null = null,
): TierPriceRow => ({ minQty, price, customerGroupId })

// ── Fallback ────────────────────────────────────────────────────

test('no tiers → returns basePrice', () => {
  const r = resolveTierPrice(BASE, [], 5, null)
  eq(r.price, 100)
  eq(r.source, 'base')
  eq(r.appliedTier, null)
})

test('qty below every minQty → returns basePrice', () => {
  const r = resolveTierPrice(BASE, [t(10, 90), t(50, 80)], 5, null)
  eq(r.price, 100)
  eq(r.source, 'base')
})

test('group-specific tier never matches anonymous buyer', () => {
  const r = resolveTierPrice(BASE, [t(1, 50, GROUP_RETAIL)], 100, null)
  eq(r.source, 'base', 'anonymous can never claim a group-specific tier')
  eq(r.price, 100)
})

// ── Single-tier matches ─────────────────────────────────────────

test('single qty=10 tier @ qty=10 → tier wins', () => {
  const r = resolveTierPrice(BASE, [t(10, 90)], 10, null)
  eq(r.source, 'tier')
  eq(r.price, 90)
  eq(r.appliedTier, { minQty: 10, customerGroupId: null })
})

test('single qty=10 tier @ qty=100 → tier still wins (>= minQty)', () => {
  const r = resolveTierPrice(BASE, [t(10, 90)], 100, null)
  eq(r.price, 90)
})

// ── Multi-tier — deepest discount wins ─────────────────────────

test('multi-tier: pick the highest minQty the buyer qualifies for', () => {
  const tiers = [t(1, 95), t(10, 90), t(50, 80), t(100, 70)]
  // Buying 60 — qualifies for 1, 10, 50; deepest is minQty=50.
  const r = resolveTierPrice(BASE, tiers, 60, null)
  eq(r.price, 80)
  eq(r.appliedTier?.minQty, 50)
})

test('multi-tier: qty=100 hits the deepest 100-tier', () => {
  const tiers = [t(1, 95), t(10, 90), t(50, 80), t(100, 70)]
  const r = resolveTierPrice(BASE, tiers, 100, null)
  eq(r.price, 70)
  eq(r.appliedTier?.minQty, 100)
})

// ── Group preference at the same minQty ────────────────────────

test('same minQty: group-specific beats generic', () => {
  const tiers = [t(10, 90, null), t(10, 80, GROUP_WHOLESALE)]
  const r = resolveTierPrice(BASE, tiers, 10, GROUP_WHOLESALE)
  eq(r.price, 80)
  eq(r.appliedTier, { minQty: 10, customerGroupId: GROUP_WHOLESALE })
})

test('same minQty + buyer not in group: generic wins', () => {
  const tiers = [t(10, 90, null), t(10, 80, GROUP_WHOLESALE)]
  // Retail buyer can't claim wholesale tier; gets generic 90.
  const r = resolveTierPrice(BASE, tiers, 10, GROUP_RETAIL)
  eq(r.price, 90)
  eq(r.appliedTier?.customerGroupId, null)
})

test('mixed tiers: group-specific at low qty + generic at high qty', () => {
  const tiers = [
    t(1, 75, GROUP_WHOLESALE), // wholesale gets a price floor immediately
    t(10, 90, null), // generic 10+ tier
    t(50, 70, null), // deepest generic tier
  ]
  // Wholesale buyer @ qty=20: qualifies for wholesale@1, generic@10.
  // Generic@10 has minQty=10 (higher than 1) → wins on the
  // highest-minQty rule. Price = 90.
  const r = resolveTierPrice(BASE, tiers, 20, GROUP_WHOLESALE)
  eq(r.price, 90)
  eq(r.appliedTier?.minQty, 10)
})

test('mixed tiers: wholesale gets best of both at high qty', () => {
  const tiers = [
    t(1, 75, GROUP_WHOLESALE),
    t(10, 90, null),
    t(50, 70, null),
  ]
  // Wholesale @ qty=100: qualifies for wholesale@1, generic@10,
  // generic@50. Highest minQty = 50 (generic). Wholesale only had
  // minQty=1 so it loses on the bracket rule. Price = 70.
  const r = resolveTierPrice(BASE, tiers, 100, GROUP_WHOLESALE)
  eq(r.price, 70)
  eq(r.appliedTier?.minQty, 50)
})

// ── Edge cases ──────────────────────────────────────────────────

test('qty=0 normalized to qty=1', () => {
  const tiers = [t(1, 90)]
  const r = resolveTierPrice(BASE, tiers, 0, null)
  eq(r.price, 90, 'minQty=1 still applies at the normalized qty=1')
})

test('negative qty normalized to 1', () => {
  const r = resolveTierPrice(BASE, [t(1, 90)], -5, null)
  eq(r.price, 90)
})

test('tier price equal to basePrice — still records source=tier', () => {
  // Edge: an operator might set a tier at the same price as base
  // (e.g., as an explicit "no discount at this qty" marker). The
  // resolver should still report source='tier' so caller can
  // distinguish.
  const r = resolveTierPrice(BASE, [t(10, 100)], 50, null)
  eq(r.source, 'tier')
  eq(r.price, 100)
})

let failed = 0
for (const t of tests) {
  try {
    t.fn()
    console.log(`  ok  ${t.name}`)
  } catch (e) {
    failed++
    console.error(`FAIL  ${t.name}\n      ${e instanceof Error ? e.message : String(e)}`)
  }
}
if (failed > 0) {
  console.error(`\n${failed} test(s) failed`)
  process.exit(1)
}
console.log(`\n${tests.length} tests passed`)
