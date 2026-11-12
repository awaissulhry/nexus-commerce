import { plusDays } from '../../calendars/dates'
import type { BusinessDate } from '../../core/time'
import type { MaterialReadiness, ReadinessWord } from '../readiness/readiness'

/**
 * Moves that know the material (B-W2b-312; PLN-134; design planning.board "Material-aware (W2b): 'Leather arrives 14 Nov.
 * Earliest start with material: 15 Nov' → Snap to 15 Nov / Keep my date", the problems list's "Material not in time"),
 * pure. From a work order's material readiness now (planning/readiness: one word per material, its date, what arrives for
 * it), the first DAY its work may start with every material:
 *
 *   in hand      issued, reserved or in stock (RECEIVED, NOT_BOOKED): no limit
 *   arrives      it comes on a day: an open purchase order line in time (EXPECTED, its latest), a draft purchase order or a
 *                firm planned order (REQUESTED, the latest such arrival), a late or overdue supply (DELAYED: its date; a
 *                line already overdue counts from today, not received yet)
 *   not covered  some of it is short and nothing is ordered for it (NOT_ENOUGH): no day with material is known
 *
 * The work may start the day after the material arrives (it is received that day), or later by the item's delay days at
 * the site (ItemPlanning.delayDays: the days between arrival and use, e.g. an incoming inspection). The latest material
 * sets the day. The API turns the day into the lane's first working instant ("15 Nov 06:00"). A move earlier than that is
 * warned, never refused (the planner may keep the date: the supplier promised it sooner). No money, no person.
 */

export const MATERIAL_START_STATES = ['IN_HAND', 'ARRIVES', 'NOT_COVERED', 'NOT_PLANNED'] as const
export type MaterialStartState = (typeof MATERIAL_START_STATES)[number]

/** One material's part of the answer. */
export interface MaterialDay {
  readonly itemId: string
  readonly itemColourId: string | null
  readonly label: string
  readonly word: Exclude<ReadinessWord, 'NOT_PLANNED'>
  /** The day it arrives (ARRIVES); null: in hand, or not covered. */
  readonly arrives: BusinessDate | null
  /** It was due before today and is not received yet: counted from today. */
  readonly overdue: boolean
  /** The purchase order that brings it last, when one does. */
  readonly purchaseOrderNumber: string | null
  /** What brings it last: a purchase order line, or a firm planned order (null: in hand, not covered, or not known). */
  readonly source: 'PURCHASE_ORDER' | 'FIRM' | null
  /** The first day it can be used (the day after it arrives, or its delay days later). */
  readonly usableFrom: BusinessDate | null
  readonly notCovered: boolean
}

