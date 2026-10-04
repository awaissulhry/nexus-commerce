import { describe, expect, it } from 'vitest'

import { classifyProvenance } from '@/design-system/grid/renderers/provenance'
import { cellIsEditable, cellOf, editRefusalReason, markSourceLabel, requiredOnRow, sharedMember, sourceLabel, validationApplies, widthFor } from './columnRules'
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

/** 2026-10-04 (channel cell marks) — the mark's source on the Shared scope: the same rule as the channel scopes. */
describe('markSourceLabel — a source only where it names where the value comes from, never the row itself', () => {
  const parent = row({ id: 'p1', sku: 'GALE-JACKET' })
  const child = row({ id: 'c1', sku: 'GALE-1', values: { k: cell({ value: 'x', inheritedFrom: 'p1', inherited: true }) } })

  it('names the parent a value is inherited from', () => {
    expect(markSourceLabel('inherited', child, 'k', [parent, child])).toBe('GALE-JACKET')
  })
  it('names nothing for a formula, an out-of-date translation or an AI draft — they name no source', () => {
    for (const member of ['formula', 'outdated', 'ai', 'aiStale', 'refused', 'own'] as const) expect(markSourceLabel(member, child, 'k', [parent, child])).toBeNull()
  })
  it('🔴 never names the row it is on ("Calculated by a formula — GALE-JACKET" on the parent)', () => {
    const own = row({ id: 'p1', sku: 'GALE-JACKET', values: { k: cell({ value: 'x', inheritedFrom: 'p1' }) } })
    expect(markSourceLabel('inherited', own, 'k', [own])).toBeNull()
    expect(markSourceLabel('formula', own, 'k', [own])).toBeNull()
  })
  it('names a language fallback by the language it shows, never its code', () => {
    const fallback = row({ id: 'p1', sku: 'GALE-JACKET', values: { k: cell({ value: 'Giacca', inheritedFrom: 'p1', language: 'it', requested: 'de' } as Partial<StudioCellValue>) } })
    expect(markSourceLabel('inherited', fallback, 'k', [fallback])).toBe('the Italian text')
  })
  /* 2026-10-04 (fix C) — a pin names the layer it NO LONGER follows, as on the channel scopes. A variation's own value
     arrives as `pinned` with `inheritedFrom` = the variation itself, so the pin named nothing and the mark said a bare
     "Pinned". */
  it('names the parent a variation’s pin no longer follows — from the wire’s `parentSku`, else the parent row on screen', () => {
    const own = cell({ value: 'Rosso', source: 'variant', inheritedFrom: 'c1', layer: 'variant', pinned: true } as Partial<StudioCellValue>)
    expect(markSourceLabel('pinned', row({ id: 'c1', sku: 'GALE-1', parentId: 'p1', parentSku: 'GALE-JACKET', values: { k: own } }), 'k', [])).toBe('GALE-JACKET')
    expect(markSourceLabel('pinned', row({ id: 'c1', sku: 'GALE-1', parentId: 'p1', values: { k: own } }), 'k', [parent])).toBe('GALE-JACKET')
  })
  it('names nothing for a pin with nothing above it on this scope (a parent row), and never the row’s own SKU', () => {
    const own = cell({ value: 'x', inheritedFrom: 'p1', pinned: true } as Partial<StudioCellValue>)
    expect(markSourceLabel('pinned', row({ id: 'p1', sku: 'GALE-JACKET', parentId: null, values: { k: own } }), 'k', [parent])).toBeNull()
    expect(markSourceLabel('pinned', row({ id: 'c1', sku: 'GALE-JACKET', parentSku: 'GALE-JACKET', values: { k: own } }), 'k', [])).toBeNull()
    // The parent is not on screen and the wire named none: nothing, never the raw id.
    expect(markSourceLabel('pinned', row({ id: 'c1', sku: 'GALE-1', parentId: 'p1', values: { k: own } }), 'k', [])).toBeNull()
  })
})

