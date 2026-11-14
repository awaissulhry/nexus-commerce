import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'

/**
 * Split one order into several shipments (B-W2b-386; LOG-005 "by carrier, service or ship-to, by hand or by rule"), pure.
 * A DRAFT shipment's garments that are not in a carton yet move onto a new DRAFT shipment of the same order, site and
 * customer (factory-db Shipment.splitFromId + splitReason, B-W2b-364), with its own carrier, service, who carries it or
 * delivery address. By hand: the office names the lines and how many garments of each. By rule: PROMISE_DATE — garments
 * promised for different days leave on different shipments (the earliest day stays, each later day gets its own).
 *
 * What may move from a line: its garments less those scanned into a carton (B-W2b-384's contents) and less those that
 * carry a serial already (a serial stays with its line); a whole line moves only when none of it is in a carton or
 * serialised. Something stays on the shipment it was split from; something moves. A shipment on hold passes its holds on
 * to the new one (the system's and the people's), so the split never frees goods from a hold.
 */

export const SPLIT_REASONS = ['CARRIER', 'SERVICE', 'SHIP_TO', 'PROMISE_DATE', 'PART_READY', 'CUSTOMER_REQUEST', 'OTHER'] as const
export type SplitReason = (typeof SPLIT_REASONS)[number]

export const SPLIT_RULES = ['PROMISE_DATE'] as const
export type SplitRule = (typeof SPLIT_RULES)[number]

export const SPLIT_LIMITS = Object.freeze({ lines: 200, shipments: 20 })

/** Why a split is refused (409 `refusal/<CODE>`). */
export const SPLIT_REFUSALS = ['NOT_DRAFT', 'NOTHING_TO_MOVE', 'NOTHING_STAYS', 'ONE_DAY'] as const
export type SplitRefusalCode = (typeof SPLIT_REFUSALS)[number]

export interface SplitLine {
  readonly id: string
  readonly quantity: number
  /** Garments of the line scanned into its carton. */
  readonly packed: number
  /** Serials the line holds. */
  readonly serials: number
}

/** The garments of a line that may move (0 for none). */
export const movableOf = (line: SplitLine): number => Math.max(0, line.quantity - Math.max(line.packed, line.serials))

export interface MoveAsk {
  readonly lineId: string
  readonly quantity: number
}

/**
 * The garments asked to move, checked against the shipment's lines (paths under `lines/<i>`): each line of the shipment
 * once, from 1 up to what may move of it; something stays behind.
 */
export function moveProblems(lines: readonly SplitLine[], asks: readonly MoveAsk[]): Issue[] {
  const issues: Issue[] = []
  const byId = new Map(lines.map((line) => [line.id, line]))
  const seen = new Set<string>()
  if (asks.length === 0) issues.push({ path: 'lines', message: 'Name the garments that move onto the new shipment.' })
  if (asks.length > SPLIT_LIMITS.lines) issues.push({ path: 'lines', message: `At most ${SPLIT_LIMITS.lines} lines at a time.` })
  asks.forEach((ask, index) => {
    const at = `lines/${index}`
    const line = byId.get(ask.lineId)
    if (!line) {
      issues.push({ path: `${at}/lineId`, message: 'Not a line of this shipment.' })
      return
    }
    if (seen.has(ask.lineId)) issues.push({ path: `${at}/lineId`, message: 'Name each line once.' })
    seen.add(ask.lineId)
    const movable = movableOf(line)
    if (movable === 0) issues.push({ path: `${at}/quantity`, message: 'None of this line can move: its garments are in a carton or carry serials (take them out first).' })
    else if (!Number.isSafeInteger(ask.quantity) || ask.quantity < 1 || ask.quantity > movable) issues.push({ path: `${at}/quantity`, message: `From 1 to ${movable} garment(s) of this line can move.` })
  })
  return issues
}

/** Garments left on the shipment after the moves (the shipment keeps at least one). */
export function garmentsLeft(lines: readonly SplitLine[], asks: readonly MoveAsk[]): number {
  const moved = new Map(asks.map((ask) => [ask.lineId, ask.quantity]))
  return lines.reduce((sum, line) => sum + line.quantity - (moved.get(line.id) ?? 0), 0)
}

export interface DeliveryChoice {
  readonly transportBy: 'CARRIER' | 'SENDER' | 'RECIPIENT'
  readonly carrierCode: string | null
  readonly serviceCode: string | null
  readonly shipToAddressId: string | null
}

/** A split by carrier, service or ship-to changes that on the new shipment (paths are field names). */
export function reasonProblems(reason: SplitReason, from: DeliveryChoice, to: DeliveryChoice): Issue[] {
  if (reason === 'CARRIER' && from.transportBy === to.transportBy && from.carrierCode === to.carrierCode) return [{ path: 'carrierCode', message: 'A split by carrier gives the new shipment another carrier (or who carries it).' }]
  if (reason === 'SERVICE' && from.serviceCode === to.serviceCode) return [{ path: 'serviceCode', message: 'A split by service gives the new shipment another service.' }]
  if (reason === 'SHIP_TO' && (to.shipToAddressId === null || from.shipToAddressId === to.shipToAddressId)) return [{ path: 'shipToAddressId', message: 'A split by delivery address sends the new shipment to another delivery address of the customer.' }]
  return []
}

/** A line with its ship-by day (its garments' current promise), for the rule. */
export interface DatedLine extends SplitLine {
  readonly shipBy: BusinessDate | null
}

export interface RuleGroup {
  readonly shipBy: BusinessDate
  readonly moves: readonly MoveAsk[]
  readonly garments: number
}

/**
 * PROMISE_DATE: the shipment's garments by their ship-by day. The earliest day (and garments of no known day) stay; each
 * later day becomes a new shipment with what may move of its lines (what may not move stays, `kept`).
 */
export function groupsByPromise(lines: readonly DatedLine[]): { readonly stays: BusinessDate | null; readonly groups: readonly RuleGroup[]; readonly kept: readonly { readonly lineId: string; readonly garments: number }[] } {
  const days = [...new Set(lines.flatMap((line) => (line.shipBy === null ? [] : [line.shipBy])))].sort()
  const stays = days[0] ?? null
  const kept: { lineId: string; garments: number }[] = []
  const groups: RuleGroup[] = []
  for (const day of days.slice(1)) {
    const moves: MoveAsk[] = []
    for (const line of lines.filter((candidate) => candidate.shipBy === day)) {
      const movable = movableOf(line)
      if (movable > 0) moves.push({ lineId: line.id, quantity: movable })
      if (movable < line.quantity) kept.push({ lineId: line.id, garments: line.quantity - movable })
    }
    if (moves.length > 0) groups.push({ shipBy: day, moves, garments: moves.reduce((sum, move) => sum + move.quantity, 0) })
  }
  return { stays, groups: groups.slice(0, SPLIT_LIMITS.shipments), kept }
}
