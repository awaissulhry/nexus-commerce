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

// ── B-OS-010 (order shipments tab; X1 S1, D1): split into several shipments in one go ──────────────────────────────────────────
/** One new shipment of a split into several: its garments (each line once, any number of a line's movable garments). */
export interface GroupAsk {
  readonly moves: readonly MoveAsk[]
}

/**
 * The garments asked to move into several new shipments (paths under `groups/<g>/lines/<i>`): 1 to 20 shipments, each with
 * something to move and each line once in it; a line may give garments to several new shipments, never more than may move of
 * it in all; something stays behind. A single group reads exactly as `moveProblems`.
 */
export function groupMoveProblems(lines: readonly SplitLine[], groups: readonly GroupAsk[]): Issue[] {
  if (groups.length === 0) return [{ path: 'groups', message: 'Name the new shipments and their garments.' }]
  if (groups.length > SPLIT_LIMITS.shipments) return [{ path: 'groups', message: `At most ${SPLIT_LIMITS.shipments} new shipments at a time.` }]
  const issues: Issue[] = []
  const byId = new Map(lines.map((line) => [line.id, line]))
  const asked = new Map<string, number>()
  for (const group of groups) for (const move of group.moves) asked.set(move.lineId, (asked.get(move.lineId) ?? 0) + move.quantity)
  groups.forEach((group, index) => {
    const at = `groups/${index}`
    if (group.moves.length === 0) issues.push({ path: `${at}/lines`, message: 'Name the garments that move onto this new shipment.' })
    if (group.moves.length > SPLIT_LIMITS.lines) issues.push({ path: `${at}/lines`, message: `At most ${SPLIT_LIMITS.lines} lines at a time.` })
    const seen = new Set<string>()
    group.moves.forEach((move, position) => {
      const path = `${at}/lines/${position}`
      const line = byId.get(move.lineId)
      if (!line) {
        issues.push({ path: `${path}/lineId`, message: 'Not a line of this shipment.' })
        return
      }
      if (seen.has(move.lineId)) issues.push({ path: `${path}/lineId`, message: 'Name each line once in a new shipment.' })
      seen.add(move.lineId)
      const movable = movableOf(line)
      if (movable === 0) issues.push({ path: `${path}/quantity`, message: 'None of this line can move: its garments are in a carton or carry serials (take them out first).' })
      else if (!Number.isSafeInteger(move.quantity) || move.quantity < 1 || (asked.get(move.lineId) ?? 0) > movable) issues.push({ path: `${path}/quantity`, message: `From 1 to ${movable} garment(s) of this line can move, over every new shipment.` })
    })
  })
  return issues
}

/** The moves of several new shipments as one ask per line (what the split re-checks under its lock). */
export function mergedAsks(groups: readonly GroupAsk[]): MoveAsk[] {
  const asked = new Map<string, number>()
  for (const group of groups) for (const move of group.moves) asked.set(move.lineId, (asked.get(move.lineId) ?? 0) + move.quantity)
  return [...asked].map(([lineId, quantity]) => ({ lineId, quantity }))
}
// ── end B-OS-010 ──

// ── B-OS-011, B-OS-012, B-OS-013 (order shipments tab; X1 S2–S4; 13-backend §2): move, merge, take an order off ─────────────────
/**
 * Garments of a DRAFT move onto another DRAFT of the same customer, company and site (each order of them passes the join rules
 * against the target: B-OP-047's joinProblems, refused as `JOIN_<CODE>`); a merge moves every garment and cancels the emptied
 * DRAFT ("Merged into …", never deleted); taking one order off removes all of its lines in one step. What may move of a line is
 * the split's (`movableOf`: never garments in a carton or carrying a serial). Refusals are 409 `refusal/<CODE>`.
 */
export const MOVE_REFUSALS = ['NOT_DRAFT', 'SAME', 'OTHER_SITE', 'NOTHING_TO_MOVE', 'NOTHING_STAYS', 'ON_HOLD_QUALITY', 'MERGE_PACKED', 'MERGE_LABELLED'] as const
export type MoveRefusalCode = (typeof MOVE_REFUSALS)[number]

export const TAKE_OFF_REFUSALS = ['NOT_DRAFT', 'NOT_ON_IT', 'FIRST_ORDER', 'IN_CARTON'] as const
export type TakeOffRefusalCode = (typeof TAKE_OFF_REFUSALS)[number]

/** The refusal path of a move: its own codes, or a join reason of the target (`JOIN_SHIP_TO`, …). */
export const moveRefusalPath = (code: MoveRefusalCode | `JOIN_${string}`): string => `refusal/${code}`
export const takeOffRefusalPath = (code: TakeOffRefusalCode): string => `refusal/${code}`

/** The cancel reason of a DRAFT merged into another (the database's cancelReason: free text, not blank). */
export function mergedReason(intoNumber: string, words?: string | null): string {
  const extra = (words ?? '').trim()
  return extra === '' ? `Merged into ${intoNumber}` : `Merged into ${intoNumber}: ${extra}`
}

/** The words of a move's own refusal (English; the screens word the code themselves). */
export function moveRefusalWords(code: MoveRefusalCode, facts: { readonly number: string; readonly target?: string | null; readonly status?: string | null }): string {
  switch (code) {
    case 'NOT_DRAFT':
      return `Shipment ${facts.number} is ${facts.status ?? 'not a draft'}: only a DRAFT gives or takes garments (unpack it first).`
    case 'SAME':
      return `Garments move to another shipment, not to ${facts.number} itself.`
    case 'OTHER_SITE':
      return `${facts.target ?? 'The other shipment'} leaves from another site: garments move only between shipments of one site.`
    case 'NOTHING_TO_MOVE':
      return `None of these garments of ${facts.number} can move: they are in a carton or carry serials (take them out first).`
    case 'NOTHING_STAYS':
      return `Everything of ${facts.number} would move: merge it into ${facts.target ?? 'the other shipment'} instead.`
    case 'ON_HOLD_QUALITY':
      return `Quality holds these garments: they wait on ${facts.number} until the hold is released.`
    case 'MERGE_PACKED':
      return `Garments of ${facts.number} are in cartons or carry serials: take them out of the cartons first, then merge.`
    case 'MERGE_LABELLED':
      return `A parcel of ${facts.number} carries a carrier label: void it first, then merge.`
  }
}

/** The words of a take-off's refusal (English). */
export function takeOffRefusalWords(code: TakeOffRefusalCode, facts: { readonly number: string; readonly order: string; readonly status?: string | null }): string {
  switch (code) {
    case 'NOT_DRAFT':
      return `Shipment ${facts.number} is ${facts.status ?? 'not a draft'}: an order comes off only while it is a DRAFT (unpack it first).`
    case 'NOT_ON_IT':
      return `Shipment ${facts.number} carries no garments of ${facts.order}.`
    case 'FIRST_ORDER':
      return `Shipment ${facts.number} was made for ${facts.order}: move the other orders' garments with Split… or Move garments to…, then cancel it.`
    case 'IN_CARTON':
      return `Garments of ${facts.order} on ${facts.number} are in a carton or carry serials: take them out of the cartons first.`
  }
}

/** What a merge moves: every line of the source, each whole (refused while a line has garments in a carton or serials). */
export function mergeProblems(lines: readonly SplitLine[]): 'MERGE_PACKED' | 'NOTHING_TO_MOVE' | null {
  if (lines.length === 0) return 'NOTHING_TO_MOVE'
  return lines.some((line) => line.packed > 0 || line.serials > 0) ? 'MERGE_PACKED' : null
}
// ── end B-OS-011, B-OS-012, B-OS-013 ──
