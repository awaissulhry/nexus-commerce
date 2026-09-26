/**
 * PES.1 — the readiness wire parse.
 *
 * This is the one place a server value becomes a percentage on a chip, and every failure here is
 * silent: nothing throws, a number just appears that nobody computed. So the cases below are mostly
 * about what must NOT become a number.
 */

import { describe, expect, it } from 'vitest'

import { parseReadinessResponse } from './readiness'

describe('the happy shape', () => {
  it('maps scopes by id, keeping the counts and the server’s own sentence', () => {
    const out = parseReadinessResponse({
      market: 'IT',
      scopes: [
        { id: 'master', pct: 96, state: 'ready', required: { filled: 24, total: 25 } },
        { id: 'EBAY', pct: 71, state: 'blocked', note: 'Missing: EAN, country of origin.' },
      ],
    })
    expect(out.master).toEqual({ pct: 96, state: 'ready', required: { filled: 24, total: 25 }, note: undefined, mappingRules: null })
    expect(out.EBAY.pct).toBe(71)
    expect(out.EBAY.state).toBe('blocked')
    expect(out.EBAY.note).toBe('Missing: EAN, country of origin.')
  })

  it('keeps a real zero, which is a genuine answer', () => {
    // 0% is only a lie when nobody measured it. Measured, it is the most important number here.
    expect(parseReadinessResponse({ scopes: [{ id: 'A', pct: 0, state: 'blocked' }] }).A.pct).toBe(0)
  })
})

describe('🔴 nothing may become a percentage that was not one', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a numeric STRING', '92'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['an object', {}],
    ['a boolean', true],
  ])('%s → pct null, never a number', (_label, pct) => {
    const out = parseReadinessResponse({ scopes: [{ id: 'A', pct, state: 'warn' }] })
    expect(out.A.pct).toBeNull()
  })
})

describe('an unrecognised payload degrades, it does not guess', () => {
  it('falls back to absent for a state outside the scope vocabulary', () => {
    // `missing` is a ROW state. Accepting it here would silently render the row vocabulary on a
    // scope chip — the exact collapse the two-vocabulary split exists to prevent.
    expect(parseReadinessResponse({ scopes: [{ id: 'A', pct: 5, state: 'missing' }] }).A.state).toBe('absent')
    expect(parseReadinessResponse({ scopes: [{ id: 'A', pct: 5 }] }).A.state).toBe('absent')
  })

  it('drops rows it cannot identify rather than inventing an id', () => {
    const out = parseReadinessResponse({ scopes: [null, 'x', {}, { id: '' }, { id: 'OK', pct: 1, state: 'ready' }] })
    expect(Object.keys(out)).toEqual(['OK'])
  })

  it('ignores a partial `required` instead of half-reporting it', () => {
    expect(parseReadinessResponse({ scopes: [{ id: 'A', pct: 1, state: 'ready', required: { filled: 3 } }] }).A.required).toBeUndefined()
  })

  it('returns nothing at all for a payload that is not the contract', () => {
    for (const junk of [null, undefined, {}, { scopes: 'nope' }, [], 'text']) {
      expect(parseReadinessResponse(junk)).toEqual({})
    }
  })
})

/**
 * The real thing.
 *
 * Captured verbatim from PES.5's endpoint on the shared API, 2026-09-01
 * (`GET /api/products/cmokmy3a40078pm0p1fvnu523/readiness?market=IT`, the XAVIA GALE-JACKET family).
 * A hand-written fixture only proves the parser against the shape I imagined; this proves it
 * against the shape that exists.
 */
const REAL = {
  market: 'IT',
  scopes: [
    { id: 'master', label: 'Master', pct: 71, required: { filled: 105, total: 147 }, state: 'warn', aliasCount: 0 },
    { id: 'AMAZON', label: 'Amazon · IT', pct: 71, required: { filled: 105, total: 147 }, state: 'blocked', aliasCount: 0 },
    { id: 'EBAY', label: 'eBay · IT', pct: 100, required: { filled: 21, total: 21 }, state: 'warn', aliasCount: 0 },
    { id: 'SHOPIFY', label: 'Shopify · GLOBAL', pct: null, required: { filled: 0, total: 0 }, state: 'absent', note: 'Shopify · GLOBAL declares no required fields for this product type', aliasCount: 0 },
  ],
  computedAt: '2026-09-01T01:50:21.725Z',
}

