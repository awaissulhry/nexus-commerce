import { createElement } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Countdown } from './Countdown'
import {
  countdownNextTick, countdownSnapshot, countdownStep, countdownText, createCountdownTicker, readCountdownSnapshot,
  type CountdownClock,
} from './countdownTicker'

const S = 1000
const M = 60 * S
const H = 60 * M

describe('countdown words (G7)', () => {
  it('counts seconds under a minute, rounded up — never "0 s" while time is left', () => {
    expect(countdownText(14_300)).toBe('15 s')
    expect(countdownText(14_000)).toBe('14 s')
    expect(countdownText(1)).toBe('1 s')
    expect(countdownText(59 * S)).toBe('59 s')
    expect(countdownText(0)).toBe('0 s')
    expect(countdownText(-5)).toBe('0 s')
    expect(countdownText(Number.NaN)).toBe('0 s')
  })

  it('steps in minutes, hours and days above it — never "60 s" or "60 min"', () => {
    expect(countdownText(59 * S + 1)).toBe('1 min')
    expect(countdownText(3 * M)).toBe('3 min')
    expect(countdownText(59.4 * M)).toBe('59 min')
    expect(countdownText(59.6 * M)).toBe('1 h')
    expect(countdownText(3 * H)).toBe('3 h')
    expect(countdownText(23.4 * H)).toBe('23 h')
    expect(countdownText(24 * H)).toBe('1 d')
  })

  it('ticks on the next whole second under a minute, every 30 s above it, and lands on the minute boundary', () => {
    expect(countdownNextTick(14_300)).toBe(300)
    expect(countdownNextTick(14_000)).toBe(1000)
    expect(countdownNextTick(0.4)).toBe(1)
    expect(countdownNextTick(60_500)).toBe(1500)
    expect(countdownNextTick(3 * H)).toBe(30 * S)
    expect(countdownNextTick(0)).toBeNull()
  })

  it('announces at 60, 30 and 10 seconds and at zero — not every second', () => {
    expect(countdownStep(3 * M)).toBeNull()
    expect(countdownStep(60 * S)).toBe(60)
    expect(countdownStep(31 * S)).toBe(60)
    expect(countdownStep(30 * S)).toBe(30)
    expect(countdownStep(10 * S)).toBe(10)
    expect(countdownStep(1)).toBe(10)
    expect(countdownStep(0)).toBe(0)
  })

  it('the snapshot changes only with the words or the step', () => {
    expect(countdownSnapshot(3 * H)).toBe(countdownSnapshot(3 * H - 20 * S))
    expect(countdownSnapshot(14_000)).not.toBe(countdownSnapshot(13_000))
    expect(readCountdownSnapshot(countdownSnapshot(14_000))).toEqual({ done: false, text: '14 s', step: 30 })
    expect(readCountdownSnapshot(countdownSnapshot(3 * H))).toEqual({ done: false, text: '3 h', step: null })
    expect(readCountdownSnapshot(countdownSnapshot(0))).toEqual({ done: true, text: '0 s', step: 0 })
  })
})

/** A hand-driven clock: one list of timers, a visibility flag, nothing real. */
function fakeClock(start = 0) {
  let t = start
  let hidden = false
  const timers = new Map<number, { at: number; run: () => void }>()
  let id = 0
  const watchers = new Set<() => void>()
  const clock: CountdownClock = {
    now: () => t,
    setTimeout: (run, ms) => { timers.set(++id, { at: t + ms, run }); return id },
    clearTimeout: (h) => { timers.delete(h as number) },
    hidden: () => hidden,
    onVisibilityChange: (run) => { watchers.add(run); return () => watchers.delete(run) },
  }
  return {
    clock,
    pending: () => [...timers.values()].map((x) => x.at - t),
    /** Move time forward, firing every timer that falls due on the way. */
    advance(ms: number) {
      const end = t + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        t = due[1].at
        due[1].run()
      }
      t = end
    },
    setHidden(h: boolean) { hidden = h; for (const w of [...watchers]) w() },
  }
}

describe('the shared ticker', () => {
  it('ONE timer for many countdowns, armed for the soonest change', () => {
    const f = fakeClock()
    const ticker = createCountdownTicker(f.clock)
    const offs = Array.from({ length: 50 }, (_, i) => ticker.subscribe(3 * H + i, () => {}))
    expect(ticker.armed()).toBe(1)
    expect(f.pending()).toEqual([30 * S])
    const off = ticker.subscribe(14_300, () => {})
    expect(f.pending()).toEqual([300])
    off()
    expect(f.pending()).toEqual([30 * S])
    offs.forEach((o) => o())
    expect(ticker.armed()).toBe(0)
  })

  it('notifies every second under a minute and stops once everything reached zero', () => {
    const f = fakeClock()
    const ticker = createCountdownTicker(f.clock)
    const seen: number[] = []
    ticker.subscribe(3_000, () => seen.push(ticker.now()))
    seen.length = 0 // the catch-up tick on subscribe
    f.advance(3_000)
    expect(seen).toEqual([1_000, 2_000, 3_000])
    expect(ticker.armed()).toBe(0)
  })

  it('pauses while the tab is hidden and catches up once when it returns', () => {
    const f = fakeClock()
    const ticker = createCountdownTicker(f.clock)
    let calls = 0
    ticker.subscribe(10 * M, () => { calls++ })
    calls = 0
    f.setHidden(true)
    expect(ticker.armed()).toBe(0)
    f.advance(5 * M)
    expect(calls).toBe(0)
    f.setHidden(false)
    expect(calls).toBe(1)
    expect(ticker.now()).toBe(5 * M)
    expect(ticker.armed()).toBe(1)
  })

  it('a newcomer reads a fresh clock, not one up to 30 s old', () => {
    const f = fakeClock()
    const ticker = createCountdownTicker(f.clock)
    ticker.subscribe(3 * H, () => {})
    f.advance(20 * S) // no tick due yet: the reading is 0
    expect(ticker.now()).toBe(0)
    ticker.subscribe(3 * H, () => {})
    expect(ticker.now()).toBe(20 * S)
  })
})

describe('Countdown markup', () => {
  it('renders the words with a machine-readable instant and a quiet live region', () => {
    const html = render(createElement(Countdown, { to: 14_000, now: 0, label: (t: string) => `Runs in ${t}` }))
    expect(html).toContain('<time dateTime="1970-01-01T00:00:14.000Z">Runs in 14 s</time>')
    expect(html).toContain('<span class="nds-vh" aria-live="polite" aria-atomic="true"></span>')
  })

  it('done words at zero; the instant itself on a server render without a clock; a dash for no time', () => {
    expect(render(createElement(Countdown, { to: 5_000, now: 9_000, doneLabel: 'Starting…' }))).toContain('class="nds-countdown done"')
    expect(render(createElement(Countdown, { to: '2026-10-05T12:00:00Z' }))).toContain('>2026-10-05T12:00:00.000Z</time>')
    expect(render(createElement(Countdown, { to: 'not a time', announce: false }))).toBe('<span class="nds-countdown"><time>—</time></span>')
  })
})
