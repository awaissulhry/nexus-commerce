import { describe, expect, it, vi } from 'vitest'

import { actionMenuItems, actionVerbs } from './menuAdapters'
import { AVAILABLE, HIDDEN, ROW, disabled, type GridAction } from './registry'

interface Row { id: string; state: 'waiting' | 'done'; stale?: boolean }
const act = (id: string, over: Partial<GridAction<Row>> = {}): GridAction<Row> => ({
  id, label: id[0].toUpperCase() + id.slice(1), scope: ROW, available: () => AVAILABLE, run: async () => ({ ok: true }), ...over,
})
const ACTIONS: GridAction<Row>[] = [
  act('approve', { available: ([r]) => (r.state !== 'waiting' ? HIDDEN : r.stale ? disabled('The data changed — refresh first') : AVAILABLE) }),
  act('reject', { danger: true, available: ([r]) => (r.state === 'waiting' ? AVAILABLE : HIDDEN) }),
  act('automate'),
]
const waiting: Row = { id: 'r1', state: 'waiting' }

describe('actionVerbs — the row buttons from the registry (G2)', () => {
  it('draws the shown verbs in order: first primary, a danger verb danger', () => {
    const verbs = actionVerbs({ actions: ACTIONS, onSelect: () => {}, show: ['approve', 'reject'] })(waiting)
    expect(verbs.map((v) => [v.id, v.label, v.tone])).toEqual([['approve', 'Approve', 'primary'], ['reject', 'Reject', 'danger']])
  })

  it('keeps a disabled verb HELD with the registry reason, and skips a hidden one', () => {
    const verbs = actionVerbs({ actions: ACTIONS, onSelect: () => {}, show: ['approve', 'reject'] })
    const stale = verbs({ ...waiting, stale: true })
    expect(stale[0]?.disabled?.(waiting)).toBe('The data changed — refresh first')
    expect(verbs({ id: 'r2', state: 'done' })).toEqual([])
  })

  it('runs through onSelect with the one row, and honours tones and accessible names', () => {
    const onSelect = vi.fn()
    const [first] = actionVerbs({ actions: ACTIONS, onSelect, show: ['reject'], tones: { reject: 'default' }, ariaLabel: (a, r) => `${a.id} ${r.id}` })(waiting)
    expect(first?.tone).toBe('default')
    expect(first?.ariaLabel?.(waiting)).toBe('reject r1')
    first?.onClick?.(waiting)
    expect(onSelect).toHaveBeenCalledWith(ACTIONS[1], [waiting])
  })

  it('`omit` keeps the ⋯ from repeating the buttons; without it the menu is unchanged', () => {
    const base = { actions: ACTIONS, onSelect: () => {} }
    expect(actionMenuItems(base)(waiting).map((i) => i.id)).toEqual(['approve', 'reject', 'automate'])
    expect(actionMenuItems({ ...base, omit: ['approve', 'reject'] })(waiting).map((i) => i.id)).toEqual(['automate'])
  })
})
