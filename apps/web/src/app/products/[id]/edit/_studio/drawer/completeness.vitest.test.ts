/**
 * PES.4 — the completeness mirror must match the service that sends it.
 *
 * WHY THIS FILE EXISTS. `MasterCompleteness` in `types.ts` is a hand-written mirror of an API type
 * that `apps/web` cannot import. It was wrong from the day it was written — flat instead of
 * nested, `percent` instead of `pct`, `missing: string[]` instead of `{key,label}[]` — and nothing
 * caught it. TypeScript could not: a mirror is only ever checked against itself, so every consumer
 * type-checked perfectly against a shape the server has never sent. The drawer's footer rendered
 * "undefined% complete" and the suite stayed green (ruling #46, caught by PES.2 at wiring time).
 *
 * So this asserts against the SERVICE SOURCE, the same way `layers.vitest.test.ts` asserts the
 * provenance vocabulary against the resolver's. The rule those two share: a contract restated in
 * two repos is not a contract until something compares the copies.
 *
 * The extractor asserts its own catch FIRST — an extractor that silently matches nothing turns
 * this into a test that passes because it checked nothing, which is the worse failure.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { pimFile } from './api-source.testutil'

import type { MasterCompleteness } from './types'

const SERVICE = pimFile('master-completeness.service.ts')
const STUDIO = pimFile('studio-sheet.service.ts')

/** The body of `export interface <name> { … }`, brace-matched rather than regex-guessed. */
function interfaceBody(name: string, file = SERVICE): string {
  const src = readFileSync(file, 'utf8')
  // `export interface X {` OR `export interface X extends Y {` — matching only the first form
  // made this throw on `StudioCellValue extends SheetCellValue`. It threw rather than returning
  // an empty string, which is the whole reason the extractor is written to fail loudly.
  const decl = new RegExp(`export interface ${name}\\b[^{]*\\{`)
  const m = decl.exec(src)
  if (!m) throw new Error(`${name} not found in ${file} — renamed or moved?`)
  const start = m.index
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces reading ${name}`)
}

describe('MasterCompleteness mirrors the API service', () => {
  const body = interfaceBody('MasterCompleteness')

  it('the extractor actually read something', () => {
    // Guard the tool before trusting the tool's answer.
    expect(body.length).toBeGreaterThan(80)
    expect(body).toContain('overall')
  })

  it('has the three top-level keys, nested — not a flat bag', () => {
    for (const key of ['overall', 'required', 'byGroup']) {
      expect(body, `service no longer declares '${key}'`).toContain(`${key}:`)
    }
    // The exact wrong shape this test was written for. If the mirror ever flattens again, the
    // consumer reads undefined and prints it.
    expect(body).not.toMatch(/^\s*percent:/m)
  })

  it("uses `pct`, not `percent` — the mismatch that printed 'undefined% complete'", () => {
    expect(body).toContain('pct: number')
    expect(body).not.toContain('percent: number')
  })

  it('`required.missing` carries key AND label, not bare strings', () => {
    expect(body).toMatch(/missing:\s*\{\s*key:\s*string;\s*label:\s*string\s*\}\[\]/)
    expect(body).not.toMatch(/missing:\s*string\[\]/)
  })

  it('the local mirror satisfies the same shape at compile time and at runtime', () => {
    // A literal typed as the mirror: if `types.ts` drifts from the service, the assertions above
    // fail; if the mirror drifts from THIS literal, the compiler fails. Both directions pinned.
    const sample: MasterCompleteness = {
      overall: { filled: 12, total: 44, pct: 27 },
      required: { filled: 3, total: 9, missing: [{ key: 'item_name', label: 'Title' }] },
      byGroup: [{ group: 'Content', filled: 2, total: 5 }],
    }
    expect(sample.overall.pct).toBe(27)
    expect(sample.required.missing[0].label).toBe('Title')
    expect(sample.byGroup[0].group).toBe('Content')
  })
})

/**
 * The SAME class of bug, twice more, found only by the first real payload: `listing` and
 * `readiness` are SINGULAR on a studio row. This lane had mirrored the catalogue-wide read
 * (`sheet-rows.service.ts`), where both are maps keyed by coordinate — because that endpoint
 * reports one row against every channel in a market. The studio read is loaded FOR one scope.
 *
 * The crash was `readiness.issues is not iterable`: `Object.values({state, issues})` yields the
 * STRING "missing", and a string has no `.issues`. Type-checked perfectly the whole time.
 */
describe('StudioRow mirrors studio-sheet.service.ts', () => {
  const body = interfaceBody('StudioRow', STUDIO)

  it('the extractor actually read something', () => {
    expect(body.length).toBeGreaterThan(200)
    expect(body).toContain('values:')
  })

  it('🔴 `listing` and `readiness` are SINGULAR, not coordinate-keyed maps', () => {
    expect(body).toMatch(/\blisting:\s*SheetListing \| null/)
    expect(body).toMatch(/\breadiness:\s*SheetReadiness\b/)
    // The exact wrong shapes this lane shipped. A map here means the mirror drifted back to the
    // catalogue-wide read, and `Object.values()` over the singular object throws on first paint.
    expect(body).not.toMatch(/listings:\s*Record</)
    expect(body).not.toMatch(/readiness:\s*Record</)
  })

  it('carries the alias axis the drawer reads', () => {
    expect(body).toMatch(/aliasId:\s*string \| null/)
    expect(body).toMatch(/rowKind:\s*'parent' \| 'variant'/)
  })

  it('completeness on the row is the MA.4 shape, not a flat bag', () => {
    expect(body).toMatch(/completeness:\s*MasterCompleteness/)
  })
})

/**
 * The three fields that gate the commit affordances (#58). Each one, if it silently disappears
 * from the contract, turns a correct UI into a lying one — and the lie is invisible, because the
 * drawer would simply stop warning.
 */
describe('StudioCellValue mirrors the commit-gating contract', () => {
  const body = interfaceBody('StudioCellValue', STUDIO)

  it('the extractor actually read something', () => {
    expect(body.length).toBeGreaterThan(200)
    expect(body).toContain('writeTarget')
  })

  it('🔴 `affectsAllChannels` exists — without it a channel form silently edits every channel', () => {
    // Only six field names route to a ChannelListing in bulk-PATCH; measured on eBay·IT, 399 of
    // 441 cells write to master. If this field vanishes, the drawer stops warning and an operator
    // editing "the eBay title" changes Amazon too, with nothing on screen saying so.
    expect(body).toMatch(/affectsAllChannels:\s*boolean/)
  })

  it('`writable` + `writeBlockedReason` travel together — a block must be able to explain itself', () => {
    expect(body).toMatch(/writable:\s*boolean/)
    expect(body).toMatch(/writeBlockedReason:\s*string \| null/)
  })

  it('`writeTarget` stays a two-value union — the drawer branches on exactly these', () => {
    expect(body).toMatch(/writeTarget:\s*'master' \| 'channelListing'/)
  })
})
