/**
 * W2.14 — Pure-function tests for the score() function.
 *
 * No DB. Run with `npx tsx <file>`. Same harness style as
 * family-hierarchy.service.test.ts.
 */

import {
  isFilled,
  score,
} from './family-completeness.service.js'
import { type EffectiveFamilyAttribute } from './family-hierarchy.service.js'

const tests: Array<{ name: string; fn: () => void }> = []
function test(name: string, fn: () => void) { tests.push({ name, fn }) }
function eq(a: unknown, b: unknown, msg = '') {
  const x = JSON.stringify(a)
  const y = JSON.stringify(b)
  if (x !== y) throw new Error(`${msg} expected=${y} actual=${x}`)
}

// ── isFilled ────────────────────────────────────────────────────

test('isFilled: null and undefined are not filled', () => {
  eq(isFilled(null), false)
  eq(isFilled(undefined), false)
})

test('isFilled: empty / whitespace strings are not filled', () => {
  eq(isFilled(''), false)
  eq(isFilled('   '), false)
  eq(isFilled('\n\t'), false)
})

test('isFilled: non-empty string is filled', () => {
  eq(isFilled('Xavia Racing'), true)
})

test('isFilled: empty array is not filled, non-empty is', () => {
  eq(isFilled([]), false)
  eq(isFilled(['red']), true)
})

test('isFilled: booleans (true and false) count as filled', () => {
  eq(isFilled(true), true)
  eq(isFilled(false), true, 'false is an explicit operator signal')
})

test('isFilled: 0 counts as filled', () => {
  eq(isFilled(0), true, 'operator might literally mean zero')
  eq(isFilled(42), true)
})

// ── score ──────────────────────────────────────────────────────

const attrId = (n: string) => `attr-${n}`

function eff(
  attrName: string,
  required: boolean,
  channels: string[] = [],
): EffectiveFamilyAttribute {
  return {
    attributeId: attrId(attrName),
    required,
    channels,
    sortOrder: 0,
    source: 'self',
  }
}

const codes = (...names: string[]) =>
  new Map(names.map((n) => [attrId(n), n]))

test('score: no required attributes → 100% by definition', () => {
  const r = score([eff('brand', false)], new Map(), codes('brand'))
  eq(r.totalRequired, 0)
  eq(r.score, 100)
  eq(r.byChannel.all.score, 100)
})

test('score: all required attrs filled → 100%', () => {
  const r = score(
    [eff('brand', true), eff('color', true)],
    new Map([
      ['brand', 'Xavia Racing'],
      ['color', 'Black'],
    ]),
    codes('brand', 'color'),
  )
  eq(r.totalRequired, 2)
  eq(r.filled, 2)
  eq(r.score, 100)
  eq(r.missing, [])
})

test('score: half required filled → 50%, missing list correct', () => {
  const r = score(
    [eff('brand', true), eff('color', true)],
    new Map([['brand', 'Xavia Racing']]),
    codes('brand', 'color'),
  )
  eq(r.totalRequired, 2)
  eq(r.filled, 1)
  eq(r.score, 50)
  eq(r.missing, [{ attributeId: attrId('color'), source: 'self' }])
})

test('score: optional attrs do not count toward required', () => {
  const r = score(
    [eff('brand', true), eff('description', false)],
    new Map([['brand', 'Xavia Racing']]),
    codes('brand', 'description'),
  )
  eq(r.totalRequired, 1)
  eq(r.filled, 1)
  eq(r.score, 100, 'optional missing description does not lower score')
})

test('score: per-channel — universal vs channel-specific required', () => {
  // brand is universal-required (channels=[]); ce_cert required only on AMAZON.
  const r = score(
    [
      eff('brand', true, []),
      eff('ce_cert', true, ['AMAZON']),
    ],
    new Map([['brand', 'Xavia Racing']]), // ce_cert missing
    codes('brand', 'ce_cert'),
  )
  // Headline: 1/2 = 50% (ce_cert required somewhere → counts in 'all').
  eq(r.score, 50)
  // AMAZON channel: both apply (brand universal + ce_cert specific).
  // Filled: brand only. 1/2 = 50%.
  eq(r.byChannel.AMAZON.score, 50)
  eq(r.byChannel.AMAZON.filled, 1)
  eq(r.byChannel.AMAZON.totalRequired, 2)
})

test('score: per-channel — channel without specific reqs gets just universals', () => {
  const r = score(
    [
      eff('brand', true, []),
      eff('ce_cert', true, ['AMAZON']),
    ],
    new Map([['brand', 'Xavia Racing']]),
    codes('brand', 'ce_cert'),
  )
  // EBAY channel: only brand applies. brand is filled. 1/1 = 100%.
  // (EBAY isn't in any required.channels[] so it's not in byChannel
  // unless we synthesise it. Per current impl it isn't synthesised
  // because no attr listed it. That's correct: scoring is silent
  // for channels with no opinions about them.)
  eq(r.byChannel.EBAY, undefined, 'channels with no required attrs are not in byChannel')
})

test('score: missing attribute mapping is recorded as missing', () => {
  // Effective has attribute attr-orphan but no entry in attributeCodes.
  const r = score(
    [eff('orphan', true)],
    new Map(),
    new Map(), // empty mapping
  )
  eq(r.filled, 0)
  eq(r.missing, [{ attributeId: attrId('orphan'), source: 'self' }])
})

test('score: source provenance preserved in missing entries', () => {
  const e: EffectiveFamilyAttribute = {
    attributeId: attrId('color'),
    required: true,
    channels: [],
    sortOrder: 0,
    source: 'fam-parent-001',
  }
  const r = score([e], new Map(), codes('color'))
  eq(r.missing, [{ attributeId: attrId('color'), source: 'fam-parent-001' }])
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
