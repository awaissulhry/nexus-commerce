import { describe, expect, it, vi } from 'vitest'

import { createIdleTimer, type IdleClock, type IdleSnapshot } from './idleTimer'

/** A clock that only moves when the test says so, running due timers in order. */
function fakeClock(start = 0) {
  let now = start
  let seq = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  const clock: IdleClock = {
    now: () => now,
    setTimeout: (run, ms) => {
      const id = ++seq
      timers.set(id, { at: now + ms, run })
      return id
    },
    clearTimeout: (h) => void timers.delete(h as number),
  }
  const advance = (ms: number) => {
    const end = now + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0])
      now = due[1].at
      due[1].run()
    }
    now = end
  }
  return { clock, advance, armed: () => timers.size }
}

const S = 1000

describe('idle sign-out (G2)', () => {
  it('warns after the idle time, counts the warning down second by second, then signs out once', () => {
    const { clock, advance, armed } = fakeClock()
    const seen: IdleSnapshot[] = []
    const onExpire = vi.fn()
    const t = createIdleTimer({ idleMs: 120 * S, warnMs: 30 * S, clock, onChange: (s) => seen.push(s), onExpire })

    advance(119 * S)
    expect(t.snapshot()).toEqual({ phase: 'active', secondsLeft: 0 })
    advance(1 * S)
    expect(t.snapshot()).toEqual({ phase: 'warning', secondsLeft: 30 })
    advance(1 * S)
    expect(t.snapshot().secondsLeft).toBe(29)
    advance(28 * S)
    expect(t.snapshot().secondsLeft).toBe(1)
    expect(onExpire).not.toHaveBeenCalled()
    advance(1 * S)
    expect(t.snapshot()).toEqual({ phase: 'expired', secondsLeft: 0 })
    expect(onExpire).toHaveBeenCalledTimes(1)
    expect(armed()).toBe(0)
    // Every second of the warning was reported, 30 … 1, then the end.
    expect(seen.map((s) => s.secondsLeft)).toEqual([...Array.from({ length: 30 }, (_, i) => 30 - i), 0])
    advance(600 * S)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('a touch while active pushes the warning back by the whole idle time', () => {
    const { clock, advance } = fakeClock()
    const t = createIdleTimer({ idleMs: 60 * S, warnMs: 10 * S, clock, onExpire: vi.fn() })
    advance(50 * S)
    t.activity()
    advance(50 * S)
    expect(t.snapshot().phase).toBe('active')
    advance(10 * S)
    expect(t.snapshot().phase).toBe('warning')
  })

  it('a touch during the warning does not end it; only "I am here" does', () => {
    const { clock, advance } = fakeClock()
    const onExpire = vi.fn()
    const t = createIdleTimer({ idleMs: 60 * S, warnMs: 10 * S, clock, onExpire })
    advance(65 * S)
    t.activity()
    expect(t.snapshot()).toEqual({ phase: 'warning', secondsLeft: 5 })
    t.stay()
    expect(t.snapshot()).toEqual({ phase: 'active', secondsLeft: 0 })
    advance(59 * S)
    expect(t.snapshot().phase).toBe('active')
    advance(1 * S + 10 * S)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('stop() arms nothing more and never signs out', () => {
    const { clock, advance, armed } = fakeClock()
    const onExpire = vi.fn()
    const t = createIdleTimer({ idleMs: 10 * S, warnMs: 5 * S, clock, onExpire })
    t.stop()
    expect(armed()).toBe(0)
    advance(60 * S)
    t.stay()
    advance(60 * S)
    expect(onExpire).not.toHaveBeenCalled()
  })

  it('keeps one timer armed at a time, however many touches arrive', () => {
    const { clock, advance, armed } = fakeClock()
    const t = createIdleTimer({ idleMs: 60 * S, warnMs: 10 * S, clock, onExpire: vi.fn() })
    for (let i = 0; i < 500; i++) {
      t.activity()
      advance(100)
    }
    expect(armed()).toBe(1)
  })
})
