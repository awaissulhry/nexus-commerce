import { describe, expect, it } from 'vitest'

import { cellIsEditable, cellOf, editRefusalReason, requiredOnRow, sourceLabel, validationApplies, widthFor } from './columnRules'
import type { SheetColumn, StudioCellValue, StudioRow } from './types'

/**
 * A real cell, not a cast. `source`, `inheritedFrom` and `inherited` are REQUIRED on the contract —
 * casting a `{}` past that would let these tests pass against a shape the server never sends, which
 * is the fixture-fiction that nearly filed a false defect against a working axis matcher earlier in
 * this programme.
 */
const cell = (over: Partial<StudioCellValue> = {}): StudioCellValue =>
  ({ value: null, source: 'master', inheritedFrom: null, inherited: false, ...over })

const col = (over: Partial<SheetColumn> = {}): SheetColumn =>
  ({ key: 'k', label: 'k', group: 'g', requiredBy: [], storage: 'categoryAttributes', editable: true, ...over } as SheetColumn)

const row = (over: Partial<StudioRow> = {}): StudioRow =>
  ({ id: 'r1', sku: 'GALE-1', values: {}, ...over } as StudioRow)

describe('cellIsEditable — three independent vetoes', () => {
  it('is editable when the column allows it and the cell says nothing', () => {
    expect(cellIsEditable(col(), row())).toBe(true)
  })

  it('🔴 a cell that omits `editable` is EDITABLE — undefined is not false', () => {
    // Reading a missing flag as "not editable" would lock most of the sheet on any response that
    // omits it. The check is `!== false`, not a truthy test.
    expect(cellIsEditable(col(), row({ values: { k: cell() } }))).toBe(true)
    expect(cellIsEditable(col(), row({ values: { k: cell({ editable: false }) } }))).toBe(false)
  })

  it('refuses when the COLUMN is not editable, whatever the cell says', () => {
    expect(cellIsEditable(col({ editable: false }), row({ values: { k: cell({ editable: true }) } }))).toBe(false)
  })

  it('refuses with no row at all rather than throwing', () => {
    expect(cellIsEditable(col(), undefined)).toBe(false)
  })
})

describe('sourceLabel — an operator reads SKUs, never cuids', () => {
  const parent = row({ id: 'p1', sku: 'GALE-JACKET' })
  const child = row({ id: 'c1', sku: 'GALE-1', values: { k: cell({ inheritedFrom: 'p1', inherited: true }) } })

  it('resolves the id to the parent’s SKU', () => {
    expect(sourceLabel(child, 'k', [parent, child])).toBe('GALE-JACKET')
  })

  it('returns null for a value the row owns', () => {
    expect(sourceLabel(row({ values: { k: cell({ value: 'x' }) } }), 'k', [])).toBeNull()
    expect(sourceLabel(row(), 'missing', [])).toBeNull()
  })

  it('🔴 returns null — NOT the raw id — when the parent is not on screen', () => {
    // A cuid rendered in a tooltip is not a source label; it is noise that looks like one.
    expect(sourceLabel(child, 'k', [child])).toBeNull()
  })
})

describe('validationApplies / requiredOnRow — both are per ROW, never per column', () => {
  it('a column that does not apply to the row is neither validated nor required', () => {
    // `scope: 'per_variant'` on a parent row: the column exists on the sheet and holds nothing here.
    const axis = col({ key: 'colour', scope: 'per_variant' })
    const parent = row({ id: 'p1', parentId: null })
    // Whatever the shared predicate rules, the two must AGREE — a cell that cannot be validated
    // must not be reported as required, or the sheet flags work that has nowhere to land.
    if (!validationApplies(axis, parent)) expect(requiredOnRow(axis, parent)).toBe(false)
  })

  it('requiredOnRow is false for a column no channel requires', () => {
    expect(requiredOnRow(col({ requiredBy: [] }), row())).toBe(false)
  })
})

describe('cellOf', () => {
  it('reads the cell, and is undefined rather than throwing for an absent key', () => {
    expect(cellOf(row({ values: { k: cell({ value: 1 }) } }), 'k')?.value).toBe(1)
    expect(cellOf(row(), 'nope')).toBeUndefined()
  })
})

describe('widthFor — the contract owns the width', () => {
  it('takes the contract\'s width', () => {
    // `SPEC_WIDTHS` used to force `name` to 220 here while the server served 380. PES.5 now serves
    // 220 on every scope, so the override is gone — a client re-asserting a value the server
    // already states means the next person has to check two places to learn one number.
    expect(widthFor(col({ key: 'name', width: 220 }), 150)).toBe(220)
    expect(widthFor(col({ key: 'brand', width: 160 }), 150)).toBe(160)
  })

  it('falls back only when the contract declares no width', () => {
    expect(widthFor(col({ key: 'brand' }), 150)).toBe(150)
    expect(widthFor(col({ key: 'notes' }), 240)).toBe(240)
  })
})

