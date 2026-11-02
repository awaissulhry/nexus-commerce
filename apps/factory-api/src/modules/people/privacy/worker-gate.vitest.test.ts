import { describe, expect, it } from 'vitest'
import { workerGate } from './worker-gate'

const NAMES = new Map([['w1', 'Made-up Worker']])

describe('who did a piece of work, as an office read tells it (Statuto art. 4 c.1; GATE-LABOUR)', () => {
  it('with the gate not open: no name, no id, and the record says a person is on it', () => {
    const who = workerGate(false)
    expect(who.lookup(['w1', null, undefined])).toEqual([])
    expect(who.id('w1')).toBeNull()
    expect(who.person('w1', NAMES)).toBeNull()
    expect(who.name('w1', NAMES)).toBeNull()
    expect(who.hidden('w1')).toBe(true)
  })

  it('with the gate open: the worker, as the read answered before', () => {
    const who = workerGate(true)
    expect(who.lookup(['w1', null, undefined])).toEqual(['w1'])
    expect(who.id('w1')).toBe('w1')
    expect(who.person('w1', NAMES)).toEqual({ id: 'w1', name: 'Made-up Worker' })
    expect(who.name('w1', NAMES)).toBe('Made-up Worker')
    expect(who.hidden('w1')).toBe(false)
  })

  it('a row that names nobody (a site that records the station) is not hidden: there is nobody to hide', () => {
    for (const open of [false, true]) {
      const who = workerGate(open)
      expect(who.person(null, NAMES)).toBeNull()
      expect(who.id(null)).toBeNull()
      expect(who.hidden(null)).toBe(false)
      expect(who.hidden(undefined)).toBe(false)
    }
  })
})
