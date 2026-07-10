import { describe, it, expect, beforeEach } from 'vitest'
import {
  setFlatFileDirtyCount, getFlatFileDirtyCount, shouldConfirmLeave, channelSwitchMessage,
} from './unsaved-guard'

describe('unsaved-guard', () => {
  beforeEach(() => setFlatFileDirtyCount(0))

  it('starts clean — no confirm', () => {
    expect(getFlatFileDirtyCount()).toBe(0)
    expect(shouldConfirmLeave()).toBe(false)
  })

  it('publishing a dirty count arms the guard', () => {
    setFlatFileDirtyCount(3)
    expect(getFlatFileDirtyCount()).toBe(3)
    expect(shouldConfirmLeave()).toBe(true)
  })

  it('resetting to 0 (grid unmount / after save) disarms it', () => {
    setFlatFileDirtyCount(5)
    setFlatFileDirtyCount(0)
    expect(shouldConfirmLeave()).toBe(false)
  })

  it('clamps garbage input to 0', () => {
    setFlatFileDirtyCount(-2)
    expect(getFlatFileDirtyCount()).toBe(0)
    setFlatFileDirtyCount(NaN)
    expect(getFlatFileDirtyCount()).toBe(0)
  })

  it('floors fractional counts', () => {
    setFlatFileDirtyCount(2.9)
    expect(getFlatFileDirtyCount()).toBe(2)
  })

  it('message copy is honest about drafts and pluralizes', () => {
    expect(channelSwitchMessage(1)).toBe(
      'You have 1 unsaved change on this sheet. Edits are kept as a local draft and restored when you come back. Switch channel?',
    )
    expect(channelSwitchMessage(4)).toContain('4 unsaved changes')
    expect(channelSwitchMessage(4)).toContain('local draft')
  })
})
