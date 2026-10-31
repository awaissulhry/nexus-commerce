import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FloorList, FloorListRow } from '../FloorListRow'
import { FloorListUpdates } from './FloorListUpdates'
import { floorListChanges, floorListTakesAtOnce } from './floorListUpdatesModel'

/** B-W2b-28 — FloorList's updates slot: rows never move under a gloved finger. */
interface Row { id: string; status: string }
const key = (r: Row) => r.id
const version = (r: Row) => r.status
const A = { id: 'a', status: 'ready' }
const B = { id: 'b', status: 'ready' }
const C = { id: 'c', status: 'ready' }

describe('floorListChanges', () => {
  it('counts added, removed, changed and moved rows, each row once', () => {
    expect(floorListChanges([A, B], [A, B], key, version)).toBe(0)
    expect(floorListChanges([A, B], [A, B, C], key, version)).toBe(1)
    expect(floorListChanges([A, B, C], [A, C], key, version)).toBe(1)
    expect(floorListChanges([A, B], [A, { id: 'b', status: 'done' }], key, version)).toBe(1)
    expect(floorListChanges([A, B], [B, A], key, version)).toBe(2)
    // Changed AND moved is still one row.
    expect(floorListChanges([A, B, C], [{ id: 'c', status: 'done' }, A, B], key, version)).toBe(3)
  })
  it('without a version only added, removed and moved rows count', () => {
    expect(floorListChanges([A, B], [A, { id: 'b', status: 'done' }], key)).toBe(0)
  })
  it('takes new rows at once only when nothing is on screen or nothing changed', () => {
    expect(floorListTakesAtOnce(0, 5)).toBe(true)
    expect(floorListTakesAtOnce(3, 0)).toBe(true)
    expect(floorListTakesAtOnce(3, 1)).toBe(false)
  })
})

describe('FloorListUpdates and the FloorList slot', () => {
  it('draws only an empty live region while nothing waits', () => {
    const html = render(h(FloorListUpdates, { pending: 0, onShow: () => {} }))
    expect(html).toContain('aria-live="polite"')
    expect(html).not.toContain('<button')
  })
  it('a big Show button while rows wait, with the count or without it', () => {
    expect(render(h(FloorListUpdates, { pending: 3, onShow: () => {} }))).toContain('List changed: 3 updates · Show')
    expect(render(h(FloorListUpdates, { pending: 1, onShow: () => {}, countUnknown: true }))).toContain('List changed · Show')
    expect(render(h(FloorListUpdates, { pending: 2, onShow: () => {}, labels: { changed: (n: number) => `Elenco cambiato: ${n}`, show: 'Mostra' } }))).toContain('Elenco cambiato: 2 · Mostra')
  })
  it('FloorList without the slot draws exactly as before; with it, the button comes first', () => {
    const row = h(FloorListRow, { icon: h('svg'), title: 'Bundle B-000123' })
    expect(render(h(FloorList, { label: 'My work', children: row }))).toBe(
      '<ul class="nds-floor-list" aria-label="My work"><li class="nds-floor-list-item"><div class="nds-floor-row" data-tone="neutral"><span class="nds-floor-icon nds-floor-tone-icon nds-floor-row-icon" aria-hidden="true"><svg></svg></span><span class="nds-floor-row-text"><span class="nds-floor-row-title">Bundle B-000123</span></span></div></li></ul>',
    )
    const slotted = render(h(FloorList, { label: 'My work', updates: h(FloorListUpdates, { pending: 1, onShow: () => {} }), children: row }))
    expect(slotted.indexOf('List changed')).toBeLessThan(slotted.indexOf('<ul'))
  })
})
