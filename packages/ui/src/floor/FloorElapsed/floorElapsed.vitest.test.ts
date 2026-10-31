import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createElapsedTicker, type ElapsedClock } from './elapsedTicker'
import { FloorElapsed } from './FloorElapsed'
import { FLOOR_ELAPSED_LABELS } from './FloorElapsedLabels'
import { elapsedClock, elapsedHoursMinutes, elapsedIsoDuration, elapsedMoment, elapsedReading, elapsedTone, elapsedWords } from './floorElapsedModel'

/** B-W2b-28 — FloorElapsed: count up or down at numeral size, minute-level words for a screen reader. */
const T0 = Date.parse('2026-11-03T08:00:00Z')
const MIN = 60_000

describe('elapsedReading', () => {
  it('counts up from since, adding the time carried from earlier runs', () => {
    expect(elapsedReading({ since: T0 }, T0 + 5 * MIN)).toEqual({ ms: 5 * MIN, over: false, mode: 'up' })
    expect(elapsedReading({ since: T0, carriedMs: 2 * MIN }, T0 + 5 * MIN).ms).toBe(7 * MIN)
    // A clock behind the server's moment never reads negative.
    expect(elapsedReading({ since: T0 }, T0 - 3000).ms).toBe(0)
  })
  it('a paused time is frozen at what was carried', () => {
    expect(elapsedReading({ since: T0, carriedMs: 4 * MIN, paused: true }, T0 + 60 * MIN)).toEqual({ ms: 4 * MIN, over: false, mode: 'up' })
  })
  it('counts down to until and, past zero, counts the time OVER', () => {
    expect(elapsedReading({ until: T0 + 90_000 }, T0)).toEqual({ ms: 90_000, over: false, mode: 'down' })
    expect(elapsedReading({ until: T0 }, T0 + 45_000)).toEqual({ ms: 45_000, over: true, mode: 'down' })
  })
  it('a moment that is not a number reads as nothing', () => {
    expect(elapsedMoment('not a date')).toBeUndefined()
    expect(elapsedMoment(null)).toBeUndefined()
    expect(elapsedMoment('2026-11-03T08:00:00Z')).toBe(T0)
  })
})

describe('the numeral and the words', () => {
  it('writes m:ss under an hour and h:mm:ss above; a countdown never reads 0:00 while time is left', () => {
    expect(elapsedClock(4 * MIN + 7000)).toBe('4:07')
    expect(elapsedClock(65 * MIN + 9000)).toBe('1:05:09')
    expect(elapsedClock(400, 'down')).toBe('0:01')
    expect(elapsedClock(400, 'up')).toBe('0:00')
  })
  it('minutes precision gives hours and two-digit minutes; the ISO duration matches', () => {
    expect(elapsedHoursMinutes(7 * 60 * MIN + 42 * MIN + 59_000)).toEqual({ h: 7, m: '42' })
    expect(elapsedIsoDuration(65 * MIN + 9000)).toBe('PT1H5M9S')
    expect(elapsedIsoDuration(9000)).toBe('PT9S')
  })
  it('says minute-level words, never seconds', () => {
    const w = FLOOR_ELAPSED_LABELS
    expect(elapsedWords({ ms: 59_000, over: false }, w)).toBe('under a minute')
    expect(elapsedWords({ ms: MIN + 59_000, over: false }, w)).toBe('1 minute')
    expect(elapsedWords({ ms: 12 * MIN, over: false }, w)).toBe('12 minutes')
    expect(elapsedWords({ ms: 60 * MIN, over: false }, w)).toBe('1 hour')
    expect(elapsedWords({ ms: 125 * MIN, over: false }, w)).toBe('2 hours 5 minutes')
    expect(elapsedWords({ ms: 3 * MIN, over: true }, w)).toBe('3 minutes over')
  })
  it('the tone rises with the thresholds; a countdown past zero is danger', () => {
    const th = { warnAfterMs: 5 * MIN, dangerAfterMs: 10 * MIN }
    expect(elapsedTone({ ms: 4 * MIN, over: false, mode: 'up' }, th)).toBe('neutral')
    expect(elapsedTone({ ms: 5 * MIN, over: false, mode: 'up' }, th)).toBe('warning')
    expect(elapsedTone({ ms: 11 * MIN, over: false, mode: 'up' }, th)).toBe('danger')
    expect(elapsedTone({ ms: 1, over: true, mode: 'down' })).toBe('danger')
    expect(elapsedTone({ ms: 11 * MIN, over: false, mode: 'down' }, th)).toBe('neutral')
  })
})

