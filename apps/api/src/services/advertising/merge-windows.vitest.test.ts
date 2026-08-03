import { describe, it, expect } from 'vitest'
import { mergeWindows, isUsableWindow } from './merge-windows.js'
import { resolveActiveTargetKey } from './rank-controller.js'

const W = (days: number[], startHour: number, endHour: number, targetKey: string) => ({ days, startHour, endHour, targetKey })

describe('mergeWindows', () => {
  it('keeps every existing window — the plan is added to, never replaced', () => {
    const existing = [W([1], 9, 12, 'own-top'), W([2], 9, 12, 'own-top'), W([3], 9, 12, 'own-top')]
    const { windows } = mergeWindows(existing, [W([1], 18, 22, 'defend')], 'rest')
    expect(windows).toHaveLength(4)
    // apply-template would have left exactly ONE window here; every original survives.
    for (const w of existing) expect(windows).toContainEqual(w)
  })

  it('painted hours win where they overlap, because first-match wins', () => {
    const existing = [W([1], 0, 24, 'own-top')]
    const painted = [W([1], 18, 22, 'defend')]
    const { windows, diff } = mergeWindows(existing, painted, null)
    expect(resolveActiveTargetKey(windows, null, 1, 19)).toBe('defend')
    expect(resolveActiveTargetKey(windows, null, 1, 17)).toBe('own-top')
    // endHour EXCLUSIVE, same as the engine
    expect(resolveActiveTargetKey(windows, null, 1, 22)).toBe('own-top')
    expect(diff.retargetedHours).toBe(4)
    expect(diff.addedHours).toBe(0)
  })

  it('separates hours GAINED from hours RETARGETED — they are different decisions', () => {
    const existing = [W([1], 9, 12, 'own-top')]
    const painted = [W([1], 10, 14, 'defend')]
    const { diff } = mergeWindows(existing, painted, null)
    // 10:00 and 11:00 were own-top → defend; 12:00 and 13:00 had nothing at all
    expect(diff.retargetedHours).toBe(2)
    expect(diff.addedHours).toBe(2)
    expect(diff.unchangedHours).toBe(168 - 4)
    expect(diff.changed).toContainEqual({ dow: 1, hour: 10, from: 'own-top', to: 'defend' })
    expect(diff.changed).toContainEqual({ dow: 1, hour: 12, from: null, to: 'defend' })
  })

  it('counts a baseline hour as retargeted, not added', () => {
    // With a baseline every hour already resolves to something, so nothing is ever "added".
    const { diff } = mergeWindows([], [W([1], 0, 3, 'defend')], 'rest')
    expect(diff.addedHours).toBe(0)
    expect(diff.retargetedHours).toBe(3)
    expect(diff.byTarget).toEqual([
      { key: 'rest', gained: 0, lost: 3, net: -3 },
      { key: 'defend', gained: 3, lost: 0, net: 3 },
    ].sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || b.gained - a.gained))
  })

  it('reports no change when the paint matches what is already there', () => {
    const existing = [W([1], 18, 22, 'defend')]
    const { diff } = mergeWindows(existing, [W([1], 18, 22, 'defend')], null)
    expect(diff.changed).toEqual([])
    expect(diff.unchangedHours).toBe(168)
    expect(diff.byTarget).toEqual([])
  })

  it('preserves bidMultiplierPct on classic windows — a re-collapse would have dropped it', () => {
    const classic = [{ days: [1], startHour: 9, endHour: 12, bidMultiplierPct: 130 }]
    const { windows } = mergeWindows(classic, [W([1], 18, 22, 'defend')], null)
    expect(windows).toContainEqual({ days: [1], startHour: 9, endHour: 12, bidMultiplierPct: 130 })
  })

  it('is reversible — dropping the prepended entries restores the original plan', () => {
    const existing = [W([1], 0, 24, 'own-top'), W([2], 0, 24, 'own-top')]
    const painted = [W([1], 18, 22, 'defend')]
    const { windows } = mergeWindows(existing, painted, null)
    expect(windows.slice(painted.length)).toEqual(existing)
  })

  it('ignores unusable painted windows rather than writing them', () => {
    expect(isUsableWindow({ days: [1], startHour: 5, endHour: 5, targetKey: 'x' })).toBe(false) // empty
    expect(isUsableWindow({ days: [1], startHour: 5, endHour: 4, targetKey: 'x' })).toBe(false) // inverted
    expect(isUsableWindow({ days: [1], startHour: 0, endHour: 25, targetKey: 'x' })).toBe(false) // out of range
    expect(isUsableWindow({ days: [1], startHour: 5, endHour: 6 })).toBe(false) // no target
    expect(isUsableWindow(null)).toBe(false)
    expect(isUsableWindow(W([1], 5, 6, 'x'))).toBe(true)

    const { windows, diff } = mergeWindows([], [{ days: [1], startHour: 5, endHour: 5, targetKey: 'x' }], null)
    expect(windows).toEqual([])
    expect(diff.changed).toEqual([])
  })

  it('treats an empty days array as every day, matching the engine', () => {
    const { diff } = mergeWindows([], [{ days: [], startHour: 0, endHour: 1, targetKey: 'defend' }], null)
    expect(diff.addedHours).toBe(7)
  })
})
