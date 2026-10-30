import { moveAllocation, type Allocation as AllocationState } from '@nexus/factory-domain/planning/schedule/allocation'
import type { PlanningBucket, PlanningCard, PlanningLane, PlanningMark } from '@nexus/ui/patterns/planning-board/index'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { INTL_LOCALE, type Locale } from '../../../lib/i18n/locales'
import type { Translate } from '../../../lib/i18n/messages'
import type { AllocateBody, Allocation, AllocationCard, AllocationLane, AllocationLaneRef } from './api'

/**
 * Lines & subcontractors (SCR-126), pure: the address, the API's allocation → the DS PlanningBoard in its columns
 * layout (the tray is "Not allocated", one column per line and workshop, one bucket: the next four weeks), what a card
 * move asks of the API (factory-domain's `moveAllocation`, then the work order's whole allocation with its version), and
 * a refusal in our words (never the domain's or the API's English).
 */

export const NAMESPACE = 'planning-allocation'
/** The one bucket of the columns: the load is the next four weeks'. */
export const WINDOW = 'next-4-weeks'

export interface AllocationControls {
  site: string | null
  /** The card whose detail is open (`?card=`). */
  card: string | null
}

export function controlsOf(params: { get(name: string): string | null } | null | undefined): AllocationControls {
  return { site: params?.get('site') ?? null, card: params?.get('card') ?? null }
}

export function queryOf(controls: AllocationControls): string {
  const query = new URLSearchParams()
  if (controls.site) query.set('site', controls.site)
  if (controls.card) query.set('card', controls.card)
  return query.toString()
}

export const laneKeyOf = (lane: AllocationLaneRef): string => `${lane.kind}:${lane.id}`
export function laneRefOf(key: string | null): AllocationLaneRef | null {
  if (!key) return null
  const at = key.indexOf(':')
  const kind = key.slice(0, at)
  return kind === 'LINE' || kind === 'WORKSHOP' ? { kind, id: key.slice(at + 1) } : null
}

export interface Words {
  t: Translate
  locale: Locale
}

const number = (value: number, locale: Locale, digits = 0) => new Intl.NumberFormat(INTL_LOCALE[locale], { maximumFractionDigits: digits }).format(value)
export const minutesText = (value: number | string, locale: Locale) => number(Number(value), locale, 1)

export function dayWords(date: string, locale: Locale): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(new Date(Date.UTC(year, month - 1, day)))
}

export function laneDetail(lane: AllocationLane, words: Words): string {
  const { t, locale } = words
  if (lane.kind === 'LINE') return t('lane.line', { count: lane.piecesBooked, pieces: number(lane.piecesBooked, locale) })
  return t('lane.workshop', { count: lane.subcontractOrders ?? 0, orders: number(lane.subcontractOrders ?? 0, locale), pieces: number(lane.piecesBooked, locale) })
}

/** The columns: every line and workshop of the site. */
export function lanesOf(data: Allocation, words: Words): PlanningLane[] {
  const { t, locale } = words
  return data.lanes.map((lane) => ({
    id: laneKeyOf(lane),
    label: lane.name,
    detail: laneDetail(lane, words),
    ...(lane.load
      ? {
          capacity: { [WINDOW]: Number(lane.load.availableMinutes) },
          capacityWords: { [WINDOW]: t('lane.capacity', { available: minutesText(lane.load.availableMinutes, locale), booked: minutesText(lane.load.bookedMinutes, locale), pct: lane.load.loadPct ? number(Number(lane.load.loadPct), locale) : '—' }) },
        }
      : { capacityWords: { [WINDOW]: t('lane.workshopCapacity') } }),
  }))
}

export const bucketsOf = (words: Words): PlanningBucket[] => [{ id: WINDOW, label: words.t('window') }]

export function cardOf(card: AllocationCard, words: Words): PlanningCard {
  const { t, locale } = words
  const marks: PlanningMark[] = []
  if (card.slot) marks.push({ label: t('mark.part', { pieces: number(card.pieces, locale), of: number(card.workOrder.garments, locale) }), tone: 'info' })
  if (card.schedule.status === 'AT_RISK') marks.push({ label: t('mark.atRisk'), tone: 'warning' })
  if (card.workOrder.holdReason) marks.push({ label: t('mark.onHold'), tone: 'neutral' })
  if (card.workOrder.status === 'DRAFT') marks.push({ label: t('mark.draft'), tone: 'neutral' })
  return {
    id: card.id,
    label: card.workOrder.number,
    detail: t('card.detail', { style: card.workOrder.style.name, pieces: number(card.pieces, locale), due: card.workOrder.dueDate ? t('card.due', { date: dayWords(card.workOrder.dueDate, locale) }) : t('card.noDue') }),
    minutes: Number(card.minutes),
    laneId: card.lane ? laneKeyOf(card.lane) : null,
    bucketId: WINDOW,
    late: card.schedule.status === 'LATE',
    marks,
  }
}

