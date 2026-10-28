import { describe, expect, it, vi } from 'vitest'
import { cellDetailKeys } from './cellDetail'

/** A-45 — Enter / Space on a LOCKED readiness cell opens its detail; nothing else is taken from AG. */
const trigger = () => ({ click: vi.fn() })
const cell = (t: ReturnType<typeof trigger> | null) => ({
  closest: (sel: string) => (sel === '[data-cell-detail-trigger]' ? null : null),
  querySelector: () => t,
})
const onTrigger = () => ({ closest: () => ({}), querySelector: () => null })

describe('cellDetailKeys', () => {
  it('Enter on the focused cell clicks its trigger, once, on keydown', () => {
    const t = trigger(); const preventDefault = vi.fn()
    expect(cellDetailKeys({ event: { key: 'Enter', type: 'keydown', target: cell(t) as never, preventDefault }, editing: false })).toBe(true)
    expect(t.click).toHaveBeenCalledTimes(1); expect(preventDefault).toHaveBeenCalled()
    expect(cellDetailKeys({ event: { key: 'Enter', type: 'keypress', target: cell(t) as never }, editing: false })).toBe(true)
    expect(t.click).toHaveBeenCalledTimes(1)
  })
  it('Space does the same', () => {
    const t = trigger()
    expect(cellDetailKeys({ event: { key: ' ', type: 'keydown', target: cell(t) as never }, editing: false })).toBe(true)
    expect(t.click).toHaveBeenCalledTimes(1)
  })
  it('focus on the trigger itself: AG leaves the key to the native button', () => {
    expect(cellDetailKeys({ event: { key: 'Enter', type: 'keydown', target: onTrigger() as never }, editing: false })).toBe(true)
  })
  it('arrows, Tab and every other key stay AG\'s', () => {
    const t = trigger()
    for (const key of ['ArrowDown', 'Tab', 'c', 'Escape']) expect(cellDetailKeys({ event: { key, type: 'keydown', target: cell(t) as never }, editing: false })).toBe(false)
    expect(t.click).not.toHaveBeenCalled()
  })
  it('never while editing, and never on a cell without a trigger', () => {
    const t = trigger()
    expect(cellDetailKeys({ event: { key: 'Enter', type: 'keydown', target: cell(t) as never }, editing: true })).toBe(false)
    expect(cellDetailKeys({ event: { key: 'Enter', type: 'keydown', target: cell(null) as never }, editing: false })).toBe(false)
    expect(t.click).not.toHaveBeenCalled()
  })
})
