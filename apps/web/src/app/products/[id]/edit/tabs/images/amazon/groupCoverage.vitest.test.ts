import { describe, it, expect } from 'vitest'
import { computeSlotGroups, groupOf } from './groupCoverage'
import type { AmazonSlot } from './useAmazonImages'

const SLOTS = ['MAIN', 'PT01', 'PT02', 'PS01', 'PS02', 'PS03', 'PS04', 'PS05', 'PS06', 'SWCH'] as AmazonSlot[]

describe('groupOf', () => {
  it('maps slots to groups', () => {
    expect(groupOf('MAIN')).toBe('MAIN')
    expect(groupOf('PT03')).toBe('PT')
    expect(groupOf('PS02')).toBe('PS')
    expect(groupOf('SWCH')).toBe('SWCH')
  })
})

describe('computeSlotGroups', () => {
  it('counts filled slots per group and flags complete', () => {
    const filled = new Set(['MAIN', 'PT01', 'PS01', 'PS02', 'PS03', 'PS04', 'PS05', 'PS06'])
    const groups = computeSlotGroups(SLOTS, (s) => filled.has(s))
    const by = Object.fromEntries(groups.map((g) => [g.key, g]))
    expect(by.MAIN.filledSlots).toBe(1)
    expect(by.MAIN.complete).toBe(true)
    expect(by.PT.filledSlots).toBe(1)
    expect(by.PT.totalSlots).toBe(2)
    expect(by.PT.complete).toBe(false)
    expect(by.PS.filledSlots).toBe(6)
    expect(by.PS.complete).toBe(true)
    expect(by.SWCH.filledSlots).toBe(0)
    expect(by.SWCH.complete).toBe(false)
  })

  it('returns groups in canonical order, omitting empty groups', () => {
    const groups = computeSlotGroups(['MAIN', 'PS01'] as AmazonSlot[], () => false)
    expect(groups.map((g) => g.key)).toEqual(['MAIN', 'PS'])
  })
})
