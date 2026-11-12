import type { ScanRead } from '../../../scan/scan-model'
import { codeKey } from '../../shared/as-of'
import type { TickState } from '../../shared/view/TaskParts'

/**
 * The pick list by bin on the floor (B-W2b-310 on B-W2b-298's API; design floor.pick sec:need "W2b pick list (SCM-212): sorted by
 * bin path, reservations, scan each pick"), as rules without a screen or a network: one work order's walk through the store (its
 * stops in the order of the site's bins: what is reserved for it first, an approved substitute, then what W2a proposes), which
 * stop a scanned code is, what it takes (a hide whole, a lot by quantity on the pad defaulted to the stop's quantity), why a
 * stop is not taken now (a blocked place, a lot on hold or not released), the next stop, and the stops this tablet took while
 * offline. Quantities are the API's decimal text in the material's base unit: shown and compared, never valued. Pure.
 */

export const STOP_SOURCES = ['RESERVED', 'PROPOSED', 'SUBSTITUTE'] as const
export type StopSource = (typeof STOP_SOURCES)[number]

export const WALK_QUALITIES = ['RELEASED', 'QUARANTINE', 'BLOCKED', 'REJECTED', 'ON_HOLD'] as const
export type WalkQuality = (typeof WALK_QUALITIES)[number]

export interface WalkPlace {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly kind: string
  readonly labelCode: string | null
  /** Its codes from the top of the site's tree down to it. */
  readonly path: readonly string[]
  /** Its turn in the walk (0 = first). */
  readonly rank: number
  readonly blocked: boolean
}

export interface WalkStop {
  /** Its turn in the walk (1 = first). */
  readonly turn: number
  readonly workOrderId: string
  readonly workOrderNumber: string
  readonly lineKey: string
  readonly itemId: string
  readonly itemCode: string
  readonly itemName: string
  readonly colourCode: string | null
  readonly baseUom: string
  /** NONE, LOT or HIDE. */
  readonly tracking: string
  readonly location: WalkPlace
  readonly lotId: string | null
  readonly lotCode: string | null
  readonly hideId: string | null
  readonly hideCode: string | null
  readonly quantity: string
  readonly source: StopSource
  readonly reservationId: string | null
  readonly substitutionId: string | null
  readonly quality: WalkQuality
  readonly issuable: boolean
}

export interface WalkLine {
  readonly key: string
  readonly itemId: string
  readonly itemCode: string
  readonly itemName: string
  readonly itemColourId: string | null
  readonly colourCode: string | null
  readonly baseUom: string
  readonly toIssue: string
  readonly reserved: string
  readonly substituted: string
  readonly toPick: string
  readonly covered: boolean
}

export interface WalkKit {
  readonly location: { readonly id: string; readonly code: string; readonly name: string } | null
  readonly checkedAt: string | null
  /** The kit record's version (0: none yet). */
  readonly version: number
}

/** One work order's pick list by bin (`GET /inventory/pick-lists/work-orders/:id`). */
export interface Walk {
  readonly asOf: string
  readonly workOrder: { readonly id: string; readonly number: string; readonly status: string; readonly issuable: boolean }
  readonly kit: WalkKit
  /** Its open PICK task of the warehouse inbox. */
  readonly task: { readonly id: string; readonly status: string; readonly version: number } | null
  readonly lines: readonly WalkLine[]
  readonly stops: readonly WalkStop[]
  readonly places: readonly (WalkPlace & { readonly stops: number })[]
}

// ---- numbers -----------------------------------------------------------------------------------------------------------

export const num = (value: string | number | null | undefined): number => {
  const n = typeof value === 'string' ? Number(value) : (value ?? 0)
  return Number.isFinite(n) ? n : 0
}

const COUNT_UOMS = new Set(['PCS', 'PAIR', 'SET', 'HIDE', 'SIDE', 'ROLL', 'CONE', 'BOX'])
export const decimalsOf = (uom: string): number => (COUNT_UOMS.has(uom) ? 0 : 2)

// ---- the stops -----------------------------------------------------------------------------------------------------------

/** A stop as this tablet tells it apart (its place, what it takes and for what): stable across reads, unlike its turn. */
export const stopKey = (stop: Pick<WalkStop, 'location' | 'lotId' | 'hideId' | 'substitutionId' | 'itemId'>): string => [stop.location.id, stop.itemId, stop.lotId ?? '-', stop.hideId ?? '-', stop.substitutionId ?? '-'].join('|')

/** Why a stop is not taken now (in the screen's words), or null: take it. */
export type StopHeld = 'blocked' | 'onHold' | 'notReleased' | null