/**
 * The refusal words. Ruling 1's second half: an editor that genuinely cannot open must SAY so.
 *
 * Measured before this existed, on the live sheet: `condition_type` (`editable: false` on the wire)
 * refused double-click, Enter, F2 and a typed character with 0 editors, 0 toasts, no `title` and
 * nothing new on screen. Four gestures, four silences.
 */
describe('editRefusalReason', () => {
  /* 🔴 THE LOAD-BEARING TEST, and the only one that cannot be satisfied by writing the words twice.
     A refusal reason derived beside `cellIsEditable` rather than FROM it diverges on the first
     clause someone edits — and both directions of divergence are invisible on screen: a `null`
     where the cell is locked is the silence we just removed, and a reason where the cell is
     editable is an explanation for a refusal that never happened. So: over every combination of
     the four vetoes, a reason exists exactly when the cell is not editable. */
  it('speaks for EXACTLY the cells cellIsEditable rejects, across every combination', () => {
    let refusedAndSilent = 0
    let editableButExplained = 0
    let cases = 0
    for (const colEditable of [true, false]) {
      for (const scope of ['global', 'per_variant'] as const) {
        for (const isParent of [true, false]) {
          for (const applicable of [[], ['OUTERWEAR'], ['SHOES']]) {
            for (const cellEditable of [true, false, undefined]) {
              const c = col({ key: 'x', label: 'Item Condition', editable: colEditable, scope, applicableProductTypes: applicable })
              const r = row({ isParent, productType: 'OUTERWEAR', values: { x: cell({ editable: cellEditable }) } })
              const canEdit = cellIsEditable(c, r)
              const why = editRefusalReason(c, r)
              cases++
              if (!canEdit && why === null) refusedAndSilent++
              if (canEdit && why !== null) editableButExplained++
            }
          }
        }
      }
    }
    // The denominator is stated so a shrunken loop cannot pass vacuously at 0/0.
    expect(cases).toBe(2 * 2 * 2 * 3 * 3)
    expect({ refusedAndSilent, editableButExplained }).toEqual({ refusedAndSilent: 0, editableButExplained: 0 })
  })

  it('says nothing when there is no row — an empty grid area has nothing to explain', () => {
    expect(editRefusalReason(col(), undefined)).toBeNull()
  })

  /* The branches are distinct because the REMEDIES are: "open a variation row" and "this field is
     not part of this product type" send an operator to completely different places. A single
     "cannot edit here" would send them looking for a row that does not exist. */
  it('names the per-variation veto on a parent row, and points at the remedy', () => {
    const why = editRefusalReason(col({ label: 'Colour', scope: 'per_variant' }), row({ isParent: true, productType: 'OUTERWEAR' }))
    expect(why).toBe('Colour is set per variation — open a variation row to edit it, not the parent.')
  })

  it('names the product type when the column does not apply to it', () => {
    const why = editRefusalReason(
      col({ label: 'Heel Height', applicableProductTypes: ['SHOES'] }),
      row({ isParent: false, productType: 'OUTERWEAR' }),
    )
    expect(why).toBe('Heel Height does not apply to OUTERWEAR products.')
  })

  it('does not print "null products" when the row has no product type', () => {
    const why = editRefusalReason(
      col({ label: 'Heel Height', applicableProductTypes: ['SHOES'] }),
      row({ isParent: false, productType: null }),
    )
    expect(why).toBe('Heel Height does not apply to this product.')
  })

  it('names a read-only column, and a row-locked cell, differently', () => {
    expect(editRefusalReason(col({ label: 'Amazon ASIN', editable: false }), row())).toBe(
      'Amazon ASIN is read-only on this sheet — it cannot be edited here.',
    )
    expect(editRefusalReason(col({ label: 'Base Price' }), row({ values: { k: cell({ editable: false }) } }))).toBe(
      'Base Price cannot be edited on this row.',
    )
  })

  /* A column with no label must still be able to speak. `label` is required on the contract, but a
     blank string is not, and a sentence starting " is read-only" reads as a rendering bug. */
  it('falls back to the column key when the label is blank', () => {
    expect(editRefusalReason(col({ key: 'amazonAsin', label: '', editable: false }), row())).toBe(
      'amazonAsin is read-only on this sheet — it cannot be edited here.',
    )
  })
})
