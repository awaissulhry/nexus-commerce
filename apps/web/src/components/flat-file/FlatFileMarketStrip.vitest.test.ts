/**
 * UFX P5 — Alt+1..N market-switch shortcut matcher (FlatFileMarketStrip).
 * Matches on the physical key (`e.code`) because Option+digit on macOS
 * produces special characters (¡™£¢∞) in `e.key`.
 */
import { describe, it, expect } from 'vitest'
import { matchMarketShortcut } from './market-strip-shortcut'

type Ev = Parameters<typeof matchMarketShortcut>[0]

function ev(partial: Partial<Ev>): Ev {
  return { altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, code: '', ...partial }
}

describe('matchMarketShortcut', () => {
  it('matches Alt+Digit1..N to the 0-based market index', () => {
    expect(matchMarketShortcut(ev({ altKey: true, code: 'Digit1' }), 5)).toBe(0)
    expect(matchMarketShortcut(ev({ altKey: true, code: 'Digit3' }), 5)).toBe(2)
    expect(matchMarketShortcut(ev({ altKey: true, code: 'Digit5' }), 5)).toBe(4)
  })

  it('matches on e.code, so macOS Option+digit works despite the special-char e.key', () => {
    // On macOS, Option+1 fires with key '¡' but code 'Digit1' — the matcher
    // must not care about e.key at all.
    const e = { ...ev({ altKey: true, code: 'Digit1' }), key: '¡' } as Ev & { key: string }
    expect(matchMarketShortcut(e, 5)).toBe(0)
  })

  it('ignores digits beyond the market count', () => {
    expect(matchMarketShortcut(ev({ altKey: true, code: 'Digit6' }), 5)).toBeNull()
    expect(matchMarketShortcut(ev({ altKey: true, code: 'Digit1' }), 0)).toBeNull()
  })

  it('requires Alt and suppresses on any other modifier (meta/ctrl/shift)', () => {
    expect(matchMarketShortcut(ev({ code: 'Digit1' }), 5)).toBeNull()
    expect(matchMarketShortcut(ev({ altKey: true, metaKey: true, code: 'Digit1' }), 5)).toBeNull()
    expect(matchMarketShortcut(ev({ altKey: true, ctrlKey: true, code: 'Digit1' }), 5)).toBeNull()
    expect(matchMarketShortcut(ev({ altKey: true, shiftKey: true, code: 'Digit1' }), 5)).toBeNull()
  })

  it('ignores non-digit and numpad codes', () => {
    expect(matchMarketShortcut(ev({ altKey: true, code: 'KeyA' }), 5)).toBeNull()
    expect(matchMarketShortcut(ev({ altKey: true, code: 'Digit0' }), 5)).toBeNull()
    expect(matchMarketShortcut(ev({ altKey: true, code: 'Numpad1' }), 5)).toBeNull()
    expect(matchMarketShortcut(ev({ altKey: true, code: '' }), 5)).toBeNull()
  })

  it('caps at nine markets even when more are supplied', () => {
    expect(matchMarketShortcut(ev({ altKey: true, code: 'Digit9' }), 12)).toBe(8)
  })
})
