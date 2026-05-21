/**
 * IR.11.4 — Pure-function tests for @nexus/shared/image-validation.
 *
 * Validates that PLATFORM_RULES match each channel's published
 * requirements and that validateImageList / isAspectOnTarget /
 * isDimensionOnTarget produce the expected blocking + warning shape
 * across realistic Xavia inputs.
 *
 * Matches the existing apps/api test convention — manual test()/eq()
 * runner, no Vitest harness needed. Run with `npx tsx <file>`.
 */

import {
  PLATFORM_RULES,
  validateImageList,
  isAspectOnTarget,
  isDimensionOnTarget,
  type ImageForValidation,
  type PlatformKey,
} from './image-validation.js'

const tests: Array<{ name: string; fn: () => void }> = []
function test(name: string, fn: () => void) { tests.push({ name, fn }) }
function eq(a: unknown, b: unknown, msg = '') {
  const x = JSON.stringify(a)
  const y = JSON.stringify(b)
  if (x !== y) throw new Error(`${msg} expected=${y} actual=${x}`)
}
function ok(b: boolean, msg = '') { if (!b) throw new Error(`expected true: ${msg}`) }

// ── PLATFORM_RULES sanity ──────────────────────────────────────────────

test('AMAZON rules match Seller Central requirements', () => {
  const r = PLATFORM_RULES.AMAZON
  eq(r.minImages, 1, 'AMAZON min')
  eq(r.maxImages, 9, 'AMAZON max')
  eq(r.minDimensionPx, 1000, 'AMAZON dim')
  eq(r.recommendedAspectRatio, 1, 'AMAZON aspect')
  ok(r.acceptedMimeTypes.includes('image/jpeg'), 'jpeg accepted')
  ok(r.acceptedMimeTypes.includes('image/png'), 'png accepted')
})

test('EBAY rules match Trading API limits — IR.1.1 fix', () => {
  const r = PLATFORM_RULES.EBAY
  // The IR.1.1 bug was maxImages=12; 24 is the correct PictureDetails
  // gallery max since 2017. Pin it so it can't regress.
  eq(r.maxImages, 24, 'EBAY gallery max must be 24, not 12 (IR.1.1)')
  eq(r.minDimensionPx, 500, 'EBAY dim')
})

test('SHOPIFY rules match storefront defaults', () => {
  const r = PLATFORM_RULES.SHOPIFY
  eq(r.maxImages, 250, 'SHOPIFY max')
  eq(r.recommendedAspectRatio, 4 / 5, 'SHOPIFY aspect 4:5 portrait')
  eq(r.acceptedMimeTypes.length, 0, 'SHOPIFY accepts any mime')
})

// ── validateImageList: blocking issues ─────────────────────────────────

test('AMAZON blocks empty image set', () => {
  const result = validateImageList([], 'AMAZON', 'IT')
  ok(result.blocking.length >= 1, 'should have blocking issues')
  ok(result.blocking.some((b) => b.code === 'too_few'), 'too_few code')
  eq(result.status, 'blocked')
})

test('AMAZON blocks > 9 images', () => {
  const imgs: ImageForValidation[] = Array.from({ length: 10 }, (_, i) => ({
    url: `https://example.com/${i}.jpg`,
    role: i === 0 ? 'MAIN' : 'GALLERY',
    width: 1500, height: 1500, mimeType: 'image/jpeg',
  }))
  const result = validateImageList(imgs, 'AMAZON', 'IT')
  ok(result.blocking.some((b) => b.code === 'too_many'), 'too_many fires at 10')
})

test('EBAY allows 24 images (regression for IR.1.1)', () => {
  const imgs: ImageForValidation[] = Array.from({ length: 24 }, (_, i) => ({
    url: `https://example.com/${i}.jpg`,
    width: 800, height: 800, mimeType: 'image/jpeg',
  }))
  const result = validateImageList(imgs, 'EBAY', 'DEFAULT')
  eq(result.blocking.filter((b) => b.code === 'too_many').length, 0, 'no too_many at exactly 24')
})

test('EBAY blocks at 25 images', () => {
  const imgs: ImageForValidation[] = Array.from({ length: 25 }, (_, i) => ({
    url: `https://example.com/${i}.jpg`,
    width: 800, height: 800,
  }))
  const result = validateImageList(imgs, 'EBAY', 'DEFAULT')
  ok(result.blocking.some((b) => b.code === 'too_many'), 'too_many at 25')
})

// ── validateImageList: warnings ────────────────────────────────────────

test('AMAZON warns on sub-1000px image', () => {
  const result = validateImageList([
    { url: 'https://example.com/0.jpg', role: 'MAIN', width: 800, height: 800, mimeType: 'image/jpeg' },
  ], 'AMAZON', 'IT')
  ok(result.warnings.some((w) => w.code === 'small_image'), 'small_image warns')
  ok(result.warnings.some((w) => w.code === 'manual_reminder' && /white background/i.test(w.message)), 'white-bg reminder')
})

