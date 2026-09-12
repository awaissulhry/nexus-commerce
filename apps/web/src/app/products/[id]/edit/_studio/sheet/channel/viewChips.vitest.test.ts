/**
 * PES.3 — the channel scope's chips, tested where they can lie.
 *
 * Ruling #34's honest-count rule is the whole contract: `null` is not zero, and a chip that hides
 * or prints "(0)" without having counted answers "none" on the strength of not having checked.
 */
import { describe, expect, it } from 'vitest'

import { buildChannelChips, chipHasCell, rowsForChip } from './viewChips'
import type { ChannelSheetRow, SheetColumn, StudioCellValue } from './types'

const col = (key: string): SheetColumn => ({
  key, writeField: key, label: key, group: 'g', kind: 'text', storage: 'column',
  scope: 'global', requiredBy: [], editable: true, defaultVisible: true,
})

const cell = (over: Partial<StudioCellValue> = {}): StudioCellValue => ({
  value: 'x', source: 'master', inheritedFrom: null, inherited: false, layer: 'master',
  pinned: false, follows: null, editable: true, linkGroupId: null, mapped: null,
  writeField: 'f', writeTarget: 'channelListing', writeVerb: 'channel',
  affectsAllChannels: false, writable: true, ...over,
})

const row = (
  rowId: string,
  rowKind: 'parent' | 'variant',
  issues: Array<{ key: string; severity: 'error' | 'warn' }> = [],
  values: Record<string, StudioCellValue> = {},
): ChannelSheetRow => ({
  rowId, id: rowId.split(':').pop()!, sku: rowId, name: null, parentId: null,
  isParent: rowKind === 'parent', status: 'ACTIVE', productType: null, version: 1, childCount: 0,
  aliasId: 'a1', rowKind, aliasPosition: 1, values,
  basePrice: null, listing: null,
  completeness: { overall: { filled: 0, total: 0, pct: 0 }, required: { filled: 0, total: 0, missing: issues.filter((i) => i.severity === 'error').map((i) => ({ key: i.key, label: i.key })) }, byGroup: [] },
  readiness: {
    state: 'ready',
    issues: issues.map((i) => ({ key: i.key, label: i.key, message: i.key, severity: i.severity })),
  },
})

const COLS = [col('brand'), col('gtin'), col('gpsr_safety_attestation')]

describe('honest counts (ruling #34)', () => {
  it('counts CELLS, not rows — two bad fields on one row are two', () => {
    const rows = [row('a1:x', 'variant', [{ key: 'brand', severity: 'error' }, { key: 'gtin', severity: 'error' }])]
    const chip = buildChannelChips(rows, COLS).find((c) => c.id === 'missing-required')!
    expect(chip.count).toBe(2)
    expect(chip.cells.byRow['a1:x']).toEqual(['brand', 'gtin'])
  })

  it('reports null — NOT zero — when any row has no readiness', () => {
    const rows = [row('a1:x', 'variant', [{ key: 'brand', severity: 'error' }])]
    // @ts-expect-error — a payload that did not carry readiness for this row.
    rows.push({ ...row('a1:y', 'variant'), readiness: undefined })
    for (const chip of buildChannelChips(rows, COLS)) {
      if (chip.id === 'mapping-errors' || chip.id === 'missing-required') continue
      expect(chip.count).toBeNull()
      expect(chip.note).toMatch(/not.*computed/)
    }
  })

  it('reports a REAL zero as 0, so hideWhenZero can hide it', () => {
    const chip = buildChannelChips([row('a1:x', 'variant', [])], COLS).find((c) => c.id === 'missing-required')!
    expect(chip.count).toBe(0)
    expect(chip.hideWhenZero).toBe(true)
  })

  it('separates errors from warnings', () => {
    const rows = [row('a1:x', 'variant', [
      { key: 'brand', severity: 'error' },
      { key: 'gtin', severity: 'warn' },
    ])]
    const chips = buildChannelChips(rows, COLS)
    expect(chips.find((c) => c.id === 'missing-required')!.count).toBe(1)
    expect(chips.find((c) => c.id === 'channel-warnings')!.count).toBe(1)
  })
})

describe('a cell you cannot reach is not a cell you can count', () => {
  it('excludes an issue naming a field this scope does not show, and SAYS so', () => {
    const rows = [row('a1:x', 'variant', [
      { key: 'brand', severity: 'error' },
      { key: 'not_a_column', severity: 'error' },
    ])]
    const chip = buildChannelChips(rows, COLS).find((c) => c.id === 'missing-required')!
    // Counting it would promise the operator a destination the filter cannot reach.
    expect(chip.count).toBe(1)
    expect(chip.note).toContain('not_a_column')
    expect(chip.note).toMatch(/1 more/)
  })
})

