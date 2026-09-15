/**
 * PES.3 — the row model, tested on the shape prod actually has.
 *
 * The fixture mirrors 2026-09-01: GALE-JACKET listed under several eBay·IT aliases over the same
 * child SKUs. The invariant under test is PES.5 §3.2's: nothing in this lane totals a quantity, and
 * the counts that DO cross aliases are counts of SKUs, which do not scale with the alias list.
 */
import { describe, expect, it } from 'vitest'

import * as rowsModule from './rows'
/* 🔴 The DEEP path, never the barrel: `@/design-system/grid` re-exports `.tsx`, and this suite is
   node-only — importing the barrel here dies at PARSE before a single case runs
   (reference_test_scoping_and_hidden_assertions). `readiness.ts` is plain TS. */
import { readyPillTone } from '@/design-system/grid/renderers/readiness'
import {
  rowReadinessPill,
  affordanceOf,
  isCellEditable,
  isOperatorEdit,
  offersCascade,
  channelWriteGate,
  aliasReadinessPct,
  bandRowOf,
  dataPathFor,
  distinctVariantCount,
  orderRows,
  summariseAlias,
  variantRowsOf,
  isRevealAnchor,
  withMappingRun,
  withRowIdentity,
} from './rows'
import { aliasKeyOf, type AliasGroup, type StudioCellValue, type StudioRow } from './types'

const alias = (id: string | null, position: number, over: Partial<AliasGroup> = {}): AliasGroup => ({
  id,
  label: id === null ? 'Primary' : `Listing ${position}`,
  position,
  status: 'ACTIVE',
  externalListingId: id === null ? '257584954808' : `25656610${position}20`,
  listingStatus: 'ACTIVE',
  isPublished: true,
  readiness: { percent: 100, state: 'ready', errors: 0, warnings: 0, rowsMissingRequired: 0 },
  rowIds: [],
  ...over,
})

const row = (aliasId: string | null, id: string, rowKind: 'parent' | 'variant'): StudioRow => ({
  id,
  sku: id,
  name: null,
  parentId: rowKind === 'variant' ? 'GALE-JACKET' : null,
  isParent: rowKind === 'parent',
  status: 'ACTIVE',
  productType: 'OUTERWEAR',
  version: 1,
  childCount: rowKind === 'parent' ? 3 : 0,
  aliasId,
  rowKind,
  values: {},
  readiness: { state: 'ready', issues: [] },
  basePrice: null,
  listing: null,
  completeness: { overall: { filled: 0, total: 0, pct: 0 }, required: { filled: 0, total: 0, missing: [] }, byGroup: [] },
})

const SKUS = ['GALE-BLACK-M', 'GALE-BLACK-L', 'GALE-YELLOW-M']
const ALIASES = [alias(null, 0), alias('a1', 1), alias('a2', 2)]
const RAW: StudioRow[] = ALIASES.flatMap((a) => [
  row(a.id, 'GALE-JACKET', 'parent'),
  ...SKUS.map((s) => row(a.id, s, 'variant')),
])
const ROWS = withRowIdentity(RAW, ALIASES)

describe('row identity — the same SKU under N aliases is N rows', () => {
  it('gives every row a unique id even though product ids repeat', () => {
    const ids = ROWS.map((r) => r.rowId)
    expect(new Set(ids).size).toBe(ids.length)
    // The product id genuinely repeats: that is why rowId exists.
    expect(new Set(ROWS.map((r) => r.id)).size).toBeLessThan(ids.length)
  })

  it('keys the PRIMARY listing like any other group, with no special case', () => {
    expect(aliasKeyOf(null)).toBe('primary')
    expect(ROWS.some((r) => r.rowId.startsWith('primary:'))).toBe(true)
  })

  it('copies each group position onto its rows', () => {
    expect(ROWS.find((r) => r.aliasId === 'a2')?.aliasPosition).toBe(2)
    expect(ROWS.find((r) => r.aliasId === null)?.aliasPosition).toBe(0)
  })
})