describe('the live PES.5 response', () => {
  it('parses every scope, ignoring fields the frame does not use', () => {
    const out = parseReadinessResponse(REAL)
    expect(Object.keys(out)).toEqual(['master', 'AMAZON', 'EBAY', 'SHOPIFY'])
    // `label` ("Amazon · IT") and `aliasCount` are deliberately dropped. The chip is labelled with
    // the CHANNEL alone; taking the server's label would put the market on the chip beside the
    // market switcher — two controls for one fact.
    expect(out.AMAZON).not.toHaveProperty('label')
    expect(out.AMAZON).not.toHaveProperty('aliasCount')
  })

  it('🔴 keeps state and percentage INDEPENDENT — this response proves they are', () => {
    // Same 71% reads `warn` on master and `blocked` on Amazon; and eBay is 100% yet still `warn`.
    // So a chip must take its colour from `state` and never from `pct`: colouring by percentage
    // would paint eBay green while the server says it is not clear.
    expect(out71()).toEqual(['warn', 'blocked'])
    const out = parseReadinessResponse(REAL)
    expect(out.EBAY.pct).toBe(100)
    expect(out.EBAY.state).toBe('warn')
  })

  it('carries a null percentage with the reason, rather than a zero', () => {
    const out = parseReadinessResponse(REAL)
    expect(out.SHOPIFY.pct).toBeNull()
    expect(out.SHOPIFY.state).toBe('absent')
    expect(out.SHOPIFY.note).toContain('declares no required fields')
    // A `required` of 0/0 is real and kept — it is what makes the null percentage explicable.
    expect(out.SHOPIFY.required).toEqual({ filled: 0, total: 0 })
  })
})

function out71(): string[] {
  const out = parseReadinessResponse(REAL)
  return [out.master.state, out.AMAZON.state]
}

describe('mappingRules — the no-rules discriminator (PES.5 §11)', () => {
  it('keeps a ZERO, because zero is the whole signal', () => {
    // Three causes produce `absent`; `mappingRules === 0` is the only machine-readable way to tell
    // "nothing is configured for this product type" from the others. Dropping the 0 as falsy would
    // erase exactly the case it was added for.
    const out = parseReadinessResponse({
      scopes: [{ id: 'AMAZON', pct: null, state: 'absent', mappingRules: 0, required: { filled: 0, total: 12 }, note: 'No mapping rules configured for Amazon · IT and AUTO_ACCESSORY — nothing would publish here yet' }],
    })
    expect(out.AMAZON.mappingRules).toBe(0)
    expect(out.AMAZON.pct).toBeNull()
    expect(out.AMAZON.state).toBe('absent')
    // counts are preserved even when the verdict degrades
    expect(out.AMAZON.required).toEqual({ filled: 0, total: 12 })
    // and the sentence is carried through untouched, both variables intact
    expect(out.AMAZON.note).toBe('No mapping rules configured for Amazon · IT and AUTO_ACCESSORY — nothing would publish here yet')
  })

  it('is null when the server did not say, and for anything that is not a number', () => {
    expect(parseReadinessResponse({ scopes: [{ id: 'A', pct: 1, state: 'ready' }] }).A.mappingRules).toBeNull()
    for (const v of ['3', null, Number.NaN, {}]) {
      expect(parseReadinessResponse({ scopes: [{ id: 'A', pct: 1, state: 'ready', mappingRules: v }] }).A.mappingRules).toBeNull()
    }
  })
})

