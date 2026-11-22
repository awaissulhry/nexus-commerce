import { createElement } from 'react'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import type { SplitPreview } from '../split/api'
import type { MoveTargets } from './api'
import type { MoveModel } from './model'
import { MoveDialog } from './view/MoveDialog'

/**
 * T.1 (order SHIPMENTS tab; F-OS-203; 18-lead-settles L6) — Move garments to… and Merge into…, the ONE window Warehouse's record ⋯ and
 * the order's Shipments tab both open: the drafts of the same customer that may take them (each order's verdict in words), what may
 * move per line, why, and the refusals. Made-up data only (Seed Customer One; SEED-SH-…; styles SEED-JKT-02, SEED-PNT-01).
 */

const uid = (n: number) => `0190f0e2-7497-7000-8000-${String(n).padStart(12, '0')}`
const ORDER_2 = { id: uid(2), number: 'SEED-SO-0002' }
const ORDER_3 = { id: uid(3), number: 'SEED-SO-0003' }
const ORDER_5 = { id: uid(5), number: 'SEED-SO-0005' }

const preview = (over: Partial<SplitPreview> = {}): SplitPreview => ({
  shipmentId: uid(12),
  number: 'SEED-SH-0012',
  status: 'DRAFT',
  version: 4,
  splittable: true,
  held: false,
  lines: [
    { id: uid(21), label: 'SEED-JKT-02 · Black', size: '50', quantity: 6, packed: 0, serials: 0, movable: 6, shipBy: '2026-12-18' },
    { id: uid(22), label: 'SEED-JKT-02 · Black', size: '52', quantity: 4, packed: 1, serials: 0, movable: 3, shipBy: '2026-12-18' },
    { id: uid(23), label: 'SEED-PNT-01 · Red', size: '48', quantity: 2, packed: 0, serials: 1, movable: 1, shipBy: '2026-12-20' },
  ],
  reasons: ['CARRIER', 'SERVICE', 'SHIP_TO', 'PROMISE_DATE', 'PART_READY', 'CUSTOMER_REQUEST', 'OTHER'],
  rules: [],
  mayManage: true,
  ...over,
})

const allowed = (orderId: string) => ({ orderId, allowed: true, code: null, why: null })
const targets = (over: Partial<MoveTargets> = {}): MoveTargets => ({
  shipmentId: uid(12),
  number: 'SEED-SH-0012',
  version: 4,
  targets: [
    { id: uid(15), number: 'SEED-SH-0015', orders: [ORDER_5], garments: 8, verdicts: [allowed(ORDER_2.id), allowed(ORDER_3.id)] },
    { id: uid(16), number: 'SEED-SH-0016', orders: [ORDER_3], garments: 4, verdicts: [allowed(ORDER_2.id), { orderId: ORDER_3.id, allowed: false, code: 'SHIP_TO', why: 'Another delivery address.' }] },
  ],
  ...over,
})

type MoveCase = { readonly number: string; readonly move: MoveModel }
const move = (over: Partial<MoveModel> = {}): MoveCase => ({ number: 'SEED-SH-0012', move: { mode: 'move', preview: { state: 'ready', value: preview() }, targets: { state: 'ready', value: targets() }, targetId: null, quantities: {}, reason: null, words: '', busy: false, problem: null, ...over } })
const merge = (over: Partial<MoveModel> = {}): MoveCase => move({ mode: 'merge', ...over })

function MoveCaseView({ model }: { model: MoveCase }) {
  return createElement(MoveDialog, { number: model.number, model: model.move })
}

export const designScreen = defineDesignScreen<MoveCase>({
  screen: 'SCR-593-move',
  title: 'Shipment › ⋯ Move garments to… / Merge into…: the drafts of the same customer, what may move, why (Warehouse and the order\'s Shipments tab)',
  view: MoveCaseView,
  part: true,
  cases: [
    { id: 'move-pick', label: 'Move: nothing picked yet (held with why); two drafts of Seed Customer One, one refuses an order (another address)', model: move() },
    { id: 'move-ready', label: 'Move: 4 garments to SEED-SH-0015, part ready', model: move({ targetId: uid(15), quantities: { [uid(21)]: 4 }, reason: 'PART_READY' }) },
    { id: 'move-all', label: 'Move: every movable garment picked — nothing stays: use Merge into… (held)', model: move({ preview: { state: 'ready', value: preview({ lines: preview().lines.map((line) => ({ ...line, packed: 0, serials: 0, movable: line.quantity })) }) }, targetId: uid(15), quantities: { [uid(21)]: 6, [uid(22)]: 4, [uid(23)]: 2 }, reason: 'CUSTOMER_REQUEST' }) },
    { id: 'move-no-target', label: 'Move: no other draft of this customer can take them — make one with Create shipment… (held)', model: move({ targets: { state: 'ready', value: targets({ targets: [] }) } }) },
    { id: 'move-refused', label: 'Move: refused in words (nothing can move: every garment is in a carton or has a serial)', model: move({ targetId: uid(15), quantities: { [uid(21)]: 2 }, reason: 'PART_READY', problem: { key: 'move.refusal.NOTHING_TO_MOVE' } }) },
    { id: 'merge', label: 'Merge: all garments go; SEED-SH-0012 is cancelled "Merged into …", never deleted', model: merge({ targetId: uid(15) }) },
    { id: 'merge-packed', label: 'Merge refused: garments in cartons or with serials (take them out first)', model: merge({ targetId: uid(15), problem: { key: 'move.refusal.MERGE_PACKED' } }) },
    { id: 'move-packed', label: 'A packed shipment: only a draft gives or takes garments (held)', model: move({ preview: { state: 'ready', value: preview({ status: 'PACKED' }) } }) },
    { id: 'loading', label: 'Reading what can move', model: move({ preview: { state: 'loading' }, targets: { state: 'loading' } }) },
    { id: 'error', label: 'Could not be read: Try again', model: move({ targets: { state: 'error', problem: { key: 'problem.read.unavailable' } } }) },
  ],
})
