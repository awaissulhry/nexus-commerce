import { describe, expect, it, vi } from 'vitest'

import { entityPathKeys } from './entityPathKeys'

/** A link stand-in: focusable, clickable, inside a cell that holds the path's links. */
function cellWith(n: number) {
  const cell = { focus: vi.fn(), querySelectorAll: () => links, closest: () => null as unknown }
  const links = Array.from({ length: n }, () => {
    const link = { focus: vi.fn(), click: vi.fn(), closest: (sel: string) => (sel === 'a[href]' ? link : sel === '.ag-cell' ? cell : null) }
    return link
  })
  return { cell, links }
}
const key = (k: string, target: unknown, type = 'keydown') => ({ key: k, type, target: target as EventTarget, prevented: false, preventDefault() { this.prevented = true } })

describe('entityPathKeys (H7)', () => {
  it('Enter on a cell with ONE link follows it, once (AG calls for keydown and keypress)', () => {
    const { cell, links } = cellWith(1)
    expect(entityPathKeys({ event: key('Enter', cell), editing: false })).toBe(true)
    expect(entityPathKeys({ event: key('Enter', cell, 'keypress'), editing: false })).toBe(true)
    expect(links[0].click).toHaveBeenCalledTimes(1)
  })

  it('Enter on a cell with several steps onto the LAST link (the most precise place)', () => {
    const { cell, links } = cellWith(3)
    expect(entityPathKeys({ event: key('Enter', cell), editing: false })).toBe(true)
    expect(links[2].focus).toHaveBeenCalled()
    expect(links[0].click).not.toHaveBeenCalled()
  })

  it('on a link: ← / → walk the links, Esc returns to the cell, Tab stays AG\'s, Enter is the link\'s own', () => {
    const { cell, links } = cellWith(3)
    expect(entityPathKeys({ event: key('ArrowLeft', links[2]), editing: false })).toBe(true)
    expect(links[1].focus).toHaveBeenCalled()
    expect(entityPathKeys({ event: key('ArrowRight', links[2]), editing: false })).toBe(true)
    expect(links[2].focus).toHaveBeenCalled()
    expect(entityPathKeys({ event: key('Escape', links[0]), editing: false })).toBe(true)
    expect(cell.focus).toHaveBeenCalled()
    expect(entityPathKeys({ event: key('Tab', links[0]), editing: false })).toBe(false)
    expect(entityPathKeys({ event: key('Enter', links[0]), editing: false })).toBe(true)
    expect(links[0].click).not.toHaveBeenCalled()
  })

  it('every other key on the cell stays AG\'s; a cell without links does nothing', () => {
    const { cell } = cellWith(2)
    expect(entityPathKeys({ event: key('ArrowDown', cell), editing: false })).toBe(false)
    expect(entityPathKeys({ event: key(' ', cell), editing: false })).toBe(false)
    expect(entityPathKeys({ event: key('Enter', cellWith(0).cell), editing: false })).toBe(false)
    expect(entityPathKeys({ event: key('Enter', cell), editing: true })).toBe(false)
  })
})