describe('sharedMember — a row never inherits from itself; a variation that follows its parent keeps its mark', () => {
  /**
   * The content resolver's answer for a field nobody filled (`content-resolver.ts`, last line) as the wire carries it
   * (`content-read.ts`): `inherited`, no owner — so `inheritedFrom` is the row ITSELF, on a parent and on a variation alike.
   */
  const nothingAnywhere = (rowId: string, over: Partial<StudioCellValue> = {}) => cell({ value: null, source: 'default' as never, inheritedFrom: rowId,
    inherited: true, tier: 'computed', language: 'it', requested: 'it', provenance: { member: 'inherited', from: null }, ...over } as Partial<StudioCellValue>)
  const member = (r: StudioRow) => sharedMember(classifyProvenance(r.values.k, 'master'), r, r.values.k)
  const parent = row({ id: 'p1', sku: 'GALE-JACKET', parentId: null })

  it('🔴 the parent row: an empty field "inherited" from itself wears no mark (61 on GALE-JACKET in Italian)', () => {
    const p = row({ ...parent, values: { k: nothingAnywhere('p1') } })
    expect(classifyProvenance(p.values.k, 'master')).toBe('inherited')
    expect(member(p)).toBe('own')
    expect(member(row({ ...parent, values: { k: nothingAnywhere('p1', { value: [] }) } }))).toBe('own')
  })
  it('a variation whose parent holds nothing either keeps the muted 🔗 "follows an empty parent" (2026-09-26), named by its parent', () => {
    // The same wire on a variation (`inheritedFrom` = the variation itself): it follows its parent, which is empty.
    const child = row({ id: 'c1', sku: 'GALE-1', parentId: 'p1', values: { k: nothingAnywhere('c1') } })
    expect(member(child)).toBe('inherited')
    expect(markSourceLabel('inherited', child, 'k', [parent, child])).toBe('GALE-JACKET')
    // A slot the parent's list does not reach: the source is the parent, the value empty — kept as on base.
    const slot = row({ id: 'c1', sku: 'GALE-1', parentId: 'p1', values: { k: cell({ value: null, inheritedFrom: 'p1', inherited: true }) } })
    expect(member(slot)).toBe('inherited')
  })
  it('a variation that follows its parent’s value keeps its mark', () => {
    const child = row({ id: 'c1', sku: 'GALE-1', parentId: 'p1', values: { k: cell({ value: 'Giacca', inheritedFrom: 'p1', inherited: true }) } })
    expect(member(child)).toBe('inherited')
  })
  it('a language fallback on the parent row keeps its mark — it follows the Italian text, filled or not', () => {
    expect(member(row({ ...parent, values: { k: nothingAnywhere('p1', { requested: 'de' } as Partial<StudioCellValue>) } }))).toBe('inherited')
    expect(member(row({ ...parent, values: { k: nothingAnywhere('p1', { value: 'Giacca', requested: 'de', tier: 'source' } as Partial<StudioCellValue>) } }))).toBe('inherited')
  })
  it('changes no other member', () => {
    for (const m of ['pinned', 'refused', 'formula', 'ai', 'outdated', 'inheritedOverride', 'own'] as const)
      expect(sharedMember(m, parent, nothingAnywhere('p1'))).toBe(m)
    expect(sharedMember('inherited', parent, undefined)).toBe('inherited')
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

describe('P1 — the family row and per-variant columns (report 2 I-11)', () => {
  const pv = (over: Record<string, unknown>) => ({ key: 'neckline', label: 'Neckline', group: 'g', requiredBy: [], editable: true, scope: 'per_variant', storage: 'categoryAttributes', axis: false, ...over }) as never
  const parent = { id: 'p', sku: 'REGAL', isParent: true, parentId: null, productType: 'OUTERWEAR', values: { neckline: { value: null, editable: true }, color: { value: null, editable: true } } } as never
  it('the family row edits a value its variations inherit; it is optional there, never required', async () => {
    const { cellIsEditable, editRefusalReason, holdsFamilyValue, requiredOnRow } = await import('./columnRules')
    expect(cellIsEditable(pv({}), parent)).toBe(true)
    expect(editRefusalReason(pv({}), parent)).toBeNull()
    expect(holdsFamilyValue(pv({}), parent)).toBe(true)
    expect(requiredOnRow(pv({ requiredBy: ['Master'] }), parent)).toBe(false)
  })
  it('an axis stays locked and says it is an axis; another per-variant column keeps the per-variation sentence', async () => {
    const { cellIsEditable, editRefusalReason } = await import('./columnRules')
    expect(cellIsEditable(pv({ key: 'color', label: 'Colour', axis: true }), parent)).toBe(false)
    expect(editRefusalReason(pv({ key: 'color', label: 'Colour', axis: true }), parent)).toBe('Colour is a variation axis — each variation has its own value, so the parent has none. Open a variation row to edit it.')
    expect(editRefusalReason(pv({ key: 'ean', label: 'EAN', storage: 'column' }), parent)).toBe('EAN is set per variation — open a variation row to edit it, not the parent.')
  })
})
