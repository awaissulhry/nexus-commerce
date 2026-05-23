/**
 * IE.1 — Unit tests for the upload-dedup hashing helpers.
 *
 * Same lightweight pattern as crypto.test.ts: pure functions, no DB,
 * no network. Run via `npx tsx <file>` until the Vitest harness lands.
 *
 * What we verify:
 *   • SHA-256 is deterministic + distinct for distinct inputs
 *   • SHA-256 emits 64 hex chars (256 bits)
 *   • hammingHex returns 0 for identical strings
 *   • hammingHex counts bits, not chars (each hex digit = 4 bits)
 *   • hammingHex handles length mismatch as "very far"
 *   • NEAR_DUP threshold matches the value the route relies on
 */

import sharp from 'sharp'
import {
  NEAR_DUP_HAMMING_THRESHOLD,
  aHashBuffer,
  hammingHex,
  sha256Buffer,
} from './image-hash.service.js'

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = []
function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }) }
function assert(cond: unknown, msg = 'assertion failed'): asserts cond {
  if (!cond) throw new Error(msg)
}
function assertEq<T>(actual: T, expected: T, msg?: string): void {
  if (actual !== expected) {
    throw new Error(`${msg ?? 'not equal'}: got ${actual}, want ${expected}`)
  }
}

test('sha256Buffer is deterministic', () => {
  const a = sha256Buffer(Buffer.from('hello world'))
  const b = sha256Buffer(Buffer.from('hello world'))
  assertEq(a, b)
})

test('sha256Buffer emits 64 hex chars', () => {
  const h = sha256Buffer(Buffer.from('x'))
  assertEq(h.length, 64)
  assert(/^[0-9a-f]{64}$/.test(h), 'must be lowercase hex')
})

test('sha256Buffer differs for distinct bytes', () => {
  const a = sha256Buffer(Buffer.from([1, 2, 3]))
  const b = sha256Buffer(Buffer.from([1, 2, 4]))
  assert(a !== b)
})

test('hammingHex is 0 for identical strings', () => {
  assertEq(hammingHex('abcdef', 'abcdef'), 0)
  assertEq(hammingHex('0000000000000000', '0000000000000000'), 0)
})

test('hammingHex counts bit differences, not char differences', () => {
  // 0x0 = 0000, 0x1 = 0001 — 1 bit
  assertEq(hammingHex('0', '1'), 1)
  // 0x0 = 0000, 0xf = 1111 — 4 bits
  assertEq(hammingHex('0', 'f'), 4)
  // 0xff = 11111111, 0x00 = 00000000 — 8 bits
  assertEq(hammingHex('ff', '00'), 8)
})

test('hammingHex sums bit differences across a 16-char pHash', () => {
  // Cloudinary pHash is 16 hex chars (64 bits). Build two strings that
  // differ in exactly one nibble by one bit → distance must be 1.
  const a = '0000000000000000'
  const b = '0000000000000001'
  assertEq(hammingHex(a, b), 1)
  // Differ in two nibbles, one bit each → distance 2.
  const c = '0000000000000010'
  const d = '0000000000000001'
  assertEq(hammingHex(c, d), 2)
})

test('hammingHex flags length mismatch as very far', () => {
  // Different-length inputs should NOT silently compare prefix —
  // surface as a distance well above the near-dup threshold so the
  // route treats them as unrelated.
  const d = hammingHex('abc', 'abcdef')
  assert(d > NEAR_DUP_HAMMING_THRESHOLD, `expected ${d} > ${NEAR_DUP_HAMMING_THRESHOLD}`)
})

test('NEAR_DUP_HAMMING_THRESHOLD matches the route expectation', () => {
  // The route's 409 path depends on this threshold. If anyone changes
  // it, both ends + the en/it i18n strings need to move together.
  assertEq(NEAR_DUP_HAMMING_THRESHOLD, 6)
})

test('aHashBuffer is deterministic on the same buffer', async () => {
  // Build a tiny synthetic image: 16×16 PNG with a gradient.
  const buf = await sharp({
    create: {
      width: 16,
      height: 16,
      channels: 3,
      background: { r: 128, g: 128, b: 128 },
    },
  }).png().toBuffer()
  const a = await aHashBuffer(buf)
  const b = await aHashBuffer(buf)
  assertEq(a, b)
  assertEq(a.length, 16, 'aHash must be 16 hex chars (64 bits)')
})

test('aHashBuffer detects same image at different resolutions', async () => {
  // The Amazon-sync duplication shape: identical content rendered at
  // 256, 128, and 32 px. aHash must give near-identical fingerprints
  // (Hamming ≤ threshold) so the IE.2 collapse can group them.
  const source = await sharp({
    create: { width: 256, height: 256, channels: 3, background: { r: 80, g: 80, b: 80 } },
  })
    // Add a darker top-left quadrant so the gradient survives downscale.
    .composite([{
      input: await sharp({
        create: { width: 128, height: 128, channels: 3, background: { r: 0, g: 0, b: 0 } },
      }).png().toBuffer(),
      top: 0,
      left: 0,
    }])
    .png()
    .toBuffer()
  const small = await sharp(source).resize(128, 128).png().toBuffer()
  const tiny = await sharp(source).resize(32, 32).png().toBuffer()
  const h256 = await aHashBuffer(source)
  const h128 = await aHashBuffer(small)
  const h32 = await aHashBuffer(tiny)
  // 256→128 should be near-zero distance (downscale preserves the
  // mean-threshold pattern almost exactly).
  const d128 = hammingHex(h256, h128)
  const d32 = hammingHex(h256, h32)
  assert(d128 <= NEAR_DUP_HAMMING_THRESHOLD, `256→128 distance ${d128} must be ≤ ${NEAR_DUP_HAMMING_THRESHOLD}`)
  assert(d32 <= NEAR_DUP_HAMMING_THRESHOLD, `256→32 distance ${d32} must be ≤ ${NEAR_DUP_HAMMING_THRESHOLD}`)
})

test('aHashBuffer differs for visually different images', async () => {
  // Inverse contrast pattern. The mean-threshold flip means every
  // bit should toggle → distance ≈ 64.
  const dark = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 240, g: 240, b: 240 } },
  })
    .composite([{
      input: await sharp({
        create: { width: 32, height: 32, channels: 3, background: { r: 0, g: 0, b: 0 } },
      }).png().toBuffer(),
      top: 0,
      left: 0,
    }])
    .png()
    .toBuffer()
  const light = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .composite([{
      input: await sharp({
        create: { width: 32, height: 32, channels: 3, background: { r: 240, g: 240, b: 240 } },
      }).png().toBuffer(),
      top: 0,
      left: 0,
    }])
    .png()
    .toBuffer()
  const d = hammingHex(await aHashBuffer(dark), await aHashBuffer(light))
  assert(d > NEAR_DUP_HAMMING_THRESHOLD, `distinct images should differ by > ${NEAR_DUP_HAMMING_THRESHOLD}, got ${d}`)
})

let passed = 0
let failed = 0
for (const t of tests) {
  try {
    await t.fn()
    console.log(`  ✓ ${t.name}`)
    passed++
  } catch (e: any) {
    console.error(`  ✗ ${t.name}: ${e?.message ?? e}`)
    failed++
  }
}
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