import { parseReadinessMatrix } from './readiness'
it('keeps matrix, pressed-language chip and other-language tooltip on the same wire values', () => {
 const entry = { id: 'AMAZON', coordinateKey: '["AMAZON","BE","a",null]', channel: 'AMAZON', market: 'BE', accountId: 'a', aliasId: null,
  language: 'nl', label: 'Amazon · BE', pct: null, state: 'blocked', note: 'Dutch title is missing.', missing: [{ productId: 'p', field: 'name', label: 'Title', reason: 'Dutch title is missing.' }], computedAt: '2026-09-12T00:00:00Z',
  languages: [{ language: 'nl', pct: null, state: 'blocked' }, { language: 'fr', pct: 100, state: 'ready' }] }
 const response = { scopes: [entry], matrix: [entry] }
 const chip = parseReadinessResponse(response).AMAZON, matrix = parseReadinessMatrix(response)[0]
 expect(matrix.pct).toBe(chip.pct); expect(matrix.state).toBe(chip.state)
 expect(matrix.missing[0].reason).toBe(chip.note)
 expect(chip.languages?.[1]).toEqual({ language: 'fr', pct: 100, state: 'ready' })
 expect(parseReadinessMatrix({ matrix: [{ ...entry, accountId: 1 }] })).toEqual([])
})

/**
 * LX.FIN (R-LX-22) — `byProduct`, parsed with the SAME strictness as the chip's percentage.
 *
 * These values become a CELL in every row of the master sheet's per-coordinate readiness column, so a
 * coerced one asserts a measurement nobody took, one row at a time. A dropped entry reads
 * `Not computed` at the call site, which is the truth about an entry the parser could not understand.
 */
it('parses byProduct strictly and drops what it cannot read, rather than guessing', () => {
 const base = { id: 'AMAZON', coordinateKey: '["AMAZON","IT",null,null]', channel: 'AMAZON', market: 'IT', accountId: null, aliasId: null,
  language: 'it', label: 'Amazon · IT', pct: 100, state: 'blocked', missing: [], computedAt: '2026-09-13T09:00:00Z' }
 const parsed = parseReadinessMatrix({ matrix: [{ ...base, byProduct: {
   good: { state: 'ready', pct: 100 },
   noPct: { state: 'blocked', pct: null },
   withNote: { state: 'notComputed', pct: null, note: 'Readiness has not been computed for this language.' },
   stringPct: { state: 'warn', pct: '71' },
   nanPct: { state: 'warn', pct: Number.NaN },
   badState: { state: 'live', pct: 100 },
   notAnObject: 5,
 } }] })[0]
 // 🔴 POSITIVE CONTROL first: the good entries survive with their exact values.
 expect(parsed.byProduct?.good).toEqual({ state: 'ready', pct: 100 })
 expect(parsed.byProduct?.noPct).toEqual({ state: 'blocked', pct: null })
 expect(parsed.byProduct?.withNote?.note).toBe('Readiness has not been computed for this language.')
 // A numeric string and a NaN are NOT percentages — kept as `null`, never coerced to 71 or 0.
 expect(parsed.byProduct?.stringPct).toEqual({ state: 'warn', pct: null })
 expect(parsed.byProduct?.nanPct).toEqual({ state: 'warn', pct: null })
 // `live` belongs to the ROW vocabulary; a scope cell must never render it (PES.0 #3, no converter).
 expect(parsed.byProduct?.badState).toBeUndefined()
 expect(parsed.byProduct?.notAnObject).toBeUndefined()
 expect(Object.keys(parsed.byProduct ?? {})).toEqual(['good', 'noPct', 'withNote', 'stringPct', 'nanPct'])
})

it('byProduct is an empty object, never undefined, when the server sends nothing usable', () => {
 const base = { id: 'AMAZON', coordinateKey: 'k', channel: 'AMAZON', market: 'IT', accountId: null, aliasId: null,
  language: 'it', label: 'Amazon · IT', pct: null, state: 'notComputed', missing: [], computedAt: null }
 for (const value of [undefined, null, [], 'x', 3]) {
  expect(parseReadinessMatrix({ matrix: [{ ...base, byProduct: value }] })[0].byProduct).toEqual({})
 }
})

