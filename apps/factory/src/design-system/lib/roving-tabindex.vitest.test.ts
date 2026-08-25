import { describe, expect, it } from 'vitest'
import { rovingTabIndex } from './roving-tabindex'

const groupOf = (n: number, selectedIndex: number) =>
  Array.from({ length: n }, (_, i) => rovingTabIndex(i === selectedIndex, selectedIndex, i))

describe('rovingTabIndex', () => {
  it('gives the group exactly one tab stop when something is selected', () => {
    expect(groupOf(4, 2)).toEqual([-1, -1, 0, -1])
  })

  it('🔴 still gives the group a tab stop when NOTHING is selected', () => {
    // the bug this exists for: every item -1 means the control cannot be reached by Tab at all
    const tabs = groupOf(4, -1)
    expect(tabs).toEqual([0, -1, -1, -1])
    expect(tabs.filter((t) => t === 0)).toHaveLength(1)
  })

  it('never produces two tab stops, which would make Tab pass through the group twice', () => {
    for (const sel of [-1, 0, 1, 2, 3]) {
      expect(groupOf(4, sel).filter((t) => t === 0)).toHaveLength(1)
    }
  })

  it('holds for a single-option group', () => {
    expect(groupOf(1, -1)).toEqual([0])
    expect(groupOf(1, 0)).toEqual([0])
  })
})