describe('counts that cross aliases are SKU counts, never quantities', () => {
  it('does not scale with the number of aliases', () => {
    expect(distinctVariantCount(ROWS)).toBe(3)
    const withFourth = withRowIdentity(
      [...RAW, row('a3', 'GALE-JACKET', 'parent'), ...SKUS.map((s) => row('a3', s, 'variant'))],
      [...ALIASES, alias('a3', 3)],
    )
    // Twelve visible variant rows, still three SKUs.
    expect(withFourth.filter((r) => r.rowKind === 'variant')).toHaveLength(12)
    expect(distinctVariantCount(withFourth)).toBe(3)
  })

  it('exposes NO quantity/stock total anywhere in the module (PES.5 §3.2)', () => {
    // A standing guard, not a comment: "never summed" is the kind of rule a later refactor breaks
    // silently while every screen still looks plausible.
    expect(rowsModule.assertNoQuantitySummation(rowsModule)).toEqual([])
  })
})

describe('grouping', () => {
  it('paths a leaf under its alias and the band as the group node', () => {
    const band = ROWS.find((r) => r.rowKind === 'parent' && r.aliasId === 'a1')!
    const leaf = ROWS.find((r) => r.rowKind === 'variant' && r.aliasId === 'a1')!
    expect(dataPathFor(band)).toEqual(['a1'])
    expect(dataPathFor(leaf)).toEqual(['a1', leaf.rowId])
  })

  it('finds a group own band and children', () => {
    expect(variantRowsOf(ROWS, 'a1')).toHaveLength(3)
    expect(bandRowOf(ROWS, 'a1')?.rowKind).toBe('parent')
    expect(variantRowsOf(ROWS, null)).toHaveLength(3)
  })

  it('orders each band directly above its own children, primary first', () => {
    const ordered = orderRows([...ROWS].reverse())
    expect(ordered.slice(0, 4).map((r) => `${aliasKeyOf(r.aliasId)}/${r.rowKind}`)).toEqual([
      'primary/parent', 'primary/variant', 'primary/variant', 'primary/variant',
    ])
    expect(ordered[4].aliasId).toBe('a1')
  })
})

describe('summariseAlias', () => {
  it('reports the server readiness rather than recomputing it', () => {
    const a = alias('a1', 1, {
      readiness: { percent: 71, state: 'missing', errors: 2, warnings: 3, rowsMissingRequired: 4 },
    })
    const s = summariseAlias(ROWS, a)
    expect(s.percent).toBe(71)
    expect(s.errors).toBe(2)
    expect(s.rowsMissingRequired).toBe(4)
    expect(aliasReadinessPct(a)).toBe(71)
  })

  it('reports NULL, not 0 and not 100, when the server declares nothing to measure', () => {
    // ⚠ This test previously asserted 0 — it was protecting the bug rather than the behaviour.
    // The server sends `percent: null` when a coordinate has NO required fields, and its own
    // comment says 0 (alarming) and 100 (falsely reassuring) are both inventions. Found by the
    // #129 field-drift scan; the old assertion is exactly how the defect survived being tested.
    const a = alias('a9', 9, {
      readiness: { percent: null, state: 'unlisted', errors: 0, warnings: 0, rowsMissingRequired: 0 },
    })
    expect(aliasReadinessPct(a)).toBeNull()

    const missing = alias('a8', 8)
    // @ts-expect-error — a payload that omits readiness entirely is also "not measured", not zero.
    missing.readiness = undefined
    expect(aliasReadinessPct(missing)).toBeNull()
  })

  it('flags an unadopted shell: a real listing id with no rows under it', () => {
    // The 22 EBAY_LISTING_SHELL products measured on prod.
    const shell = alias('shell', 9, { externalListingId: '256564203510' })
    expect(summariseAlias([], shell).isUnadoptedShell).toBe(true)
    // A brand-new alias has no channel id yet, so it is NOT a shell — it is simply new.
    const fresh = alias('new', 9, { externalListingId: null })
    expect(summariseAlias([], fresh).isUnadoptedShell).toBe(false)
  })
})

