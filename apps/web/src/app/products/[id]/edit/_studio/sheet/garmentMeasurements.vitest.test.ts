/**
 * Garment measurements (2026-10-14) — the editor's model: flat columns typed as half widths and stored doubled, a stored
 * table opening halved again, spreadsheet paste (with and without a header row, decimal commas), the product's sizes as
 * the first rows, and the cell's own parse. Node only (no DOM): logic, not rendering.
 */
import { describe, expect, it } from 'vitest'
import type { VariationFamilyView } from '@/design-system/grid'
import {
  addMeasure, addRow, checkDraft, deleteMeasure, deleteRow, draftFromValue, familySizeNames, measureFromHeader, parseGarmentCell,
  pasteIntoDraft, pastedBlock, sameTable, setCell, setFlat, setName, setRoom, type GarmentDraft,
} from './garmentMeasurements'

const STORED = {
  measures: ['chest', 'waist', 'sleeve'],
  sizes: [{ name: 'M', chest: 106, waist: 94, sleeve: 62.5 }, { name: 'L', chest: 112.2, waist: 100, sleeve: 64 }],
  flat: ['chest'],
  room: { chest: [6, 16] },
}
const view = (draft: GarmentDraft) => draft.rows.map((r) => [r.name, ...draft.measures.map((m) => r.cells[m] ?? '')])

describe('a stored table and the draft', () => {
  it('opens a stored table with its flat columns halved, and saves it back exactly', () => {
    const draft = draftFromValue(STORED)
    expect(draft.measures).toEqual(['chest', 'waist', 'sleeve'])
    expect(view(draft)).toEqual([['M', '53', '94', '62.5'], ['L', '56.1', '100', '64']])
    expect(draft.room).toEqual({ chest: { least: '6', most: '16' } })
    expect(checkDraft(draft)).toEqual({ value: STORED, problems: [] })
  })

  it('a typed flat value is saved doubled; switching flat off saves it as typed', () => {
    let draft = addMeasure(draftFromValue(null, ['M']), 'chest')
    draft = setCell(draft, draft.rows[0].key, 'chest', '52,5')
    draft = setFlat(draft, 'chest', true)
    expect(checkDraft(draft).value).toEqual({ measures: ['chest'], sizes: [{ name: 'M', chest: 105 }], flat: ['chest'] })
    expect(checkDraft(setFlat(draft, 'chest', false)).value).toEqual({ measures: ['chest'], sizes: [{ name: 'M', chest: 52.5 }] })
    // A length is never flat.
    expect(setFlat(addMeasure(draft, 'sleeve'), 'sleeve', true).flat).toEqual(['chest'])
  })

  it('an empty table starts from the product sizes, else one empty row; with no values it saves as a clear', () => {
    expect(view(draftFromValue(null, ['S', 'M', 'L']))).toEqual([['S'], ['M'], ['L']])
    expect(view(draftFromValue(null))).toEqual([['']])
    expect(view(draftFromValue('not a table'))).toEqual([['']])
    expect(checkDraft(addMeasure(draftFromValue(null, ['S', 'M']), 'chest'))).toEqual({ value: null, problems: [] })
  })

  it('edits: add and delete a measure (its flat and room go with it), add and delete a size, rename, room', () => {
    let draft = draftFromValue(STORED)
    draft = deleteMeasure(draft, 'chest')
    expect(draft.flat).toEqual([])
    expect(draft.room).toEqual({})
    expect(checkDraft(draft).value).toEqual({ measures: ['waist', 'sleeve'], sizes: [{ name: 'M', waist: 94, sleeve: 62.5 }, { name: 'L', waist: 100, sleeve: 64 }] })
    draft = addRow(draft)
    expect(draft.rows).toHaveLength(3)
    expect(checkDraft(draft).problems).toEqual([]) // an empty row is dropped, never a problem
    draft = setName(draft, draft.rows[2].key, 'XL')
    draft = setCell(draft, draft.rows[2].key, 'waist', 'wide')
    expect(checkDraft(draft).problems).toEqual(['Size XL, Waist: "wide" is not a number.'])
    draft = deleteRow(draft, draft.rows[2].key)
    draft = setRoom(draft, 'waist', 'least', '2')
    expect(checkDraft(draft).problems).toEqual(['Waist: give both the least and the most room, or neither.'])
    draft = setRoom(draft, 'waist', 'most', '8,5')
    expect(checkDraft(draft).value?.room).toEqual({ waist: [2, 8.5] })
    // Deleting the last row leaves one empty row to type into.
    expect(view(deleteRow(draftFromValue(null), draftFromValue(null).rows[0].key))).toEqual([['']])
  })

  it('sameTable compares as stored: key order and a decimal comma do not count', () => {
    expect(sameTable({ sizes: [{ chest: 100, name: 'M' }], measures: ['chest'] }, { measures: ['chest'], sizes: [{ name: 'M', chest: '100,0' }] })).toBe(true)
    expect(sameTable(null, { measures: ['chest'], sizes: [{ name: 'M' }] })).toBe(true)
    expect(sameTable(STORED, null)).toBe(false)
  })
})

