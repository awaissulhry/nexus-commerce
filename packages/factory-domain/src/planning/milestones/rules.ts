import { daysFrom } from '../../calendars/dates'
import type { BusinessDate } from '../../core/time'

/**
 * Time & action (B-W2b-263; PLN-186 "Pre-production gates"; design planning.milestones, SCR-253), pure. The pre-production
 * gates of a sales order (factory-db samples.prisma `OrderGate`, B-W2b-212: what must be true before its work may start, by
 * when, whose) and the milestones of the order built from what the factory already records:
 *
 *   GATE    each gate: its target date, passed (the actual date) or started before it (an override with its reason)
 *   START   production start: the earliest bar of the order's production work orders (SIZE_GRID, MADE_TO_MEASURE) on the
 *           site's working plan (target) and the first of them that started (actual); a sample or a repair work order never
 *           counts (B-W2b-284, PRODUCTION_WORK_ORDER_KINDS)
 *   SHIP    the promise date (target) and the first shipment that left (actual)
 *
 * A gate is WAITING until it is passed (marked done by a person, or by its event: a SAMPLE_APPROVED / PP_SAMPLE gate that
 * names a round passes when that round is approved — `sample_round.decided`; a LEATHER_APPROVED gate passes when every
 * leather lot reserved for the order is released — `lot.released`) or started before (the override: someone who is
 * neither its owner nor its maker, with a reason; the database holds the same rule). While a gate WAITS, the planning
 * board holds a drop of the order's work orders that have not started (apps/factory-api modules/planning/schedule/gates.ts);
 * only its production work orders, never a sample or a repair (B-W2b-F22, HELD_WORK_ORDER_KINDS).
 * Templates (milestones made from an order type's offsets) stay Later (design).
 *
 * This is a planning milestone, NOT a compliance gate: the one compliance gate at work-order release, label print and
 * shipment stays B-W2b-254's (compliance/gates). A pre-production gate holds the scheduling of the work, not its release.
 */

export const GATE_KINDS = ['SAMPLE_APPROVED', 'LEATHER_APPROVED', 'TRIMS_IN', 'PP_SAMPLE', 'LAB_PASSED', 'OTHER'] as const
export type GateKind = (typeof GATE_KINDS)[number]

/** The kinds that may name a sample round (PP_SAMPLE: a PRE_PRODUCTION round). */
export const SAMPLE_GATE_KINDS = ['SAMPLE_APPROVED', 'PP_SAMPLE'] as const satisfies readonly GateKind[]
export const isSampleGate = (kind: GateKind): boolean => (SAMPLE_GATE_KINDS as readonly string[]).includes(kind)

/** A sample round's decisions that pass a gate naming it (the database's rule). */
export const PASSING_DECISIONS = ['APPROVED', 'APPROVED_WITH_COMMENTS'] as const
export const passesGate = (decision: string | null | undefined): boolean => decision != null && (PASSING_DECISIONS as readonly string[]).includes(decision)

export const GATE_LIMITS = Object.freeze({
  /** OrderGate.label (the database: 1 to 200 characters, one line). */
  label: 200,
  /** OrderGate.overrideReason (the database: 1 to 1000 characters). */
  reason: 1000,
  /** A reason says something: at least this many characters after trimming. */
  reasonMin: 3,
  /** Gates marked done in one command. */
  perBatch: 100,
  /** Open orders one read covers (the oldest promise first). */
  orders: 400,
})

export const GATE_STATES = ['WAITING', 'PASSED', 'STARTED_BEFORE'] as const
export type GateState = (typeof GATE_STATES)[number]

/** A gate's state: passed wins over started before (both may be written: started before, then passed). */
export function gateStateOf(gate: { readonly passedAt: unknown; readonly overriddenAt: unknown }): GateState {
  if (gate.passedAt != null) return 'PASSED'
  if (gate.overriddenAt != null) return 'STARTED_BEFORE'
  return 'WAITING'
}

/** Who or what passed a gate: a person in the office, a sample round's decision, the leather lots' release. */
export const PASS_VIAS = ['OFFICE', 'SAMPLE', 'LOT'] as const
export type PassVia = (typeof PASS_VIAS)[number]

/** What the order's leather is for its LEATHER_APPROVED gate: nothing reserved yet, reserved but not released, all released. */
export const LEATHER_STATES = ['NOT_RECEIVED', 'NOT_PASSED', 'PASSED'] as const
export type LeatherState = (typeof LEATHER_STATES)[number]

/** The leather of an order from the quality status of the lots reserved for it (rows: one per reserved lot). */
export function leatherStateOf(lots: readonly { readonly qualityStatus: string }[]): LeatherState {
  if (lots.length === 0) return 'NOT_RECEIVED'
  return lots.every((lot) => lot.qualityStatus === 'RELEASED') ? 'PASSED' : 'NOT_PASSED'
}

