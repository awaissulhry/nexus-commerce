import { afterEach, describe, expect, it, vi } from 'vitest'

import { confirmFeedback, FEEDBACK_FLASH_MS, FEEDBACK_TONES, FEEDBACK_VIBRATION } from './confirmFeedback'

/** A stand-in AudioContext that records the oscillators it was asked for. */
function fakeAudio() {
  const started: { wave: string; hz: number }[] = []
  class FakeParam {
    value = 0
    setValueAtTime(v: number) {
      this.value = v
      return this
    }
    exponentialRampToValueAtTime() {
      return this
    }
  }
  class FakeContext {
    static made = 0
    state = 'running'
    currentTime = 0
    destination = {}
    constructor() {
      FakeContext.made++
    }
    resume() {
      return Promise.resolve()
    }
    createOscillator() {
      const osc = {
        type: 'sine',
        frequency: new FakeParam(),
        connect: () => undefined,
        start: () => started.push({ wave: osc.type, hz: osc.frequency.value }),
        stop: () => undefined,
      }
      return osc
    }
    createGain() {
      return { gain: new FakeParam(), connect: () => undefined }
    }
  }
  return { FakeContext, started }
}

/** A stand-in element: just the attribute calls the flash uses. */
function fakeElement() {
  const attrs = new Map<string, string>()
  return {
    attrs,
    offsetWidth: 0,
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    getAttribute: (k: string) => attrs.get(k) ?? null,
    removeAttribute: (k: string) => void attrs.delete(k),
  } as unknown as Element & { attrs: Map<string, string> }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('confirm feedback (G8)', () => {
  it('in a bare runtime (no vibrate, no AudioContext, no target) it does nothing and never throws', () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('AudioContext', undefined)
    vi.stubGlobal('webkitAudioContext', undefined)
    vi.stubGlobal('matchMedia', undefined)
    for (const kind of ['success', 'warning', 'error'] as const) {
      expect(confirmFeedback(kind)).toEqual({ flashed: false, vibrated: false, sounded: false, reducedMotion: false })
    }
  })

  it('vibrates with the pattern of its kind and plays its tones through WebAudio', () => {
    const vibrate = vi.fn(() => true)
    const { FakeContext, started } = fakeAudio()
    vi.stubGlobal('navigator', { vibrate })
    vi.stubGlobal('AudioContext', FakeContext)

    const r = confirmFeedback('error')
    expect(r).toMatchObject({ vibrated: true, sounded: true })
    expect(vibrate).toHaveBeenCalledWith([...FEEDBACK_VIBRATION.error])
    expect(started).toEqual(FEEDBACK_TONES.error.map((t) => ({ wave: t.wave, hz: t.hz })))

    started.length = 0
    confirmFeedback('success')
    expect(started.map((s) => s.hz)).toEqual([880, 1320])
    // One AudioContext for the page, however many sounds.
    expect(FakeContext.made).toBe(1)
  })

  it('muted: no sound, but it still vibrates and flashes', () => {
    const vibrate = vi.fn(() => true)
    const { FakeContext, started } = fakeAudio()
    vi.stubGlobal('navigator', { vibrate })
    vi.stubGlobal('AudioContext', FakeContext)
    const el = fakeElement()
    const r = confirmFeedback('warning', { target: el, muted: true })
    expect(r).toMatchObject({ flashed: true, vibrated: true, sounded: false })
    expect(started).toHaveLength(0)
    expect(vibrate).toHaveBeenCalledTimes(1)
  })

  it('haptics off: no vibration', () => {
    const vibrate = vi.fn(() => true)
    vi.stubGlobal('navigator', { vibrate })
    expect(confirmFeedback('success', { haptics: false }).vibrated).toBe(false)
    expect(vibrate).not.toHaveBeenCalled()
  })

  it('a throwing vibrate or AudioContext is skipped, not thrown', () => {
    vi.stubGlobal('navigator', {
      vibrate: () => {
        throw new Error('blocked')
      },
    })
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          throw new Error('no audio')
        }
      },
    )
    expect(confirmFeedback('error')).toMatchObject({ vibrated: false, sounded: false })
  })

  it('flashes the target with its kind, then takes the colour off again', () => {
    vi.useFakeTimers()
    const el = fakeElement()
    confirmFeedback('success', { target: el, muted: true, haptics: false })
    expect(el.attrs.get('data-nds-feedback')).toBe('success')
    // A second answer on the same element restarts the flash with the new kind.
    confirmFeedback('error', { target: el, muted: true, haptics: false })
    expect(el.attrs.get('data-nds-feedback')).toBe('error')
    vi.advanceTimersByTime(FEEDBACK_FLASH_MS - 1)
    expect(el.attrs.get('data-nds-feedback')).toBe('error')
    vi.advanceTimersByTime(1)
    expect(el.attrs.has('data-nds-feedback')).toBe(false)
  })

  it('reports prefers-reduced-motion, so the colour holds still instead of flashing', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }))
    expect(confirmFeedback('success', { muted: true, haptics: false }).reducedMotion).toBe(true)
  })
})
