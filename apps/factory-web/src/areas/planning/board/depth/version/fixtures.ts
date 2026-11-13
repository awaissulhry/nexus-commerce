import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { BOARD, PREFIX, SLOTS, TODAY, WORK_ORDERS } from '../../fixtures'
import type { VersionBoard } from '../api'
import { VersionTabView, type VersionTabModel } from '../view/VersionTabView'

/**
 * SCR-408 — Published version v3, read-only (NEW id, B-W2b-337; design planning.board tab:version "Published version v12
 * (read-only)": compare what the floor has with the working plan side by side). Made-up site, lines and work orders (the
 * board's design data): v3 is what the floor works to now; since then the working plan moved the sewing of WO-0103 and took
 * the workshop part of WO-0105 off, and added one bar. Opened in a new tab from the board (`?version=<id>`).
 */

const published = BOARD.plan.published!
const named = (key: { kind: 'LINE' | 'WORK_CENTRE' | 'WORKSHOP'; id: string }) => {
  const lane = BOARD.lanes.find((entry) => entry.kind === key.kind && entry.id === key.id)!
  return { kind: lane.kind, id: lane.id, code: lane.code, name: lane.name }
}
const byId = new Map(WORK_ORDERS.map((workOrder) => [workOrder.id, workOrder]))

const VERSION: VersionBoard = {
  site: BOARD.site,
  asOf: BOARD.asOf,
  version: { id: published.id, number: published.number, coversFrom: '2026-11-16', coversTo: '2026-11-20', effectiveFrom: published.effectiveFrom, publishedAt: published.publishedAt, publishedBy: published.publishedBy, note: 'Settimana con straordinario sulla linea 1 (esempio)' },
  readOnly: true,
  floor: 'CURRENT',
  lanes: BOARD.lanes.map((lane) => named(lane)),
  slots: SLOTS.map((slot, index) => {
    const workOrder = byId.get(slot.workOrderId)!
    const operation = slot.operationId ? workOrder.operations.find((entry) => entry.id === slot.operationId)! : null
    const lane = named(slot.lane)
    const state = index === 4 ? 'MOVED' : index === 5 ? 'REMOVED' : 'SAME'
    return {
      id: `${slot.id.slice(0, -2)}9${index}`,
      lane: slot.lane,
      workOrderId: slot.workOrderId,
      operationId: slot.operationId,
      startAt: index === 4 ? '2026-11-19T07:00:00.000Z' : slot.startAt,
      endAt: index === 4 ? '2026-11-19T16:00:00.000Z' : slot.endAt,
      pieces: slot.pieces,
      minutes: slot.minutes,
      pinned: false,
      workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status, rush: workOrder.rush, dueDate: workOrder.dueDate, style: workOrder.style },
      operation: operation ? { id: operation.id, seq: operation.seq, code: operation.code, name: operation.name } : null,
      laneCode: lane.code,
      laneName: lane.name,
      floor: slot.floor ?? null,
      working: { state, slot: state === 'MOVED' ? { id: slot.id, lane: slot.lane, startAt: slot.startAt, endAt: slot.endAt } : state === 'SAME' ? { id: slot.id, lane: slot.lane, startAt: slot.startAt, endAt: slot.endAt } : null },
    }
  }),
  compare: {
    moved: 1,
    added: 1,
    removed: 1,
    addedSlots: [{ id: '0190f0e2-8888-7000-8000-000000000077', workOrderId: WORK_ORDERS[3]!.id, operationId: WORK_ORDERS[3]!.operations[0]!.id, lane: { kind: 'WORK_CENTRE', id: BOARD.lanes[2]!.id }, startAt: '2026-11-20T07:00:00.000Z', endAt: '2026-11-20T10:00:00.000Z' }],
  },
}

const base = (over: Partial<VersionTabModel> = {}): VersionTabModel => ({ prefix: PREFIX, read: { status: 'ready', value: VERSION }, today: TODAY, offline: false, mayExport: true, exportJob: null, ...over })

export const designScreen = defineDesignScreen<VersionTabModel>({
  screen: 'SCR-408',
  title: 'Published version (read-only)',
  view: VersionTabView,
  cases: [
    { id: 'current', label: 'v3, what the floor works to now', model: base(), note: 'The version’s bars on the board, read-only, each with its state on the floor and where the working plan has it now (WO-0103 moved, WO-0105’s workshop part taken off); the band says the difference in words; the bar the working plan added; Export this version (XLSX).' },
    { id: 'upcoming', label: 'A version waiting for its start', model: base({ read: { status: 'ready', value: { ...VERSION, floor: 'UPCOMING', compare: { moved: 0, added: 0, removed: 0, addedSlots: [] }, slots: VERSION.slots.map((slot) => ({ ...slot, working: { state: 'SAME', slot: { id: slot.id, lane: slot.lane, startAt: slot.startAt, endAt: slot.endAt } } })) } } }) },
    { id: 'replaced', label: 'A replaced version', model: base({ read: { status: 'ready', value: { ...VERSION, floor: 'REPLACED' } } }) },
    { id: 'export-held', label: 'Export held (outside the Office)', model: base({ mayExport: false }) },
    { id: 'not-found', label: 'No such version', model: base({ read: { status: 'notFound' } }) },
    { id: 'loading', label: 'Loading', model: base({ read: { status: 'loading' } }) },
    { id: 'error', label: 'Could not load', model: base({ read: { status: 'error', problem: 'failed' } }) },
    { id: 'no-permission', label: 'No permission', model: base({ read: { status: 'error', problem: 'forbidden' } }) },
  ],
})
