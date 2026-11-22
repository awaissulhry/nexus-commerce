import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MOVE_REFUSALS, TAKE_OFF_REFUSALS } from '@nexus/factory-domain/shipping/split/split'
import { ApiError } from '../../../../../lib/api/errors'
import type { SplitPreview } from '../split/api'
import type { MoveTargets } from './api'
import { initialMove, mergeBody, MOVE_REFUSAL_CODES, moveBody, moveHeld, moveProblem, moveTotals, TAKE_OFF_REFUSAL_CODES, takeOffReasonProblem, targetHeld } from './model'

/**
 * F-OS-203 (order SHIPMENTS tab, 10-design §7 D2 / D3; 18-lead-settles L6) — Move garments to… / Merge into…, pure: only a draft of the
 * same customer takes them (each order's verdict in Warehouse's join words), what is in a carton or has a serial stays, something
 * stays (else Merge), why; a merge moves everything. ONE dialog for Warehouse's record and the order's Shipments tab. Made-up data.
 */

const preview = (over: Partial<SplitPreview> = {}): SplitPreview => ({
  shipmentId: 'sh-12',
  number: 'SEED-SH-0012',
  status: 'DRAFT',
  version: 4,
  splittable: true,
  held: false,
  lines: [
    { id: 'l1', label: 'SEED-JKT-02 Black', size: '50', quantity: 10, packed: 0, serials: 0, movable: 10, shipBy: '2026-12-18' },
    { id: 'l2', label: 'SEED-JKT-02 Red', size: '52', quantity: 6, packed: 2, serials: 0, movable: 4, shipBy: null },
  ],
  reasons: ['PART_READY', 'CUSTOMER_REQUEST', 'CARRIER', 'SERVICE', 'PROMISE_DATE', 'OTHER'],
  rules: [],
  mayManage: true,
  ...over,
})
const targets = (over: Partial<MoveTargets['targets'][number]> = {}): MoveTargets => ({
  shipmentId: 'sh-12',
  number: 'SEED-SH-0012',
  version: 4,
  targets: [{ id: 'sh-15', number: 'SEED-SH-0015', orders: [{ id: 'so-5', number: 'SEED-SO-0005' }], garments: 8, verdicts: [{ orderId: 'so-2', allowed: true, code: null, why: null }], ...over }],
})
const model = (over: Partial<ReturnType<typeof initialMove>> = {}) => ({ ...initialMove('move'), targetId: 'sh-15', quantities: { l1: 4 }, reason: 'PART_READY' as const, ...over })

describe('Move garments to…', () => {
  it('held by the state first, then what is still to choose; open when a target, garments, something staying and why are there', () => {
    expect(moveHeld(model(), preview(), targets())).toBeNull()
    expect(moveHeld(model(), preview({ status: 'PACKED' }), targets())).toEqual({ key: 'move.held.notDraft' })
    expect(moveHeld(model(), preview({ mayManage: false }), targets())).toEqual({ key: 'split.held.noManage' })
    expect(moveHeld(model(), preview(), { targets: [] })).toEqual({ key: 'move.held.noTarget' })
    expect(moveHeld(model({ targetId: null }), preview(), targets())).toEqual({ key: 'move.held.pickTarget' })
    expect(moveHeld(model({ quantities: {} }), preview(), targets())).toEqual({ key: 'split.held.pickGarments' })
    expect(moveHeld(model({ quantities: { l1: 10, l2: 6 } }), preview(), targets())).toBeNull() // l2 moves only its 4 movable: 2 stay
    expect(moveHeld(model({ quantities: { l1: 10, l2: 6 } }), preview({ lines: preview().lines.map((line) => ({ ...line, movable: line.quantity, packed: 0 })) }), targets())).toEqual({ key: 'move.held.useMerge' })
    expect(moveHeld(model({ reason: null }), preview(), targets())).toEqual({ key: 'split.held.pickReason' })
    expect(moveHeld(model({ busy: true }), preview(), targets())).toEqual({ key: 'move.held.busy' })
  })

  it('a target that cannot take an order says why in Warehouse\'s join words', () => {
    expect(targetHeld({ verdicts: [{ orderId: 'so-2', allowed: false, code: 'SHIP_TO', why: 'x' }] })).toEqual({ key: 'shipOrders.why.SHIP_TO' })
    expect(targetHeld({ verdicts: [{ orderId: 'so-2', allowed: false, code: null, why: null }] })).toEqual({ key: 'shipOrders.cannotJoin' })
    expect(moveHeld(model(), preview(), targets({ verdicts: [{ orderId: 'so-2', allowed: false, code: 'CUSTOMER_HOLD', why: 'x' }] }))).toEqual({ key: 'shipOrders.why.CUSTOMER_HOLD' })
  })

  it('the request: the lines that move (capped at what may move), both versions, why and the office\'s words', () => {
    expect(moveTotals(preview(), { l1: 4, l2: 9 })).toEqual({ moving: 8, staying: 8 })
    expect(moveBody(model({ quantities: { l1: 4, l2: 9 }, words: '  for the shop  ' }), preview(), targets(), 7)).toEqual({ version: 4, toShipmentId: 'sh-15', toVersion: 7, lines: [{ lineId: 'l1', quantity: 4 }, { lineId: 'l2', quantity: 4 }], reason: 'PART_READY', words: 'for the shop' })
    expect(moveBody(model({ targetId: 'sh-99' }), preview(), targets())).toBeNull()
    expect(moveBody(model({ quantities: {} }), preview(), targets())).toBeNull()
  })
})

