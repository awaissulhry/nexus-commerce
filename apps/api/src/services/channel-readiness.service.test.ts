/**
 * W3.10 — Pure-function tests for the FALLBACK_FIELDS_BY_CHANNEL
 * scoring path.
 *
 * The family-driven path delegates to FamilyCompletenessService
 * which has its own 14 unit tests (W2.14); we don't re-cover that
 * here. These tests pin the no-family fallback behaviour: per-channel
 * minimum-fields list + filled-vs-missing scoring.
 *
 * No DB. Run with `npx tsx <file>`.
 */

import {
  FALLBACK_FIELDS_BY_CHANNEL,
} from './channel-readiness.service.js'

const tests: Array<{ name: string; fn: () => void }> = []
function test(name: string, fn: () => void) { tests.push({ name, fn }) }
function eq(a: unknown, b: unknown, msg = '') {
  const x = JSON.stringify(a)
  const y = JSON.stringify(b)
  if (x !== y) throw new Error(`${msg} expected=${y} actual=${x}`)
}

const COMPLETE_PRODUCT = {
  brand: 'Xavia Racing',
  productType: 'Motorcycle Jacket',
  description:
    'Premium leather motorcycle jacket with CE-certified armor at shoulders, elbows, and back. Perforated for summer riding.',
  gtin: '1234567890123',
  upc: null,
  ean: null,
  basePrice: 299.99,
  weightValue: 1.8,
  imageCount: 5,
}

const EMPTY_PRODUCT = {
  brand: null,
  productType: null,
  description: null,
  gtin: null,
  upc: null,
  ean: null,
  basePrice: 0,
  weightValue: null,
  imageCount: 0,
}

function scoreFallback(channel: 'AMAZON' | 'EBAY' | 'SHOPIFY', p: any) {
  const fields = FALLBACK_FIELDS_BY_CHANNEL[channel]
  let filled = 0
  const missingKeys: string[] = []
  for (const f of fields) {
    if (f.isFilledFor(p)) filled++
    else missingKeys.push(f.key)
  }
  return {
    score: fields.length === 0 ? 100 : Math.round((filled / fields.length) * 100),
    filled,
    total: fields.length,
    missingKeys,
  }
}

// ── Per-channel field lists ─────────────────────────────────────

test('AMAZON requires the most fields (Amazon-strict)', () => {
  const fields = FALLBACK_FIELDS_BY_CHANNEL.AMAZON.map((f) => f.key)
  // Pin the list so we notice if a future commit silently changes
  // the bar without thinking about it.
  eq(fields, ['brand', 'productType', 'gtin', 'description', 'photos', 'weight', 'price'])
})

test('EBAY is leaner — no GTIN required, no productType', () => {
  const fields = FALLBACK_FIELDS_BY_CHANNEL.EBAY.map((f) => f.key)
  eq(fields, ['brand', 'description', 'photos', 'price'])
})

test('SHOPIFY is leanest — no brand required (operator-driven)', () => {
  const fields = FALLBACK_FIELDS_BY_CHANNEL.SHOPIFY.map((f) => f.key)
  eq(fields, ['description', 'photos', 'price'])
})

// ── Scoring ─────────────────────────────────────────────────────

test('complete product → 100% on every channel', () => {
  for (const ch of ['AMAZON', 'EBAY', 'SHOPIFY'] as const) {
    const r = scoreFallback(ch, COMPLETE_PRODUCT)
    eq(r.score, 100, `${ch}`)
    eq(r.missingKeys.length, 0, `${ch}`)
  }
})

test('empty product → 0% on every channel', () => {
  for (const ch of ['AMAZON', 'EBAY', 'SHOPIFY'] as const) {
    const r = scoreFallback(ch, EMPTY_PRODUCT)
    eq(r.score, 0, `${ch}`)
    eq(r.missingKeys.length, r.total, `${ch}: every field missing`)
  }
})

test('GTIN: any of gtin / upc / ean satisfies the Amazon check', () => {
  const withUpc = { ...EMPTY_PRODUCT, upc: '012345678901' }
  const r = scoreFallback('AMAZON', withUpc)
  eq(r.missingKeys.includes('gtin'), false)
})

test('description must be > 50 chars (trimmed)', () => {
  const tiny = { ...COMPLETE_PRODUCT, description: 'short' }
  const r = scoreFallback('SHOPIFY', tiny)
  eq(r.missingKeys, ['description'])
})

test('imageCount=0 → photos missing on every channel that requires them', () => {
  const noPhotos = { ...COMPLETE_PRODUCT, imageCount: 0 }
  for (const ch of ['AMAZON', 'EBAY', 'SHOPIFY'] as const) {
    const r = scoreFallback(ch, noPhotos)
    eq(r.missingKeys.includes('photos'), true, `${ch}`)
  }
})

test('weightValue=null → weight missing on Amazon only', () => {
  const noWeight = { ...COMPLETE_PRODUCT, weightValue: null }
  eq(scoreFallback('AMAZON', noWeight).missingKeys.includes('weight'), true)
  eq(scoreFallback('EBAY', noWeight).missingKeys.includes('weight'), false, 'eBay does not require weight')
  eq(scoreFallback('SHOPIFY', noWeight).missingKeys.includes('weight'), false, 'Shopify does not require weight')
})

test('zero basePrice fails the price check on every channel', () => {
  const zeroPrice = { ...COMPLETE_PRODUCT, basePrice: 0 }
  for (const ch of ['AMAZON', 'EBAY', 'SHOPIFY'] as const) {
    const r = scoreFallback(ch, zeroPrice)
    eq(r.missingKeys.includes('price'), true, `${ch}`)
  }
})

test('brand whitespace-only counts as missing', () => {
  const blankBrand = { ...COMPLETE_PRODUCT, brand: '   ' }
  eq(scoreFallback('AMAZON', blankBrand).missingKeys.includes('brand'), true)
  eq(scoreFallback('EBAY', blankBrand).missingKeys.includes('brand'), true)
  eq(scoreFallback('SHOPIFY', blankBrand).missingKeys.includes('brand'), false, 'Shopify does not require brand')
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
