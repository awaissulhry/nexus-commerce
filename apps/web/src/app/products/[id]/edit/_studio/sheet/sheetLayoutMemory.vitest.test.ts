import { beforeEach, describe, expect, it } from 'vitest'
import { columnsViewPayload, sheetLayoutPayload } from '@/design-system/grid/views/viewPayload'
import {
  chooseLanding, emptyLayout, fieldPayload, forgetSessionPicks, hasMyLayout, isSheetPick, languageKeyMap, layoutPart, pickOf,
  progressShown, recalledPick, rememberPick, TEXT_FIELDS_GROUP, withPick,
} from './sheetLayoutMemory'

import type { KeyedColumn } from './sheetLayoutMemory'

const col = (key: string, extra: Partial<KeyedColumn> = {}): KeyedColumn => ({ key, group: 'Identity', groupKey: 'identity', ...extra })

describe('views work on FIELDS; the Languages menu owns the language columns (rule 1)', () => {
  const split = [
    col('progress:scope', { group: 'Progress', groupKey: 'progress' }),
    col('name@it', { locale: 'it', group: 'Name', groupKey: 'language:name', sourceGroup: 'Content', sourceGroupKey: 'content' }),
    col('name@de', { locale: 'de', group: 'Name', groupKey: 'language:name', sourceGroup: 'Content', sourceGroupKey: 'content' }),
    col('brand'),
    col('bullet@it', { locale: 'it', group: 'Bullet', groupKey: 'language:bullet' }),
    col('bullet@de', { locale: 'de', group: 'Bullet', groupKey: 'language:bullet' }),
  ]

  it('lists every field once, in its own group, and maps it back to one column per language', () => {
    const map = languageKeyMap(split)
    expect(map.fields.map((c) => [c.key, c.group, c.groupKey])).toEqual([
      ['progress:scope', 'Progress', 'progress'],
      ['name', 'Content', 'content'],
      ['brand', 'Identity', 'identity'],
      // An older API sends no source group: the field still gets ONE honest home.
      ['bullet', TEXT_FIELDS_GROUP, 'text-fields'],
    ])
    expect(map.fields.every((c) => c.locale === undefined)).toBe(true)
    expect(map.toGrid(['brand', 'name', 'unknown'])).toEqual(['brand', 'name@it', 'name@de'])
    expect(map.toFields(['name@de', 'name@it', 'brand'])).toEqual(['name', 'brand'])
    expect(map.split).toBe(true)
  })

  it('is the identity on a one-language sheet', () => {
    const map = languageKeyMap([col('name'), col('brand')])
    expect(map.toGrid(['name', 'brand'])).toEqual(['name', 'brand'])
    expect(map.toFields(['name'])).toEqual(['name'])
    expect(map.split).toBe(false)
    // A stored language key still finds its field on a one-language sheet.
    expect(map.toGrid(['name@de'])).toEqual(['name'])
  })

  it('reads a layout stored in Languages mode as plain fields — the snap-back root cause (B1)', () => {
    const stored = sheetLayoutPayload({
      columns: ['name@it', 'name@de', 'brand'], columnOrder: ['name@it', 'name@de', 'brand', 'color'], lockedColumns: ['name@it'],
      groupOrder: ['language:name', 'identity'], groupOverrides: { 'name@de': 'language:name', brand: 'identity' },
    })
    const plain = fieldPayload(stored)
    expect(plain.columns).toEqual(['name', 'brand'])
    expect(plain.v === 3 && [plain.columnOrder, plain.lockedColumns, plain.groupOrder, plain.groupOverrides]).toEqual([
      ['name', 'brand', 'color'], ['name'], ['identity'], { brand: 'identity' },
    ])
    const v2 = columnsViewPayload(['name@nl', 'name@fr'])
    expect(fieldPayload(v2).columns).toEqual(['name'])
    const clean = columnsViewPayload(['name'])
    expect(fieldPayload(clean)).toBe(clean)
  })
})

