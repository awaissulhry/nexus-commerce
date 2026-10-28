import { describe, expect, it } from 'vitest'

import { classifyBurst, createWedgeReader, isCameraRepeat, nextStamps, WEDGE_DEFAULTS } from './scanWedge'

/** Times for `n` characters `gap` ms apart, from `start`. */
const times = (n: number, gap: number, start = 1000) => Array.from({ length: n }, (_, i) => start + i * gap)

/** Feeds a code to a reader, one character `gap` ms apart, then the terminator; returns the last step. */
function feed(reader: ReturnType<typeof createWedgeReader>, code: string, gap: number, terminator = 'Enter', start = 1000) {
  const steps = [...code].map((ch, i) => reader.key(ch, start + i * gap))
  return { steps, end: reader.key(terminator, start + code.length * gap) }
}

describe('scan field: scanner or person (G3)', () => {
  it('a scanner types 5–30 ms apart: a wedge', () => {
    expect(classifyBurst(times(12, 8), 50)).toBe('wedge')
    expect(classifyBurst(times(12, 30), 50)).toBe('wedge')
  })

  it('a person types 80 ms or more apart: typed', () => {
    expect(classifyBurst(times(8, 90), 50)).toBe('typed')
    expect(classifyBurst(times(8, 220), 50)).toBe('typed')
  })

  it('one stall inside a fast burst is still a scan; a long pause is not', () => {
    const stall = [...times(6, 10), 1000 + 5 * 10 + 140, ...times(5, 10, 1000 + 5 * 10 + 150)]
    expect(classifyBurst(stall, 50)).toBe('wedge')
    const pause = [...times(6, 10), 1000 + 5 * 10 + 400, 1000 + 5 * 10 + 410]
    expect(classifyBurst(pause, 50)).toBe('typed')
  })

  it('one character, or a paste (all at one moment), counts as a wedge', () => {
    expect(classifyBurst([5], 50)).toBe('wedge')
    expect(classifyBurst([7, 7, 7, 7], 50)).toBe('wedge')
  })

  it('keeps one arrival time per character through typing, deleting and editing', () => {
    let s = nextStamps([], '', 'A', 10)
    s = nextStamps(s, 'A', 'AB', 20)
    s = nextStamps(s, 'AB', 'ABCD', 30)
    expect(s).toEqual([10, 20, 30, 30])
    expect(nextStamps(s, 'ABCD', 'AB', 40)).toEqual([10, 20])
    expect(nextStamps(s, 'ABCD', 'XBCD', 50)).toEqual([50, 50, 50, 50])
    expect(nextStamps(s, 'ABCD', '', 60)).toEqual([])
  })
})

describe('document reader: scans while no text field has focus (G3)', () => {
  it('a fast burst ending in Enter is a scan, and every character after the first is swallowed', () => {
    const r = createWedgeReader()
    const { steps, end } = feed(r, 'BND-000417', 12)
    expect(steps[0]).toEqual({ kind: 'char', burst: false })
    expect(steps.slice(1).every((s) => s.kind === 'char' && s.burst)).toBe(true)
    expect(end).toEqual({ kind: 'scan', code: 'BND-000417' })
  })

  it('Tab ends a scan too (a scanner set to a Tab suffix)', () => {
    expect(feed(createWedgeReader(), 'LOT77', 10, 'Tab').end).toEqual({ kind: 'scan', code: 'LOT77' })
  })

  it('a person pressing keys then Enter is not a scan: Enter keeps pressing the focused tile', () => {
    const r = createWedgeReader()
    const { steps, end } = feed(r, 'abc', 180)
    expect(steps.every((s) => s.kind === 'char' && !s.burst)).toBe(true)
    expect(end).toEqual({ kind: 'ignore' })
    // Enter alone, nothing buffered.
    expect(r.key('Enter', 99_000)).toEqual({ kind: 'ignore' })
  })

  it('a burst shorter than the minimum is not a scan', () => {
    expect(feed(createWedgeReader({ minLength: 4 }), 'AB1', 10).end).toEqual({ kind: 'ignore' })
    expect(feed(createWedgeReader({ minLength: 4 }), 'AB12', 10).end).toEqual({ kind: 'scan', code: 'AB12' })
  })

  it('Shift between characters (capitals) neither counts nor breaks the burst', () => {
    const r = createWedgeReader()
    let t = 1000
    for (const ch of 'Ab9') {
      if (ch === ch.toUpperCase() && /[A-Z]/.test(ch)) expect(r.key('Shift', (t += 3))).toEqual({ kind: 'ignore' })
      r.key(ch, (t += 9))
    }
    expect(r.key('Enter', (t += 9))).toEqual({ kind: 'scan', code: 'Ab9' })
  })

  it('a long pause before the terminator, or an arrow key, drops the buffer', () => {
    const r = createWedgeReader()
    ;[...'ABCDE'].forEach((ch, i) => r.key(ch, 1000 + i * 10))
    expect(r.key('Enter', 1000 + 4 * 10 + WEDGE_DEFAULTS.maxKeyGapMs * 3 + 1)).toEqual({ kind: 'ignore' })
    ;[...'ABCDE'].forEach((ch, i) => r.key(ch, 5000 + i * 10))
    expect(r.key('ArrowDown', 5050)).toEqual({ kind: 'ignore' })
    expect(r.key('Enter', 5055)).toEqual({ kind: 'ignore' })
  })

  it('a stray key long before a scan does not spoil it', () => {
    const r = createWedgeReader()
    r.key('x', 100)
    expect(feed(r, 'HIDE-21', 9, 'Enter', 5000).end).toEqual({ kind: 'scan', code: 'HIDE-21' })
  })
})

describe('camera repeats (G3)', () => {
  it('the same code inside the window counts once; a new code or a later read counts again', () => {
    const last = { code: 'BND-1', at: 1000 }
    expect(isCameraRepeat(null, 'BND-1', 1000)).toBe(false)
    expect(isCameraRepeat(last, 'BND-1', 1800)).toBe(true)
    expect(isCameraRepeat(last, 'BND-2', 1100)).toBe(false)
    expect(isCameraRepeat(last, 'BND-1', 2600)).toBe(false)
  })
})