export interface MaterialStart {
  readonly state: MaterialStartState
  /** The latest arrival (ARRIVES, and NOT_COVERED when another material also arrives). */
  readonly arrives: BusinessDate | null
  /** The first day work may start with every material that has a day; null: no limit (in hand, not planned) or none known. */
  readonly startDay: BusinessDate | null
  /** The material that sets the day. */
  readonly setBy: MaterialDay | null
  /** The materials short with nothing ordered (NOT_COVERED). */
  readonly notCovered: readonly MaterialDay[]
  readonly materials: readonly MaterialDay[]
  /** One English sentence (the screens say their own from the state and the days). */
  readonly words: string
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "14 Nov" (a business date, no year: the board's horizon is months). */
export function shortDay(date: BusinessDate): string {
  const [, month, day] = date.split('-').map(Number) as [number, number, number]
  return `${day} ${MONTHS[month - 1]}`
}

const later = (a: BusinessDate | null, b: BusinessDate | null): BusinessDate | null => (a === null ? b : b === null ? a : a > b ? a : b)

/** The day a material arrives, from its readiness (see above). */
function arrivalOf(material: Pick<MaterialReadiness, 'word' | 'date' | 'arrivals'>, today: BusinessDate): { date: BusinessDate | null; overdue: boolean; purchaseOrderNumber: string | null; source: MaterialDay['source'] } {
  if (material.word === 'RECEIVED' || material.word === 'NOT_BOOKED' || material.word === 'NOT_ENOUGH') return { date: null, overdue: false, purchaseOrderNumber: null, source: null }
  const dated = material.arrivals.filter((arrival) => arrival.date !== null)
  const counted = material.word === 'DELAYED' ? dated : dated.filter((arrival) => arrival.state !== 'LATE')
  const last = [...counted].sort((a, b) => (a.date! < b.date! ? 1 : a.date! > b.date! ? -1 : 0))[0] ?? null
  let date: BusinessDate | null = material.word === 'DELAYED' || material.word === 'EXPECTED' ? (material.date ?? last?.date ?? null) : (last?.date ?? material.date ?? null)
  // A supply that sets the day: the latest arrival at or before the date (the one that comes that day).
  const by = date === null ? last : ([...counted].filter((arrival) => arrival.date === date)[0] ?? last)
  let overdue = false
  if (date !== null && date < today) {
    overdue = true
    date = today
  }
  const source = by?.kind ?? null
  if (date === null) return { date: today, overdue: false, purchaseOrderNumber: by?.purchaseOrderNumber ?? null, source }
  return { date, overdue, purchaseOrderNumber: by?.purchaseOrderNumber ?? null, source }
}

/**
 * The first day a work order's work may start with its materials. `delayDays` (item id → days, colour-specific first as
 * `itemId|itemColourId`): the item's days between arrival and use at the site (at least one: the day it is received).
 */
export function materialStartOf(
  readiness: { readonly word: ReadinessWord; readonly materials: readonly MaterialReadiness[] } | null,
  today: BusinessDate,
  delayDays: ReadonlyMap<string, number> = new Map(),
): MaterialStart {
  if (readiness === null || readiness.word === 'NOT_PLANNED' || readiness.materials.length === 0) {
    return { state: 'NOT_PLANNED', arrives: null, startDay: null, setBy: null, notCovered: [], materials: [], words: 'The plan has no material need for this work order: nothing holds its start.' }
  }
  const materials: MaterialDay[] = readiness.materials.map((material) => {
    const notCovered = material.word === 'NOT_ENOUGH'
    const arrival = arrivalOf(material, today)
    const delay = delayDays.get(`${material.itemId}|${material.itemColourId ?? ''}`) ?? delayDays.get(material.itemId) ?? 0
    const usableFrom = arrival.date === null ? null : plusDays(arrival.date, Math.max(1, delay))
    return { itemId: material.itemId, itemColourId: material.itemColourId, label: material.label, word: material.word, arrives: arrival.date, overdue: arrival.overdue, purchaseOrderNumber: arrival.purchaseOrderNumber, source: arrival.source, usableFrom, notCovered }
  })
  const notCovered = materials.filter((material) => material.notCovered)
  const dated = materials.filter((material) => material.usableFrom !== null)
  const setBy = [...dated].sort((a, b) => (a.usableFrom! < b.usableFrom! ? 1 : a.usableFrom! > b.usableFrom! ? -1 : a.label < b.label ? -1 : 1))[0] ?? null
  const startDay = setBy?.usableFrom ?? null
  const arrives = dated.reduce<BusinessDate | null>((latest, material) => later(latest, material.arrives), null)
  if (notCovered.length > 0) {
    const first = notCovered[0]!
    const more = notCovered.length > 1 ? ` (and ${notCovered.length - 1} more)` : ''
    return { state: 'NOT_COVERED', arrives, startDay, setBy, notCovered, materials, words: `${first.label}${more} is short and nothing is ordered for it yet: no day with material is known.` }
  }
  if (setBy === null) return { state: 'IN_HAND', arrives: null, startDay: null, setBy: null, notCovered: [], materials, words: 'Every material is in hand (issued, reserved or in stock): nothing holds its start.' }
  return { state: 'ARRIVES', arrives, startDay, setBy, notCovered: [], materials, words: `${arrivalWords(setBy)} Earliest start with material: ${shortDay(startDay!)}.` }
}

/** "Leather BLK arrives 14 Nov (SEED-PO-0001)." / "… (a firm planned order)." / "… was due before today and is not received yet." */
export function arrivalWords(material: MaterialDay): string {
  const order = material.purchaseOrderNumber ? ` (${material.purchaseOrderNumber})` : material.source === 'FIRM' ? ' (a firm planned order)' : ''
  if (material.overdue) return `${material.label}${order} was due before today and is not received yet.`
  return `${material.label} arrives ${shortDay(material.arrives!)}${order}.`
}

/**
 * A start against the material (the drop's check): in time when nothing holds it, or it starts on or after the earliest
 * start with material (`earliestStart`, the lane's first working instant of the start day). A material short with nothing
 * ordered is never in time.
 */
export function startInTime(state: MaterialStartState, startAt: number, earliestStart: number | null): boolean {
  if (state === 'IN_HAND' || state === 'NOT_PLANNED') return true
  if (state === 'NOT_COVERED') return false
  return earliestStart === null || startAt >= earliestStart
}
