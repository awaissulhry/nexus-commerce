import { describe, expect, it, vi } from 'vitest'
import { closeStudioRecord } from './recordClose'

describe('studio record close guard', () => {
  it.each([0, 1])('keeps the drawer open when an editor blocks close (opened=%s)', (opened) => {
    const back = vi.fn(), clear = vi.fn()
    expect(closeStudioRecord({ opened, canChangeEditor: () => false, back, clear })).toBe(opened)
    expect(back).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
  })

  it('steps back after an in-session drawer is safe to close', () => {
    const back = vi.fn(), clear = vi.fn()
    expect(closeStudioRecord({ opened: 2, canChangeEditor: () => true, back, clear })).toBe(1)
    expect(back).toHaveBeenCalledOnce()
    expect(clear).not.toHaveBeenCalled()
  })

  it('clears a deep-linked record after its editor is safe to close', () => {
    const back = vi.fn(), clear = vi.fn()
    expect(closeStudioRecord({ opened: 0, canChangeEditor: () => true, back, clear })).toBe(0)
    expect(clear).toHaveBeenCalledOnce()
    expect(back).not.toHaveBeenCalled()
  })
})