describe('readiness colour comes from STATE — the ENGINE\'s function now (#43/#727)', () => {
  /**
   * Three of this block's four cases moved into the engine with the function
   * (`renderers/readyPillTone.vitest.test.ts`, which also gained the two regression cases). THIS one
   * stayed, because it is not about the mapping — it is about the STYLESHEET: an unmapped tone
   * paints nothing at all (reference_undefined_css_class_is_silent), and the classes it has to
   * match are `nds-readypill-*`, which this scope renders.
   */
  it('maps every row-level state to a tone the stylesheet defines', () => {
    const defined = new Set(['success', 'warning', 'danger', 'neutral', 'info'])
    for (const s of ['ready', 'missing', 'errors', 'live', 'unlisted'] as const) {
      expect(defined).toContain(readyPillTone(s))
    }
  })
})

describe('isOperatorEdit — deny-list, never allow-list (ruling #53)', () => {
  it("refuses the grid's own data set, which would make the sheet talk to itself", () => {
    expect(isOperatorEdit('data')).toBe(false)
  })

  it('lets every documented edit source through', () => {
    for (const s of ['edit', 'paste', 'undo', 'redo']) expect(isOperatorEdit(s)).toBe(true)
  })

  it('lets an UNPREDICTED source through — the asymmetry is the whole point', () => {
    // AG documents only examples. An allow-list would silently drop these, and an on-screen edit
    // that never reaches the server is worse than one extra save.
    for (const s of ['fillHandle', 'rangeService', 'someFutureAgSource', undefined]) {
      expect(isOperatorEdit(s)).toBe(true)
    }
  })

  it('gives undo/redo a server round-trip with no code of its own', () => {
    expect(isOperatorEdit('undo')).toBe(true)
    expect(isOperatorEdit('redo')).toBe(true)
  })
})

describe('cell affordance from the server routing fields (ruling #58)', () => {
  const c = (over: Partial<StudioCellValue>): StudioCellValue => ({
    value: 'x', source: 'master', inheritedFrom: null, inherited: false, layer: 'master',
    pinned: false, follows: null, editable: true, linkGroupId: null, mapped: null,
    writeField: 'f', writeTarget: 'channelListing', writeVerb: 'channel', affectsAllChannels: false, writable: true, ...over,
  })

  it('blocks everything on a non-writable cell', () => {
    const blocked = c({ writable: false, writeBlockedReason: 'Alias rows are unproven until PES.5-ii' })
    expect(affordanceOf(blocked)).toBe('blocked')
    expect(offersCascade(blocked)).toBe(false)
    expect(isCellEditable(blocked)).toBe(false)
  })

  it('offers NO cascade on a master-routed cell, even when follows is true', () => {
    // basePrice: follows can be SEEN but not un-followed here. An un-pin would rewrite every
    // channel — ruled honest, not contradictory.
    const basePrice = c({ writeTarget: 'master', writeVerb: 'master', follows: true, affectsAllChannels: true })
    expect(affordanceOf(basePrice)).toBe('masterEdit')
    expect(offersCascade(basePrice)).toBe(false)
    // …but it is still editable; the edit is simply a master edit.
    expect(isCellEditable(basePrice)).toBe(true)
  })

  it('offers the cascade only on a channel-routed writable cell', () => {
    const chan = c({ writeTarget: 'channelListing', writeVerb: 'channel', follows: true })
    expect(affordanceOf(chan)).toBe('cascade')
    expect(offersCascade(chan)).toBe(true)
  })

  it('treats a missing cell as blocked rather than as editable', () => {
    expect(affordanceOf(undefined)).toBe('blocked')
    expect(isCellEditable(undefined)).toBe(false)
  })

  it('respects editable:false independently of writable', () => {
    expect(isCellEditable(c({ editable: false }))).toBe(false)
  })
})

