import { isSafetyReturn, suggestedOutcome, type GoodsOutcome } from '@nexus/factory-domain/sales/returns/rules'
import type { DockLine, DockReturn, ParcelCondition, ReceiptBody, ReturnGrade } from './api'

/**
 * Receive a return's rules without a screen (SCR-180; design floor.returnsin; LOG-114, QHS-117, SAL-346): which lines a
 * scanned label matches, what this parcel brings per line (never more than a line still expects; a graded line takes no
 * more: what else comes of it goes on a new return), the receipt's body, the lines left to grade, the suggestion for a
 * grade (factory-domain's suggestedOutcome: the same rule the office decides by) and why restocking as new is held,
 * and where the goods go. Pure, so the tests hold them.
 */

export const PARCEL_CONDITIONS: readonly ParcelCondition[] = ['INTACT', 'DAMAGED', 'OPENED']
export const GRADES: readonly ReturnGrade[] = ['NEW', 'LIKE_NEW', 'GOOD', 'DAMAGED', 'UNUSABLE']
export const MAX_PARCELS = 99
/** The most photos the dock keeps per parcel or garment here (the API takes 12 per record). */
export const MAX_PHOTOS = 6

export type ReturnsStage = 'scan' | 'parcel' | 'lines' | 'grade' | 'route' | 'done' | 'noPermission'

/** A photo taken at the dock, waiting for its receipt or grade (the bytes stay in the screen). */
export interface DockPhoto {
  readonly key: string
}

/** What this parcel brings, as the dock enters it before the one receipt. */
export interface Arrival {
  readonly parcels: number
  readonly condition: ParcelCondition | null
  readonly ddtNumber: string | null
  readonly photos: readonly DockPhoto[]
  /** Line id → pieces in this parcel. */
  readonly counts: Readonly<Record<string, number>>
}

export function emptyArrival(): Arrival {
  return { parcels: 1, condition: null, ddtNumber: null, photos: [], counts: {} }
}

const key = (value: string | null | undefined) => (value ?? '').trim().toUpperCase()

/** A line still takes pieces: something is expected and it is not graded yet. */
export const takes = (line: DockLine): boolean => line.expected > 0 && line.grade === null

/** How many more of `line` this parcel may bring. */
export const roomOf = (line: DockLine, arrival: Arrival): number => (takes(line) ? Math.max(0, line.expected - (arrival.counts[line.id] ?? 0)) : 0)

/** Lines a garment's scanned serial or batch label names (the open ones first). */
export type ScanMatch = { readonly kind: 'line'; readonly lineId: string } | { readonly kind: 'full'; readonly seq: number } | { readonly kind: 'none' }

export function matchScan(dock: DockReturn, arrival: Arrival, code: string): ScanMatch {
  const wanted = key(code)
  if (wanted === '') return { kind: 'none' }
  const named = dock.lines.filter((line) => key(line.serial) === wanted || key(line.batchNumber) === wanted)
  const open = named.find((line) => roomOf(line, arrival) > 0)
  if (open) return { kind: 'line', lineId: open.id }
  if (named[0]) return { kind: 'full', seq: named[0].seq }
  return { kind: 'none' }
}

/** One more (or one less) piece of a line in this parcel, within what it still expects. */
export function countLine(arrival: Arrival, line: DockLine, delta: 1 | -1): Arrival {
  const now = arrival.counts[line.id] ?? 0
  const next = Math.min(Math.max(0, now + delta), takes(line) ? line.expected : 0)
  if (next === now) return arrival
  const counts = { ...arrival.counts }
  if (next === 0) delete counts[line.id]
  else counts[line.id] = next
  return { ...arrival, counts }
}

/** Every piece each open line still expects. */
export function countAll(arrival: Arrival, dock: DockReturn): Arrival {
  const counts: Record<string, number> = {}
  for (const line of dock.lines) if (takes(line)) counts[line.id] = line.expected
  return { ...arrival, counts }
}