describe('Merge into…', () => {
  it('everything moves: a garment in a carton keeps it back; the request names the target and the words', () => {
    const merge = { ...model(), mode: 'merge' as const }
    expect(moveHeld(merge, preview(), targets())).toEqual({ key: 'move.refusal.MERGE_PACKED' })
    const loose = preview({ lines: preview().lines.map((line) => ({ ...line, movable: line.quantity, packed: 0 })) })
    expect(moveHeld(merge, loose, targets())).toBeNull()
    expect(mergeBody({ targetId: 'sh-15', words: '' }, loose)).toEqual({ version: 4, intoShipmentId: 'sh-15', intoVersion: undefined, words: null })
  })
})

describe('take an order off: ONE command with the office\'s reason (B-OS-013)', () => {
  it('the reason is 3 to 500 characters', () => {
    expect(takeOffReasonProblem('')).toEqual({ key: 'move.held.reasonShort', params: { min: 3 } })
    expect(takeOffReasonProblem('The customer collects it.')).toBeNull()
    expect(takeOffReasonProblem('x'.repeat(501))).toEqual({ key: 'move.held.wordsLong', params: { max: 500 } })
  })
})

describe('refusals in words, never a raw code', () => {
  it('the domain\'s own lists; a join reason of the target in Warehouse\'s words; the rest in the step\'s words', () => {
    expect(MOVE_REFUSAL_CODES).toEqual(MOVE_REFUSALS)
    expect(TAKE_OFF_REFUSAL_CODES).toEqual(TAKE_OFF_REFUSALS)
    const refused = (code: string) => new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: `refusal/${code}`, message: 'x' }])
    expect(moveProblem(refused('MERGE_LABELLED'))).toMatchObject({ key: 'move.refusal.MERGE_LABELLED', reload: true })
    expect(moveProblem(refused('JOIN_SHIP_TO'))).toMatchObject({ key: 'shipOrders.why.SHIP_TO', reload: true })
    expect(moveProblem(refused('FIRST_ORDER'), TAKE_OFF_REFUSAL_CODES)).toMatchObject({ key: 'move.refusal.FIRST_ORDER' })
    expect(moveProblem(new Error('offline')).key).toBe('problem.write.internal')
  })
})

describe('ONE component on both pages (L6)', () => {
  it('Warehouse\'s record ⋯ and the order\'s Shipments row ⋯ mount the same Move container', () => {
    const depth = readFileSync(new URL('../record-depth.tsx', import.meta.url), 'utf8')
    expect(depth).toContain("import { Move } from './move/Move'")
    const tab = readFileSync(new URL('../../../../sales/orders/record/use-shipments-acts.ts', import.meta.url), 'utf8')
    expect(tab).toContain("import { Move } from '../../../warehouse/shipments/queue/move/Move'")
  })
})

// ── os-fx7 (30-walk W-03) ──
describe('os-fx7 (W-03): the move\'s Why never shows a raw key', () => {
  it('never "another delivery address" (a move goes to a draft of the same address); every choice worded through the split\'s key', async () => {
    const { MOVE_REASONS } = await import('./model')
    const { splitReasonKey } = await import('../split/model')
    expect(MOVE_REASONS).not.toContain('SHIP_TO')
    expect(splitReasonKey('SHIP_TO')).toBe('door.split.reasonShipTo')
    expect(splitReasonKey('PART_READY')).toBe('splitReason.PART_READY')
    expect(readFileSync(new URL('./view/MoveDialog.tsx', import.meta.url), 'utf8')).toContain('title={t(splitReasonKey(reason))')
    expect(readFileSync(new URL('../split/view/SplitDialog.tsx', import.meta.url), 'utf8')).not.toContain('t(`splitReason.${reason}`)')
  })
})
// ── end os-fx7 ──
