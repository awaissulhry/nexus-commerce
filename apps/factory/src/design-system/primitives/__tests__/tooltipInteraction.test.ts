import { describe, expect, it } from 'vitest'
import { nextTooltipInteraction, type TooltipInteractionEvent } from '../tooltipInteraction'

function interact(...events: TooltipInteractionEvent[]) {
  return events.reduce(nextTooltipInteraction, { open: false, keyboardFocus: false, suppressed: false })
}

describe('portal tooltip dismissal', () => {
  it('stays closed when a drawer restores focus after pointer activation', () => {
    expect(interact('pointer-enter', 'dismiss', 'pointer-focus', 'blur', 'keyboard-focus').open).toBe(false)
  })

  it('stays closed when a drawer restores focus after keyboard activation', () => {
    expect(interact('keyboard-focus', 'dismiss', 'blur', 'keyboard-focus').open).toBe(false)
  })

  it('does not reopen when a closing overlay exposes the stationary pointer', () => {
    expect(interact('pointer-enter', 'dismiss', 'blur', 'pointer-enter').open).toBe(false)
  })

  it('dismisses immediately even while the trigger keeps focus and hover', () => {
    expect(interact('keyboard-focus', 'pointer-enter', 'dismiss').open).toBe(false)
    expect(interact('keyboard-focus', 'dismiss', 'pointer-leave').open).toBe(false)
  })

  it('reopens for a fresh keyboard visit after dismissal', () => {
    expect(interact('keyboard-focus', 'dismiss', 'blur', 'keyboard-focus', 'keyboard-navigation', 'blur', 'keyboard-focus').open).toBe(true)
  })

  it('reopens after the user moves the pointer again', () => {
    expect(interact('pointer-enter', 'dismiss', 'blur', 'pointer-enter', 'pointer-move').open).toBe(true)
  })

  it('does not let restored focus keep a later hover hint open after pointer exit', () => {
    expect(interact('keyboard-focus', 'dismiss', 'blur', 'keyboard-focus', 'pointer-move', 'pointer-leave').open).toBe(false)
    expect(interact('keyboard-focus', 'dismiss', 'pointer-move', 'pointer-leave').open).toBe(false)
  })

  it('hides on pointer exit without treating click focus as keyboard focus', () => {
    expect(interact('pointer-enter', 'pointer-focus', 'pointer-leave').open).toBe(false)
    expect(interact('pointer-enter', 'pointer-leave').open).toBe(false)
  })

  it('preserves a keyboard hint until blur or explicit dismissal', () => {
    expect(interact('keyboard-focus', 'pointer-enter', 'pointer-leave').open).toBe(true)
    expect(interact('keyboard-focus', 'blur').open).toBe(false)
  })
})
