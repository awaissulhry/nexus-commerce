import { describe, expect, it } from 'vitest'
import en from '../../../messages/en/floor-board.json'
import { lineOf, lotAt, plusOf, reportBody, stepOf, undoOpen, undoPayload, UNDO_KIND, UNDO_MS, type LastReport } from '../chains/model'
import type { FloorBoard, FloorBoardCard } from './api'
import { basketPath, boardTabShown, chipsOf, customerCodeOf, firstChip, listOf, READY_CHIP } from './model'

const dept = (number: number, name: string) => ({ id: `dept-${number}`, number, name, shortName: name, nameI18n: null, tone: 'blue', icon: 'ruler' })
const card = (code: string, extra: Partial<FloorBoardCard> = {}): FloorBoardCard => ({ bundleId: `bundle-${code}`, code, picture: null, customerCode: 'SEED', customer: { code: 'SEED' }, step: null, state: 'WAITING', flags: { first: false, late: false, problem: null }, team: null, worker: null, ...extra })

const board: FloorBoard = {
  columns: [
    { department: dept(2, 'Cutting'), baskets: [card('B-0433'), card('B-0431', { flags: { first: true } }), card('B-0432', { flags: { problem: { callId: 'c1' } } })] },
    { department: dept(4, 'Stitching'), baskets: [] },
  ],
  readyToShip: [card('B-0402')],
}

describe('owb-fl9 — the phone\'s Board', () => {
  it('is absent for a worker: only a team leader (floor.lead) has the tab', () => {
    expect(boardTabShown(['floor.work', 'production.scan'])).toBe(false)
    expect(boardTabShown(['floor.work', 'floor.lead'])).toBe(true)
    expect(en.leaderOnly).toMatch(/team leader/)
  })

  it('has a chip per department in use and Ready to ship, each with its count', () => {
    expect(chipsOf(board).map((chip) => [chip.key, chip.count])).toEqual([
      ['dept-2', 3],
      ['dept-4', 0],
      [READY_CHIP, 1],
    ])
    expect(firstChip(chipsOf(board), 'dept-4')).toBe('dept-2')
    expect(firstChip(chipsOf(board), 'dept-2')).toBe('dept-2')
  })

  it('lists Do this first on top, then a problem, then by number; a tap opens the basket; the CODE only', () => {
    expect(listOf(board, 'dept-2').map((entry) => entry.code)).toEqual(['B-0431', 'B-0432', 'B-0433'])
    expect(listOf(board, READY_CHIP).map((entry) => entry.code)).toEqual(['B-0402'])
    expect(customerCodeOf(board.readyToShip[0]!)).toBe('SEED')
    expect(basketPath('B-0431')).toBe('/floor/basket/B-0431')
  })
})

describe('owb-fl9 — a chain on the floor: +12 and −12', () => {
  const chain = {
    steps: [
      { operationId: 'op-cut', name: 'Cutting', waiting: 0, done: 48, slowest: false },
      { operationId: 'op-sew', name: 'Stitching', waiting: 24, done: 24, slowest: true },
    ],
  }
  it('opens the step asked for, else the first with pieces waiting', () => {
    expect(stepOf(chain, 'op-cut')).toBe('op-cut')
    expect(stepOf(chain, null)).toBe('op-sew')
    expect(stepOf({ steps: [] }, null)).toBeNull()
  })

  it('sends ONE report for +12 (one client id) and ONE undo for −12 (by the report\'s scan)', () => {
    expect(reportBody('line-1', 'op-sew', 'size-m', 'ev-1')).toEqual({ lineId: 'line-1', operationId: 'op-sew', workOrderSizeId: 'size-m', clientEventId: 'ev-1' })
    expect(UNDO_KIND).toBe('production.scan.undo')
    expect(undoPayload({ scanId: 'scan-9' })).toEqual({ scanId: 'scan-9' })
  })

  it('offers −12 only for that lot at that step, for today\'s two minutes', () => {
    const last: LastReport = { workOrderSizeId: 'size-m', operationId: 'op-sew', scanId: 'scan-9', quantity: 12, bundleCode: 'B-0500', at: 1_000 }
    expect(undoOpen(last, 'size-m', 'op-sew', 1_000 + UNDO_MS - 1)).toBe(true)
    expect(undoOpen(last, 'size-m', 'op-sew', 1_000 + UNDO_MS)).toBe(false)
    expect(undoOpen(last, 'size-l', 'op-sew', 2_000)).toBe(false)
    expect(undoOpen(null, 'size-m', 'op-sew', 2_000)).toBe(false)
  })

  it('reads a lot at a step, the "+" number, and the device\'s chain', () => {
    const lot = { workOrderSizeId: 'size-m', model: 'Hoodie Example', size: 'M', quantity: 48, bundleSize: 12, perStep: [{ operationId: 'op-cut', done: 48, waiting: 0 }] }
    expect(lotAt(lot, 'op-cut')).toEqual({ done: 48, waiting: 0, full: true })
    expect(plusOf(lot)).toBe(12)
    expect(plusOf({ bundleSize: undefined })).toBeNull()
    expect(lineOf({ line: { id: 'line-1' } }, null)).toBe('line-1')
    expect(lineOf(null, { line: null })).toBeNull()
  })
})
