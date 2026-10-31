import { describe, expect, it } from 'vitest'
import { isKitWorkOrder, kitActions, kitHeldWords, stagingProblem } from './rules'

describe('kit staging (B-W2b-15; SCM-213)', () => {
  it('stages and checks a kit only while the work order is picked for', () => {
    expect(['RELEASED', 'IN_PROGRESS', 'ON_HOLD'].every(isKitWorkOrder)).toBe(true)
    expect(['DRAFT', 'COMPLETED', 'CLOSED', 'CANCELLED'].some(isKitWorkOrder)).toBe(false)
    const done = kitActions({ workOrderStatus: 'COMPLETED', lines: 3, short: 0, checked: false })
    expect(done).toEqual({ stage: { allowed: false, held: 'WORK_ORDER_NOT_OPEN' }, complete: { allowed: false, held: 'WORK_ORDER_NOT_OPEN' }, reopen: { allowed: false, held: 'WORK_ORDER_NOT_OPEN' } })
  })

  it('holds "Mark kit complete" while lines are short (by how many), with nothing planned, or once checked', () => {
    expect(kitActions({ workOrderStatus: 'RELEASED', lines: 3, short: 2, checked: false }).complete).toEqual({ allowed: false, held: 'LINES_SHORT', count: 2 })
    expect(kitActions({ workOrderStatus: 'RELEASED', lines: 0, short: 0, checked: false }).complete).toEqual({ allowed: false, held: 'NOTHING_PLANNED' })
    expect(kitActions({ workOrderStatus: 'IN_PROGRESS', lines: 3, short: 0, checked: false })).toEqual({ stage: { allowed: true, held: null }, complete: { allowed: true, held: null }, reopen: { allowed: false, held: 'NOT_CHECKED' } })
    expect(kitActions({ workOrderStatus: 'ON_HOLD', lines: 3, short: 0, checked: true })).toEqual({ stage: { allowed: true, held: null }, complete: { allowed: false, held: 'ALREADY_CHECKED' }, reopen: { allowed: true, held: null } })
  })

  it('says each refusal in words', () => {
    expect(kitHeldWords('LINES_SHORT', { number: 'WO-1', status: 'RELEASED', count: 2 })).toBe('2 line(s) of work order WO-1 are still short: the kit is checked complete once every line is picked in full.')
    expect(kitHeldWords('WORK_ORDER_NOT_OPEN', { number: 'WO-1', status: 'IN_PROGRESS' })).toContain('is in progress')
  })

  it('stages at a place of the site in use, never a workshop\'s', () => {
    expect(stagingProblem({ siteId: 's1', status: 'ACTIVE', kind: 'PRODUCTION' }, 's1')).toBeNull()
    expect(stagingProblem({ siteId: 's2', status: 'ACTIVE', kind: 'BIN' }, 's1')).toMatch(/site/)
    expect(stagingProblem({ siteId: 's1', status: 'ARCHIVED', kind: 'BIN' }, 's1')).toMatch(/archived/)
    expect(stagingProblem({ siteId: 's1', status: 'ACTIVE', kind: 'SUBCONTRACTOR' }, 's1')).toMatch(/workshop/)
    expect(stagingProblem(null, 's1')).toMatch(/site/)
  })
})