export function drawAllocation(data: Allocation, words: Words): { lanes: PlanningLane[]; buckets: PlanningBucket[]; cards: PlanningCard[] } {
  return { lanes: lanesOf(data, words), buckets: bucketsOf(words), cards: data.cards.map((card) => cardOf(card, words)) }
}

/** The work order's allocation as the board shows it: its line (the line part's lane) and its parts. */
export function allocationOf(data: Allocation, workOrderId: string): AllocationState {
  const cards = data.cards.filter((card) => card.workOrder.id === workOrderId)
  const line = cards.find((card) => card.slot === null)
  return {
    lineId: line?.lane?.kind === 'LINE' ? line.lane.id : null,
    parts: cards.filter((card) => card.slot !== null && card.lane !== null).map((card) => ({ lane: card.lane!, pieces: card.pieces })),
  }
}

export type AllocationRefusal = 'STALE' | 'WHOLE' | 'TOO_MANY' | 'SAME' | 'UNALLOCATED_PART' | 'CHANGED' | 'LOCKED' | 'NOT_OPEN' | 'LANE_INACTIVE' | 'INVALID' | 'FORBIDDEN' | 'NOT_FOUND' | 'OFFLINE' | 'FAILED'

const DOMAIN: ReadonlyArray<[RegExp, AllocationRefusal]> = [
  [/not in that column any more/, 'STALE'],
  [/Move whole garments/, 'WHOLE'],
  [/The card holds/, 'TOO_MANY'],
  [/already there/, 'SAME'],
  [/cannot wait unallocated/, 'UNALLOCATED_PART'],
]

export type AllocationPlan = { kind: 'put'; workOrderId: string; body: AllocateBody } | { kind: 'refused'; code: AllocationRefusal }

/** What moving a card (or `pieces` of its garments) to a column asks: the work order's whole next allocation. */
export function planAllocation(data: Allocation, cardId: string, toLane: string | null, pieces?: number): AllocationPlan {
  const card = data.cards.find((entry) => entry.id === cardId)
  if (!card) return { kind: 'refused', code: 'STALE' }
  const to = laneRefOf(toLane)
  const result = moveAllocation(allocationOf(data, card.workOrder.id), { from: card.lane, to, pieces }, card.workOrder.garments)
  if ('refusal' in result) return { kind: 'refused', code: DOMAIN.find(([pattern]) => pattern.test(result.refusal))?.[1] ?? 'INVALID' }
  return { kind: 'put', workOrderId: card.workOrder.id, body: { version: card.workOrder.version, lineId: result.allocation.lineId, parts: result.allocation.parts.map((part) => ({ lane: part.lane, pieces: part.pieces })) } }
}

/** A refused PUT, classified by the API's kind, issue paths and the shape of its sentence. */
export function refusalOf(error: unknown): AllocationRefusal {
  if (!isApiError(error)) return 'FAILED'
  if (error.kind === 'conflict') {
    if (error.issues.some((issue) => issuePath(issue) === 'version' || issuePath(issue) === 'body/version')) return 'CHANGED'
    if (/allocation is kept as it was/.test(error.message)) return 'LOCKED'
    if (/is not open/.test(error.message)) return 'NOT_OPEN'
    if (/already allocated so/.test(error.message)) return 'SAME'
    if (/is archived|is not active/.test(error.message)) return 'LANE_INACTIVE'
    return 'CHANGED'
  }
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'FORBIDDEN'
  if (error.kind === 'not_found') return 'NOT_FOUND'
  if (error.kind === 'invalid') return 'INVALID'
  if (error.kind === 'unavailable' || error.code === 'network') return 'OFFLINE'
  return 'FAILED'
}

export type ReadProblem = 'forbidden' | 'offline' | 'failed' | 'noSite'
export function readProblemOf(error: unknown): ReadProblem {
  if (!isApiError(error)) return 'failed'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'forbidden'
  if (error.kind === 'unavailable' || error.code === 'network') return 'offline'
  return 'failed'
}
