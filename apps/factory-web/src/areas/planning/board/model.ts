import { isoWeekday, plusDays } from '@nexus/factory-domain/calendars/dates'
import { businessDate, businessDayStart } from '@nexus/factory-domain/core/time'
import { isOver, landingLoads, withMove, type PlanningBucket, type PlanningCard, type PlanningCellLoad, type PlanningLane, type PlanningMark, type PlanningMove, type PlanningPlace } from '@nexus/ui/patterns/planning-board/index'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { INTL_LOCALE, type Locale } from '../../../lib/i18n/locales'
import type { Translate } from '../../../lib/i18n/messages'
import { BOARD_BUCKETS, type Board, type BoardBucket, type BoardCell, type BoardLane, type BoardOperation, type BoardProblem, type BoardSlot, type BoardWorkOrder, type LaneRef, type PublishPreview, type TrayChip } from './api'

/**
 * The planning board's rules (SCR-122), pure: the address ⇄ the board controls, the API's board → the DS PlanningBoard's
 * lanes, buckets and cards (resource view and order view), the filters and highlights, what a move asks of the API,
 * which drops the app holds and why, a refused write in our words, the publish band's held reason, the problems list.
 * The API's English is never shown: codes and numbers become words of `messages/<locale>/planning-board.json`.
 *
 * Load: a lane's LoadBar counts the bars on the board that book capacity (released or in progress); the API's cell also
 * counts open work not on the board yet at its due date — said in the cell's words, the same total the Problems list
 * and Capacity & load use. No money, no person: lines, work centres, workshops and work orders only.
 */

export const NAMESPACE = 'planning-board'
export const BOARD_VIEWS = ['resources', 'orders'] as const
export type BoardViewKind = (typeof BOARD_VIEWS)[number]
export const WO_STATUSES = ['DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD'] as const
export const NOT_READY = new Set(['NOT_ENOUGH', 'DELAYED'])

// ---- the address ---------------------------------------------------------------------------------------------------

/** Every choice of the board, in the address (a link reproduces the view). */
export interface BoardControls {
  site: string | null
  view: BoardViewKind
  zoom: BoardBucket
  /** The window's first day; null = today. */
  from: string | null
  q: string
  /** Lane keys (`LINE:<id>`) the board shows; empty = every lane. */
  lanes: readonly string[]
  styles: readonly string[]
  statuses: readonly string[]
  /** Only work orders whose material is not ready. */
  material: boolean
  /** What the cards point out (late: striped and said; material: the material mark). */
  late: boolean
  materialMark: boolean
  /** The bar popover's work order. */
  wo: string | null
}

export const DEFAULT_CONTROLS: BoardControls = Object.freeze({
  site: null,
  view: 'resources',
  zoom: 'DAY',
  from: null,
  q: '',
  lanes: [],
  styles: [],
  statuses: [],
  material: false,
  late: true,
  materialMark: true,
  wo: null,
})

const list = (value: string | null | undefined): string[] => (value ? value.split(',').map((part) => part.trim()).filter(Boolean) : [])
const DATE = /^\d{4}-\d{2}-\d{2}$/

export function controlsOf(params: { get(name: string): string | null } | null | undefined): BoardControls {
  const get = (name: string) => params?.get(name) ?? null
  const view = get('view')
  const zoom = get('zoom')
  const from = get('from')
  const highlight = get('hl')
  const marks = highlight === null ? null : new Set(list(highlight))
  return {
    site: get('site'),
    view: view === 'orders' ? 'orders' : 'resources',
    zoom: (BOARD_BUCKETS as readonly string[]).includes(zoom ?? '') ? (zoom as BoardBucket) : 'DAY',
    from: from && DATE.test(from) ? from : null,
    q: (get('q') ?? '').trim(),
    lanes: list(get('lane')),
    styles: list(get('style')),
    statuses: list(get('status')).filter((status) => (WO_STATUSES as readonly string[]).includes(status)),
    material: get('material') === '1',
    late: marks ? marks.has('late') : true,
    materialMark: marks ? marks.has('material') : true,
    wo: get('wo'),
  }
}

/** The address's query (defaults left out). */
export function queryOf(controls: BoardControls): string {
  const query = new URLSearchParams()
  if (controls.site) query.set('site', controls.site)
  if (controls.view !== 'resources') query.set('view', controls.view)
  if (controls.zoom !== 'DAY') query.set('zoom', controls.zoom)
  if (controls.from) query.set('from', controls.from)
  if (controls.q.trim()) query.set('q', controls.q.trim())
  if (controls.lanes.length) query.set('lane', controls.lanes.join(','))
  if (controls.styles.length) query.set('style', controls.styles.join(','))
  if (controls.statuses.length) query.set('status', controls.statuses.join(','))
  if (controls.material) query.set('material', '1')
  if (!controls.late || !controls.materialMark) query.set('hl', [controls.late ? 'late' : null, controls.materialMark ? 'material' : null].filter(Boolean).join(','))
  if (controls.wo) query.set('wo', controls.wo)
  return query.toString()
}

