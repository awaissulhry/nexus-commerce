import { describe, expect, it } from 'vitest'
import { holdsCheck, materialReadinessCheck, shortWithReadiness, type MaterialReadinessFact } from './blockers'
import { materialLines, releaseChecklist, RELEASE_CHECKS, type MaterialFacts } from './release'

/** B-W2a-46 (MES-004): the release's W2a blockers — holds, and the plan's readiness beside W1's material check. */

const leather: MaterialFacts = { itemId: 'item-lea', itemColourId: 'col-red', label: 'LEA RED', baseUom: 'FT2', planned: '48', issued: '0', usable: '10', committed: '0', held: [] }
const thread: MaterialFacts = { itemId: 'item-thr', itemColourId: null, label: 'THR', baseUom: 'M', planned: '100', issued: '0', usable: '500', committed: '0', held: [] }
const word = (itemId: string, itemColourId: string | null, value: MaterialReadinessFact['word'], date: string | null = null): MaterialReadinessFact => ({ itemId, itemColourId, word: value, date: date as MaterialReadinessFact['date'], reason: `${itemId} is ${value}.` })

describe('the release checks (W2a)', () => {
  it('lists HOLDS last, after the W1 checks, so the record keeps its order', () => {
    expect(RELEASE_CHECKS.at(-1)).toBe('HOLDS')
    expect(RELEASE_CHECKS).toHaveLength(10)
  })
})

describe('holdsCheck', () => {
  it('passes a work order no hold names', () => {
    expect(holdsCheck('WO-1', [])).toEqual({ code: 'HOLDS', state: 'OK', message: 'Work order WO-1 is not on hold.', problems: [] })
  })

  it('blocks with each hold, its reason and day, and is never overridden', () => {
    const check = holdsCheck('WO-1', [
      { holdId: 'h-1', reason: 'Customer request', placedAt: '2026-11-02T08:00:00.000Z' },
      { holdId: null, reason: 'Nonconformance NC-4', placedAt: '2026-11-03T09:00:00.000Z' },
    ])
    expect(check.state).toBe('BLOCKED')
    expect(check.message).toBe('Work order WO-1 is on hold (Customer request; Nonconformance NC-4): it is released only after quality releases its 2 holds.')
    expect(check.problems).toEqual([
      { path: 'holds/h-1', message: 'On hold since 2026-11-02: Customer request. Quality releases the hold first.' },
      { path: 'checks/HOLDS', message: 'On hold since 2026-11-03: Nonconformance NC-4. Quality releases the hold first.' },
    ])
    expect(releaseChecklist([check]).releasable).toBe(false)
  })
})

describe('materialReadinessCheck', () => {
  const lines = materialLines([leather, thread])

  it('keeps W1 when nothing is short, or when the plan is not read', () => {
    const covered = materialLines([thread])
    expect(materialReadinessCheck(covered, [], null).state).toBe('OK')
    expect(materialReadinessCheck(lines, null, null).state).toBe('BLOCKED')
  })

  it('lets a shortage pass that the plan expects in time (a sent purchase order) or holds for this work order', () => {
    const check = materialReadinessCheck(lines, [word('item-lea', 'col-red', 'EXPECTED', '2026-11-12'), word('item-thr', null, 'NOT_BOOKED')], null)
    expect(check).toMatchObject({ code: 'MATERIAL', state: 'OK', problems: [] })
    expect(check.message).toBe('1 material(s) short on hand now are expected in time (the last by 2026-11-12) or set aside for this work order: item-lea is EXPECTED.')
    expect(materialReadinessCheck(lines, [word('item-lea', 'col-red', 'RECEIVED')], null).state).toBe('OK')
  })

  it.each(['NOT_ENOUGH', 'DELAYED', 'REQUESTED', 'NOT_BOOKED'] as const)('blocks a shortage the plan calls %s, in W1 words, and passes it only with the override', (value) => {
    const readiness = [word('item-lea', 'col-red', value)]
    const blocked = materialReadinessCheck(lines, readiness, null)
    expect(blocked.state).toBe('BLOCKED')
    expect(blocked.problems).toEqual([{ path: 'materials/item-lea/col-red', message: 'LEA RED: 48 FT2 needed, 10 usable on hand and 0 promised to other released work orders, so 38 FT2 short.' }])
    expect(materialReadinessCheck(lines, readiness, { reason: 'Hides arrive Monday, cut Tuesday' }).state).toBe('OVERRIDDEN')
  })

  it('blocks when the plan knows nothing of a short material (NOT_PLANNED is not a pass either)', () => {
    expect(materialReadinessCheck(lines, [word('item-thr', null, 'RECEIVED')], null).state).toBe('BLOCKED')
    expect(shortWithReadiness(lines, [])).toEqual([{ line: lines[0], readiness: undefined }])
  })
})