describe('the shared ticker', () => {
  function fakeClock() {
    let now = T0 + 250
    const timers = new Map<number, { at: number; run: () => void }>()
    let seq = 0
    let hidden = false
    const watchers = new Set<() => void>()
    const clock: ElapsedClock = {
      now: () => now,
      setTimeout: (run, ms) => (timers.set(++seq, { at: now + ms, run }), seq),
      clearTimeout: (handle) => void timers.delete(handle as number),
      hidden: () => hidden,
      onVisibilityChange: (run) => (watchers.add(run), () => watchers.delete(run)),
    }
    return {
      clock,
      timers,
      advance(ms: number) {
        now += ms
        for (const [id, t] of [...timers]) if (t.at <= now) (timers.delete(id), t.run())
      },
      hide(v: boolean) {
        hidden = v
        for (const w of watchers) w()
      },
    }
  }
  it('keeps one timer for many numerals, on the whole second, and none while hidden or unused', () => {
    const f = fakeClock()
    const ticker = createElapsedTicker(f.clock)
    let ticks = 0
    const off = [ticker.subscribe(() => ticks++), ticker.subscribe(() => ticks++), ticker.subscribe(() => ticks++)]
    expect(ticker.armed()).toBe(1)
    expect([...f.timers.values()][0].at % 1000).toBe(0)
    f.advance(750)
    expect(ticks).toBe(3)
    f.hide(true)
    expect(ticker.armed()).toBe(0)
    f.hide(false)
    expect(ticker.armed()).toBe(1)
    for (const o of off) o()
    expect(ticker.armed()).toBe(0)
  })
})

describe('FloorElapsed', () => {
  it('draws the server moment it is given, the label, and the minute words in a polite region', () => {
    const html = render(h(FloorElapsed, { label: 'Running', since: T0, now: T0 + 12 * MIN + 7000 }))
    expect(html).toContain('12:07')
    expect(html).toContain('Running: 12 minutes')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('dateTime="PT12M7S"')
  })
  it('a paused time needs no clock and says Paused in words; a countdown past zero says Over', () => {
    const paused = render(h(FloorElapsed, { label: 'Running', since: T0, carriedMs: 4 * MIN, paused: true }))
    expect(paused).toContain('4:00')
    expect(paused).toContain('>Paused<')
    const over = render(h(FloorElapsed, { label: 'Break ends', until: T0, now: T0 + 45_000 }))
    expect(over).toContain('+0:45')
    expect(over).toContain('>Over<')
    expect(over).toContain('data-tone="danger"')
  })
  it('minutes precision shows hours and minutes with their units; without a clock it shows a dash', () => {
    const day = render(h(FloorElapsed, { label: 'Today', since: T0, precision: 'minutes', now: T0 + 7 * 60 * MIN + 42 * MIN }))
    expect(day).toMatch(/7<span class="nds-floor-elapsed-unit">h<\/span> 42<span class="nds-floor-elapsed-unit">min<\/span>/)
    expect(render(h(FloorElapsed, { since: T0 }))).toContain('—')
  })
  it('speaks the host’s language', () => {
    const html = render(h(FloorElapsed, { label: 'Chiamata', since: T0, now: T0 + 2 * MIN, labels: { minutes: (n: number) => `${n} minuti` } }))
    expect(html).toContain('Chiamata: 2 minuti')
  })
})