describe('channelWriteGate — lane rules layered over the substrate gate', () => {
  const cell = (over: Partial<StudioCellValue> = {}): StudioCellValue => ({
    value: 'x', source: 'master', inheritedFrom: null, inherited: false, layer: 'master',
    pinned: false, follows: null, editable: true, linkGroupId: null, mapped: null,
    writeField: 'f', writeTarget: 'channelListing', writeVerb: 'channel', affectsAllChannels: false, writable: true, ...over,
  })
  const base = { colId: 'brand', source: 'edit', selfInflicted: false, cell: cell(), acknowledged: false }

  it("ignores the grid's own data set", () => {
    expect(channelWriteGate({ ...base, source: 'data' })).toBe('ignore')
  })

  it('ignores our OWN undo — the bug found on screen, not in review', () => {
    // `setDataValue` re-fires cellValueChanged and AG does NOT mark it `data`, so without this the
    // decline path re-armed the very acknowledgement it had just dismissed, unescapably.
    expect(channelWriteGate({ ...base, selfInflicted: true })).toBe('ignore')
  })

  it('blocks a non-writable cell and a missing one', () => {
    expect(channelWriteGate({ ...base, cell: cell({ writable: false }) })).toBe('blocked')
    expect(channelWriteGate({ ...base, cell: undefined })).toBe('blocked')
  })

  it('holds a master-routed write until the operator has been told', () => {
    expect(channelWriteGate({ ...base, cell: cell({ affectsAllChannels: true }) })).toBe('acknowledge')
  })

  it('writes once acknowledged, and writes channel-routed cells straight away', () => {
    expect(channelWriteGate({ ...base, cell: cell({ affectsAllChannels: true }), acknowledged: true })).toBe('write')
    expect(channelWriteGate(base)).toBe('write')
  })

  it('never writes when the cell is blocked, whatever else is true', () => {
    expect(channelWriteGate({ ...base, cell: cell({ writable: false, affectsAllChannels: true }), acknowledged: true })).toBe('blocked')
  })
})

describe('§5.4 — which cell the record is opened FROM', () => {
  /**
   * 🔴 The measured trap: clicking `⋯` moves AG's focus to the actions cell, so reading focus when
   * the verb runs gives `cell=actions` — pinned, always visible, so the reveal decides "not
   * covered" and never scrolls. The feature was inert and looked implemented.
   */
  it('ignores grid chrome, which is never a cell anyone was working in', () => {
    for (const c of ['actions', '__identity', 'alias', 'ag-Grid-AutoColumn']) {
      expect(isRevealAnchor(c)).toBe(false)
    }
  })

  it('accepts a real data column', () => {
    expect(isRevealAnchor('country_of_origin')).toBe(true)
    expect(isRevealAnchor('item_name')).toBe(true)
  })

  it('treats absent focus as no anchor rather than guessing one', () => {
    expect(isRevealAnchor(undefined)).toBe(false)
    expect(isRevealAnchor(null)).toBe(false)
    expect(isRevealAnchor('')).toBe(false)
  })
})

describe('#379 — the run-level mapping fact reaches the classifier', () => {
  /**
   * Measured on Amazon·IT (441 cells): with the flag withheld, **63 `mapped` / 0 `mappedShared`**;
   * with it supplied, **0 / 63** — every product-grain derivation had been rendering as an ordinary
   * per-row `mapped`, the opposite of what §9.6b intends ("editing one row changes N").
   */
  const cell = (status?: string) => ({ value: 'x', mapped: status ? { status } : null }) as never

  it('adds the flag only when the run WAS product-grain', () => {
    expect(withMappingRun(cell('mapped'), true)).toMatchObject({ mappedProductLevel: true })
  })

  it('🔴 returns the cell UNTOUCHED when it was not — no allocation on the common path', () => {
    const c = cell('mapped')
    expect(withMappingRun(c, false)).toBe(c)
  })

  it('passes undefined through rather than inventing a cell', () => {
    expect(withMappingRun(undefined, true)).toBeUndefined()
  })

  it('does not mutate the wire cell it was given', () => {
    const c = cell('mapped')
    withMappingRun(c, true)
    expect(c).not.toHaveProperty('mappedProductLevel')
  })
})

