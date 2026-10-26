import { describe, expect, it, vi } from 'vitest'
import { ownerKeys, placeKeys, SINCE_DAY, sinceKeys, verbKeys } from './cellKeys'

const el = (opts: { onControl?: boolean; buttons?: Array<{ disabled?: boolean }>; links?: number } = {}) => {
  const clicks: string[] = []
  const buttons = (opts.buttons ?? []).map((b, i) => ({ click: () => clicks.push(`button${i}`), focus: () => clicks.push(`focus${i}`), getAttribute: (n: string) => (n === 'aria-disabled' && b.disabled ? 'true' : null) }))
  const links = Array.from({ length: opts.links ?? 0 }, (_, i) => ({ click: () => clicks.push(`link${i}`) }))
  return {
    clicks,
    target: {
      closest: () => (opts.onControl ? {} : null),
      querySelector: (sel: string) => (sel.includes('button') && !sel.includes('a[href]') ? buttons[0] ?? null : links[0] ?? buttons[0] ?? null),
      querySelectorAll: () => links,
    },
  }
}

describe('cell keys (audit S4)', () => {
  it('Enter or Space on the verb cell presses the verb; a held one takes the focus instead', () => {
    const a = el({ buttons: [{}] })
    expect(verbKeys({ event: { key: 'Enter', type: 'keydown', target: a.target, preventDefault: vi.fn() }, editing: false })).toBe(true)
    expect(verbKeys({ event: { key: ' ', type: 'keydown', target: a.target }, editing: false })).toBe(true)
    expect(a.clicks).toEqual(['button0', 'button0'])
    const held = el({ buttons: [{ disabled: true }] })
    verbKeys({ event: { key: 'Enter', type: 'keydown', target: held.target }, editing: false })
    expect(held.clicks).toEqual(['focus0'])
  })
  it('Shift+Enter presses the second button: Reject beside Approve (a waiting row), else the ⋯', () => {
    const clicks: string[] = []
    const btn = (n: string) => ({ click: () => clicks.push(n), getAttribute: () => null })
    const target = { closest: () => null, querySelector: () => btn('approve'), querySelectorAll: () => [btn('approve'), btn('reject'), btn('more')] }
    expect(verbKeys({ event: { key: 'Enter', shiftKey: true, type: 'keydown', target }, editing: false })).toBe(true)
    expect(verbKeys({ event: { key: 'Enter', type: 'keydown', target }, editing: false })).toBe(true)
    expect(clicks).toEqual(['reject', 'approve'])
  })
  it('other keys stay the grid\'s; focus on the control keeps its own keys', () => {
    expect(verbKeys({ event: { key: 'ArrowDown', target: el({ buttons: [{}] }).target }, editing: false })).toBe(false)
    expect(verbKeys({ event: { key: 'Enter', target: el({ onControl: true }).target }, editing: false })).toBe(true)
  })
  it('Where: Enter the campaign, Shift+Enter the ad group; Who: Enter the chip', () => {
    const w = el({ links: 2 })
    placeKeys({ event: { key: 'Enter', type: 'keydown', target: w.target }, editing: false })
    placeKeys({ event: { key: 'Enter', shiftKey: true, type: 'keydown', target: w.target }, editing: false })
    expect(w.clicks).toEqual(['link0', 'link1'])
    const o = el({ links: 1 })
    expect(ownerKeys({ event: { key: 'Enter', type: 'keydown', target: o.target }, editing: false })).toBe(true)
    expect(o.clicks).toEqual(['link0'])
    expect(ownerKeys({ event: { key: 'Enter', type: 'keydown', target: el().target }, editing: false })).toBe(false)
  })
})

describe('Since (NFIX): its reason on keyboard focus, as on hover', () => {
  const cell = () => {
    const log: string[] = []
    const day = { focus: () => log.push('day'), click: () => log.push('click') }
    const agCell = { focus: () => log.push('cell') }
    return {
      log,
      onCell: { closest: () => null, querySelector: (sel: string) => (sel === SINCE_DAY ? day : null) },
      onDay: { closest: (sel: string) => (sel === SINCE_DAY ? day : sel === '.ag-cell' ? agCell : null) },
      bare: { closest: () => null, querySelector: () => null },
    }
  }
  it('Enter on the cell puts the focus on the day (its tooltip opens); Esc gives it back to the cell', () => {
    const c = cell()
    expect(sinceKeys({ event: { key: 'Enter', type: 'keydown', target: c.onCell, preventDefault: vi.fn() }, editing: false })).toBe(true)
    expect(sinceKeys({ event: { key: 'Escape', type: 'keydown', target: c.onDay, preventDefault: vi.fn() }, editing: false })).toBe(true)
    expect(c.log).toEqual(['day', 'cell'])
  })
  it('on the day Enter does nothing more; arrows and Tab stay the grid\'s; a cell with no reason lets Enter through', () => {
    const c = cell()
    expect(sinceKeys({ event: { key: 'Enter', type: 'keydown', target: c.onDay }, editing: false })).toBe(true)
    expect(sinceKeys({ event: { key: 'ArrowDown', type: 'keydown', target: c.onDay }, editing: false })).toBe(false)
    expect(sinceKeys({ event: { key: 'Tab', type: 'keydown', target: c.onDay }, editing: false })).toBe(false)
    expect(sinceKeys({ event: { key: 'Enter', type: 'keydown', target: c.bare }, editing: false })).toBe(false)
    expect(c.log).toEqual([])
  })
})
