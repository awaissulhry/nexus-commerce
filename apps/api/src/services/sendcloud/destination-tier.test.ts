/**
 * CR.22 — destination-tier classifier tests. Pure function; no DB.
 */

import { classifyDestinationTier, preferredTierFor, __test } from './destination-tier.js'

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = []
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn })
}
function assert(cond: unknown, msg = 'assertion failed') {
  if (!cond) throw new Error(msg)
}

test('IT → IT is DOMESTIC', () => {
  assert(classifyDestinationTier('IT', 'IT') === 'DOMESTIC')
})

test('IT → DE is EU', () => {
  assert(classifyDestinationTier('IT', 'DE') === 'EU')
})

test('IT → FR is EU', () => {
  assert(classifyDestinationTier('IT', 'FR') === 'EU')
})

test('IT → GB is INTL (post-Brexit)', () => {
  assert(classifyDestinationTier('IT', 'GB') === 'INTL', `Got ${classifyDestinationTier('IT', 'GB')}`)
})

test('IT → US is INTL', () => {
  assert(classifyDestinationTier('IT', 'US') === 'INTL')
})

test('IT → CH is INTL (Switzerland is EFTA, not EU)', () => {
  assert(classifyDestinationTier('IT', 'CH') === 'INTL')
})

test('IT → NO is INTL (Norway is EFTA)', () => {
  assert(classifyDestinationTier('IT', 'NO') === 'INTL')
})

test('case-insensitive', () => {
  assert(classifyDestinationTier('it', 'de') === 'EU')
  assert(classifyDestinationTier('It', 'dE') === 'EU')
})

test('whitespace-tolerant', () => {
  assert(classifyDestinationTier(' IT ', ' DE ') === 'EU')
})

test('empty inputs default to INTL (safer than DOMESTIC)', () => {
  assert(classifyDestinationTier('', 'IT') === 'INTL')
  assert(classifyDestinationTier('IT', '') === 'INTL')
  assert(classifyDestinationTier(null, null) === 'INTL')
  assert(classifyDestinationTier(undefined, 'IT') === 'INTL')
})

test('US → US is DOMESTIC (not just IT)', () => {
  assert(classifyDestinationTier('US', 'US') === 'DOMESTIC')
})

test('DE → FR is EU', () => {
  assert(classifyDestinationTier('DE', 'FR') === 'EU')
})

test('preferredTierFor maps DOMESTIC + EU to STANDARD, INTL to EXPRESS', () => {
  assert(preferredTierFor('DOMESTIC') === 'STANDARD')
  assert(preferredTierFor('EU') === 'STANDARD')
  assert(preferredTierFor('INTL') === 'EXPRESS')
})

test('EU member set excludes UK, includes 27 members', () => {
  assert(__test.EU_MEMBERS.size === 27, `Expected 27 EU members, got ${__test.EU_MEMBERS.size}`)
  assert(!__test.EU_MEMBERS.has('GB'))
  assert(__test.EU_MEMBERS.has('IT'))
  assert(__test.EU_MEMBERS.has('IE'))
  assert(__test.EU_MEMBERS.has('FI'))
})

;(async () => {
  let passed = 0
  let failed = 0
  for (const t of tests) {
    try {
      await t.fn()
      passed++
    } catch (err) {
      failed++
      // eslint-disable-next-line no-console
      console.error(`FAIL: ${t.name}`, err instanceof Error ? err.message : err)
    }
  }
  if (failed > 0) {
    // eslint-disable-next-line no-console
    console.error(`destination-tier.test.ts: ${failed} failed / ${passed} passed`)
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log(`destination-tier.test.ts: ${passed}/${passed} passed`)
})()