describe('filtered rows keep the affected listing visible', () => {
  const rows = withRowIdentity(RAW, ALIASES)
  it('shows a refused parent even when none of its variants failed', () => {
    const parent = rows.find(row => row.rowKind === 'parent' && row.aliasId === null)!
    expect(rowsModule.filterRowsWithBands(rows, row => row.rowId === parent.rowId)).toEqual([parent])
  })
  it('keeps only the matching variant and its own listing band', () => {
    const child = rows.find(row => row.rowKind === 'variant' && row.aliasId === 'a1')!
    const parent = rows.find(row => row.rowKind === 'parent' && row.aliasId === 'a1')!
    expect(rowsModule.filterRowsWithBands(rows, row => row.rowId === child.rowId)).toEqual([parent, child])
  })
})

// Q-LX6-1: a missing contract cannot inherit 100% from four structural columns.
it('keeps every row unscorable when the server alias percentage is null', () => {
  const child = row(null, 'GALE-BLACK-M', 'variant')
  child.completeness.overall = { filled: 4, total: 4, pct: 100 }
  child.completeness.required = { filled: 4, total: 4, missing: [] }
  child.readiness = { state: 'errors', issues: [{ key: 'productType', label: 'Channel requirements', severity: 'error', message: 'OUTERWEAR requirements on Amazon · BE are unavailable.' }] }
  const unscorable = alias(null, 0)
  unscorable.readiness.percent = null
  expect(rowReadinessPill(child, unscorable)).toEqual({ pct: null, state: 'errors', tip: 'GALE-BLACK-M — OUTERWEAR requirements on Amazon · BE are unavailable.' })
  expect(rowReadinessPill(child, alias(null, 0)).pct).toBe(100)
})

describe('channel progress measures required fields for each variant', () => {
  it('reports 100% for the production GALE shape: 31/31 required, 64/247 overall', () => {
    const child = row(null, 'GALE-JACKET-BLACK-MEN-3XL', 'variant')
    child.completeness.overall = { filled: 64, total: 247, pct: 26 }
    child.completeness.required = { filled: 31, total: 31, missing: [] }
    child.readiness.state = 'live'
    expect(rowReadinessPill(child, alias(null, 0))).toEqual({
      pct: 100, state: 'live',
      tip: 'GALE-JACKET-BLACK-MEN-3XL — 31 of 31 required channel fields filled · Listed',
    })
  })

  it('uses the refreshed row count, independent of optional coverage and the alias average', () => {
    const child = row('a1', 'GALE-BLACK-M', 'variant')
    child.completeness.overall = { filled: 64, total: 247, pct: 26 }
    child.completeness.required = { filled: 30, total: 31, missing: [{ key: 'brand', label: 'Brand' }] }
    const listing = alias('a1', 1)
    expect(rowReadinessPill(child, listing).pct).toBe(97)
    const saved = { ...child, completeness: { ...child.completeness, required: { filled: 31, total: 31, missing: [] } } }
    expect(rowReadinessPill(saved, listing).pct).toBe(100)
    child.completeness.required.filled = 0
    expect(rowReadinessPill(child, listing).pct).toBe(0)
  })

  it('preserves an error state when required fields are filled but validation fails', () => {
    const child = row(null, 'GALE-BLACK-M', 'variant')
    child.completeness.required = { filled: 31, total: 31, missing: [] }
    child.readiness.state = 'errors'
    expect(rowReadinessPill(child, alias(null, 0))).toMatchObject({ pct: 100, state: 'errors' })
  })

  it('does not borrow a score from the alias when the row has no required fields', () => {
    const child = row(null, 'GALE-BLACK-M', 'variant')
    child.completeness.overall = { filled: 4, total: 4, pct: 100 }
    expect(rowReadinessPill(child, alias(null, 0))).toMatchObject({
      pct: null, tip: 'GALE-BLACK-M — No required attributes are defined for this row.',
    })
    expect(rowReadinessPill(child, undefined).pct).toBeNull()
  })
})