describe('paste from a spreadsheet', () => {
  it('one value is not a block: the field takes it as typed', () => {
    expect(pastedBlock('106')).toBeNull()
    expect(pasteIntoDraft(draftFromValue(null), { row: 0, column: -1 }, '106')).toBeNull()
    expect(pastedBlock('M\t106\r\nL\t112\r\n')).toEqual([['M', '106'], ['L', '112']])
  })

  it('a block with a header row places each column under its measure, adding the missing ones', () => {
    const draft = draftFromValue(null, ['S'])
    const text = 'Taglia\tChest (cm)\tVita\tSleeve length\nM\t106\t94\t62,5\nL\t112\t100\t64\n'
    const { draft: next, note } = pasteIntoDraft(draft, { row: 0, column: -1 }, text)!
    expect(note).toBeNull()
    expect(next.measures).toEqual(['chest', 'waist', 'sleeve'])
    expect(view(next)).toEqual([['M', '106', '94', '62,5'], ['L', '112', '100', '64']])
    expect(checkDraft(next).value?.sizes).toEqual([{ name: 'M', chest: 106, waist: 94, sleeve: 62.5 }, { name: 'L', chest: 112, waist: 100, sleeve: 64 }])
  })

  it('a block with no header fills from the cell it lands on, adds rows, and says what had no column', () => {
    let draft = addMeasure(addMeasure(draftFromValue(null, ['S', 'M']), 'chest'), 'waist')
    // Into the Chest cell of row 2: chest, waist, then one value with no column.
    const { draft: next, note } = pasteIntoDraft(draft, { row: 1, column: 0 }, '106\t94\t7\n112\t100')!
    expect(view(next)).toEqual([['S', '', ''], ['M', '106', '94'], ['', '112', '100']])
    expect(note).toBe('1 pasted value has no measure column; add the measure first, or paste a first row of measure names.')
    // Into the size-name column: the first column is the names.
    draft = pasteIntoDraft(draft, { row: 0, column: -1 }, 'XS\t98\nS\t102')!.draft
    expect(view(draft)).toEqual([['XS', '98', ''], ['S', '102', '']])
  })

  it('rows past the 30th are left out, and said', () => {
    const lines = Array.from({ length: 32 }, (_, i) => `S${i + 1}\t${80 + i}`).join('\n')
    const { draft, note } = pasteIntoDraft(addMeasure(draftFromValue(null), 'chest'), { row: 0, column: -1 }, lines)!
    expect(draft.rows).toHaveLength(30)
    expect(note).toContain('2 pasted rows were left out')
  })

  it('header words: names, keys and the usual spellings; anything else is not a measure', () => {
    expect(measureFromHeader('Inside leg')).toBe('inseam')
    expect(measureFromHeader('INSEAM cm')).toBe('inseam')
    expect(measureFromHeader('Circonferenza petto')).toBe('chest')
    expect(measureFromHeader('Hip')).toBe('hips')
    expect(measureFromHeader('Shoulder')).toBeNull()
    expect(measureFromHeader('')).toBeNull()
  })
})

describe('the product sizes and the sheet cell', () => {
  it('the size axis of the family, in its order, once each', () => {
    const family = (code: string, label: string, values: string[]): VariationFamilyView => ({
      axes: [
        { code: 'color', label: 'Colore', dictionary: true, values: [{ key: 'color:black', option: 'black', label: 'Nero', count: 1, photo: null }] },
        { code, label, dictionary: true, values: values.map((v) => ({ key: `${code}:${v}`, option: v, label: v, count: 1, photo: null })) },
      ],
      variants: [],
    })
    expect(familySizeNames(family('taglia', 'Taglia', ['S', 'M', 'm', 'L']))).toEqual(['S', 'M', 'L'])
    expect(familySizeNames(family('apparel_size', 'Size', ['48', '50']))).toEqual(['48', '50'])
    expect(familySizeNames(family('fit', 'Fit', ['Slim']))).toEqual([])
    expect(familySizeNames(null)).toEqual([])
  })

  it('free-text sizes (no option code: no saved order, A–Z by SKU) come in garment size order; ordered ones keep theirs', () => {
    const family = (values: Array<[label: string, option: string | null]>): VariationFamilyView => ({
      axes: [{ code: 'taglia', label: 'Taglia', dictionary: values.some(([, o]) => o), values: values.map(([label, option]) => ({ key: option ? `taglia:${option}` : `taglia:text:${label.toLowerCase()}`, option, label, count: 2, photo: null })) }],
      variants: [],
    })
    // The GALE jacket family: a free-text axis, first seen in SKU order.
    expect(familySizeNames(family(['3XL', '4XL', '5XL', 'L', 'M', 'S', 'XL', 'XS', 'XXL', 'XXS'].map((s) => [s, null]))))
      .toEqual(['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL'])
    expect(familySizeNames(family([['52', null], ['Taglia unica', null], ['46', null]]))).toEqual(['46', '52', 'Taglia unica'])
    // A saved (or dictionary) order is the family's own, even when it is not the garment scale; free-text values follow it.
    expect(familySizeNames(family([['L', 'l'], ['S', 's'], ['M', 'm'], ['XXL', null], ['XS', null]]))).toEqual(['L', 'S', 'M', 'XS', 'XXL'])
  })

  it('a table pasted into the cell as JSON is read; other text keeps the cell', () => {
    const previous = { measures: ['chest'], sizes: [{ name: 'M', chest: 100 }] }
    expect(parseGarmentCell(JSON.stringify(STORED), previous)).toEqual(STORED)
    expect(parseGarmentCell('6 sizes · chest', previous)).toBe(previous)
    expect(parseGarmentCell('{"measures":["x"]}', previous)).toBe(previous)
    expect(parseGarmentCell('', previous)).toBeNull()
    expect(parseGarmentCell(STORED, previous)).toBe(STORED)
  })
})