test('AMAZON warns on non-square aspect', () => {
  const result = validateImageList([
    { url: 'https://example.com/0.jpg', role: 'MAIN', width: 1600, height: 900, mimeType: 'image/jpeg' },
  ], 'AMAZON', 'IT')
  ok(result.warnings.some((w) => w.code === 'aspect_mismatch'), 'aspect mismatch warns')
})

test('AMAZON accepts 1:1 within tolerance', () => {
  // 1040×1000 ratio is 1.04, comfortably inside Amazon's 5 % tolerance.
  // 1050×1000 sits on the boundary and runs into 1.05-1 ≈ 0.0500…04
  // IEEE-754 noise, so we avoid that edge in this test.
  const result = validateImageList([
    { url: 'https://example.com/0.jpg', role: 'MAIN', width: 1040, height: 1000, mimeType: 'image/jpeg' },
  ], 'AMAZON', 'IT')
  eq(result.warnings.filter((w) => w.code === 'aspect_mismatch').length, 0, 'no aspect warn within tolerance')
})

test('AMAZON warns on weird mime type', () => {
  const result = validateImageList([
    { url: 'https://example.com/0.heic', role: 'MAIN', width: 1500, height: 1500, mimeType: 'image/heic' },
  ], 'AMAZON', 'IT')
  ok(result.warnings.some((w) => w.code === 'mime_type'), 'mime warns on HEIC')
})

test('SHOPIFY tolerates any mime', () => {
  const result = validateImageList([
    { url: 'https://example.com/0.webp', width: 1500, height: 1500, mimeType: 'image/webp' },
  ], 'SHOPIFY', 'DEFAULT')
  eq(result.warnings.filter((w) => w.code === 'mime_type').length, 0, 'shopify mime open')
})

// ── isAspectOnTarget ───────────────────────────────────────────────────

const aspectCases: Array<{ p: PlatformKey; w: number; h: number; expected: boolean | null; note: string }> = [
  { p: 'AMAZON', w: 1500, h: 1500, expected: true, note: 'Amazon 1:1 exact' },
  { p: 'AMAZON', w: 1000, h: 1500, expected: false, note: 'Amazon portrait rejects' },
  { p: 'EBAY', w: 1000, h: 1100, expected: true, note: 'eBay 1:1 within 10% tolerance' },
  { p: 'EBAY', w: 1000, h: 1500, expected: false, note: 'eBay 4:6 rejects' },
  { p: 'SHOPIFY', w: 1600, h: 2000, expected: true, note: 'Shopify 4:5 exact' },
  { p: 'SHOPIFY', w: 1500, h: 1500, expected: false, note: 'Shopify 1:1 rejects' },
  { p: 'AMAZON', w: 0, h: 0, expected: null, note: 'zero dims → null' },
  { p: 'AMAZON', w: null as any, h: 1500, expected: null, note: 'null width → null' },
]

for (const c of aspectCases) {
  test(`isAspectOnTarget: ${c.note}`, () => {
    eq(isAspectOnTarget(c.w, c.h, c.p), c.expected, `${c.p} ${c.w}×${c.h}`)
  })
}

// ── isDimensionOnTarget ────────────────────────────────────────────────

test('isDimensionOnTarget: amazon 1000 floor', () => {
  eq(isDimensionOnTarget(1500, 1500, 'AMAZON'), true, '1500 ≥ 1000')
  eq(isDimensionOnTarget(900, 900, 'AMAZON'), false, '900 < 1000')
  eq(isDimensionOnTarget(900, 1500, 'AMAZON'), true, 'long edge counts')
  eq(isDimensionOnTarget(null, null, 'AMAZON'), null, 'null → null')
})

test('isDimensionOnTarget: ebay 500 floor', () => {
  eq(isDimensionOnTarget(500, 500, 'EBAY'), true, 'exactly at floor')
  eq(isDimensionOnTarget(499, 600, 'EBAY'), true, 'long edge over')
})

// ── No-MAIN block on platforms with minImages > 0 ──────────────────────

test('AMAZON considers first image as MAIN by default', () => {
  // The validator treats "any image" as having a MAIN when role is
  // not set — Amazon/eBay default to "first image is the hero".
  const result = validateImageList([
    { url: 'https://example.com/0.jpg', width: 1500, height: 1500, mimeType: 'image/jpeg' },
  ], 'AMAZON', 'IT')
  eq(result.hasMain, true, 'has implicit main')
  eq(result.blocking.filter((b) => b.code === 'no_main').length, 0, 'no_main not raised')
})

// ── Runner ─────────────────────────────────────────────────────────────

let passed = 0
let failed = 0
for (const t of tests) {
  try {
    t.fn()
    passed++
    console.log(`  ✓ ${t.name}`)
  } catch (err) {
    failed++
    console.error(`  ✗ ${t.name}`)
    console.error(`    ${err instanceof Error ? err.message : err}`)
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
