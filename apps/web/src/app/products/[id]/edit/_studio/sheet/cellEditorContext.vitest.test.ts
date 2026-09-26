import { describe, expect, it, vi } from 'vitest'

vi.mock('../drawer/useFieldHistory', () => ({ fetchFieldHistory: vi.fn() }))

import { aiDraftContextOf, editorText, historyEntriesOf, historyLoaderFor, inheritedContextOf } from './cellEditorContext'
import type { FieldHistoryEntry } from '../drawer/types'

const entry = (at: string, previous: unknown, extra: Partial<FieldHistoryEntry> = {}): FieldHistoryEntry =>
  ({ at, by: 'Awais', layer: 'master', fieldKey: 'name', previous, previousRecorded: true, next: 'x', source: 'studio', ...extra })

describe('editorText — only what one line can show and write back', () => {
  it('keeps text, numbers and yes/no; drops lists, records and empties that are not text', () => {
    expect(editorText('Xavia')).toBe('Xavia')
    expect(editorText(12.5)).toBe('12.5')
    expect(editorText(true)).toBe('true')
    expect(editorText(['a'])).toBeNull()
    expect(editorText({ value: 1 })).toBeNull()
    expect(editorText(null)).toBeNull()
    expect(editorText(Number.NaN)).toBeNull()
  })
})

describe('historyEntriesOf — earlier values', () => {
  it('lists recorded previous values newest first, once each, never the current one', () => {
    const out = historyEntriesOf([
      entry('2026-09-20T10:00:00Z', 'Old A'),
      entry('2026-09-24T10:00:00Z', 'Old B'),
      entry('2026-09-22T10:00:00Z', 'Old A'),
      entry('2026-09-25T10:00:00Z', 'Now'),
    ], 'Now')
    expect(out.map(h => h.value)).toEqual(['Old B', 'Old A'])
    expect(out[0]).toEqual({ value: 'Old B', when: '24 Sept', who: 'Awais' })
  })
  it('skips a change whose previous value was never recorded — "not recorded" is not "empty"', () => {
    // A value that is there but flagged NOT recorded is a placeholder, not history.
    expect(historyEntriesOf([entry('2026-09-24T10:00:00Z', 'Ghost', { previousRecorded: false }), entry('2026-09-23T10:00:00Z', '')], 'x').map(h => h.value)).toEqual([''])
  })
  it('stops at the limit', () => {
    const many = Array.from({ length: 12 }, (_, i) => entry(`2026-09-${String(10 + i).padStart(2, '0')}T10:00:00Z`, `v${i}`))
    expect(historyEntriesOf(many, null, 3)).toHaveLength(3)
  })
})

describe('inheritedContextOf — the row a cell follows', () => {
  it('names the source, or "the parent" when the row does not say', () => {
    expect(inheritedContextOf({ inherited: true, inheritedFrom: 'AIREON', value: 'Nero' })).toEqual({ from: 'AIREON', value: 'Nero' })
    expect(inheritedContextOf({ inherited: true, inheritedFrom: null, value: 'Nero' })).toEqual({ from: 'the parent', value: 'Nero' })
  })
  it('names the source row by its SKU, and never shows a raw id', () => {
    const skus: Record<string, string> = { cmokmy24v004bpm0pnretnc03: 'AIREON' }
    expect(inheritedContextOf({ inherited: true, inheritedFrom: 'cmokmy24v004bpm0pnretnc03', value: 'Nero' }, id => skus[id])).toEqual({ from: 'AIREON', value: 'Nero' })
    expect(inheritedContextOf({ inherited: true, inheritedFrom: 'cmokmy24v004bpm0pnretnc99', value: 'Nero' }, id => skus[id])).toEqual({ from: 'the parent', value: 'Nero' })
    // `<id>:<column>` names the same row as `<id>`.
    expect(inheritedContextOf({ inherited: true, inheritedFrom: 'cmokmy24v004bpm0pnretnc03:colour', value: 'Nero' }, id => skus[id])).toEqual({ from: 'AIREON', value: 'Nero' })
  })
  it('says so when the followed value is empty', () => {
    expect(inheritedContextOf({ inherited: true, inheritedFrom: 'AIREON', value: null })).toEqual({ from: 'AIREON', value: '' })
  })
  it('is nothing for an own value, a missing cell or a value one line cannot show', () => {
    expect(inheritedContextOf({ inherited: false, value: 'Nero' })).toBeNull()
    expect(inheritedContextOf(undefined)).toBeNull()
    expect(inheritedContextOf({ inherited: true, value: ['a', 'b'] })).toBeNull()
  })
})

describe('aiDraftContextOf — an AI draft the operator can take from one line', () => {
  const verbs = () => ({ approve: vi.fn(async () => ({ applied: 1 })), reject: vi.fn(async () => ({ rejected: 1 })), onApplied: vi.fn() })
  it('offers a pending, fresh, text draft and runs the review\'s own verbs by id', async () => {
    const v = verbs()
    const ctx = aiDraftContextOf({ id: 'd1', status: 'pending', stale: false, draftValue: 'Xavia Racing' }, v)!
    expect(ctx.value).toBe('Xavia Racing')
    await ctx.accept()
    expect(v.approve).toHaveBeenCalledWith(['d1'])
    expect(v.onApplied).toHaveBeenCalled()
    await ctx.reject()
    expect(v.reject).toHaveBeenCalledWith(['d1'])
  })
  it('leaves a stale, decided or non-text draft to the review', () => {
    expect(aiDraftContextOf({ id: 'd1', status: 'pending', stale: true, draftValue: 'x' }, verbs())).toBeNull()
    expect(aiDraftContextOf({ id: 'd1', status: 'approved', stale: false, draftValue: 'x' }, verbs())).toBeNull()
    expect(aiDraftContextOf({ id: 'd1', status: 'pending', stale: false, draftValue: ['x'] }, verbs())).toBeNull()
    expect(aiDraftContextOf(undefined, verbs())).toBeNull()
  })
})

describe('historyLoaderFor — the same request the record drawer makes', () => {
  it('asks for the cell\'s write field, in its language, for this row, and maps the page', async () => {
    const fetch = vi.fn(async () => ({ entries: [entry('2026-09-24T10:00:00Z', 'Old')], coverageSince: null }))
    const row = { id: 'p1', values: { 'name@fr': { writeField: 'name', value: 'Neu' } } }
    const out = await historyLoaderFor(row, 'name@fr', { kind: 'master', marketplace: 'IT', locale: 'it' }, fetch as never)()
    expect(fetch).toHaveBeenCalledWith({ productId: 'p1', fieldKey: 'name', scope: { kind: 'master', marketplace: 'IT', locale: 'fr' }, rowId: 'p1' })
    expect(out.map(h => h.value)).toEqual(['Old'])
  })
})
