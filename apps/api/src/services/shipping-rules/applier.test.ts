/**
 * O.16 — applier smoke tests. Pure functions only; no DB.
 */

import { __test, RuleConditions, RuleOrderContext } from './applier.js'

const tests: Array<{ name: string; fn: () => void }> = []
function test(name: string, fn: () => void) { tests.push({ name, fn }) }
function assert(cond: unknown, msg = 'assertion failed') {
  if (!cond) throw new Error(msg)
}

const baseCtx: RuleOrderContext = {
  channel: 'AMAZON',
  marketplace: 'IT',
  destinationCountry: 'IT',
  weightGrams: 1500,
  orderTotalCents: 9999,
  itemCount: 2,
  isPrime: false,
  hasHazmat: false,
  skus: ['SKU-001', 'SKU-002'],
}

test('empty conditions → match', () => {
  assert(__test.matchConditions({}, baseCtx))
})

test('channel mismatch → no match', () => {
  assert(!__test.matchConditions({ channel: ['EBAY'] }, baseCtx))
})

test('channel match → match', () => {
  assert(__test.matchConditions({ channel: ['AMAZON', 'EBAY'] }, baseCtx))
})

test('weight in range → match', () => {
  assert(__test.matchConditions({ weightGramsMin: 1000, weightGramsMax: 2000 }, baseCtx))
})

test('weight below min → no match', () => {
  assert(!__test.matchConditions({ weightGramsMin: 2000 }, baseCtx))
})

test('weight unknown but min set → no match', () => {
  const ctx = { ...baseCtx, weightGrams: null }
  assert(!__test.matchConditions({ weightGramsMin: 1000 }, ctx))
})

test('skuMatch mode=any → match if at least one', () => {
  const c: RuleConditions = { skuMatch: { mode: 'any', skus: ['SKU-001', 'SKU-999'] } }
  assert(__test.matchConditions(c, baseCtx))
})

test('skuMatch mode=all → match only if all present', () => {
  const all: RuleConditions = { skuMatch: { mode: 'all', skus: ['SKU-001', 'SKU-002'] } }
  const partial: RuleConditions = { skuMatch: { mode: 'all', skus: ['SKU-001', 'SKU-999'] } }
  assert(__test.matchConditions(all, baseCtx))
  assert(!__test.matchConditions(partial, baseCtx))
})

test('isPrime exact match', () => {
  assert(!__test.matchConditions({ isPrime: true }, baseCtx))
  assert(__test.matchConditions({ isPrime: true }, { ...baseCtx, isPrime: true }))
})

test('compound conditions all must hold', () => {
  const c: RuleConditions = {
    channel: ['AMAZON'],
    weightGramsMax: 2000,
    destinationCountry: ['IT', 'DE'],
  }
  assert(__test.matchConditions(c, baseCtx))
  assert(!__test.matchConditions(c, { ...baseCtx, weightGrams: 3000 }))
})

let passed = 0
let failed = 0
for (const t of tests) {
  try { t.fn(); passed++ }
  catch (err) { failed++; console.error(`FAIL: ${t.name}`, err instanceof Error ? err.message : err) }
}
if (failed > 0) {
  console.error(`shipping-rules applier.test.ts: ${failed} failed / ${passed} passed`)
  process.exit(1)
}
console.log(`shipping-rules applier.test.ts: ${passed}/${passed} passed`)
