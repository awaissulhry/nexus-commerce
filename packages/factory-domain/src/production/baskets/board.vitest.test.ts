import { describe, expect, it } from 'vitest'
import { standingKey } from '../scans/rules'
import { boardColumns, nextToReport, slowestStep, teamNumbers } from './board'

/** owb-fl4 (S5 server B): the Baskets board's columns, the team's numbers, the chain's slowest step and "+12". */

const dept = (id: string, number: number, floorReady = true, status = 'ACTIVE') => ({ id, number, seq: number, floorReady, status })
const DEPARTMENTS = [dept('d4', 4), dept('d1', 1), dept('d2', 2), dept('d8', 8, false), dept('d9', 9, false), dept('d3', 3, true, 'CLOSED')]

describe('boardColumns', () => {
  it('one column per department in use: the floor’s departments plus any other on a listed basket’s route, in order', () => {
    const items = [
      { id: 'b1', departmentId: 'd1', ready: false, routeDepartmentIds: ['d1', 'd2', 'd8'] },
      { id: 'b2', departmentId: 'd2', ready: false, routeDepartmentIds: ['d1', 'd2'] },
      { id: 'b3', departmentId: null, ready: true, routeDepartmentIds: ['d1', 'd2'] },
    ]
    const board = boardColumns(DEPARTMENTS, items)
    expect(board.columns.map((column) => column.department.id)).toEqual(['d1', 'd2', 'd4', 'd8'])
    expect(board.columns.find((column) => column.department.id === 'd1')!.baskets.map((item) => item.id)).toEqual(['b1'])
    expect(board.readyToShip.map((item) => item.id)).toEqual(['b3'])
    expect(board.elsewhere).toEqual([])
  })

  it('a closed department shows only while a basket stands in it; a basket of no department is kept apart', () => {
    const board = boardColumns(DEPARTMENTS, [
      { id: 'b1', departmentId: 'd3', ready: false, routeDepartmentIds: ['d3'] },
      { id: 'b2', departmentId: null, ready: false, routeDepartmentIds: [] },
    ])
    expect(board.columns.map((column) => column.department.id)).toEqual(['d1', 'd2', 'd3', 'd4'])
    expect(board.elsewhere.map((item) => item.id)).toEqual(['b2'])
  })
})

describe('teamNumbers', () => {
  it('counts the team’s live baskets: working, waiting (paused too), late, problem; Ready to ship counts nowhere', () => {
    expect(
      teamNumbers([
        { state: 'WORKING', late: true, problem: false, ready: false },
        { state: 'PAUSED', late: false, problem: true, ready: false },
        { state: 'WAITING', late: false, problem: false, ready: false },
        { state: 'WAITING', late: true, problem: true, ready: true },
      ]),
    ).toEqual({ working: 1, waiting: 2, late: 1, problem: 1 })
  })
})

describe('slowestStep', () => {
  it('the step where most garments wait; ties go to the earlier step; nothing waits → null', () => {
    expect(slowestStep([{ operationId: 'o1', waiting: 12 }, { operationId: 'o2', waiting: 36 }, { operationId: 'o3', waiting: 36 }])).toBe('o2')
    expect(slowestStep([{ operationId: 'o1', waiting: 0 }])).toBeNull()
  })
})

describe('nextToReport ("+12", settle 10)', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 10, 28, 8, minutes))
  const bundles = [
    { id: 'b1', workOrderSizeId: 'c48', status: 'ACTIVE', createdAt: at(1) },
    { id: 'b2', workOrderSizeId: 'c48', status: 'ACTIVE', createdAt: at(2) },
    { id: 'b3', workOrderSizeId: 'c48', status: 'VOID', createdAt: at(0) },
    { id: 'b4', workOrderSizeId: 'c50', status: 'ACTIVE', createdAt: at(0) },
  ]
  it('the oldest ACTIVE bundle of the cell that reached the step and is not reported there', () => {
    const standing = new Set([standingKey('b1', 'cut'), standingKey('b2', 'cut'), standingKey('b1', 'sew')])
    expect(nextToReport(bundles, { workOrderSizeId: 'c48', operationId: 'sew', previousOperationIds: ['cut'], standing })?.id).toBe('b2')
  })
  it('one that reached it first; else the oldest left; every one done → null', () => {
    const standing = new Set([standingKey('b2', 'cut')])
    expect(nextToReport(bundles, { workOrderSizeId: 'c48', operationId: 'sew', previousOperationIds: ['cut'], standing })?.id).toBe('b2')
    expect(nextToReport(bundles, { workOrderSizeId: 'c48', operationId: 'sew', previousOperationIds: ['cut'], standing: new Set() })?.id).toBe('b1')
    const done = new Set([standingKey('b1', 'sew'), standingKey('b2', 'sew')])
    expect(nextToReport(bundles, { workOrderSizeId: 'c48', operationId: 'sew', previousOperationIds: ['cut'], standing: done })).toBeNull()
  })
})
