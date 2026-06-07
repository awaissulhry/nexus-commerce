import { describe, it, expect } from 'vitest'
import { reconcileColPrefs } from './matrixColumnPrefs'
import type { AmazonSlot } from './useAmazonImages'

// Literal canonical list (avoids importing the runtime ALL_SLOTS value, which
// would pull React into the node test env).
const CANON = ['MAIN', 'PT01', 'PT02', 'SWCH', 'PS01'] as AmazonSlot[]

describe('reconcileColPrefs', () => {
  it('defaults to every slot visible when nothing is stored', () => {
    const r = reconcileColPrefs(null, CANON)
    expect(r.length).toBe(CANON.length)
    expect(r.every((p) => p.visible)).toBe(true)
  })

  it('keeps stored order + visibility, appends new slots as visible', () => {
    const r = reconcileColPrefs([{ slot: 'PT01' as AmazonSlot, visible: false }, { slot: 'MAIN' as AmazonSlot, visible: true }], CANON)
    expect(r[0]!.slot).toBe('PT01')
    expect(r[0]!.visible).toBe(false)
    expect(r[1]!.slot).toBe('MAIN')
    expect(r.length).toBe(CANON.length)
    expect(r.find((p) => p.slot === 'SWCH')?.visible).toBe(true)
  })

  it('forces MAIN visible even if stored hidden', () => {
    const r = reconcileColPrefs([{ slot: 'MAIN' as AmazonSlot, visible: false }], CANON)
    expect(r.find((p) => p.slot === 'MAIN')?.visible).toBe(true)
  })

  it('drops stale slots not in the canonical list', () => {
    const r = reconcileColPrefs([{ slot: 'ZZ99' as AmazonSlot, visible: true }], CANON)
    expect(r.find((p) => (p.slot as string) === 'ZZ99')).toBeUndefined()
    expect(r.length).toBe(CANON.length)
  })

  it('min-visible guard restores MAIN when all hidden', () => {
    const r = reconcileColPrefs(CANON.map((slot) => ({ slot, visible: false })), CANON)
    expect(r.some((p) => p.visible)).toBe(true)
    expect(r.find((p) => p.slot === 'MAIN')?.visible).toBe(true)
  })
})
