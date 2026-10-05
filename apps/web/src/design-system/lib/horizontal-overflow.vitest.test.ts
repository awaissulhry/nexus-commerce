import { describe, expect, it } from 'vitest'
import { horizontalOverflow, markHorizontalOverflow, overflowMarkDelay, OVERFLOW_ATTR, SCROLLBAR_SIZE_PROP, type HorizontalOverflowBox, type OverflowTarget } from './horizontal-overflow'

/** A 300 × 40 strip with 1px top and bottom borders, overlay scrollbar, content that fits. */
const box = (over: Partial<HorizontalOverflowBox> = {}): HorizontalOverflowBox => ({
  scrollWidth: 300, clientWidth: 300, offsetHeight: 42, clientHeight: 40, borderTopWidth: 1, borderBottomWidth: 1,
  overflowX: 'auto', scrollbarWidth: 'thin', ...over,
})

describe('horizontalOverflow — does the strip scroll sideways, and what scrollbar does it show', () => {
  it('is null while the content fits — nothing changes on a strip that does not scroll', () => {
    expect(horizontalOverflow(box())).toBeNull()
  })

  it('an overlay bar: the content is wider and the bar takes no room (macOS with a trackpad)', () => {
    expect(horizontalOverflow(box({ scrollWidth: 560 }))).toEqual({ kind: 'overlay' })
  })

  it('a strip 1px over still shows a bar, so it still needs the room (the browser\'s own test, no tolerance)', () => {
    expect(horizontalOverflow(box({ scrollWidth: 301 }))).toEqual({ kind: 'overlay' })
  })

  it('a classic bar takes its own room: its height is measured (Chromium thin 11px, regular 15px)', () => {
    expect(horizontalOverflow(box({ scrollWidth: 560, clientHeight: 29 }))).toEqual({ kind: 'classic', size: 11 })
    expect(horizontalOverflow(box({ scrollWidth: 560, clientHeight: 25, scrollbarWidth: 'auto' }))).toEqual({ kind: 'classic', size: 15 })
  })

  it('rounding and fractional borders are not mistaken for a classic bar', () => {
    expect(horizontalOverflow(box({ scrollWidth: 560, offsetHeight: 43, borderBottomWidth: 0.5 }))).toEqual({ kind: 'overlay' })
    expect(horizontalOverflow(box({ scrollWidth: 560, offsetHeight: 41, borderTopWidth: 0, borderBottomWidth: 0, clientHeight: 40 }))).toEqual({ kind: 'overlay' })
  })

  it('is null when the box is not a scroll box — a strip that spills or clips shows no bar', () => {
    for (const overflowX of ['visible', 'hidden', 'clip']) expect(horizontalOverflow(box({ scrollWidth: 560, overflowX }))).toBeNull()
    expect(horizontalOverflow(box({ scrollWidth: 560, overflowX: 'scroll' }))).toEqual({ kind: 'overlay' })
  })

  it('is null when the host hides the scrollbar (`scrollbar-width: none`) — no bar, no room', () => {
    expect(horizontalOverflow(box({ scrollWidth: 560, scrollbarWidth: 'none' }))).toBeNull()
  })

  it('a browser that does not report scrollbar-width is measured like any other', () => {
    expect(horizontalOverflow(box({ scrollWidth: 560, scrollbarWidth: '' }))).toEqual({ kind: 'overlay' })
  })
})

/** A stand-in element that records every write. */
function target() {
  const attrs = new Map<string, string>(), props = new Map<string, string>(), writes: string[] = []
  const el: OverflowTarget = {
    getAttribute: name => attrs.get(name) ?? null,
    setAttribute: (name, value) => { attrs.set(name, value); writes.push(`attr ${name}=${value}`) },
    removeAttribute: name => { attrs.delete(name); writes.push(`attr ${name} removed`) },
    style: {
      getPropertyValue: name => props.get(name) ?? '',
      setProperty: (name, value) => { props.set(name, value); writes.push(`prop ${name}=${value}`) },
      removeProperty: name => { const was = props.get(name) ?? ''; props.delete(name); writes.push(`prop ${name} removed`); return was },
    },
  }
  return { el, attrs, props, writes }
}

describe('markHorizontalOverflow — writes the mark, and only what changed', () => {
  it('marks an overlay strip and clears it again', () => {
    const t = target()
    expect(markHorizontalOverflow(t.el, { kind: 'overlay' })).toBe(true)
    expect(t.attrs.get(OVERFLOW_ATTR)).toBe('overlay')
    expect(t.props.has(SCROLLBAR_SIZE_PROP)).toBe(false)
    expect(markHorizontalOverflow(t.el, null)).toBe(true)
    expect(t.attrs.has(OVERFLOW_ATTR)).toBe(false)
  })

  it('a classic strip also carries its bar height, for a host of fixed height to grow by', () => {
    const t = target()
    markHorizontalOverflow(t.el, { kind: 'classic', size: 11 })
    expect(t.attrs.get(OVERFLOW_ATTR)).toBe('classic')
    expect(t.props.get(SCROLLBAR_SIZE_PROP)).toBe('11px')
    // Back to an overlay bar (the mouse unplugged): the height goes, the mark changes.
    markHorizontalOverflow(t.el, { kind: 'overlay' })
    expect(t.attrs.get(OVERFLOW_ATTR)).toBe('overlay')
    expect(t.props.has(SCROLLBAR_SIZE_PROP)).toBe(false)
  })

  it('🔴 the same state twice writes nothing — a re-measure cannot restyle the strip or wake its observers', () => {
    const t = target()
    markHorizontalOverflow(t.el, { kind: 'classic', size: 11 })
    const before = t.writes.length
    expect(markHorizontalOverflow(t.el, { kind: 'classic', size: 11 })).toBe(false)
    expect(markHorizontalOverflow(target().el, null)).toBe(false)
    expect(t.writes.length).toBe(before)
  })
})

describe('overflowMarkDelay — a settling strip is marked only once it has kept overflowing', () => {
  const over = { kind: 'overlay' } as const

  it('a strip that marks at once (Tabs, scope chips, media board) never waits', () => {
    expect(overflowMarkDelay(false, over, 0, 0)).toBe(0)
  })

  it('🔴 a toolbar that only overflows until its fold collapses waits out the settle time — no 14px jump on load', () => {
    expect(overflowMarkDelay(false, over, 0, 250)).toBe(250)
    expect(overflowMarkDelay(false, over, 100, 250)).toBe(150)
    expect(overflowMarkDelay(false, over, 250, 250)).toBe(0)
    expect(overflowMarkDelay(false, over, 900, 250)).toBe(0)
  })

  it('removing the mark, or keeping it, never waits', () => {
    expect(overflowMarkDelay(true, null, 0, 250)).toBe(0)
    expect(overflowMarkDelay(true, over, 0, 250)).toBe(0)
    expect(overflowMarkDelay(true, { kind: 'classic', size: 11 }, 0, 250)).toBe(0)
    expect(overflowMarkDelay(false, null, 0, 250)).toBe(0)
  })
})