/**
 * A-45 (Step 4.3 #4) — the completeness card reads `requiredEmpty`, `kind` and each product's own counts from
 * the matrix. The same strictness as the chip: a flag or a count that is not exactly the contract is DROPPED,
 * never coerced — reading "yes" as true would name a field empty that nobody measured.
 */
describe('A-45 — the matrix carries the required-empty flag and each product\'s own counts', () => {
  const raw = (over: Record<string, unknown> = {}) => ({ matrix: [{
    coordinateKey: '["AMAZON","IT",null,null]', channel: 'AMAZON', market: 'IT', accountId: null, aliasId: null, language: 'de', label: 'Amazon · IT',
    pct: 82, state: 'blocked', required: { filled: 18, total: 22 }, computedAt: '2026-09-24T06:00:00.000Z',
    missing: [
      { productId: 'p', field: 'gtin', label: 'GTIN', reason: 'Required and empty', requiredEmpty: true },
      { productId: 'p', field: 'name', label: 'Title', reason: 'de content is missing', kind: 'language-fallback', requiredEmpty: 'yes' },
      { productId: 'p', field: 'x', label: 'X', reason: 'r', kind: 7 },
    ],
    byProduct: { p: { state: 'blocked', pct: 82, required: { filled: 18, total: 22 }, computedAt: '2026-09-24T06:00:00.000Z' }, half: { state: 'warn', pct: 50, required: { filled: 1 } } },
    ...over,
  }] })
  it('keeps requiredEmpty only when it is exactly true, and kind only as a string', () => {
    const [entry] = parseReadinessMatrix(raw())
    expect(entry.missing).toEqual([
      { productId: 'p', field: 'gtin', label: 'GTIN', reason: 'Required and empty', requiredEmpty: true },
      { productId: 'p', field: 'name', label: 'Title', reason: 'de content is missing', kind: 'language-fallback' },
      { productId: 'p', field: 'x', label: 'X', reason: 'r' },
    ])
  })
  it('a product\'s own counts only when both are finite; its age only as a string', () => {
    const [entry] = parseReadinessMatrix(raw())
    expect(entry.byProduct!.p).toEqual({ state: 'blocked', pct: 82, required: { filled: 18, total: 22 }, computedAt: '2026-09-24T06:00:00.000Z' })
    expect(entry.byProduct!.half.required).toBeUndefined()
    expect(entry.byProduct!.half.computedAt).toBeUndefined()
  })
})


describe('progress columns (2026-09-26) — the optional side of the matrix', () => {
  const entry = (extra: Record<string, unknown>) => parseReadinessMatrix({ matrix: [{ coordinateKey: 'k', channel: 'AMAZON', market: 'IT', accountId: 'a', aliasId: null,
    language: 'it', label: 'Amazon · IT', state: 'blocked', pct: 50, required: { filled: 1, total: 2 }, missing: [], ...extra }] })[0]
  it('reads a product\'s optional counts only when both are finite, and the empty optional names only when well formed', () => {
    const e = entry({
      byProduct: { p: { state: 'blocked', pct: 50, optional: { filled: 2, total: 5 } }, half: { state: 'warn', pct: 50, optional: { filled: 2 } }, none: { state: 'ready', pct: 100 } },
      optionalMissing: [{ productId: 'p', field: 'colour', label: 'Colour' }, { productId: 'p', field: 3 }, null],
    })
    expect(e.byProduct!.p.optional).toEqual({ filled: 2, total: 5 })
    // A half-count or no count at all is NOT RECORDED — left out, never read as "nothing optional is empty".
    expect(e.byProduct!.half.optional).toBeUndefined()
    expect(e.byProduct!.none.optional).toBeUndefined()
    expect(e.optionalMissing).toEqual([{ productId: 'p', field: 'colour', label: 'Colour' }])
  })
  it('an older server with no optional side parses as before', () => {
    expect(entry({}).optionalMissing).toEqual([])
  })
})