export const piecesIn = (arrival: Arrival): number => Object.values(arrival.counts).reduce((sum, value) => sum + value, 0)
export const anyOpen = (dock: DockReturn): boolean => dock.lines.some(takes)

/** Why Receive is held, as a code the screen words (null: it may go). */
export type ReceiveHeld = 'condition' | 'nothing' | null
export function receiveHeld(arrival: Arrival): ReceiveHeld {
  if (arrival.condition === null) return 'condition'
  if (piecesIn(arrival) === 0) return 'nothing'
  return null
}

/** The ONE receipt's body (the lines this parcel brought, in line order). */
export function receiptBody(dock: DockReturn, arrival: Arrival): ReceiptBody {
  return {
    version: dock.version,
    parcels: Math.min(Math.max(1, arrival.parcels), MAX_PARCELS),
    parcelCondition: arrival.condition ?? 'INTACT',
    ...(arrival.ddtNumber ? { customerDdtNumber: arrival.ddtNumber } : {}),
    lines: dock.lines.filter((line) => (arrival.counts[line.id] ?? 0) > 0).map((line) => ({ lineId: line.id, quantity: arrival.counts[line.id]! })),
  }
}

/** Lines received and waiting for their grade (not decided), in line order. */
export const toGrade = (dock: DockReturn): DockLine[] => dock.lines.filter((line) => line.receivedQuantity > 0 && line.grade === null && line.disposition === null)

/** The line to grade next: the one asked, else the first waiting. */
export function lineToGrade(dock: DockReturn, wanted: string | null): DockLine | null {
  const waiting = toGrade(dock)
  return waiting.find((line) => line.id === wanted) ?? waiting[0] ?? null
}

/** Why restocking as new is held for this grade (factory-domain restockHeldWords' cases), as a code the screen words. */
export type RestockHeld = 'safety' | 'usedPpe' | 'notNew' | null
export function restockHeldOf(line: Pick<DockLine, 'ppe' | 'reasonCode' | 'cause'>, grade: ReturnGrade): RestockHeld {
  if (isSafetyReturn({ ppe: line.ppe, reasonCode: line.reasonCode, cause: (line.cause as never) ?? null })) return 'safety'
  if (grade === 'NEW' || (grade === 'LIKE_NEW' && !line.ppe)) return null
  return line.ppe ? 'usedPpe' : 'notNew'
}

/** Where the return policy suggests the garment goes after this grade (the office decides: the floor only shows it). */
export function suggestionOf(line: Pick<DockLine, 'ppe' | 'reasonCode' | 'cause'>, grade: ReturnGrade): { outcome: GoodsOutcome; held: RestockHeld } {
  return { outcome: suggestedOutcome({ grade, cause: (line.cause as never) ?? null, ppe: line.ppe, reasonCode: line.reasonCode }), held: restockHeldOf(line, grade) }
}

/** Where the goods of this return go now: a decided line's place, else the inspection place until the office decides. */
export function placeOf(dock: DockReturn): { code: string; name: string } | null {
  const named = dock.lines.find((line) => line.place !== null && line.receivedQuantity > 0)
  const inspection = dock.places.inspection
  if (inspection && (!named || named.place === inspection.code)) return { code: inspection.code, name: inspection.name }
  if (named?.place) return { code: named.place, name: named.place }
  return inspection ? { code: inspection.code, name: inspection.name } : null
}

/** A scanned place label confirms the place (its code, case and spaces aside). */
export const placeConfirmed = (place: { code: string } | null, code: string): boolean => place !== null && key(place.code) === key(code)

/** The garment a line names, short: style code, colourway, size; else its description. */
export function garmentOf(line: DockLine): string {
  const parts = [line.style?.code, line.colourway?.code, line.size].filter((part): part is string => Boolean(part))
  return parts.length > 0 ? parts.join(' · ') : (line.description ?? '')
}
