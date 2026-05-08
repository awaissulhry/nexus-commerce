/**
 * CR.23 — median helper tests. Pure function; no DB, no network.
 * Runs via `npx tsx <file>`.
 */

import { __test } from './carrier-metrics.job.js'

const tests: Array<{ name: string; fn: () => void }> = []
function test(name: string, fn: () => void) { tests.push({ name, fn }) }
function assert(cond: unknown, msg = 'assertion failed') {
  if (!cond) throw new Error(msg)
}

test('median of single value is that value', () => {
  assert(__test.median([42]) === 42)
})

test('median of odd-length array picks the middle', () => {
  assert(__test.median([1, 2, 3, 4, 5]) === 3)
  assert(__test.median([5, 1, 3, 2, 4]) === 3, 'unsorted input')
})

test('median of even-length array averages the two middles', () => {
  assert(__test.median([1, 2, 3, 4]) === 2.5)
  assert(__test.median([10, 20]) === 15)
})

test('median handles negative + decimal values', () => {
  assert(__test.median([-1.5, 0.5, 2.5]) === 0.5)
})

test('median does not mutate input', () => {
  const arr = [3, 1, 2]
  __test.median(arr)
  assert(arr[0] === 3 && arr[1] === 1 && arr[2] === 2, 'mutation detected')
})

;(async () => {
  let passed = 0, failed = 0
  for (const t of tests) {
    try { t.fn(); passed++ }
    catch (err) {
      failed++
      // eslint-disable-next-line no-console
      console.error(`FAIL: ${t.name}`, err instanceof Error ? err.message : err)
    }
  }
  if (failed > 0) {
    // eslint-disable-next-line no-console
    console.error(`carrier-metrics.test.ts: ${failed} failed / ${passed} passed`)
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log(`carrier-metrics.test.ts: ${passed}/${passed} passed`)
})()
