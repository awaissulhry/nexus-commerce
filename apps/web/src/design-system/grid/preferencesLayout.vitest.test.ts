import { describe, expect, it } from 'vitest'
import { normalizeGroupedPreferences, moveAttributeGroup, moveAttributesToGroup } from '../patterns/preferencesLogic'
import type { PreferencesColumnSpec, PreferencesValue } from '../patterns/PreferencesModal'
import { readColumnLayout, sameColumnLayout, withVisibleColumnOrder } from './preferencesLayout'
import { parseStoredPrefs, prefsFromModal, prefsToModal, samePrefs } from './workspace/prefs'
import { reconcileStoredPrefs, serializePrefs } from './datagrid/prefs'
import type { GridColumn } from './workspace/types'

const columns: PreferencesColumnSpec[] = [
  { key: 'identity', label: 'Campaign', locked: true },
  { key: 'budget', label: 'Budget', group: 'Budget' },
  { key: 'spend', label: 'Spend', group: 'Performance' },
  { key: 'sales', label: 'Sales', group: 'Performance' },
  { key: 'actions', label: 'Actions', locked: true, lockSide: 'right' },
]
const value: PreferencesValue = { visibleColumns: ['budget', 'spend'], lockedColumns: [], stickyFirstColumn: true, stickyLastColumn: true, pageSize: 50, sortBy: 'spend', sortDir: 'desc' }

describe('grouped column modal → persisted advertising layout', () => {
  it('applies the order shown in groups, including group moves, hidden fields and pinned edges', () => {
    const grouped = moveAttributeGroup(columns, { ...value, lockedColumns: ['sales'] }, 'Performance', 'Budget')
    const next = normalizeGroupedPreferences(columns, grouped)
    expect(next.visibleColumns).toEqual(['identity', 'sales', 'spend', 'budget', 'actions'])
    expect(next.columnOrder).toContain('sales')
    expect(next.groupOrder).toEqual(['Performance', 'Budget'])
    expect(next.sortBy).toBe('spend')
  })

  it('keeps a hidden column’s new group and position through a DataGrid save and reload', () => {
    const next = normalizeGroupedPreferences(columns, moveAttributesToGroup(columns, value, ['sales'], 'Budget'))
    const keys = ['budget', 'spend', 'sales']
    const { patch } = reconcileStoredPrefs(JSON.parse(serializePrefs(next, keys)), { togglableKeys: keys, defaultLockedKeys: [] })
    expect(patch.visibleColumns).toEqual(['budget', 'spend'])
    expect(patch.groupOverrides).toEqual({ sales: 'Budget' })
    expect(patch.columnOrder).toEqual(['budget', 'sales', 'spend'])
    expect(patch.lockedColumns).toEqual([])
  })

  it('keeps hidden slots when headers move and recognizes changes to groups or locks', () => {
    const original = { columnOrder: ['budget', 'sales', 'spend'], groupOverrides: { sales: 'Budget' }, lockedColumns: [] }
    const moved = withVisibleColumnOrder(original, ['spend', 'budget'])
    expect(moved.columnOrder).toEqual(['spend', 'sales', 'budget'])
    expect(moved.groupOverrides).toEqual(original.groupOverrides)
    expect(sameColumnLayout(original, { ...original })).toBe(true)
    expect(sameColumnLayout(original, moved)).toBe(false)
    expect(sameColumnLayout(original, { ...original, lockedColumns: ['budget'] })).toBe(false)
  })

  it('round-trips workspace groups, locks and widths without changing the existing storage shape', () => {
    const workspace: GridColumn<unknown>[] = columns.filter((c) => !c.locked).map((c) => ({ ...c, render: () => null }))
    const previous = { visible: ['spend', 'budget'], stickyFirst: false, stickyLast: true, widths: { budget: 160 } }
    const next = prefsFromModal(previous, normalizeGroupedPreferences(columns, { ...prefsToModal(previous, workspace, 50), lockedColumns: ['spend'], groupOverrides: { budget: 'Performance' } }), workspace)
    expect(parseStoredPrefs(JSON.stringify(next), workspace)).toEqual(next)
    expect(next.widths).toEqual(previous.widths)
    expect(next.stickyFirst).toBe(false)
    expect(samePrefs(previous, next)).toBe(false)
  })

  it('migrates right pins to explicit locks and lets both a padlock and the sticky toggle release them', () => {
    const workspace: GridColumn<unknown>[] = [{ key: 'decision', label: 'Decision', freezeRight: true, width: 80, render: () => null }]
    const previous = { visible: ['decision'], stickyFirst: true, stickyLast: true }
    const modal = prefsToModal(previous, workspace, 100)
    expect(modal.lockedColumns).toEqual(['decision'])
    expect(prefsFromModal(previous, { ...modal, lockedColumns: [] }, workspace)).toMatchObject({ lockedColumns: [], stickyLast: false })
    expect(prefsFromModal(previous, { ...modal, stickyLastColumn: false }, workspace)).toMatchObject({ lockedColumns: [], stickyLast: false })
  })

  it('drops malformed or retired column references from stored layout fields', () => {
    const raw = JSON.parse('{"columnOrder":["budget",8,"gone","budget"],"lockedColumns":["gone","budget"],"groupOrder":["Budget",null],"groupOverrides":{"budget":"Performance","gone":"Budget","spend":9}}')
    expect(readColumnLayout(raw, new Set(['budget', 'spend']))).toEqual({ columnOrder: ['budget'], lockedColumns: ['budget'], groupOrder: ['Budget'], groupOverrides: { budget: 'Performance' } })
  })
})
