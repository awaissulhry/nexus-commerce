/**
 * W4.2 — pure-function tests for the automation rule matcher.
 *
 * Skips the engine (DB-bound). Verifies the condition DSL evaluates
 * the way the schema comments promise.
 */

import {
  applyOperator,
  getFieldPath,
  matchesAllConditions,
  type Condition,
} from './automation-rule.service.js'

const tests: Array<{ name: string; fn: () => void }> = []
function test(name: string, fn: () => void) { tests.push({ name, fn }) }
function eq(a: unknown, b: unknown, msg = '') {
  const x = JSON.stringify(a); const y = JSON.stringify(b)
  if (x !== y) throw new Error(`${msg} expected=${y} actual=${x}`)
}
function ok(b: boolean, msg = '') { if (!b) throw new Error(`expected true: ${msg}`) }

// ── getFieldPath ──────────────────────────────────────────────────

test('getFieldPath: top-level', () => {
  eq(getFieldPath({ x: 1 }, 'x'), 1)
})
test('getFieldPath: nested', () => {
  eq(getFieldPath({ a: { b: { c: 7 } } }, 'a.b.c'), 7)
})
test('getFieldPath: missing returns undefined', () => {
  eq(getFieldPath({ a: 1 }, 'b.c'), undefined)
})
test('getFieldPath: null in path returns undefined', () => {
  eq(getFieldPath({ a: null }, 'a.b'), undefined)
})

// ── applyOperator ─────────────────────────────────────────────────

test('eq: number', () => { ok(applyOperator('eq', 5, 5)) })
test('eq: string', () => { ok(applyOperator('eq', 'x', 'x')) })
test('eq: numeric coercion', () => { ok(applyOperator('eq', 5, '5')) })
test('ne: differs', () => { ok(applyOperator('ne', 5, 6)) })
test('lt: numeric', () => { ok(applyOperator('lt', 100, 500)) })
test('lt: false when equal', () => { ok(!applyOperator('lt', 5, 5)) })
test('lte: equal passes', () => { ok(applyOperator('lte', 5, 5)) })
test('gt: numeric', () => { ok(applyOperator('gt', 600, 500)) })
test('gte: equal passes', () => { ok(applyOperator('gte', 5, 5)) })
test('in: array membership', () => { ok(applyOperator('in', 'CRITICAL', ['CRITICAL', 'HIGH'])) })
test('in: not in array', () => { ok(!applyOperator('in', 'LOW', ['CRITICAL', 'HIGH'])) })
test('contains: string substring', () => { ok(applyOperator('contains', 'AIRMESH-J-XL', 'AIRMESH')) })
test('exists: defined non-null', () => { ok(applyOperator('exists', 0, undefined)) })
test('exists: undefined fails', () => { ok(!applyOperator('exists', undefined, undefined)) })
test('exists: null fails', () => { ok(!applyOperator('exists', null, undefined)) })

// ── matchesAllConditions ──────────────────────────────────────────

test('empty conditions match anything', () => {
  ok(matchesAllConditions([], { a: 1 }))
})

test('single condition matches', () => {
  const c: Condition[] = [{ field: 'recommendation.totalCents', op: 'lt', value: 50000 }]
  ok(matchesAllConditions(c, { recommendation: { totalCents: 30000 } }))
})

test('single condition fails when over threshold', () => {
  const c: Condition[] = [{ field: 'recommendation.totalCents', op: 'lt', value: 50000 }]
  ok(!matchesAllConditions(c, { recommendation: { totalCents: 75000 } }))
})

test('AND across multiple conditions — all pass', () => {
  const c: Condition[] = [
    { field: 'recommendation.totalCents', op: 'lt', value: 50000 },
    { field: 'supplier.onTimeRate', op: 'gte', value: 0.95 },
  ]
  ok(matchesAllConditions(c, {
    recommendation: { totalCents: 30000 },
    supplier: { onTimeRate: 0.97 },
  }))
})

test('AND fails if any condition fails', () => {
  const c: Condition[] = [
    { field: 'recommendation.totalCents', op: 'lt', value: 50000 },
    { field: 'supplier.onTimeRate', op: 'gte', value: 0.95 },
  ]
  ok(!matchesAllConditions(c, {
    recommendation: { totalCents: 30000 },
    supplier: { onTimeRate: 0.78 },
  }))
})

test('urgency in critical/high', () => {
  const c: Condition[] = [{ field: 'recommendation.urgency', op: 'in', value: ['CRITICAL', 'HIGH'] }]
  ok(matchesAllConditions(c, { recommendation: { urgency: 'CRITICAL' } }))
  ok(!matchesAllConditions(c, { recommendation: { urgency: 'LOW' } }))
})

test('exists guards against missing fields', () => {
  const c: Condition[] = [{ field: 'supplier.id', op: 'exists' }]
  ok(matchesAllConditions(c, { supplier: { id: 'sup_x' } }))
  ok(!matchesAllConditions(c, { supplier: {} }))
  ok(!matchesAllConditions(c, {}))
})

let passed = 0
const failures: string[] = []
for (const t of tests) {
  try { t.fn(); passed++ } catch (e: any) { failures.push(`${t.name}: ${e.message}`) }
}
if (failures.length > 0) {
  console.error(`automation-rule.service.test: ${passed}/${tests.length} passed`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}

export {}
