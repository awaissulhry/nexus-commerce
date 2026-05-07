/**
 * O.17 — Address validation smoke tests.
 */

import { validateAddress, AddressInput } from './index.js'

const tests: Array<{ name: string; fn: () => void }> = []
function test(name: string, fn: () => void) { tests.push({ name, fn }) }
function assert(cond: unknown, msg = 'assertion failed') {
  if (!cond) throw new Error(msg)
}

const valid: AddressInput = {
  name: 'Mario Rossi',
  address: 'Via Roma 1',
  city: 'Riccione',
  postalCode: '47838',
  country: 'IT',
}

test('valid IT address passes', () => {
  const r = validateAddress(valid)
  assert(r.valid, 'should be valid')
  assert(r.issues.length === 0, 'no issues')
})

test('missing required fields produce errors', () => {
  const r = validateAddress({ name: 'Mario' })
  assert(!r.valid, 'invalid')
  const errors = r.issues.filter((i) => i.severity === 'error')
  assert(errors.length >= 4, `expected ≥4 errors, got ${errors.length}`)
  assert(errors.every((e) => e.code === 'MISSING_REQUIRED'))
})

test('invalid country code produces error', () => {
  const r = validateAddress({ ...valid, country: 'ITA' })
  assert(!r.valid, 'invalid')
  assert(r.issues.some((i) => i.code === 'INVALID_COUNTRY_CODE'))
})

test('IT postal code with letters → warning', () => {
  const r = validateAddress({ ...valid, postalCode: '47A38' })
  // Still valid (warnings don't block) but issue present
  assert(r.valid, 'valid (warning, not error)')
  assert(r.issues.some((i) => i.code === 'POSTAL_FORMAT_MISMATCH'))
})

test('UK postal code accepted', () => {
  const r = validateAddress({ ...valid, country: 'GB', postalCode: 'SW1A 1AA' })
  assert(r.valid, 'valid')
  assert(r.issues.length === 0, 'no issues')
})

test('US ZIP+4 accepted', () => {
  const r = validateAddress({ ...valid, country: 'US', postalCode: '90210-1234', city: 'Beverly Hills' })
  assert(r.valid, 'valid')
})

test('non-listed country skips postal regex (no false positives)', () => {
  const r = validateAddress({ ...valid, country: 'JP', postalCode: '100-0001' })
  assert(r.valid, 'valid')
})

test('short phone → warning', () => {
  const r = validateAddress({ ...valid, phone: '123' })
  assert(r.valid, 'valid')
  assert(r.issues.some((i) => i.code === 'PHONE_LOOKS_INVALID'))
})

let passed = 0
let failed = 0
for (const t of tests) {
  try { t.fn(); passed++ }
  catch (err) { failed++; console.error(`FAIL: ${t.name}`, err instanceof Error ? err.message : err) }
}
if (failed > 0) {
  console.error(`address-validation: ${failed} failed / ${passed} passed`)
  process.exit(1)
}
console.log(`address-validation: ${passed}/${passed} passed`)