describe('mapping errors come from the engine, never computed here', () => {
  it('shows missing conditional data separately from authored mapping failures', () => {
    const missing = cell({ value: null, mapped: { value: null, status: 'mapped', provenance: 'missing', appliedTransforms: [], warnings: [], errors: ['Required by this category condition'], mappingErrors: [], autoCorrected: null, requiredByRule: true, overLimit: null } })
    const broken = cell({ mapped: { ...missing.mapped!, errors: ['expr failed'], mappingErrors: ['expr failed'] } })
    const chips = buildChannelChips([row('a1:x', 'variant', [{ key: 'brand', severity: 'error' }], { brand: missing, gtin: broken })], COLS)
    expect(chips.find(c => c.id === 'missing-required')!.cells.byRow['a1:x']).toEqual(['brand'])
    expect(chips.find(c => c.id === 'mapping-errors')!.cells.byRow['a1:x']).toEqual(['gtin'])
  })
  it('counts a cell whose mapped verdict carries errors', () => {
    const bad = cell({ mapped: { value: null, status: 'mapped', provenance: null, appliedTransforms: [], warnings: [], errors: ['too long'], autoCorrected: null, requiredByRule: true, overLimit: null } })
    const chip = buildChannelChips([row('a1:x', 'variant', [], { brand: bad })], COLS).find((c) => c.id === 'mapping-errors')!
    expect(chip.count).toBe(1)
    expect(chip.cells.byRow['a1:x']).toEqual(['brand'])
  })

  it('does not count a clean mapping or a null one', () => {
    const clean = cell({ mapped: { value: 'v', status: 'mapped', provenance: null, appliedTransforms: [], warnings: ['soft'], errors: [], autoCorrected: null, requiredByRule: false, overLimit: null } })
    const rows = [row('a1:x', 'variant', [], { brand: clean, gtin: cell() })]
    expect(buildChannelChips(rows, COLS).find((c) => c.id === 'mapping-errors')!.count).toBe(0)
  })
})

describe('rowsForChip keeps the tree intact', () => {
  const band = row('a1', 'parent')
  const hit = row('a1:x', 'variant', [{ key: 'brand', severity: 'error' }])
  const miss = row('a1:y', 'variant')
  const rows = [band, hit, miss]

  it('keeps the matching row AND its alias band', () => {
    const cells = buildChannelChips(rows, COLS).find((c) => c.id === 'missing-required')!.cells
    const kept = rowsForChip(rows, cells)
    // Drop the band and AG has no parent to hang the match under — the row vanishes and the
    // filter then shows fewer cells than the chip counted.
    expect(kept.map((r) => r.rowId).sort()).toEqual(['a1', 'a1:x'])
  })

  it('shows no rows when the counted filter has no matches', () => {
    expect(rowsForChip(rows, { byRow: {} })).toHaveLength(0)
  })
})

describe('chipHasCell', () => {
  it('answers per cell, for the tint', () => {
    const cells = { byRow: { 'a1:x': ['brand'] } }
    expect(chipHasCell(cells, 'a1:x', 'brand')).toBe(true)
    expect(chipHasCell(cells, 'a1:x', 'gtin')).toBe(false)
    expect(chipHasCell(cells, 'a1:y', 'brand')).toBe(false)
  })
})


describe('count and classification regressions', () => {
  it('keeps a filled invalid value out of Missing required', () => {
    const r = row('a1:x', 'variant', [{ key: 'gtin', severity: 'error' }])
    r.completeness.required.missing = []
    const chips = buildChannelChips([r], COLS)
    expect(chips.find((c) => c.id === 'missing-required')!.count).toBe(0)
    expect(chips.find((c) => c.id === 'validation-errors')!.cells.byRow[r.rowId]).toEqual(['gtin'])
  })

  it('keeps an incomplete mapping run unknown instead of reporting zero errors', () => {
    for (const run of [null, { skippedReason: 'Resolver unavailable' }, { missingProductIds: ['x'] }]) {
      expect(buildChannelChips([row('a1:x', 'variant')], COLS, run).find((c) => c.id === 'mapping-errors')!.count).toBeNull()
    }
  })

  it('keeps every one of 63 affected cells reachable across three columns and 21 rows', () => {
    const bad = cell({ mapped: { value: null, status: 'mapped', provenance: null, appliedTransforms: [], warnings: [], errors: ['Required'], autoCorrected: null, requiredByRule: true, overLimit: null } })
    const rows = Array.from({ length: 21 }, (_, i) => row(`a1:${i}`, 'variant', [], Object.fromEntries(COLS.map((c) => [c.key, bad]))))
    const chip = buildChannelChips(rows, COLS).find((c) => c.id === 'mapping-errors')!
    expect(chip.count).toBe(63)
    expect(rowsForChip(rows, chip.cells)).toHaveLength(21)
    expect(new Set(Object.values(chip.cells.byRow).flat()).size).toBe(3)
    expect(Object.values(chip.cells.byRow).flat()).toHaveLength(63)
  })
})
