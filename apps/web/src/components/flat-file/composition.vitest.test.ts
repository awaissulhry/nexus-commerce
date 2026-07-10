import { describe, it, expect } from 'vitest'
import { isComposingKeyEvent } from './composition'

describe('isComposingKeyEvent', () => {
  it('is true while a composition is active (isComposing)', () => {
    expect(isComposingKeyEvent({ isComposing: true, keyCode: 74 })).toBe(true)
  })

  it('is true for the composition-starting keystroke (keyCode 229, isComposing still false)', () => {
    expect(isComposingKeyEvent({ isComposing: false, keyCode: 229 })).toBe(true)
  })

  it('is true for the Safari post-compositionend Enter quirk (keyCode 229)', () => {
    expect(isComposingKeyEvent({ isComposing: false, keyCode: 229 })).toBe(true)
  })

  it('is false for a plain keystroke', () => {
    expect(isComposingKeyEvent({ isComposing: false, keyCode: 65 })).toBe(false)
  })

  it('is false when the fields are absent (defensive)', () => {
    expect(isComposingKeyEvent({})).toBe(false)
  })
})