/**
 * The tiles of "Waiting on a gate" (design sec:gates: Sample not approved · Leather not received · Leather not passed; plus
 * the other kinds so no waiting gate is left out): each counts the open orders with a WAITING gate of its group.
 */
export const WAITING_TILES = ['SAMPLE', 'LEATHER_NOT_RECEIVED', 'LEATHER_NOT_PASSED', 'TRIMS', 'OTHER'] as const
export type WaitingTile = (typeof WAITING_TILES)[number]

export function tileOf(kind: GateKind, leather: LeatherState | null): WaitingTile {
  if (isSampleGate(kind)) return 'SAMPLE'
  if (kind === 'LEATHER_APPROVED') return leather === 'NOT_PASSED' || leather === 'PASSED' ? 'LEATHER_NOT_PASSED' : 'LEATHER_NOT_RECEIVED'
  if (kind === 'TRIMS_IN') return 'TRIMS'
  return 'OTHER'
}

/** The tiles' counts: distinct orders per tile among the WAITING gates. */
export function tileCounts(gates: readonly { readonly salesOrderId: string; readonly kind: GateKind; readonly state: GateState; readonly leather: LeatherState | null }[]): Record<WaitingTile, number> {
  const orders = Object.fromEntries(WAITING_TILES.map((tile) => [tile, new Set<string>()])) as Record<WaitingTile, Set<string>>
  for (const gate of gates) if (gate.state === 'WAITING') orders[tileOf(gate.kind, gate.leather)].add(gate.salesOrderId)
  return Object.fromEntries(WAITING_TILES.map((tile) => [tile, orders[tile].size])) as Record<WaitingTile, number>
}

// ---- milestones ------------------------------------------------------------------------------------------------------

export const MILESTONE_KINDS = ['GATE', 'START', 'SHIP'] as const
export type MilestoneKind = (typeof MILESTONE_KINDS)[number]

/** A milestone as the screens draw it: DONE (an actual date), WAITING (a gate not passed), STARTED_BEFORE, TO_COME. */
export const MILESTONE_STATES = ['DONE', 'WAITING', 'STARTED_BEFORE', 'TO_COME'] as const
export type MilestoneState = (typeof MILESTONE_STATES)[number]

