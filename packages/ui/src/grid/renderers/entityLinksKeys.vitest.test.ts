import { describe, expect, it } from 'vitest'

import { entityLinksKeys } from './entityLinksKeys'

/** A stand-in for the focused element: what `closest` matches, and what the cell holds. */
function el(opts: { is?: string[]; holds?: Record<string, { click: () => void }> }) {
  return {
    closest: (sel: string) => (opts.is?.some((s) => sel.includes(s)) ? {} : null),
    querySelector: (sel: string) => opts.holds?.[sel] ?? null,
  }
}
const key = (k: string, target: unknown, type = 'keydown') => {
  const e = { key: k, type, target: target as EventTarget, prevented: false, preventDefault() { this.prevented = true } }
  return e
}

describe('entityLinksKeys', () => {
  it('Enter on a cell with ONE link follows it, once (AG calls for keydown and keypress)', () => {
    let clicks = 0
    const cell = el({ holds: { 'a[href]': { click: () => { clicks += 1 } } } })
    const down = key('Enter', cell)
    expect(entityLinksKeys({ event: down, editing: false })).toBe(true)
    expect(down.prevented).toBe(true)
    expect(entityLinksKeys({ event: key('Enter', cell, 'keypress'), editing: false })).toBe(true)
    expect(clicks).toBe(1)
  })

  it('Enter or Space on a cell with several opens the list (the count is the cell\'s detail trigger)', () => {
    let opened = 0
    const cell = el({ holds: { '[data-cell-detail-trigger]': { click: () => { opened += 1 } } } })
    expect(entityLinksKeys({ event: key(' ', cell), editing: false })).toBe(true)
    expect(entityLinksKeys({ event: key('Enter', cell), editing: false })).toBe(true)
    expect(opened).toBe(2)
  })

  it('focus ON a link or the count keeps its own keys; everything else stays AG\'s', () => {
    expect(entityLinksKeys({ event: key('Tab', el({ is: ['a[href]'] })), editing: false })).toBe(true)
    expect(entityLinksKeys({ event: key('Enter', el({ is: ['[data-cell-detail-trigger]'] })), editing: false })).toBe(true)
    expect(entityLinksKeys({ event: key('ArrowDown', el({})), editing: false })).toBe(false)
    expect(entityLinksKeys({ event: key(' ', el({ holds: { 'a[href]': { click: () => {} } } })), editing: false })).toBe(false)
    expect(entityLinksKeys({ event: key('Enter', el({})), editing: false })).toBe(false)
  })
})