export function stopHeld(stop: Pick<WalkStop, 'issuable' | 'quality' | 'location'>): StopHeld {
  if (stop.issuable) return null
  if (stop.location.blocked) return 'blocked'
  if (stop.quality === 'ON_HOLD') return 'onHold'
  return 'notReleased'
}

/** The refusal code a held stop's scan shows (the screen's own words, `refusal.<CODE>`). */
export const HELD_CODE: Readonly<Record<Exclude<StopHeld, null>, string>> = { blocked: 'STOP_BLOCKED', onHold: 'STOP_ON_HOLD', notReleased: 'STOP_NOT_RELEASED' }

/** The codes the pick list by bin says in its own words. */
export const WALK_REFUSALS = ['STOP_BLOCKED', 'STOP_ON_HOLD', 'STOP_NOT_RELEASED'] as const

/** What is scanned at a stop: its hide's tag, else its lot's label, else (untracked) the material's code. */
export const codeOfStop = (stop: Pick<WalkStop, 'hideCode' | 'lotCode' | 'itemCode'>): string => stop.hideCode ?? stop.lotCode ?? stop.itemCode

/** The stops still to take: the walk's, less those this tablet took and the office has not read back yet. */
export const openStops = (walk: Walk | null, taken: ReadonlySet<string>): readonly WalkStop[] => (walk ? walk.stops.filter((stop) => !taken.has(stopKey(stop))) : [])

/** The next stop to go to: the first one still to take that may be taken now. */
export const nextStop = (walk: Walk | null, taken: ReadonlySet<string>): WalkStop | null => openStops(walk, taken).find((stop) => stop.issuable) ?? null

const same = (a: string | null | undefined, b: string) => a !== null && a !== undefined && codeKey(a) === codeKey(b)

/**
 * The stop a scanned code is on the walk: a hide's (or its remnant's) tag the stop of that hide; a lot's label the first stop of
 * that lot still to take (the walk's order); an untracked material its stop by the material's code. Null: none — Pick & issue's
 * own rules decide (W1's issue, the API's words).
 */
export function stopOfScan(walk: Walk | null, taken: ReadonlySet<string>, read: ScanRead): WalkStop | null {
  const stops = openStops(walk, taken)
  const code = read.code
  const byHide = stops.find((stop) => same(stop.hideCode, code))
  if (byHide) return byHide
  if (read.kind === 'label' && (read.type === 'hide' || read.type === 'remnant')) return null
  return stops.find((stop) => stop.hideCode === null && same(stop.lotCode, code)) ?? stops.find((stop) => stop.hideCode === null && stop.lotCode === null && same(stop.itemCode, code)) ?? null
}

/** A stop's scan issues at once (a hide, whole) or asks its quantity first (a lot, an untracked material). */
export const takesWhole = (stop: Pick<WalkStop, 'hideId'>): boolean => stop.hideId !== null

export interface StopBounds {
  readonly min: number
  readonly max: number
  readonly decimals: number
  /** The stop's quantity (what the walk takes here): the pad's default. */
  readonly suggested: number
  readonly covered: boolean
}

/** The pad of a stop: at most what the walk takes here, defaulted to it. */
export function stopBounds(stop: Pick<WalkStop, 'quantity' | 'baseUom'>): StopBounds {
  const decimals = decimalsOf(stop.baseUom)
  const max = Math.max(0, num(stop.quantity))
  return { min: max > 0 ? 1 / 10 ** decimals : 0, max, decimals, suggested: max, covered: max <= 0 }
}

/** The body of a stop's issue (W1's issue, or the substitute's): its code, its place, and for a lot its quantity. */
export function stopBody(stop: WalkStop, quantity?: { readonly value: number; readonly decimals: number }): { code: string; fromLocationId: string; quantity?: string } {
  return { code: codeOfStop(stop), fromLocationId: stop.location.id, ...(quantity && !takesWhole(stop) ? { quantity: quantity.value.toFixed(Math.max(0, Math.min(4, quantity.decimals))) } : {}) }
}

/** How many places the walk passes (with something still to take), and the first. */
export function walkSummary(walk: Walk | null, taken: ReadonlySet<string>): { places: number; first: string | null; stops: number } {
  const stops = openStops(walk, taken)
  const places = [...new Set(stops.map((stop) => stop.location.id))]
  return { places: places.length, first: stops[0]?.location.code ?? null, stops: stops.length }
}

/** The last stop taken, as the strip shows it (two ticks: recorded by the office, or kept on this tablet). */
export interface PickedLast {
  readonly kind: 'picked'
  readonly code: string
  readonly place: string
  readonly quantity: string | null
  readonly uom: string
  readonly substitute: boolean
  readonly ticks: TickState
  readonly clientEventId: string | null
}
