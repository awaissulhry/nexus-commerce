/**
 * AM.1 — the one value derivation (store → cell) and its inverse (cell → store), per shape.
 * Every expected value is written from the RULE, never from the function under test.
 */
import { describe, it, expect } from 'vitest'
import { coerceForShape, projectCellValue, readListValue, readMeasureValue, withSlotValue, parseSlotField, isBlankValue } from './sheet-values.js'

describe('store → cell', () => {
  it('a slot reads item n-1 of its list, in any stored shape', () => {
    const slot = { shape: 'scalar' as const, slot: { of: 'bulletPoints', index: 2, max: 10, label: 'Bullet points' } }
    expect(projectCellValue(slot, ['a', 'b', 'c'])).toBe('b')
    expect(projectCellValue(slot, '["a","b"]')).toBe('b')
    expect(projectCellValue(slot, 'only')).toBeNull()
    expect(projectCellValue({ ...slot, slot: { ...slot.slot, index: 1 } }, 'only')).toBe('only')
    expect(projectCellValue(slot, ['a', '', 'c'])).toBeNull()
  })
  it('a list column shows the non-blank items; a measure shows { value, unit }', () => {
    expect(projectCellValue({ shape: 'list' }, ['a', '', 'c'])).toEqual(['a', 'c'])
    expect(projectCellValue({ shape: 'list' }, [])).toEqual([])
    expect(projectCellValue({ shape: 'measure' }, { value: '1.2', unit: 'kilograms' })).toEqual({ value: 1.2, unit: 'kilograms' })
    expect(projectCellValue({ shape: 'measure' }, 3)).toEqual({ value: 3, unit: null })
    expect(readMeasureValue({})).toBeNull()
    expect(readListValue('[not json')).toEqual(['[not json'])
  })
  it('blankness is by shape', () => {
    expect(isBlankValue(['', null])).toBe(true)
    expect(isBlankValue({ value: null, unit: 'kg' })).toBe(true)
    expect(isBlankValue({ value: 0, unit: null })).toBe(false)
  })
})

describe('cell → store: slots', () => {
  it('sets one position and keeps the others, trimming trailing empties only', () => {
    expect(withSlotValue(['a', 'b'], 4, 'd')).toEqual(['a', 'b', '', 'd'])
    expect(withSlotValue(['a', 'b', 'c'], 3, null)).toEqual(['a', 'b'])
    expect(withSlotValue(['a', 'b', 'c'], 1, null)).toEqual(['', 'b', 'c'])
    expect(withSlotValue(null, 2, 'x')).toEqual(['', 'x'])
  })
  it('parses `field[n]` and refuses nonsense', () => {
    expect(parseSlotField('bulletPoints[3]')).toEqual({ base: 'bulletPoints', index: 3 })
    expect(parseSlotField('amazon_bulletPoints[10]')).toEqual({ base: 'amazon_bulletPoints', index: 10 })
    expect(parseSlotField('bulletPoints')).toBeNull()
    expect(parseSlotField('bulletPoints[0]')).toBeNull()
  })
})

describe('cell → store: coerceForShape refuses instead of coercing', () => {
  const list = { key: 'recommended_browse_nodes', label: 'Browse nodes', shape: 'list' as const, cardinality: { min: 1, max: 3 } }
  const strictList = { ...list, mode: 'strict' as const, options: ['a', 'b'] }
  const measure = { key: 'item_weight', label: 'Item weight', shape: 'measure' as const, unitOptions: ['kilograms', 'grams'] }
  const scalar = { key: 'color', label: 'Color', shape: 'scalar' as const }

  it('clear is accepted for every shape', () => {
    for (const f of [list, measure, scalar]) {
      expect(coerceForShape(f, null)).toEqual({ ok: true, value: null })
      expect(coerceForShape(f, '')).toEqual({ ok: true, value: null })
    }
  })
  it('list: an array is trimmed and cleaned; the legacy JSON string is accepted; one value is refused', () => {
    expect(coerceForShape(list, [' a ', '', 'b'])).toEqual({ ok: true, value: ['a', 'b'] })
    expect(coerceForShape(list, '["a","b"]')).toEqual({ ok: true, value: ['a', 'b'] })
    expect(coerceForShape(list, 'a')).toMatchObject({ ok: false })
    expect((coerceForShape(list, 'a') as { error: string }).error).toContain('LIST')
    expect(coerceForShape(list, ['a', 'b', 'c', 'd'])).toMatchObject({ ok: false, error: '4 values — Browse nodes takes at most 3' })
    expect(coerceForShape(strictList, ['a', 'zzz'])).toMatchObject({ ok: false })
    expect(coerceForShape(strictList, ['a', 'b'])).toEqual({ ok: true, value: ['a', 'b'] })
    expect(coerceForShape(list, [])).toMatchObject({ ok: false, error: '0 values — Browse nodes needs at least 1' })
    expect(coerceForShape({ ...list, cardinality: { min: 0, max: 3 } }, [])).toEqual({ ok: true, value: [] })
  })
  it('measure: { value, unit } with a known unit; a bare number, a bad unit or a missing unit is refused', () => {
    expect(coerceForShape(measure, { value: '1,2', unit: 'kilograms' })).toEqual({ ok: true, value: { value: 1.2, unit: 'kilograms' } })
    expect(coerceForShape(measure, { value: null, unit: null })).toEqual({ ok: true, value: null })
    expect(coerceForShape(measure, 1.2)).toMatchObject({ ok: false })
    expect(coerceForShape(measure, { value: 1.2, unit: 'stones' })).toMatchObject({ ok: false })
    expect(coerceForShape(measure, { value: 1.2 })).toMatchObject({ ok: false, error: 'Item weight needs a unit (kilograms, grams)' })
    expect(coerceForShape(measure, { value: 'heavy', unit: 'grams' })).toMatchObject({ ok: false })
    expect(coerceForShape(measure, ['1', 'kg'])).toMatchObject({ ok: false })
  })
  it('scalar: a list or an object is refused, never joined or stringified', () => {
    expect(coerceForShape(scalar, ['a', 'b'])).toMatchObject({ ok: false })
    expect(coerceForShape(scalar, { value: 1 })).toMatchObject({ ok: false })
    expect(coerceForShape(scalar, ' Rosso ')).toEqual({ ok: true, value: 'Rosso' })
    expect(coerceForShape(undefined, 5)).toEqual({ ok: true, value: 5 })
    expect(coerceForShape({ ...scalar, mode: 'strict', options: ['Rosso'] }, 'Blu')).toMatchObject({ ok: false })
  })
})