describe('the view picked last opens again (rule 2, D2 = A)', () => {
  beforeEach(() => forgetSessionPicks())
  const base = { presetIds: ['all', 'required', 'gaps'], savedIds: ['mine', 'jackets'], myLayout: true, typeDefaultId: 'jackets', defaultId: 'mine' }

  it('opens the pick, over a product-type default', () => {
    expect(chooseLanding({ ...base, pick: { kind: 'all' } })).toEqual({ kind: 'all' })
    expect(chooseLanding({ ...base, pick: { kind: 'preset', id: 'required' } })).toEqual({ kind: 'preset', id: 'required' })
    expect(chooseLanding({ ...base, pick: { kind: 'saved', id: 'mine' } })).toEqual({ kind: 'saved', id: 'mine', why: 'pick' })
    expect(chooseLanding({ ...base, pick: { kind: 'custom' } })).toEqual({ kind: 'custom' })
  })

  it('falls through a pick that no longer resolves, then type default, My layout, my default, all', () => {
    expect(chooseLanding({ ...base, pick: { kind: 'saved', id: 'deleted' } })).toEqual({ kind: 'saved', id: 'jackets', why: 'type-default' })
    expect(chooseLanding({ ...base, pick: { kind: 'preset', id: 'gone' }, typeDefaultId: null })).toEqual({ kind: 'saved', id: 'mine', why: 'default' })
    expect(chooseLanding({ ...base, pick: null, typeDefaultId: null })).toEqual({ kind: 'custom' })
    expect(chooseLanding({ ...base, pick: { kind: 'custom' }, myLayout: false, typeDefaultId: null, defaultId: null })).toEqual({ kind: 'all' })
  })

  it('keeps My layout when a pick is written, and upgrades a columns-only layout', () => {
    const mine = sheetLayoutPayload({ columns: ['brand'], columnOrder: ['brand', 'color'], lockedColumns: [], groupOrder: [], groupOverrides: {}, chip: 'warnings' })
    const written = withPick(mine, { kind: 'preset', id: 'required' })
    expect(written.columns).toEqual(['brand'])
    expect('chip' in written).toBe(false)
    expect(pickOf(written)).toEqual({ kind: 'preset', id: 'required' })
    expect(layoutPart(written)).toEqual(expect.not.objectContaining({ picked: expect.anything() }))
    expect(withPick(columnsViewPayload(['a', 'b']), { kind: 'custom' })).toMatchObject({ v: 3, columns: ['a', 'b'], columnOrder: ['a', 'b'] })
    const fresh = withPick(null, { kind: 'all' })
    expect(hasMyLayout(layoutPart(fresh))).toBe(false)
    expect(hasMyLayout(emptyLayout())).toBe(false)
  })

  it('checks a stored pick rather than trusting it', () => {
    expect(isSheetPick({ kind: 'saved', id: 'v1' })).toBe(true)
    expect(isSheetPick({ kind: 'saved' })).toBe(false)
    expect(isSheetPick({ kind: 'languages' })).toBe(false)
    expect(pickOf({ picked: 'all' })).toBeNull()
  })

  it('remembers a pick in this tab before the server answers — a language switch must not lose it', () => {
    expect(recalledPick('product-edit:layout:master')).toBeNull()
    rememberPick('product-edit:layout:master', { kind: 'preset', id: 'required' })
    expect(recalledPick('product-edit:layout:master')).toEqual({ kind: 'preset', id: 'required' })
    expect(recalledPick('product-edit:layout:AMAZON')).toBeNull()
  })
})

describe('progress columns show unless hidden on purpose (rule 3)', () => {
  const progress = ['progress:scope', 'progress:AMAZON:IT']
  it('shows every one on a preset, a v2 view and a layout that never mentions them', () => {
    expect(progressShown(null, progress)).toEqual(progress)
    expect(progressShown(columnsViewPayload(['brand']), progress)).toEqual(progress)
    expect(progressShown(sheetLayoutPayload({ columns: ['brand'], columnOrder: ['brand'], lockedColumns: [], groupOrder: [], groupOverrides: {} }), progress)).toEqual(progress)
  })
  it('hides one a layout lists in its order but not in its columns', () => {
    const layout = sheetLayoutPayload({ columns: ['brand', 'progress:scope'], columnOrder: ['progress:scope', 'progress:AMAZON:IT', 'brand'], lockedColumns: [], groupOrder: [], groupOverrides: {} })
    expect(progressShown(layout, [...progress, 'progress:EBAY:IT'])).toEqual(['progress:scope', 'progress:EBAY:IT'])
  })
})