/** The window's first day the API is asked for: a week starts on Monday, a month on the 1st. */
export function windowFrom(controls: Pick<BoardControls, 'from' | 'zoom'>, today: string): string {
  const day = controls.from ?? today
  if (controls.zoom === 'WEEK') return plusDays(day, 1 - isoWeekday(day))
  if (controls.zoom === 'MONTH') return `${day.slice(0, 7)}-01`
  return day
}

/** ‹ and ›: a week of days, four weeks, three months. */
export function shiftFrom(controls: Pick<BoardControls, 'from' | 'zoom'>, today: string, direction: -1 | 1): string {
  const from = windowFrom(controls, today)
  if (controls.zoom === 'DAY') return plusDays(from, 7 * direction)
  if (controls.zoom === 'WEEK') return plusDays(from, 28 * direction)
  const [year, month] = from.split('-').map(Number) as [number, number]
  const index = year * 12 + (month - 1) + 3 * direction
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}-01`
}

// ---- lanes, buckets, cards ------------------------------------------------------------------------------------------

export const laneKeyOf = (lane: LaneRef): string => `${lane.kind}:${lane.id}`
export function laneRefOf(key: string | null): LaneRef | null {
  if (!key) return null
  const at = key.indexOf(':')
  const kind = key.slice(0, at)
  if (kind !== 'LINE' && kind !== 'WORK_CENTRE' && kind !== 'WORKSHOP') return null
  return { kind, id: key.slice(at + 1) }
}
export const ORDER_LANE = 'WO:'
export const orderLaneOf = (workOrderId: string): string => `${ORDER_LANE}${workOrderId}`
export const TRAY_CARD = 'tray:'
export const trayCardOf = (workOrderId: string): string => `${TRAY_CARD}${workOrderId}`
export const workOrderOfTrayCard = (cardId: string): string | null => (cardId.startsWith(TRAY_CARD) ? cardId.slice(TRAY_CARD.length) : null)

export interface Words {
  t: Translate
  locale: Locale
  timeZone: string
}

const number = (value: number, locale: Locale, digits = 0) => new Intl.NumberFormat(INTL_LOCALE[locale], { maximumFractionDigits: digits }).format(value)
export const minutesText = (value: number | string, locale: Locale) => number(Number(value), locale, 1)

/** "Mon 16 Nov" in the page's language (a calendar day, no zone). */
export function dayWords(date: string, locale: Locale, withWeekday = true): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeZone: 'UTC', ...(withWeekday ? { weekday: 'short' } : {}), day: 'numeric', month: 'short' }).format(new Date(Date.UTC(year, month - 1, day)))
}

/** "16 Nov, 08:00" in the site's zone. */
export function whenWords(instant: string, { locale, timeZone }: Pick<Words, 'locale' | 'timeZone'>): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant))
}

export const timeWords = (instant: string, { locale, timeZone }: Pick<Words, 'locale' | 'timeZone'>): string =>
  new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant))

export function bucketsOf(board: Pick<Board, 'buckets' | 'today' | 'lanes'>, words: Words): PlanningBucket[] {
  const { t, locale } = words
  const working = board.lanes.filter((lane) => lane.cells !== null)
  return board.buckets.map((bucket) => {
    const today = bucket.from <= board.today && board.today <= bucket.to
    if (bucket.kind === 'DAY') {
      // A day every lane is closed (a holiday, a shutdown): no drop anywhere, with its name.
      const closedEverywhere = working.length > 0 && working.every((lane) => lane.cells?.find((cell) => cell.key === bucket.key)?.closedDays.some((day) => day.date === bucket.from))
      const closedName = closedEverywhere ? closedNameOf(working[0]!.cells!.find((cell) => cell.key === bucket.key)!.closedDays[0]!, t) : null
      return { id: bucket.key, label: dayWords(bucket.from, locale), today, closed: closedName }
    }
    if (bucket.kind === 'WEEK') {
      const week = /W(\d+)$/.exec(bucket.key)?.[1]
      return { id: bucket.key, label: t('bucket.week', { week: Number(week ?? 0) }), detail: t('bucket.range', { from: dayWords(bucket.from, locale, false), to: dayWords(bucket.to, locale, false) }), today }
    }
    const [year, month] = bucket.from.split('-').map(Number) as [number, number]
    return { id: bucket.key, label: new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(Date.UTC(year, month - 1, 1))), today }
  })
}

const closedNameOf = (day: { reason: 'HOLIDAY' | 'CLOSURE'; name: string }, t: Translate) => (day.name ? day.name : t(`closed.${day.reason}`))

/** How a cell's capacity is made, in words: people × working minutes × efficiency, the closed days, the open work not on the board. */
export function capacityWordsOf(lane: BoardLane, cell: BoardCell, words: Words): string {
  const { t, locale } = words
  const available = Number(cell.availableMinutes)
  const people = lane.people ?? 0
  const efficiency = Number(lane.efficiencyPct ?? 100)
  const parts: string[] = []
  if (available === 0) parts.push(t('capacity.none'))
  else if (people === 0) parts.push(t(lane.kind === 'LINE' ? 'capacity.noPeople' : 'capacity.noStations'))
  else {
    const working = (available * 100) / (people * efficiency)
    parts.push(t(lane.kind === 'LINE' ? 'capacity.formulaPeople' : 'capacity.formulaStations', { count: people, people: number(people, locale), minutes: minutesText(working, locale), efficiency: number(efficiency, locale, 2), available: minutesText(available, locale) }))
  }
  if (cell.closedDays.length > 0) parts.push(t('capacity.closed', { days: cell.closedDays.map((day) => `${dayWords(day.date, locale)} (${closedNameOf(day, t)})`).join(', ') }))
  const other = Math.max(0, Number(cell.bookedMinutes) - Number(cell.scheduledMinutes))
  if (other > 0) parts.push(t('capacity.otherWork', { minutes: minutesText(other, locale), booked: minutesText(cell.bookedMinutes, locale) }))
  return parts.join(' ')
}

export function laneDetailOf(lane: BoardLane, words: Words): string {
  const { t, locale } = words
  if (lane.kind === 'WORKSHOP') return t('lane.workshop')
  const efficiency = number(Number(lane.efficiencyPct ?? 100), locale, 2)
  if (lane.kind === 'LINE') return t('lane.line', { count: lane.people ?? 0, people: number(lane.people ?? 0, locale), efficiency })
  return t('lane.workCentre', { count: lane.people ?? 0, stations: number(lane.people ?? 0, locale), efficiency })
}

/** The DS lanes of the resource view (lines, work centres, workshops). */
export function resourceLanesOf(board: Pick<Board, 'lanes' | 'buckets'>, controls: Pick<BoardControls, 'lanes'>, words: Words): PlanningLane[] {
  const shown = controls.lanes.length ? board.lanes.filter((lane) => controls.lanes.includes(laneKeyOf(lane))) : board.lanes
  return shown.map((lane) => {
    const capacity: Record<string, number | null> = {}
    const capacityWords: Record<string, string> = {}
    const closed: Record<string, string> = {}
    for (const cell of lane.cells ?? []) {
      capacity[cell.key] = Number(cell.availableMinutes)
      capacityWords[cell.key] = capacityWordsOf(lane, cell, words)
      const bucket = board.buckets.find((entry) => entry.key === cell.key)
      if (bucket?.kind === 'DAY') {
        const day = cell.closedDays.find((entry) => entry.date === bucket.from)
        if (day) closed[cell.key] = closedNameOf(day, words.t)
      }
    }
    return {
      id: laneKeyOf(lane),
      label: lane.name,
      detail: laneDetailOf(lane, words),
      ...(lane.cells ? { capacity, capacityWords, closed } : { capacityWords: Object.fromEntries(board.buckets.map((bucket) => [bucket.key, words.t('capacity.workshop')])) }),
    }
  })
}

/** The bucket a day falls in (null: outside the window). */
export function bucketIndexOf(buckets: Board['buckets'], date: string): number {
  return buckets.findIndex((bucket) => bucket.from <= date && date <= bucket.to)
}

/** Where a slot sits: its first bucket inside the window and how many it covers (clipped to the window). */
export function slotPlace(slot: Pick<BoardSlot, 'startAt' | 'endAt'>, buckets: Board['buckets'], timeZone: string): { bucketId: string; span: number } | null {
  if (buckets.length === 0) return null
  const first = businessDate(new Date(slot.startAt), timeZone)
  const lastInstant = new Date(Math.max(new Date(slot.startAt).getTime(), new Date(slot.endAt).getTime() - 1))
  const last = businessDate(lastInstant, timeZone)
  const windowFrom = buckets[0]!.from
  const windowTo = buckets[buckets.length - 1]!.to
  if (last < windowFrom || first > windowTo) return null
  const start = first < windowFrom ? 0 : bucketIndexOf(buckets, first)
  const end = last > windowTo ? buckets.length - 1 : bucketIndexOf(buckets, last)
  if (start < 0 || end < 0) return null
  return { bucketId: buckets[start]!.key, span: end - start + 1 }
}

export const isMaterialShort = (workOrder: Pick<BoardWorkOrder, 'readiness'>) => NOT_READY.has(workOrder.readiness?.word ?? '')

/** Which work orders the filters keep (line, style, status, material, the order number searched). */
export function keptWorkOrders(board: Pick<Board, 'workOrders' | 'lanes'>, controls: BoardControls): Set<string> {
  const q = controls.q.trim().toLowerCase()
  const lanes = new Set(controls.lanes)
  return new Set(
    board.workOrders
      .filter((workOrder) => !q || workOrder.number.toLowerCase().includes(q))
      .filter((workOrder) => !controls.styles.length || controls.styles.includes(workOrder.style.id))
      .filter((workOrder) => !controls.statuses.length || controls.statuses.includes(workOrder.status))
      .filter((workOrder) => !controls.material || isMaterialShort(workOrder))
      .filter((workOrder) => !lanes.size || workOrder.operations.some((operation) => lanes.has(laneKeyOf(operation.lane))) || (workOrder.line !== null && lanes.has(`LINE:${workOrder.line.id}`)))
      .map((workOrder) => workOrder.id),
  )
}

function marksOf(workOrder: BoardWorkOrder, slot: BoardSlot | null, controls: BoardControls, words: Words): PlanningMark[] {
  const { t, locale } = words
  const marks: PlanningMark[] = []
  if (workOrder.rush) marks.push({ label: t('mark.rush'), tone: 'info' })
  if (controls.materialMark && isMaterialShort(workOrder)) {
    marks.push({ label: workOrder.readiness?.date ? t('mark.materialFrom', { date: dayWords(workOrder.readiness.date, locale, false) }) : t('mark.material'), tone: 'warning' })
  }
  if (!workOrder.booksCapacity) marks.push({ label: t(workOrder.status === 'ON_HOLD' ? 'mark.onHold' : 'mark.draft'), tone: 'neutral' })
  if (slot?.overloadReason) marks.push({ label: t('mark.keptOver'), tone: 'warning' })
  return marks
}

function slotCard(slot: BoardSlot, workOrder: BoardWorkOrder, place: { bucketId: string; span: number }, laneId: string, controls: BoardControls, words: Words, me: string | null): PlanningCard {
  const { t, locale } = words
  const operation = slot.operationId ? workOrder.operations.find((entry) => entry.id === slot.operationId) : undefined
  const pieces = slot.pieces ?? workOrder.garments
  const detail = operation
    ? t('card.operation', { seq: operation.seq, operation: operation.name, style: workOrder.style.name, pieces: number(pieces, locale) })
    : t('card.part', { style: workOrder.style.name, pieces: number(pieces, locale) })
  const minutes = Number(slot.minutes)
  const late = controls.late && (slot.startsLate || workOrder.schedule.status === 'LATE')
  return {
    id: slot.id,
    label: workOrder.number,
    detail,
    minutes,
    laneId,
    bucketId: place.bucketId,
    span: place.span,
    // A draft's or held order's bar books no capacity: it is drawn, it loads nothing.
    ...(slot.booksCapacity ? {} : { load: Array.from({ length: place.span }, () => 0) }),
    late,
    marks: marksOf(workOrder, slot, controls, words),
    ...(slot.updatedBy && slot.updatedBy.id !== me ? { note: t('card.movedBy', { name: slot.updatedBy.name, time: whenWords(slot.updatedAt, words) }) } : {}),
  }
}

function trayCard(entry: Board['tray'][number], workOrder: BoardWorkOrder, controls: BoardControls, words: Words): PlanningCard {
  const { t, locale } = words
  const due = workOrder.dueDate ? t('card.due', { date: dayWords(workOrder.dueDate, locale, false) }) : t('card.noDue')
  const marks = marksOf(workOrder, null, controls, words)
  for (const chip of entry.chips) if (chip !== 'MATERIAL_NOT_READY' && chip !== 'ON_HOLD' && chip !== 'DRAFT') marks.push({ label: t(`chip.${chip}`), tone: chip === 'PAST_LATEST_SAFE_START' ? 'danger' : chip === 'START_SOON' ? 'warning' : 'neutral' })
  return {
    id: trayCardOf(workOrder.id),
    label: workOrder.number,
    detail: t('card.tray', { style: workOrder.style.name, pieces: number(workOrder.garments, locale), due, count: entry.unplacedOperations, operations: number(entry.unplacedOperations, locale) }),
    minutes: Number(entry.minutes),
    laneId: null,
    bucketId: null,
    late: controls.late && entry.chips.includes('PAST_LATEST_SAFE_START'),
    marks,
  }
}

export interface DrawnBoard {
  lanes: PlanningLane[]
  buckets: PlanningBucket[]
  cards: PlanningCard[]
}

/** The DS board of either view, filtered. */
export function drawBoard(board: Board, controls: BoardControls, words: Words, me: string | null): DrawnBoard {
  const buckets = bucketsOf(board, words)
  const kept = keptWorkOrders(board, controls)
  const byId = new Map(board.workOrders.map((workOrder) => [workOrder.id, workOrder]))
  const tray = board.tray.filter((entry) => kept.has(entry.workOrderId) && byId.has(entry.workOrderId)).map((entry) => trayCard(entry, byId.get(entry.workOrderId)!, controls, words))
  const slotCards = (laneOf: (slot: BoardSlot, workOrder: BoardWorkOrder) => string | null) =>
    board.slots.flatMap((slot) => {
      const workOrder = byId.get(slot.workOrderId)
      if (!workOrder || !kept.has(workOrder.id)) return []
      const place = slotPlace(slot, board.buckets, board.site.timeZone)
      const laneId = laneOf(slot, workOrder)
      return place && laneId ? [slotCard(slot, workOrder, place, laneId, controls, words, me)] : []
    })
  if (controls.view === 'orders') {
    const orders = board.workOrders.filter((workOrder) => kept.has(workOrder.id) && workOrder.schedule.status !== 'DONE')
    const lanes: PlanningLane[] = orders.map((workOrder) => ({
      id: orderLaneOf(workOrder.id),
      label: workOrder.number,
      detail: t2(words, workOrder),
    }))
    return { lanes, buckets, cards: [...slotCards((_, workOrder) => orderLaneOf(workOrder.id)), ...tray] }
  }
  const lanes = resourceLanesOf(board, controls, words)
  const shown = new Set(lanes.map((lane) => lane.id))
  return { lanes, buckets, cards: [...slotCards((slot) => (shown.has(laneKeyOf(slot.lane)) ? laneKeyOf(slot.lane) : null)), ...tray] }
}

const t2 = ({ t, locale }: Words, workOrder: BoardWorkOrder) =>
  t('lane.order', { style: workOrder.style.name, pieces: number(workOrder.garments, locale), status: t(`status.${workOrder.schedule.status}`) })

// ---- moves ----------------------------------------------------------------------------------------------------------

/** Whether a lane takes an operation's bar: a line that does its work centre, its own work centre, or a workshop. */
export function laneTakes(lane: BoardLane, operation: Pick<BoardOperation, 'workCentre' | 'lane'>): boolean {
  if (lane.kind === 'WORKSHOP') return true
  if (lane.kind === 'WORK_CENTRE') return lane.id === operation.workCentre.id
  return lane.does === null || lane.does.includes(operation.workCentre.id)
}

/** The operation a tray card places on a lane: the first one (by sequence) still without a bar that the lane takes. */
export function operationFor(workOrder: BoardWorkOrder, lane: BoardLane): BoardOperation | null {
  const open = workOrder.operations.filter((operation) => operation.slotIds.length === 0 && operation.remainingPieces > 0).sort((a, b) => a.seq - b.seq)
  return open.find((operation) => laneKeyOf(operation.lane) === laneKeyOf(lane)) ?? open.find((operation) => laneTakes(lane, operation)) ?? null
}

/** The app's own check of a drop (the DS asks before it moves anything): why it cannot go there, or null. */
export function dropHeldOf(board: Board, controls: Pick<BoardControls, 'view'>, card: Pick<PlanningCard, 'id' | 'laneId'>, to: PlanningPlace, t: Translate): string | null {
  if (to.laneId === null) return null
  const trayOf = workOrderOfTrayCard(card.id)
  if (controls.view === 'orders') {
    const own = trayOf ? orderLaneOf(trayOf) : card.laneId
    if (to.laneId !== own) return t('held.otherOrder')
    if (trayOf) {
      const workOrder = board.workOrders.find((entry) => entry.id === trayOf)
      const open = workOrder?.operations.filter((operation) => operation.slotIds.length === 0 && operation.remainingPieces > 0) ?? []
      if (open.length === 0) return t('held.nothingToPlace', { order: workOrder?.number ?? '' })
    }
    return null
  }
  const lane = board.lanes.find((entry) => laneKeyOf(entry) === to.laneId)
  if (!lane) return null
  if (trayOf) {
    const workOrder = board.workOrders.find((entry) => entry.id === trayOf)
    if (!workOrder) return null
    return operationFor(workOrder, lane) ? null : t('held.noOperation', { order: workOrder.number, lane: lane.name })
  }
  const slot = board.slots.find((entry) => entry.id === card.id)
  if (!slot || to.laneId === laneKeyOf(slot.lane)) return null
  if (slot.operationId === null) return lane.kind === 'WORK_CENTRE' ? t('held.partOnCentre') : null
  const workOrder = board.workOrders.find((entry) => entry.id === slot.workOrderId)
  const operation = workOrder?.operations.find((entry) => entry.id === slot.operationId)
  if (operation && !laneTakes(lane, operation)) return t('held.laneDoesNot', { lane: lane.name, operation: `${operation.seq} ${operation.name}`, centre: operation.workCentre.name })
  return null
}

/** The start of a bucket's first day in the site's zone, never before now when the day is today or later. */
export function startOfBucket(bucket: Board['buckets'][number], timeZone: string, now: Date): string {
  const start = businessDayStart(bucket.from, timeZone)
  const today = businessDate(now, timeZone)
  if (bucket.to >= today && start.getTime() < now.getTime()) return new Date(Math.ceil(now.getTime() / 60_000) * 60_000).toISOString()
  return start.toISOString()
}

export type MovePlan =
  | { kind: 'move'; slotId: string; version: number; lane?: LaneRef; startAt?: string; workOrderId: string }
  | { kind: 'place'; workOrderId: string; operationId: string; lane: LaneRef; startAt: string }
  | { kind: 'remove'; slotId: string; version: number; workOrderId: string }
  | { kind: 'none' }

/** What a DS move asks of the API (the inverse of a move is a move too: undo and redo are the same request). */
export function planMove(board: Board, controls: Pick<BoardControls, 'view'>, move: Pick<PlanningMove, 'cardId' | 'from' | 'to'>, now: Date): MovePlan {
  const tz = board.site.timeZone
  const bucket = (id: string | null) => board.buckets.find((entry) => entry.key === id) ?? null
  const trayOf = workOrderOfTrayCard(move.cardId)
  if (trayOf) {
    if (move.to.laneId === null) return { kind: 'none' }
    const workOrder = board.workOrders.find((entry) => entry.id === trayOf)
    const target = bucket(move.to.bucketId)
    if (!workOrder || !target) return { kind: 'none' }
    let operation: BoardOperation | null
    let lane: LaneRef
    if (controls.view === 'orders') {
      operation = workOrder.operations.filter((entry) => entry.slotIds.length === 0 && entry.remainingPieces > 0).sort((a, b) => a.seq - b.seq)[0] ?? null
      lane = operation?.lane ?? { kind: 'LINE', id: '' }
    } else {
      const ref = laneRefOf(move.to.laneId)
      const boardLane = board.lanes.find((entry) => laneKeyOf(entry) === move.to.laneId)
      if (!ref || !boardLane) return { kind: 'none' }
      operation = operationFor(workOrder, boardLane)
      lane = ref
    }
    if (!operation) return { kind: 'none' }
    return { kind: 'place', workOrderId: workOrder.id, operationId: operation.id, lane, startAt: startOfBucket(target, tz, now) }
  }
  const slot = board.slots.find((entry) => entry.id === move.cardId)
  if (!slot) return { kind: 'none' }
  if (move.to.laneId === null) return { kind: 'remove', slotId: slot.id, version: slot.version, workOrderId: slot.workOrderId }
  const plan: MovePlan = { kind: 'move', slotId: slot.id, version: slot.version, workOrderId: slot.workOrderId }
  if (controls.view === 'resources' && move.to.laneId !== move.from.laneId) {
    const ref = laneRefOf(move.to.laneId)
    if (ref) plan.lane = ref
  }
  if (move.to.bucketId !== move.from.bucketId) {
    const before = bucket(move.from.bucketId)
    const after = bucket(move.to.bucketId)
    if (before && after) {
      // The same time of day on the new day(s): the bar's start moves by the days between the two buckets.
      const shift = businessDayStart(after.from, tz).getTime() - businessDayStart(before.from, tz).getTime()
      let start = new Date(new Date(slot.startAt).getTime() + shift)
      if (after.to >= businessDate(now, tz) && start.getTime() < now.getTime()) start = new Date(Math.ceil(now.getTime() / 60_000) * 60_000)
      plan.startAt = start.toISOString()
    }
  }
  if (!plan.lane && !plan.startAt) return { kind: 'none' }
  return plan
}

// ---- the drop warning ------------------------------------------------------------------------------------------------

export interface OverDay {
  /** A bucket id (the DS's estimate) or a day (the API's answer). */
  where: string
  laneId: string | null
  booked: number
  available: number
}

export const pctOf = (day: Pick<OverDay, 'booked' | 'available'>): number => (day.available > 0 ? Math.round((day.booked / day.available) * 100) : 0)

/** The cells a drop takes over capacity, from the DS's load after the move. */
export function overFromMove(loadAfter: readonly PlanningCellLoad[]): OverDay[] {
  return loadAfter.filter(isOver).map((cell) => ({ where: cell.bucketId, laneId: cell.laneId, booked: cell.booked, available: Number(cell.available ?? 0) }))
}

const OVER_TEXT = /^([\d.]+) of ([\d.]+) min/

/** The days an overload 409 names (`over/<date>`: "2340.0 of 2880.0 min (81%), +640.0 over."). */
export function overFromIssues(error: unknown, laneId: string | null): OverDay[] {
  if (!isApiError(error)) return []
  return error.issues.flatMap((issue) => {
    const path = issuePath(issue).replace(/\./g, '/')
    if (!path.startsWith('over/')) return []
    const figures = OVER_TEXT.exec(issue.message ?? '')
    return figures ? [{ where: path.slice('over/'.length), laneId, booked: Number(figures[1]), available: Number(figures[2]) }] : []
  })
}

/** The first bucket after the target on the same lane where the card fits ("Move to the next free day"). */
export function nextFreePlace(drawn: DrawnBoard, move: Pick<PlanningMove, 'cardId' | 'to'>): PlanningPlace | null {
  const start = drawn.buckets.findIndex((bucket) => bucket.id === move.to.bucketId)
  const lane = drawn.lanes.find((entry) => entry.id === move.to.laneId)
  if (start < 0 || !lane) return null
  for (let index = start + 1; index < drawn.buckets.length; index += 1) {
    const bucket = drawn.buckets[index]!
    if (bucket.closed || lane.closed?.[bucket.id]) continue
    const place = { laneId: lane.id, bucketId: bucket.id }
    const after = withMove(drawn.cards, move.cardId, place)
    const cells = landingLoads(after, move.cardId, { lanes: drawn.lanes, buckets: drawn.buckets, layout: 'time' })
    if (cells.length > 0 && !cells.some(isOver) && cells.every((cell) => typeof cell.available === 'number' && cell.available > 0)) return place
  }
  return null
}

// ---- refusals in words ------------------------------------------------------------------------------------------------

export type Refusal =
  | { code: 'MOVED_BY'; name: string | null; at: string | null }
  | { code: 'OVERLOAD' }
  | { code: 'PLAN_CHANGED' }
  | { code: 'LANE_DOES_NOT' | 'ALREADY_ON_BOARD' | 'PART_THERE' | 'NOT_OPEN' | 'LANE_ARCHIVED' | 'NO_WORKING_TIME' | 'PART_LANE' | 'OPERATION_DONE' | 'NOTHING_TO_PLACE' | 'NOTHING_CHANGED' | 'CONFLICT' }
  | { code: 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID' | 'OFFLINE' | 'SIGNED_OUT' | 'FAILED' }

const CONFLICTS: ReadonlyArray<[RegExp, Refusal['code']]> = [
  [/ does .*; Op \d+|is done at .*: change its work centre/, 'LANE_DOES_NOT'],
  [/already has a bar on the board/, 'ALREADY_ON_BOARD'],
  [/already has a part on/, 'PART_THERE'],
  [/is not open|not open any more/, 'NOT_OPEN'],
  [/is archived|is not active/, 'LANE_ARCHIVED'],
  [/does not fit in the working time/, 'NO_WORKING_TIME'],
  [/A part of an order goes to a line or a workshop/, 'PART_LANE'],
  [/is done: nothing to place/, 'OPERATION_DONE'],
  [/^Nothing to place/, 'NOTHING_TO_PLACE'],
  [/^Nothing changed since|has nothing on/, 'NOTHING_CHANGED'],
]

/** A refused write, classified (the API's code, issue paths and the shape of its sentence; never its words on screen). */
export function refusalOf(error: unknown): Refusal {
  if (!isApiError(error)) return { code: 'FAILED' }
  const paths = error.issues.map((issue) => issuePath(issue).replace(/\./g, '/'))
  if (error.kind === 'conflict') {
    if (paths.includes('updatedAt')) {
      const at = error.issues.find((issue) => issuePath(issue) === 'updatedAt')?.message ?? null
      const name = /^Moved by (.+?) at /.exec(error.message)?.[1] ?? null
      return { code: 'MOVED_BY', name, at }
    }
    if (paths.includes('body/overloadReason') || paths.some((path) => path.startsWith('over/'))) return { code: 'OVERLOAD' }
    if (paths.includes('body/version')) return { code: 'PLAN_CHANGED' }
    for (const [pattern, code] of CONFLICTS) if (pattern.test(error.message)) return { code } as Refusal
    return { code: 'CONFLICT' }
  }
  if (error.kind === 'forbidden' || error.kind === 'step_up') return { code: 'FORBIDDEN' }
  if (error.kind === 'not_found') return { code: 'NOT_FOUND' }
  if (error.kind === 'invalid') return { code: 'INVALID' }
  if (error.kind === 'signed_out') return { code: 'SIGNED_OUT' }
  if (error.kind === 'unavailable' || error.code === 'network') return { code: 'OFFLINE' }
  return { code: 'FAILED' }
}

export function refusalWords(refusal: Refusal, words: Words): string {
  if (refusal.code === 'MOVED_BY') {
    const time = refusal.at ? whenWords(refusal.at, words) : null
    if (refusal.name && time) return words.t('refusal.MOVED_BY', { name: refusal.name, time })
    return time ? words.t('refusal.MOVED', { time }) : words.t('refusal.MOVED_SOMEONE')
  }
  return words.t(`refusal.${refusal.code}`)
}

/** A failed read, as one problem code of the page. */
export type ReadProblem = 'forbidden' | 'offline' | 'failed' | 'noSite'
export function readProblemOf(error: unknown): ReadProblem {
  if (!isApiError(error)) return 'failed'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'forbidden'
  if (error.kind === 'unavailable' || error.code === 'network') return 'offline'
  return 'failed'
}

// ---- publish ----------------------------------------------------------------------------------------------------------

export type PublishHeld = { code: 'permission' } | { code: 'nothingChanged'; version: number } | { code: 'nothingOnDays' } | { code: 'cannot' } | { code: 'noPlan' }

/** Why the band's "Publish to floor" is held (null: it may be published). The API's sentence is read for its kind only. */
export function bandPublishHeld(plan: Board['plan']): PublishHeld | null {
  if (!plan.mayPublish) return { code: 'permission' }
  if (plan.version === null) return { code: 'noPlan' }
  if (!plan.publishHeld) return null
  const changed = /^Nothing changed since v(\d+)/.exec(plan.publishHeld)
  if (changed) return { code: 'nothingChanged', version: Number(changed[1]) }
  if (/has nothing on/.test(plan.publishHeld)) return { code: 'nothingOnDays' }
  return { code: 'cannot' }
}

/** Why the dialog's "Publish vN" is held, from the preview's own figures. */
export function previewPublishHeld(preview: PublishPreview): PublishHeld | null {
  if (!preview.mayPublish) return { code: 'permission' }
  if (preview.plan.version === null) return { code: 'noPlan' }
  if (preview.slots === 0) return { code: 'nothingOnDays' }
  if (preview.previous && preview.diff.moved + preview.diff.added + preview.diff.removed === 0) return { code: 'nothingChanged', version: preview.previous.number }
  if (preview.heldReason) return { code: 'cannot' }
  return null
}

export function publishHeldWords(held: PublishHeld | null, words: Words, range?: { from: string; to: string }): string | null {
  if (!held) return null
  if (held.code === 'nothingChanged') return words.t('publish.held.nothingChanged', { version: held.version })
  if (held.code === 'nothingOnDays' && range) return words.t('publish.held.nothingOnRange', { from: dayWords(range.from, words.locale), to: dayWords(range.to, words.locale) })
  return words.t(`publish.held.${held.code}`)
}

// ---- problems -----------------------------------------------------------------------------------------------------------

export interface ProblemRow {
  id: string
  kind: BoardProblem['kind']
  words: string
  /** Where "Show on board" goes: a slot of the work order, else the lane and day. */
  workOrderId: string | null
  laneId: string | null
  date: string | null
}

export function problemRows(board: Board, words: Words): ProblemRow[] {
  const { t, locale } = words
  return board.problems.map((problem, index) => {
    if (problem.kind === 'OVERBOOKED') {
      const lane = problem.lane ? board.lanes.find((entry) => laneKeyOf(entry) === laneKeyOf(problem.lane!)) : undefined
      const bucket = board.buckets.find((entry) => entry.key === problem.bucketKey)
      const when = bucket && bucket.from !== bucket.to ? t('problem.between', { from: dayWords(bucket.from, locale), to: dayWords(bucket.to, locale) }) : t('problem.on', { day: dayWords(problem.date ?? bucket?.from ?? board.today, locale) })
      return {
        id: `over:${index}`,
        kind: problem.kind,
        words: t('problem.OVERBOOKED', { lane: lane?.name ?? '', pct: problem.loadPct ? number(Number(problem.loadPct), locale) : '—', when, over: minutesText(problem.overMinutes ?? 0, locale) }),
        workOrderId: null,
        laneId: problem.lane ? laneKeyOf(problem.lane) : null,
        date: problem.date,
      }
    }
    const workOrder = board.workOrders.find((entry) => entry.id === problem.workOrderId)
    return {
      id: `late:${problem.workOrderId ?? index}`,
      kind: problem.kind,
      words: problem.daysLate && problem.daysLate > 0 ? t('problem.FINISHES_LATE', { order: workOrder?.number ?? '', count: problem.daysLate, days: number(problem.daysLate, locale) }) : t('problem.LATE_NOW', { order: workOrder?.number ?? '' }),
      workOrderId: problem.workOrderId,
      laneId: null,
      date: problem.date,
    }
  })
}

// ---- the work order's schedule in words --------------------------------------------------------------------------------

/** The status and its first reason, in words ("At risk · must start by 4 Dec, 13:04"). */
export function scheduleWords(workOrder: Pick<BoardWorkOrder, 'schedule' | 'dueDate'>, words: Words): string {
  const { t } = words
  const reason = workOrder.schedule.reasons[0]?.code ?? workOrder.schedule.status
  const params = {
    start: workOrder.schedule.latestSafeStart ? whenWords(workOrder.schedule.latestSafeStart, words) : '—',
    finish: workOrder.schedule.plannedFinish ? whenWords(workOrder.schedule.plannedFinish, words) : workOrder.schedule.earliestFinish ? whenWords(workOrder.schedule.earliestFinish, words) : '—',
    due: workOrder.dueDate ? dayWords(workOrder.dueDate, words.locale) : '—',
  }
  return t(`reason.${reason}`, params)
}

export const trayChipTone = (chip: TrayChip) => (chip === 'PAST_LATEST_SAFE_START' ? 'danger' : chip === 'START_SOON' || chip === 'MATERIAL_NOT_READY' ? 'warning' : 'neutral')