/** Order of the milestones of one order: by target date (none last), gates before start before ship on the same day. */
export function milestoneOrder(a: { readonly kind: MilestoneKind; readonly target: BusinessDate | null; readonly id: string }, b: { readonly kind: MilestoneKind; readonly target: BusinessDate | null; readonly id: string }): number {
  if (a.target !== b.target) {
    if (a.target === null) return 1
    if (b.target === null) return -1
    return a.target < b.target ? -1 : 1
  }
  const rank = (kind: MilestoneKind) => MILESTONE_KINDS.indexOf(kind)
  if (rank(a.kind) !== rank(b.kind)) return rank(a.kind) - rank(b.kind)
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Days late: done after the target → the days between; not done and the target passed → the days since; else null (on time,
 * not due, or no target). Business dates (the site's days).
 */
export function lateDays(target: BusinessDate | null, actual: BusinessDate | null, today: BusinessDate): number | null {
  if (target === null) return null
  const end = actual ?? today
  const days = daysFrom(target, end)
  if (actual === null) return days > 0 ? days : null
  return days > 0 ? days : null
}

export function milestoneStateOf(kind: MilestoneKind, gate: GateState | null, actual: BusinessDate | null): MilestoneState {
  if (kind === 'GATE') return gate === 'PASSED' ? 'DONE' : gate === 'STARTED_BEFORE' ? 'STARTED_BEFORE' : 'WAITING'
  return actual !== null ? 'DONE' : 'TO_COME'
}

// ---- refusals ----------------------------------------------------------------------------------------------------------

/** Every refusal of a gate write, with a stable code (409 `refusal/<CODE>`; a screen says its own words from it). */
export const GATE_REFUSALS = [
  /** The order is shipped, closed or cancelled: its gates are kept as they are. */
  'ORDER_CLOSED',
  /** One gate per kind and order (OTHER: as many as needed). */
  'GATE_EXISTS',
  /** OTHER says what it is (a label). */
  'LABEL_NEEDED',
  /** Only a sample gate (SAMPLE_APPROVED, PP_SAMPLE) names a sample round. */
  'ROUND_ONLY_SAMPLE',
  /** The round is not one of the order's styles for its customer (or internal), or not of the order's company. */
  'ROUND_NOT_OF_ORDER',
  /** A PP_SAMPLE gate waits for a PRE_PRODUCTION round. */
  'ROUND_KIND',
  /** A gate that names a round passes once that round is approved (approved, or approved with comments). */
  'ROUND_NOT_APPROVED',
  /** The gate is passed already (each once). */
  'PASSED',
  /** The order started before this gate already (once). */
  'STARTED_BEFORE',
  /** Starting before the gate is for someone who is neither the gate's owner nor its maker. */
  'OWN_GATE',
  /** The day a gate was passed is not after today. */
  'FUTURE_DAY',
  /** A passed or started-before gate is kept: it cannot be removed. */
  'KEPT',
  /** The owner must be an active person who may keep this order's gates. */
  'OWNER_NOT_ALLOWED',
] as const
export type GateRefusalCode = (typeof GATE_REFUSALS)[number]

export interface GateRefusal {
  readonly code: GateRefusalCode
  readonly message: string
}

const refusal = (code: GateRefusalCode, message: string): GateRefusal => ({ code, message })

/** The order statuses whose gates may change (open orders). */
export const OPEN_ORDER_STATUSES = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'] as const
export const isOpenOrder = (status: string): boolean => (OPEN_ORDER_STATUSES as readonly string[]).includes(status)
/** The order statuses whose work may still start (the board holds a drop while a gate waits). */
export const NOT_STARTED_ORDER_STATUSES = ['CONFIRMED', 'IN_PRODUCTION'] as const

export interface GateFacts {
  readonly number: string
  readonly kind: GateKind
  readonly orderStatus: string
  readonly passedAt: unknown
  readonly overriddenAt: unknown
  readonly ownerId: string | null
  readonly createdById: string | null
  /** The round the gate names: its decision (null: not decided) and kind. */
  readonly round: { readonly number: string; readonly decision: string | null; readonly kind: string } | null
}

export const orderClosedRefusal = (facts: Pick<GateFacts, 'number' | 'orderStatus'>): GateRefusal | null =>
  isOpenOrder(facts.orderStatus) ? null : refusal('ORDER_CLOSED', `Order ${facts.number} is ${facts.orderStatus.toLowerCase().replace(/_/g, ' ')}: its gates are kept as they are.`)

/** A new or changed gate's own shape: OTHER says what it is; a round only on a sample gate; PP_SAMPLE a pre-production round. */
export function shapeRefusal(kind: GateKind, label: string | null, round: GateFacts['round']): GateRefusal | null {
  if (kind === 'OTHER' && (label === null || label.trim() === '')) return refusal('LABEL_NEEDED', 'Say what the gate is: a gate of kind Other needs its words.')
  if (round !== null && !isSampleGate(kind)) return refusal('ROUND_ONLY_SAMPLE', 'Only a sample gate (sample approved, pre-production sample) names a sample round.')
  if (round !== null && kind === 'PP_SAMPLE' && round.kind !== 'PRE_PRODUCTION') return refusal('ROUND_KIND', `A pre-production sample gate waits for a pre-production round; ${round.number} is a ${round.kind.toLowerCase().replace(/_/g, ' ')} round.`)
  return null
}

/** Mark the gate done (passed on `day`, at most today). */
export function passRefusal(facts: GateFacts, day: BusinessDate, today: BusinessDate): GateRefusal | null {
  const closed = orderClosedRefusal(facts)
  if (closed) return closed
  if (facts.passedAt != null) return refusal('PASSED', `The gate of order ${facts.number} is passed already.`)
  if (day > today) return refusal('FUTURE_DAY', 'A gate is passed today or on a day before: not on a day to come.')
  if (facts.round !== null && !passesGate(facts.round.decision)) {
    return refusal('ROUND_NOT_APPROVED', `The gate waits for sample round ${facts.round.number} to be approved (it is ${facts.round.decision ? facts.round.decision.toLowerCase().replace(/_/g, ' ') : 'not decided'}).`)
  }
  return null
}

/** Start the order's work before the gate (the override): not passed, not started before, not by its owner or maker. */
export function startBeforeRefusal(facts: GateFacts, actorId: string): GateRefusal | null {
  const closed = orderClosedRefusal(facts)
  if (closed) return closed
  if (facts.passedAt != null) return refusal('PASSED', `The gate of order ${facts.number} is passed: nothing to start before.`)
  if (facts.overriddenAt != null) return refusal('STARTED_BEFORE', `Order ${facts.number} started before this gate already.`)
  if (actorId === facts.ownerId || actorId === facts.createdById) {
    return refusal('OWN_GATE', "Starting before the gate needs someone who is neither the gate's planner nor the person who added it: ask a colleague who may.")
  }
  return null
}

/** The reason of a start before the gate, trimmed; null when it says too little. */
export function reasonOf(value: string | null | undefined): string | null {
  const reason = (value ?? '').trim()
  return reason.length >= GATE_LIMITS.reasonMin && reason.length <= GATE_LIMITS.reason ? reason : null
}

/** Remove the gate: only while neither passed nor started before. */
export function removeRefusal(facts: GateFacts): GateRefusal | null {
  const closed = orderClosedRefusal(facts)
  if (closed) return closed
  if (facts.passedAt != null || facts.overriddenAt != null) return refusal('KEPT', `The gate of order ${facts.number} was passed or started before: it is kept.`)
  return null
}

/** Change the gate (target, words, round, owner): not once passed (its record is kept as it was). */
export function editRefusal(facts: GateFacts): GateRefusal | null {
  const closed = orderClosedRefusal(facts)
  if (closed) return closed
  if (facts.passedAt != null) return refusal('PASSED', `The gate of order ${facts.number} is passed: it is kept as it was.`)
  return null
}

/** One gate per kind and order; OTHER as many as needed. */
export const existsRefusal = (number: string, kind: GateKind): GateRefusal =>
  refusal('GATE_EXISTS', `Order ${number} already has a gate of this kind (${kind.toLowerCase().replace(/_/g, ' ')}): change that one.`)

// ---- the board's hold ---------------------------------------------------------------------------------------------------

/**
 * B-W2b-F22: the work orders a waiting gate holds, the order's production. A SAMPLE work order makes the sample that passes
 * the gate, and a REPAIR mends a garment already made: neither is held.
 */
export const HELD_WORK_ORDER_KINDS = ['SIZE_GRID', 'MADE_TO_MEASURE'] as const

// ---- production start and the order's work orders per kind (B-W2b-284, F22's follow-up) -----------------------------------

/**
 * The order's production work orders: what the START milestone follows (its target, the earliest bar on the working plan; its
 * actual, the first that started) — the same kinds a waiting gate holds. A SAMPLE work order makes a sample of the order (a
 * pre-production round on its line) and a REPAIR mends a garment already sold: neither starts the order's production.
 */
export const PRODUCTION_WORK_ORDER_KINDS = HELD_WORK_ORDER_KINDS
export const isProductionWorkOrder = (kind: string): boolean => (PRODUCTION_WORK_ORDER_KINDS as readonly string[]).includes(kind)

/** Every work order kind, in the order the order view lists them (factory-db WorkOrderKind). */
export const ORDER_WORK_ORDER_KINDS = ['SIZE_GRID', 'MADE_TO_MEASURE', 'SAMPLE', 'REPAIR'] as const
export type OrderWorkOrderKind = (typeof ORDER_WORK_ORDER_KINDS)[number]

/** A work order of the order as the START milestone reads it: its kind, state, first start and earliest bar on the working plan. */
export interface StartFacts {
  readonly kind: string
  readonly status: string
  readonly startedAt: Date | null
  readonly firstBar: Date | null
}

const DONE_STATUSES = ['COMPLETED', 'CLOSED', 'CANCELLED']

/**
 * The START milestone of an order from its work orders: null when it has no production work order (no START row), else the
 * earliest bar of its production work orders (target) and the first of them that started (actual). A cancelled work order's
 * bar never counts (its slots are gone), its start does (the work began).
 */
export function productionStartOf(workOrders: readonly StartFacts[]): { readonly firstBar: Date | null; readonly firstStart: Date | null } | null {
  const production = workOrders.filter((row) => isProductionWorkOrder(row.kind))
  if (production.length === 0) return null
  const earliest = (values: readonly (Date | null)[]): Date | null => values.reduce<Date | null>((first, value) => (value !== null && (first === null || value < first) ? value : first), null)
  return { firstBar: earliest(production.map((row) => row.firstBar)), firstStart: earliest(production.map((row) => row.startedAt)) }
}

/** The order's work orders per kind (every kind it has, in ORDER_WORK_ORDER_KINDS order): how many, how many not started. */
export function workOrdersByKind(workOrders: readonly Pick<StartFacts, 'kind' | 'status' | 'startedAt'>[]): { kind: OrderWorkOrderKind; count: number; notStarted: number }[] {
  return ORDER_WORK_ORDER_KINDS.flatMap((kind) => {
    const own = workOrders.filter((row) => row.kind === kind)
    return own.length === 0 ? [] : [{ kind, count: own.length, notStarted: own.filter((row) => row.startedAt === null && !DONE_STATUSES.includes(row.status)).length }]
  })
}

/** What the planning board says when it holds a drop: the order and the gates it waits on (the API's English, for logs). */
export function holdWords(workOrder: string, gates: readonly { readonly orderNumber: string; readonly kind: GateKind; readonly label: string | null }[]): string {
  const names = gates.map((gate) => `${gate.orderNumber} ${gate.kind === 'OTHER' && gate.label ? gate.label : gate.kind.toLowerCase().replace(/_/g, ' ')}`)
  return `${workOrder} waits on ${gates.length === 1 ? 'a gate' : `${gates.length} gates`} not passed (${names.join('; ')}): pass it, or start before the gate with a reason (Time & action).`
}
