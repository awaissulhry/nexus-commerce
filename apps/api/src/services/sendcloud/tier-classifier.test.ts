/**
 * CR.24 — tier-classifier tests. Pure function; no DB.
 */

import { classifyServiceTier, __test } from './tier-classifier.js'

const tests: Array<{ name: string; fn: () => void }> = []
function test(name: string, fn: () => void) { tests.push({ name, fn }) }
function assert(cond: unknown, msg = 'assertion failed') {
  if (!cond) throw new Error(msg)
}

// PRIORITY
test('priority service → PRIORITY', () => {
  assert(classifyServiceTier('UPS Priority') === 'PRIORITY')
})

test('overnight in name → PRIORITY', () => {
  assert(classifyServiceTier('FedEx Overnight Express') === 'PRIORITY')
})

test('next day in name → PRIORITY', () => {
  assert(classifyServiceTier('Royal Mail Next Day Special') === 'PRIORITY')
})

test('"DHL Express Priority" → PRIORITY (priority wins over express)', () => {
  assert(classifyServiceTier('DHL Express Priority') === 'PRIORITY')
})

// EXPRESS
test('"DHL Express International" → EXPRESS', () => {
  assert(classifyServiceTier('DHL Express International') === 'EXPRESS')
})

test('Italian "Crono" → EXPRESS', () => {
  assert(classifyServiceTier('Poste Italiane Crono') === 'EXPRESS')
})

test('"24h delivery" → EXPRESS', () => {
  assert(classifyServiceTier('GLS 24h delivery') === 'EXPRESS')
})

// STANDARD
test('"GLS Business Parcel" → STANDARD', () => {
  assert(classifyServiceTier('GLS Business Parcel') === 'STANDARD')
})

test('"BRT 0-2kg Standard" → STANDARD', () => {
  assert(classifyServiceTier('BRT 0-2kg Standard') === 'STANDARD')
})

test('"Posta1" → STANDARD', () => {
  assert(classifyServiceTier('Poste Italiane Posta1') === 'STANDARD')
})

// ECONOMY
test('"Sendcloud Economy" → ECONOMY', () => {
  assert(classifyServiceTier('Sendcloud Economy') === 'ECONOMY')
})

test('"DPD Packetshop" → ECONOMY', () => {
  assert(classifyServiceTier('DPD Packetshop') === 'ECONOMY')
})

test('"Service Point pickup" → ECONOMY', () => {
  assert(classifyServiceTier('GLS Service Point') === 'ECONOMY')
})

// Order-matters edge cases
test('"DHL Express Standard" → EXPRESS (express wins over standard)', () => {
  assert(classifyServiceTier('DHL Express Standard') === 'EXPRESS')
})

test('"Standard Economy" → ECONOMY (economy wins over standard)', () => {
  // Wait — pattern order is PRIORITY, EXPRESS, ECONOMY, STANDARD.
  // First-match-wins, so "standard economy" hits ECONOMY first.
  assert(classifyServiceTier('Standard Economy Service') === 'ECONOMY')
})

// Carrier-only sub-name
test('carrierSubName alone classifies (BRT → STANDARD)', () => {
  assert(classifyServiceTier(null, 'BRT') === 'STANDARD')
})

// Unclassifiable
test('empty / nullish → null', () => {
  assert(classifyServiceTier(null) === null)
  assert(classifyServiceTier('') === null)
  assert(classifyServiceTier('   ') === null)
})

test('totally generic name → null (no false-positive)', () => {
  // "Mock shipping method" is what the dryRun mock returns; it
  // shouldn't accidentally match anything.
  assert(classifyServiceTier('Generic shipping option') === null)
})

// Case + whitespace insensitive
test('case-insensitive', () => {
  assert(classifyServiceTier('DHL EXPRESS') === 'EXPRESS')
  assert(classifyServiceTier('dhl express') === 'EXPRESS')
})

// Patterns sanity
test('PATTERNS array has the 4 expected tiers in priority order', () => {
  const tiers = __test.PATTERNS.map((p) => p.tier)
  assert(tiers[0] === 'PRIORITY')
  assert(tiers[1] === 'EXPRESS')
  assert(tiers[2] === 'ECONOMY')
  assert(tiers[3] === 'STANDARD')
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
    console.error(`tier-classifier.test.ts: ${failed} failed / ${passed} passed`)
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log(`tier-classifier.test.ts: ${passed}/${passed} passed`)
})()
