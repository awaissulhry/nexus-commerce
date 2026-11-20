import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { eventFor } from '@nexus/factory-domain/events/define'
import { assertOneParty, brandHealthChanged, brandHoldChanged, brandStageReached, type BrandHoldKind } from '@nexus/factory-domain/production-brand/events'
import { effectiveHealth, raiseStands, type BrandHealth, type HealthRaise, type HealthReasonCode } from '@nexus/factory-domain/production-brand/health'
import { brandStageRank, movedForward, type BrandStage } from '@nexus/factory-domain/production-brand/stages'
import { HAND_STAGE_NOTICE_DELAY_MS, handStands } from '@nexus/factory-domain/production-brand/stage-set' // B-MS-004, B-MS-008
import { STAGE_NOTICE_KEYS } from '@nexus/factory-domain/production-brand/notices' // B-MS-008
import type { Waiting, WaitingOn } from '@nexus/factory-domain/production-brand/waiting'
import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { callerFor, COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandSettings, type CommandTools } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { activeTenants, asSystem, systemContext } from '../../../platform/outbox/system'
import { dayOf } from '../../planning/store'
import type { Reader } from '../../sales/orders/store'
import { KEEPER_ORDER_STATES, keeperPlanningContext, orderOfCell, ordersOfWorkOrders, readOrderProductionFacts, type LineRisk, type OrderProductionFacts } from './facts'
// B-OP-043 (order page N6, lines-derived): the orders a shipment carries.
import { ordersOfShipment } from '../../shipping/shipments/orders-of'

/**
 * The customer's stage and health keeper (B-PR-17; production plan §4, 08-backend §3 "Keeper"; review fixes R-20, R-21, R-31,
 * R-35, R-69; the Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the
 * production unit, should be able to see it all. And manage it all as well."). It keeps each sales order's BrandOrderProduction
 * row (B-PR-15) in step with its facts (facts.ts) — the row is MADE when the order is CONFIRMED (R-21: a confirmed order that
 * waits for its PP answer or deposit is on My production before any work order) — and tells what moved
 * (B-PR-16's events):
 *
 *   stage            the plain stage of the order (its slowest unfinished line) and since when; `brand_production.stage_reached`
 *                    ONLY on a forward move (stages.ts movedForward), and once per order and stage: a stage reached, taken back
 *                    (a release reversed, a cut undone) and reached again is not told again (R-20; the audit marker
 *                    `production.brandKeeper.stageTold` on the order's BrandOrderProduction row says it was told: on the row,
 *                    so the order's own timeline stays the order's). A stage going back is written (the
 *                    customer reads only true states) and never told. An order with no open goods line keeps its last stage.
 *   by hand          B-MS-004 (set the stage by hand, design A; review fixes R2, R6, R7, R15, R21): the ONE named exception to
 *                    "only true states". While the floor cannot record work that is done, an office person may put the stage
 *                    ahead with a reason (./stage, B-MS-005; the five stageSet… columns, hidden from the customer). The keeper
 *                    then writes the SHOWN stage into `stage`: the higher of the floor's and the hand stage (production-brand
 *                    stage-set shownStageOf). The floor's own stage is never stored: every decision of a pass (the plan, the
 *                    clears, the skip of the high-volume events below) reads the floor's stage computed in THAT pass, never the
 *                    stored one. The hand stage stands while the floor is below it (nothing written, nothing told); the floor
 *                    reaching or passing it, no goods line left open, a person's Clear, or the order leaving production
 *                    (cancelled, closed, shipped: R2, a command of its own, and the nightly run looks for any the events
 *                    missed) ends it in the SAME write — the five columns cleared (the database's guard: while it stands
 *                    `stage` equals it), `stage` the floor's or, with no goods line, where the work reached; a step back takes
 *                    the floor's own day (R15, floorDayOf). The told rule stays the one above (a forward move of `stage`, what
 *                    the customer reads), so a floor Cutting under a hand Sewing tells nothing. Each end the keeper writes is
 *                    also one row on the SalesOrder (`production.brandKeeper.handCleared` {stage, floor, why}; never a `status`
 *                    key, which the portal's order history reads: R6), so the order's History says it.
 *   undo window      B-MS-008 (Owner D4; review R3a): a stage set by hand is told with `byHand`, and its notice waits 10 minutes
 *                    (the partner fan-out's delayMs). When the stage the customer reads moves off a stage whose by-hand notice
 *                    still waits — a Clear, a Change, the floor passing it, the order leaving production — that stage gets the
 *                    marker `production.brandKeeper.stageUntold` (untellWaiting): the notice's own check drops it, and the stage
 *                    counts as never told, so the floor reaching it later tells it. A stage counts as told only while its NEWEST
 *                    marker is stageTold (tellStageOnce).
 *   health           the computed health (facts.ts) and when it changed; the factory's raise to At risk is dropped once 7
 *                    days passed or the computed health changed (health.ts raiseStands). `brand_production.health_changed`
 *                    when the health the customer reads (effectiveHealth) changed, `byNote` when only the raise's drop did it.
 *   waiting on       the first owner with a blocker (customer → supplier → workshop → us) and since when (the earliest
 *                    known start of its blockers; else when the order started waiting on that owner).
 *   hold             on a hold event: `brand_production.hold_changed` for each of the work order's orders, with whether the
 *                    order is still on hold (another hold may still hold it) and the kind of the hold placed or lifted.
 *
 * The worker's handler `production.brandKeeper` follows the events that move those facts (KEEPER_EVENTS) and recomputes the
 * orders they name — read in the tenant's system scope, by the order's own row: each event names ONE order and that order's
 * own customer (PW-P07; a legacy work order of two customers gives each customer an event of its own order only). It never
 * follows `brand_production.urgency_changed` (R-69): one customer's urgency recomputes no order of another customer. High
 * volume first, one indexed read, then skipped: a scan, or a start at an operation, only at a SEWING work centre and only for
 * an order not yet at SEWING; a cut or a bundle only for an order not yet at CUTTING (B-MS-004, R7: an order with a stage set
 * by hand is never skipped — its stored stage is not the floor's, and the floor's event may end it). Stage events read no planning (the
 * health and waiting-on stay as they were); the others and the nightly cron read the planning risk too.
 *
 * The scheduler's clustered cron `production.brandKeeper` (00:35 Europe/Rome, just after the business date turns) recomputes
 * every kept order of every tenant, one by one as an event would: a promise that passed in the night shows LATE, a raise past
 * its 7 days drops, an order confirmed before the keeper existed gets its row (B-MS-004: and a stage set by hand still left on
 * an order that left production is cleared — the safety net of R2).
 *
 * Each change is ONE system command on the order (an advisory lock per order, the facts read again under it — the planning
 * risk as read just before — then the row written): its audit rows on the BrandOrderProduction row (the change, the stage
 * marker), the events; nothing changed: no command at all. B-MS-004: that command's body is `keepInCommand`, the same body the
 * set, change and clear by hand run inside their own command (never keepOrder inside another command: it opens its own). A hold event's command carries a key of the event and the order, so
 * a retried job tells the hold once. Safe to repeat: it moves on facts, never on the event.
 */

export const KEEP_COMMAND = 'production.brandKeeper'
/** The audit marker of a stage told to the customer (once per order and stage). */
export const STAGE_TOLD = 'production.brandKeeper.stageTold'
// B-MS-008: a stage told by hand whose notice was still waiting its window when the customer stopped reading it (a Clear, a Change):
// never told after all — the newest marker of a stage says whether it counts as told (tellStageOnce).
export const STAGE_UNTOLD = 'production.brandKeeper.stageUntold'

// ── B-MS-004: the stage set by hand ──
/** The office's set or change of the stage by hand (./stage): its command, and the action of its audit rows. */
export const SET_BRAND_STAGE = 'production.setBrandStage'
/** The office's Clear of the stage set by hand (./stage). */
export const CLEAR_BRAND_STAGE = 'production.clearBrandStage'
/** The SalesOrder's audit row of a hand stage the keeper ended (the order's History; never a `status` key). */
export const HAND_CLEARED = 'production.brandKeeper.handCleared'

/**
 * Why a stage set by hand ended: the floor reached or passed it, no goods line is left open, the order left production
 * (cancelled, closed, shipped), or a person cleared it (./stage).
 */
export const HAND_DROPS = ['REACHED', 'NO_LINE', 'LEFT_PRODUCTION', 'CLEARED'] as const
export type HandDrop = (typeof HAND_DROPS)[number]
// ── end B-MS-004 ──

/** The events whose facts move an order's stage, health, waiting-on or hold mark. */
export const STAGE_EVENTS = [
  'production.cut_logged',
  'production.cut_reversed',
  'production.bundle_created',
  'production.bundle_voided',
  'production.scan_recorded',
  'production.operation_timed',
  'quality.garments_released',
  'quality.release_reversed',
] as const
export const HOLD_EVENTS = ['quality.hold_placed', 'quality.hold_released', 'work_order_hold.placed', 'work_order_hold.lifted'] as const
export const ORDER_EVENTS = [
  'sales_order.created',
  'sales_order.status_changed',
  'sales_order.promise_changed',
  'sales_order.amended',
  'sales_order.lines_closed',
  'workorder.released',
  'workorder.status_changed',
  'shipment.status_changed',
  'order_gate.changed',
  'order_change_request.asked',
  'order_change_request.withdrawn',
  'order_change_request.answered',
  // B-PR-26: our counter-offer and the customer's answer to it (waiting on the customer, then on us or nobody).
  'order_change_request.countered',
  'order_change_request.counter_answered',
  'approval_request.asked',
  'approval_request.answered',
  'approval_request.withdrawn',
  'approval_request.expired',
  // B-PR-30a/30b: decided for the customer (it no longer waits on them), its answer put back (a refused new date no longer waits on us).
  'approval_request.decided_for_party',
  'approval_request.reversed',
  'deposit_request.waived',
  'production_issue.raised',
  'production_issue.answered',
  // B-PR-28: the follow-up task of a new date the customer did not accept (only such a task names orders: ordersOfEvent).
  'task.created',
  'task.completed',
  'task.changed',
] as const
export const KEEPER_EVENTS: readonly string[] = Object.freeze([...ORDER_EVENTS, ...STAGE_EVENTS, ...HOLD_EVENTS])

// ---- the plan (pure) ---------------------------------------------------------------------------------------------------------

/** The keeper's columns of an order's row, as read. */
export interface KeeperRow {
  readonly id: string
  readonly partyId: string
  readonly salesOrderId: string
  /** The stage the customer reads (B-MS-004: the shown one — the floor's, or the hand stage while it leads). */
  readonly stage: BrandStage
  // B-MS-004: the stage set by hand (null: none stands; while it stands `stage` equals it, the database's guard).
  readonly stageSet: BrandStage | null
  readonly health: BrandHealth | null
  readonly healthSet: BrandHealth | null
  readonly healthReasonCode: HealthReasonCode | null
  readonly healthSetUntil: BusinessDate | null
  readonly waitingOn: WaitingOn | null
  readonly waitingSince: Date | null
  readonly version: number
}

export interface KeeperTarget {
  /**
   * The FLOOR's plain stage now, computed in this pass (null: no open goods line; the row keeps its stage). B-MS-004: never the
   * stored stage — under a hand stage the stored one is the shown one.
   */
  readonly stage: BrandStage | null
  /** B-MS-004 (R2): where the work reached, `done` ignored (facts.ts `reached`): the stage a hand stage gives way to with no goods line open. */
  readonly reached: BrandStage
  /** The computed health now (null: nothing left to make). */
  readonly computed: BrandHealth | null
  readonly waiting: Waiting
}

export interface KeepPlan {
  /** The order has no row yet: make it. */
  readonly create: boolean
  /** The columns to write (empty: nothing changed). */
  readonly data: {
    stage?: BrandStage
    stageAt?: Date
    health?: BrandHealth | null
    healthAt?: Date | null
    waitingOn?: WaitingOn
    waitingSince?: Date
    /** The raise dropped: every raise column cleared. */
    raiseDropped?: true
    /** B-MS-004: the stage set by hand ended, and why: its five columns cleared in this same write. */
    handDropped?: HandDrop
  }
  /** A forward move to tell (still once per order and stage: the command checks the marker). */
  readonly stageReached: { readonly stage: BrandStage; readonly previous: BrandStage | null } | null
  /** The health the customer reads changed. */
  readonly healthChanged: { readonly health: BrandHealth | null; readonly previous: BrandHealth | null; readonly byNote: boolean } | null
}

const sameTime = (a: Date | null, b: Date | null): boolean => (a === null ? b === null : b !== null && a.getTime() === b.getTime())

/**
 * What the keeper writes and tells for one order: from its row (null: none yet) and its facts now. A new row is made only
 * when the order has a stage (an open goods line). B-MS-004: `clearHand` — a person clears the stage set by hand (./stage).
 */
export function planKeep(input: { readonly row: KeeperRow | null; readonly target: KeeperTarget; readonly now: Date; readonly today: BusinessDate; readonly clearHand?: boolean }): KeepPlan | null {
  const { row, target, now, today } = input
  if (row === null && target.stage === null) return null
  const data: KeepPlan['data'] = {}
  const previousStage = row?.stage ?? null
  // B-MS-004 (design A; R7): every decision reads the FLOOR's stage of this pass (target.stage), never the stored one. A hand stage
  // stands while the floor is below it (`stage` stays the hand stage); the floor reaching or passing it, no goods line open, or a
  // person's Clear ends it in this same write: `stage` the floor's — with no goods line, where the work reached.
  const hand = row?.stageSet ?? null
  const handStays = hand !== null && input.clearHand !== true && handStands(target.stage, hand)
  if (hand !== null && !handStays) data.handDropped = input.clearHand === true ? 'CLEARED' : target.stage === null ? 'NO_LINE' : 'REACHED'
  const shown: BrandStage | null = handStays ? hand : (target.stage ?? (hand !== null ? target.reached : null))
  if (shown !== null && shown !== previousStage) {
    data.stage = shown
    data.stageAt = now
  }
  // The told rule as before: a forward move of `stage` (what the customer reads), only while a goods line is open.
  const stageReached = target.stage !== null && shown !== null && movedForward(previousStage, shown) ? { stage: shown, previous: previousStage } : null

  // The health: the computed one, and the factory's raise while it stands.
  const computedBefore = row?.health ?? null
  const computedNow = target.computed
  const raise: HealthRaise | null = row?.healthSet && row.healthReasonCode && row.healthSetUntil ? { reasonCode: row.healthReasonCode, until: row.healthSetUntil } : null
  const stands = raise !== null && raiseStands(raise, { computedBefore, computedNow, today })
  if (raise !== null && !stands) data.raiseDropped = true
  if (row === null || computedNow !== computedBefore) {
    data.health = computedNow
    data.healthAt = row === null && computedNow === null ? null : now
  }
  const before = row === null ? null : effectiveHealth(computedBefore, raise).health
  const after = effectiveHealth(computedNow, stands ? raise : null).health
  const healthChanged = before !== after ? { health: after, previous: before, byNote: row !== null && computedNow === computedBefore } : null

  // What it waits on, and since when.
  const on = target.waiting.on
  const since = row !== null && on === row.waitingOn ? (target.waiting.since ?? row.waitingSince ?? now) : (target.waiting.since ?? now)
  if (row === null || on !== row.waitingOn || !sameTime(since, row.waitingSince)) {
    data.waitingOn = on
    data.waitingSince = since
  }
  return { create: row === null, data, stageReached, healthChanged }
}

// ── B-MS-004 (R2) ──
/**
 * An order the keeper no longer keeps (cancelled, closed, shipped …) whose row still has a stage set by hand: the five columns
 * cleared, `stage` where the work reached (the command writes back the floor's own day on a step back, R15). Nothing told, the
 * health and waiting-on left as they were. null: no hand stage (the keeper leaves such an order alone, as before). `why`: CLEARED
 * when a person's Clear meets it.
 */
export function planLeaving(input: { readonly row: KeeperRow; readonly reached: BrandStage; readonly now: Date; readonly why?: Extract<HandDrop, 'LEFT_PRODUCTION' | 'CLEARED'> }): KeepPlan | null {
  const { row, reached, now } = input
  if (row.stageSet === null) return null
  return { create: false, data: { handDropped: input.why ?? 'LEFT_PRODUCTION', ...(reached !== row.stage ? { stage: reached, stageAt: now } : {}) }, stageReached: null, healthChanged: null }
}
// ── end B-MS-004 ──

/** Something to write or tell. */
export const planChanges = (plan: KeepPlan | null): boolean => plan !== null && (plan.create || Object.keys(plan.data).length > 0 || plan.stageReached !== null || plan.healthChanged !== null)

// ---- one order ---------------------------------------------------------------------------------------------------------------

const ROW_SELECT = {
  id: true,
  partyId: true,
  salesOrderId: true,
  stage: true,
  stageSet: true, // B-MS-004
  health: true,
  healthSet: true,
  healthReasonCode: true,
  healthSetUntil: true,
  waitingOn: true,
  waitingSince: true,
  version: true,
} as const

async function readRow(db: Reader, orderId: string): Promise<KeeperRow | null> {
  const row = await db.brandOrderProduction.findFirst({ where: { key: `brand-production:${orderId}` }, select: ROW_SELECT })
  if (!row) return null
  return {
    ...row,
    stage: row.stage as BrandStage,
    stageSet: row.stageSet as BrandStage | null, // B-MS-004
    health: row.health as BrandHealth | null,
    healthSet: row.healthSet as BrandHealth | null,
    healthReasonCode: row.healthReasonCode as HealthReasonCode | null,
    healthSetUntil: row.healthSetUntil ? dayOf(row.healthSetUntil) : null,
    waitingOn: row.waitingOn as WaitingOn | null,
  }
}

/** A read without the planning (a stage event: a cut, a bundle, a scan, a release) keeps the health and waiting-on as they were. */
const targetOf = (facts: OrderProductionFacts, row: KeeperRow | null): KeeperTarget => {
  const planned = facts.computed !== undefined
  return {
    stage: facts.stage?.stage ?? null,
    reached: facts.reached, // B-MS-004
    computed: planned ? (facts.computed ?? null) : (row?.health ?? null),
    waiting: planned || row === null || row.waitingOn === null ? facts.waiting : { on: row.waitingOn, since: row.waitingSince },
  }
}

export interface KeepCause {
  /** What made the keeper look (an event type, `nightly`). */
  readonly what: string
  readonly causationId?: string
  /** Read the planning risk (default true). */
  readonly health?: boolean
  /** A hold placed or lifted on the order's work: tell it (once per event and order). */
  readonly hold?: { readonly kind: BrandHoldKind; readonly eventId: string }
  /** B-MS-004: a person clears the stage set by hand (./stage, inside its own command): the floor's stage counts again. */
  readonly clearHand?: boolean
}

export interface KeepResult {
  readonly orderId: string
  /** A command ran (and was not a replay). */
  readonly changed: boolean
  readonly told: readonly string[]
}

/** Keeps one order's row (a system or office caller); nothing to change or tell: no command. */
export async function keepOrder(caller: CommandCaller, orderId: string, cause: KeepCause, settings: CommandSettings = COMMAND_SETTINGS): Promise<KeepResult> {
  const context = caller.factoryContext
  if (!context || (context.audience !== 'system' && context.audience !== 'office')) throw new ForbiddenError()
  const planningContext = keeperPlanningContext(context.tenantId, context.requestId)
  const now = settings.clock.now()
  const today = businessDate(now)
  const read = await caller.withClient(async (db) => {
    const facts = await readOrderProductionFacts(db, planningContext, orderId, now, { health: cause.health !== false })
    if (!facts) return null
    const row = await readRow(db, orderId)
    // B-MS-004 (R2): an order no longer kept is left alone — unless its row still has a stage set by hand (it is cleared).
    if (!facts.kept) return row !== null && row.stageSet !== null ? { facts, row, plan: planLeaving({ row, reached: facts.reached, now }) } : null
    return { facts, row, plan: planKeep({ row, target: targetOf(facts, row), now, today }) }
  })
  if (!read) return { orderId, changed: false, told: [] }
  if (!planChanges(read.plan) && !(cause.hold && (read.row !== null || read.plan !== null))) return { orderId, changed: false, told: [] }
  // The risks as read just now: the command reads every other fact again under the order's lock (a short transaction).
  const risks: ReadonlyMap<string, LineRisk> | undefined = cause.health === false ? undefined : read.facts.risks
  const { result, replayed } = await runCommand(
    caller,
    {
      name: KEEP_COMMAND,
      input: { orderId, cause: cause.what, ...(cause.hold ? { hold: cause.hold.kind, eventId: cause.hold.eventId } : {}) },
      ...(cause.hold ? { idempotencyKey: `brand-hold:${cause.hold.eventId}:${orderId}` } : {}),
      ...(cause.causationId ? { causationId: cause.causationId } : {}),
    },
    async (tools) => {
      const kept = await keepInCommand(tools, orderId, cause, risks)
      if (!kept.wrote) {
        // Under the lock nothing was left to do (another keeper did it): one audit row says so (every command records one).
        tools.audit({
          recordType: kept.rowId ? 'BrandOrderProduction' : 'SalesOrder',
          recordId: kept.rowId ?? orderId,
          ...(kept.facts ? { companyId: kept.facts.order.companyId } : {}),
          after: { salesOrderId: orderId, kept: false },
          reason: `Kept: ${cause.what}.`,
        })
      }
      return { told: [...kept.told], wrote: kept.wrote }
    },
    settings,
  )
  return { orderId, changed: !replayed && result.wrote, told: replayed ? [] : result.told }
}

// ── B-MS-004: the keeper's pass inside a running command; the stage told once; the floor's own day ──
/** What one keeper pass inside a running command did. */
export interface KeptInCommand {
  /** The order's facts as read under the lock (null: no such order). */
  readonly facts: OrderProductionFacts | null
  /** The order's production row (null: none, and none made). */
  readonly rowId: string | null
  readonly told: readonly string[]
  /** Something was written or told. */
  readonly wrote: boolean
  /** A stage set by hand ended in this pass, and why (null: none ended). */
  readonly handDropped: HandDrop | null
  /** B-MS-008: the stages this pass left untold (their by-hand notice still waited its window: untellWaiting). */
  readonly untold: readonly BrandStage[]
}

/**
 * The keeper's pass INSIDE a running command: keepOrder's own command body, and B-MS-005's set, change and clear by hand (./stage)
 * — never keepOrder inside another command, which opens its own. It takes the keeper's lock of the order (re-entrant in one
 * transaction), reads the facts again under it (R12: the live floor; the planning risk only as given in `risks`, or read when the
 * cause asks for the health — no planning read runs here otherwise), then plans and writes as keepOrder does: with no row it MAKES
 * it at its first stage, with its marker (R1). An order no longer kept whose row still has a hand stage: that stage cleared, `stage`
 * where the work reached, nothing told (R2). Nothing to do: nothing written (keepOrder records its own one row then).
 */
export async function keepInCommand(tools: CommandTools, orderId: string, cause: KeepCause, risks?: ReadonlyMap<string, LineRisk>): Promise<KeptInCommand> {
  const context = tools.context
  if (context.audience !== 'system' && context.audience !== 'office') throw new ForbiddenError()
  const { tx, now } = tools
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.brand-keeper', ${orderId}::uuid), 0))`
  const facts = await readOrderProductionFacts(tx, keeperPlanningContext(context.tenantId, context.requestId), orderId, now, { health: cause.health !== false, ...(risks ? { risks } : {}) })
  if (!facts) return { facts: null, rowId: null, told: [], wrote: false, handDropped: null, untold: [] }
  const row = await readRow(tx, orderId)
  const plan = facts.kept
    ? planKeep({ row, target: targetOf(facts, row), now, today: businessDate(now), ...(cause.clearHand ? { clearHand: true } : {}) })
    : row !== null
      ? planLeaving({ row, reached: facts.reached, now, why: cause.clearHand ? 'CLEARED' : 'LEFT_PRODUCTION' })
      : null
  // An order no longer kept tells no hold (as before: the keeper did not look at it).
  const written = await writePlan(tools, facts, row, plan, facts.kept ? cause : { what: cause.what })
  return { facts, rowId: written.rowId, told: written.told, wrote: written.wrote, handDropped: plan?.data.handDropped ?? null, untold: written.untold }
}

/**
 * Tells the customer a stage it now reads — once per order and stage (the marker STAGE_TOLD on the row: a stage reached, taken back
 * and reached again is not told again) — in the order's own customer's name (PW-P07: the order's row and its production row agree).
 * The keeper's tell, and B-MS-005's set by hand (./stage). False: told before. B-MS-008: a stage counts as told only while its
 * NEWEST marker is STAGE_TOLD (a STAGE_UNTOLD after it — its by-hand notice never went: untellWaiting — tells it again); `byHand`
 * (the set by hand) marks the tell and its event, so its notice waits the undo window.
 */
export async function tellStageOnce(
  tools: CommandTools,
  order: { readonly id: string; readonly companyId: string; readonly partyId: string },
  row: { readonly id: string; readonly partyId: string },
  stage: BrandStage,
  previous: BrandStage | null,
  byHand = false, // B-MS-008
): Promise<boolean> {
  const newest = await newestMarkerOf(tools.tx, row.id, stage) // B-MS-008
  if (newest?.action === STAGE_TOLD) return false
  assertOneParty({ partyId: order.partyId, orderIds: [order.id] }, new Map([[order.id, row.partyId]]))
  const hand = byHand ? { byHand: true } : {} // B-MS-008: the floor's tell is as before, with no flag
  tools.audit({ action: STAGE_TOLD, recordType: 'BrandOrderProduction', recordId: row.id, companyId: order.companyId, after: { salesOrderId: order.id, stage, previous, ...hand } })
  tools.emit(eventFor(brandStageReached, { subject: order.id, companyId: order.companyId, payload: { orderId: order.id, partyId: order.partyId, stage, previous, ...hand } }))
  return true
}

// ── B-MS-008 (Owner D4: the 10-minute undo window; review R3a) ──
/** One stage marker of a production row, as read (STAGE_TOLD or STAGE_UNTOLD): its stage, a tell by hand, when, by which request. */
export interface StageMarker {
  readonly action: string
  readonly stage: BrandStage
  readonly byHand: boolean
  readonly at: Date
  readonly requestId: string
}

const STAGE_MARKERS = [STAGE_TOLD, STAGE_UNTOLD]
const MARKER_SELECT = { action: true, after: true, at: true, requestId: true } as const
const markerOf = (row: { readonly action: string; readonly after: unknown; readonly at: Date; readonly requestId: string }): StageMarker | null => {
  const after = jsonObject(row.after)
  return after && typeof after.stage === 'string' ? { action: row.action, stage: after.stage as BrandStage, byHand: after.byHand === true, at: row.at, requestId: row.requestId } : null
}

/**
 * The newest marker of one stage on a row (null: none). Newest by id — ids are made in order when the command's rows are written,
 * under the order's lock — never by `at`: two commands may share a clock instant (a test clock) or start in another order than
 * they commit.
 */
async function newestMarkerOf(db: Reader, rowId: string, stage: BrandStage): Promise<StageMarker | null> {
  const row = await db.auditLog.findFirst({ where: { recordType: 'BrandOrderProduction', recordId: rowId, action: { in: STAGE_MARKERS }, after: { path: ['stage'], equals: stage } }, select: MARKER_SELECT, orderBy: { id: 'desc' } })
  return row ? markerOf(row) : null
}

/**
 * Pure: the stages whose by-hand notice may still wait its window and that the customer no longer reads (`shown`) — the NEWEST
 * marker of the stage is a tell by hand of less than HAND_STAGE_NOTICE_DELAY_MS before `now` — in stage order, each with its tell's
 * time. `markers`: the row's, newest first.
 */
export function waitingTellsOff(markers: readonly StageMarker[], shown: BrandStage, now: Date): { readonly stage: BrandStage; readonly at: Date }[] {
  const seen = new Set<BrandStage>()
  const waiting: { stage: BrandStage; at: Date }[] = []
  for (const marker of markers) {
    if (seen.has(marker.stage)) continue
    seen.add(marker.stage)
    if (marker.action !== STAGE_TOLD || !marker.byHand || marker.stage === shown) continue
    if (now.getTime() - marker.at.getTime() >= HAND_STAGE_NOTICE_DELAY_MS) continue
    waiting.push({ stage: marker.stage, at: marker.at })
  }
  return waiting.sort((a, b) => brandStageRank(a.stage) - brandStageRank(b.stage))
}

/**
 * The customer stopped reading a stage whose by-hand notice still waits its window (`shown`: the stage it reads after this
 * command's write — a Clear, a Change, the floor passing it, the order leaving production): that notice will not be made (its own
 * check: the stage the customer reads when the worker tells it), so the stage gets the marker STAGE_UNTOLD and counts as never told
 * (tellStageOnce tells it when the order reaches it again). A notice the worker already made (a job run early) stays told. `skip`:
 * stages this command left untold already. The stages left untold.
 */
export async function untellWaiting(
  tools: CommandTools,
  order: { readonly id: string; readonly companyId: string },
  rowId: string,
  shown: BrandStage,
  skip: readonly BrandStage[] = [],
): Promise<BrandStage[]> {
  const since = new Date(tools.now.getTime() - HAND_STAGE_NOTICE_DELAY_MS)
  const rows = await tools.tx.auditLog.findMany({ where: { recordType: 'BrandOrderProduction', recordId: rowId, action: { in: STAGE_MARKERS }, at: { gte: since } }, select: MARKER_SELECT, orderBy: { id: 'desc' }, take: 50 })
  const untold: BrandStage[] = []
  for (const { stage, at } of waitingTellsOff(rows.flatMap((row) => markerOf(row) ?? []), shown, tools.now)) {
    if (skip.includes(stage)) continue
    const key = STAGE_NOTICE_KEYS[stage]
    const made = key ? await tools.tx.notification.findFirst({ where: { eventType: brandStageReached.type, recordId: order.id, messageKey: key, createdAt: { gte: at } }, select: { id: true } }) : null
    if (made) continue
    tools.audit({ action: STAGE_UNTOLD, recordType: 'BrandOrderProduction', recordId: rowId, companyId: order.companyId, after: { salesOrderId: order.id, stage } })
    untold.push(stage)
  }
  return untold
}

/**
 * The partner notice's side (platform/portal/notifications/rules/production): a stage told by hand is made only while ITS tell — the
 * request that wrote it — is still the newest marker of that stage. A Clear or a Change since (STAGE_UNTOLD), or a later tell (it
 * carries a notice of its own), means this one is not made: the customer is told each stage once. No marker: the notice's own check
 * alone.
 */
export async function handTellStands(db: Reader, rowId: string, stage: BrandStage, requestId: string): Promise<boolean> {
  const newest = await newestMarkerOf(db, rowId, stage)
  return newest === null || (newest.action === STAGE_TOLD && newest.byHand && newest.requestId === requestId)
}
// ── end B-MS-008 ──

/** A plain JSON object of an audit row (else null). */
const jsonObject = (value: unknown): Record<string, unknown> | null => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null)

/**
 * R15: the day the floor reached `floor`, for a step back from a stage set by hand. The newest set by hand of the row that found no
 * hand stage before it (its audit `before.hand` null — a Change keeps the chain) recorded the floor's stage and day as they stood;
 * the same stage now: that day, else `now` (the floor's own day of another stage is not stored).
 */
export async function floorDayOf(db: Reader, rowId: string, floor: BrandStage, now: Date): Promise<Date> {
  const sets = await db.auditLog.findMany({ where: { recordType: 'BrandOrderProduction', recordId: rowId, action: SET_BRAND_STAGE }, select: { before: true }, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: 50 })
  const first = sets.map((set) => jsonObject(set.before)).find((before) => before !== null && before.hand === null && typeof before.stageAt === 'string')
  if (!first || first.stage !== floor) return now
  const day = new Date(first.stageAt as string)
  return Number.isFinite(day.getTime()) ? day : now
}
// ── end B-MS-004 ──

async function writePlan(tools: CommandTools, facts: OrderProductionFacts, row: KeeperRow | null, plan: KeepPlan | null, cause: KeepCause): Promise<{ told: string[]; wrote: boolean; rowId: string | null; untold: BrandStage[] }> {
  const { tx, now } = tools
  const order = facts.order
  const told: string[] = []
  let untold: BrandStage[] = [] // B-MS-008
  let rowId = row?.id ?? null
  if (plan !== null && planChanges(plan)) {
    const { raiseDropped, handDropped, ...columns } = plan.data
    const raise = raiseDropped ? { healthSet: null, healthReasonCode: null, healthNote: null, healthSetAt: null, healthSetById: null, healthSetUntil: null } : {}
    // B-MS-004: the stage set by hand ended — its five columns cleared in this same write (the database's guard: while it stands
    // `stage` equals it); a step back to the floor's stage takes the floor's own day (R15).
    const hand = handDropped ? { stageSet: null, stageSetReason: null, stageSetNote: null, stageSetAt: null, stageSetById: null } : {}
    if (handDropped && row !== null && columns.stage !== undefined && brandStageRank(columns.stage) < brandStageRank(row.stage)) columns.stageAt = await floorDayOf(tx, row.id, columns.stage, now)
    if (plan.create) {
      rowId = newId()
      await tx.brandOrderProduction.create({
        data: {
          id: rowId,
          companyId: order.companyId,
          partyId: order.partyId,
          salesOrderId: order.id,
          key: `brand-production:${order.id}`,
          stage: columns.stage ?? 'PREPARING',
          stageAt: columns.stageAt ?? now,
          health: columns.health ?? null,
          healthAt: columns.healthAt ?? null,
          ...(columns.waitingOn ? { waitingOn: columns.waitingOn, waitingSince: columns.waitingSince ?? now } : {}),
        },
        select: { id: true },
      })
    } else if (Object.keys(plan.data).length > 0) {
      await tx.brandOrderProduction.update({ where: { id: row!.id }, data: { ...columns, ...raise, ...hand, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    }
    if (plan.create || Object.keys(plan.data).length > 0) {
      tools.audit({
        action: KEEP_COMMAND, // B-MS-004: the keeper's own row, also when it runs inside the set or clear by hand (./stage)
        recordType: 'BrandOrderProduction',
        recordId: rowId!,
        companyId: order.companyId,
        before: row
          ? { stage: row.stage, health: row.health, raised: row.healthSet !== null, waitingOn: row.waitingOn, waitingSince: row.waitingSince ? toUtcIso(row.waitingSince) : null, ...(row.stageSet !== null ? { hand: row.stageSet } : {}) /* B-MS-004 */ }
          : null,
        after: {
          salesOrderId: order.id,
          ...(plan.create ? { made: true } : {}),
          ...(columns.stage ? { stage: columns.stage } : {}),
          ...('health' in columns ? { health: columns.health ?? null } : {}),
          ...(raiseDropped ? { raiseDropped: true } : {}),
          ...(handDropped ? { handDropped } : {}), // B-MS-004
          ...(columns.waitingOn ? { waitingOn: columns.waitingOn, waitingSince: toUtcIso(columns.waitingSince ?? now) } : {}),
          ...(facts.promiseOnly ? { riskFrom: 'PROMISE_ONLY' } : {}),
        },
        reason: `Kept: ${cause.what}.`,
      })
    }
    // B-MS-008: the stage the customer reads moved — a stage whose by-hand notice still waits its window, and that it no longer reads,
    // is left untold (told when the order reaches it again).
    if (row !== null && columns.stage !== undefined) untold = await untellWaiting(tools, order, row.id, columns.stage)
    // B-MS-004 (R6): the order's own History says the hand stage ended — one office row on the SalesOrder, never with a `status`
    // key (the portal's order history and madeWaiting read that key of every SalesOrder audit row). A person's Clear writes its
    // own row (./stage).
    if (handDropped && handDropped !== 'CLEARED' && row !== null) {
      tools.audit({
        action: HAND_CLEARED,
        recordType: 'SalesOrder',
        recordId: order.id,
        companyId: order.companyId,
        before: { stage: row.stage },
        after: { stage: columns.stage ?? row.stage, floor: handDropped === 'REACHED' && facts.stage !== null ? facts.stage.stage : facts.reached, why: handDropped },
      })
    }
    // The wall (PW-P07): every event below names this one order and its own customer — the order's row and its production row
    // must agree before anything is told.
    const partyOf = new Map([[order.id, row?.partyId ?? order.partyId]])
    if (plan.stageReached) {
      const { stage, previous } = plan.stageReached
      // B-MS-004: the one tell of a stage (tellStageOnce), shared with the set by hand.
      if (await tellStageOnce(tools, order, { id: rowId!, partyId: row?.partyId ?? order.partyId }, stage, previous)) told.push('brand_production.stage_reached')
    }
    if (plan.healthChanged) {
      assertOneParty({ partyId: order.partyId, orderIds: [order.id] }, partyOf)
      tools.emit(eventFor(brandHealthChanged, { subject: order.id, companyId: order.companyId, payload: { orderId: order.id, partyId: order.partyId, ...plan.healthChanged } }))
      told.push('brand_production.health_changed')
    }
  }
  if (cause.hold && rowId !== null) {
    assertOneParty({ partyId: order.partyId, orderIds: [order.id] }, new Map([[order.id, row?.partyId ?? order.partyId]]))
    tools.audit({ action: `${KEEP_COMMAND}.hold`, recordType: 'BrandOrderProduction', recordId: rowId, companyId: order.companyId, after: { salesOrderId: order.id, held: facts.held, kind: cause.hold.kind } })
    tools.emit(eventFor(brandHoldChanged, { subject: order.id, companyId: order.companyId, payload: { orderId: order.id, partyId: order.partyId, held: facts.held, kind: cause.hold.kind } }))
    told.push('brand_production.hold_changed')
  }
  // Nothing written nor told (another keeper did it under the lock): the caller records its own one row (keepOrder).
  return { told, wrote: told.length > 0 || (plan !== null && planChanges(plan)), rowId, untold }
}

// ---- the worker's handler ----------------------------------------------------------------------------------------------------

/** The stage at or after which a high-volume event cannot move the order any more (null: never skipped). */
function skipFrom(type: string): BrandStage | null {
  if (type === 'production.scan_recorded' || type === 'production.operation_timed') return 'SEWING'
  if (type === 'production.cut_logged' || type === 'production.bundle_created') return 'CUTTING'
  return null
}

const asStrings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [])

/**
 * The orders an event names (its own sales order, or the orders of the work orders and cells it names), and for a hold event
 * the kind of hold. Read in the event's tenant; a high-volume event at a step that cannot move a stage names none.
 */
export async function ordersOfEvent(db: Reader, event: Pick<EventEnvelope, 'type' | 'payload'>): Promise<{ orderIds: string[]; hold: BrandHoldKind | null }> {
  const payload = (event.payload ?? {}) as Record<string, unknown>
  const text = (key: string): string | null => (typeof payload[key] === 'string' ? (payload[key] as string) : null)
  switch (event.type) {
    case 'sales_order.created':
    case 'sales_order.status_changed':
    case 'sales_order.promise_changed':
    case 'sales_order.amended':
    case 'sales_order.lines_closed':
    case 'order_change_request.asked':
    case 'order_change_request.withdrawn':
    case 'order_change_request.answered':
    // B-PR-26
    case 'order_change_request.countered':
    case 'order_change_request.counter_answered':
    case 'deposit_request.waived':
      return { orderIds: asStrings([text('orderId')]), hold: null }
    case 'order_gate.changed':
      return { orderIds: asStrings([text('salesOrderId')]), hold: null }
    case 'production_issue.answered':
      return { orderIds: asStrings([text('salesOrderId')]), hold: null }
    // B-PR-28: a task on a sales order counts only as the follow-up of a refused new date (its id is the REPROMISE request's).
    case 'task.created':
    case 'task.completed':
    case 'task.changed': {
      const taskId = text('taskId')
      if (text('recordType') !== 'SalesOrder' || !taskId) return { orderIds: [], hold: null }
      const asked = await db.approvalRequest.findFirst({ where: { id: taskId, kind: 'REPROMISE', recordType: 'SalesOrder' }, select: { recordId: true } })
      return { orderIds: asked ? [asked.recordId] : [], hold: null }
    }
    case 'production_issue.raised':
    case 'approval_request.asked':
    case 'approval_request.answered':
    case 'approval_request.withdrawn':
    case 'approval_request.expired':
    case 'approval_request.decided_for_party': // B-PR-30a
    case 'approval_request.reversed': { // B-PR-30b
      const recordType = text('recordType')
      const recordId = text('recordId')
      if (!recordId) return { orderIds: [], hold: null }
      if (recordType === 'SalesOrder') return { orderIds: [recordId], hold: null }
      if (recordType === 'WorkOrder') return { orderIds: await ordersOfWorkOrders(db, [recordId]), hold: null }
      // B-PR-26: a counter-offer is about a change request of the order (its expiry or withdrawal moves who it waits on).
      if (recordType === 'OrderChangeRequest') {
        const asked = await db.orderChangeRequest.findUnique({ where: { id: recordId }, select: { orderId: true } })
        return { orderIds: asked ? [asked.orderId] : [], hold: null }
      }
      if (recordType === 'SampleRound') {
        const gates = await db.orderGate.findMany({ where: { sampleRoundId: recordId }, select: { salesOrderId: true } })
        return { orderIds: [...new Set(gates.map((gate) => gate.salesOrderId))].sort(), hold: null }
      }
      return { orderIds: [], hold: null }
    }
    case 'workorder.released':
      return { orderIds: [...new Set(asStrings(payload.salesOrderIds))].sort(), hold: null }
    case 'shipment.status_changed': {
      const shipmentId = text('shipmentId')
      const shipment = shipmentId ? await db.shipment.findUnique({ where: { id: shipmentId }, select: { id: true, salesOrderId: true } }) : null
      // B-OP-043 (order page N6): every order the shipment carries (its lines' orders, the first first; one customer).
      return { orderIds: shipment ? [...(await ordersOfShipment(db, shipment))].sort() : [], hold: null }
    }
    case 'quality.garments_released':
    case 'quality.release_reversed': {
      const cellId = text('workOrderSizeId')
      return { orderIds: cellId ? await orderOfCell(db, cellId) : [], hold: null }
    }
    case 'quality.hold_placed':
    case 'quality.hold_released': {
      const subjects = text('subjectType') === 'WorkOrder' ? asStrings(payload.subjectIds) : []
      const moved = asStrings(event.type === 'quality.hold_placed' ? payload.workOrdersHeld : payload.workOrdersLifted)
      return { orderIds: await ordersOfWorkOrders(db, [...subjects, ...moved]), hold: 'QUALITY' }
    }
    case 'work_order_hold.placed':
    case 'work_order_hold.lifted': {
      const workOrderId = text('workOrderId')
      const kind = text('kind') === 'BRAND' ? 'BRAND' : 'PRODUCTION'
      return { orderIds: workOrderId ? await ordersOfWorkOrders(db, [workOrderId]) : [], hold: kind }
    }
    case 'production.scan_recorded':
    case 'production.operation_timed': {
      if (event.type === 'production.operation_timed' && text('kind') !== 'START') return { orderIds: [], hold: null }
      const operationId = text('operationId')
      const operation = operationId ? await db.workOrderOperation.findUnique({ where: { id: operationId }, select: { workOrderId: true, workCentre: { select: { kind: true } } } }) : null
      if (!operation || operation.workCentre.kind !== 'SEWING') return { orderIds: [], hold: null }
      return { orderIds: await notYetAt(db, await ordersOfWorkOrders(db, [operation.workOrderId]), 'SEWING'), hold: null }
    }
    default: {
      // workorder.status_changed, the cuts and bundles: the work order's orders.
      const workOrderId = text('workOrderId')
      const orderIds = workOrderId ? await ordersOfWorkOrders(db, [workOrderId]) : []
      const from = skipFrom(event.type)
      return { orderIds: from ? await notYetAt(db, orderIds, from) : orderIds, hold: null }
    }
  }
}

/**
 * The orders whose row is not yet at `stage` (an order with no row yet counts: its row is made). One indexed read. B-MS-004 (R7):
 * a row with a stage set by hand always counts — its stored stage is the shown one, not the floor's, and this event may end it.
 */
async function notYetAt(db: Reader, orderIds: readonly string[], stage: BrandStage): Promise<string[]> {
  if (orderIds.length === 0) return []
  const rows = await db.brandOrderProduction.findMany({ where: { key: { in: orderIds.map((id) => `brand-production:${id}`) } }, select: { salesOrderId: true, stage: true, stageSet: true } })
  const at = new Map(rows.map((row) => [row.salesOrderId, row]))
  return orderIds.filter((id) => {
    const known = at.get(id)
    return known === undefined || known.stageSet !== null || brandStageRank(known.stage as BrandStage) < brandStageRank(stage)
  })
}

/** The worker's `production.brandKeeper` (background.ts): the orders an event names, each kept on its own facts. */
export function brandKeeperHandler(): EventHandler {
  return defineHandler({
    name: 'production.brandKeeper',
    events: KEEPER_EVENTS,
    attempts: 5,
    async handle(event, { caller }) {
      const { orderIds, hold } = await caller.withClient((db) => ordersOfEvent(db, event))
      const health = !(STAGE_EVENTS as readonly string[]).includes(event.type)
      for (const orderId of orderIds) {
        await keepOrder(caller, orderId, { what: event.type, causationId: event.eventId, health, ...(hold ? { hold: { kind: hold, eventId: event.eventId } } : {}) })
      }
    },
  })
}

// ---- the nightly cron --------------------------------------------------------------------------------------------------------

export interface KeeperNightlyOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

export interface KeeperNightlyRun {
  readonly tenants: number
  readonly orders: number
  readonly changed: number
  readonly failed: number
}

/** One run over every active tenant's kept orders (the cron's tick; tests call it directly). */
export async function runBrandKeeperNightly(options: KeeperNightlyOptions): Promise<KeeperNightlyRun> {
  const clock = options.clock ?? serverClock
  const settings: CommandSettings = { ...COMMAND_SETTINGS, clock }
  const requestId = `brand-keeper-${newId()}`
  let orders = 0
  let changed = 0
  let failed = 0
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    try {
      const caller = callerFor(options.database, systemContext(tenantId, requestId))
      const ids = await asSystem(options.database, tenantId, requestId, async (client) =>
        (await client.salesOrder.findMany({ where: { status: { in: [...KEEPER_ORDER_STATES] } }, select: { id: true }, orderBy: { id: 'asc' } })).map((row) => row.id),
      )
      // B-MS-004 (R2): the safety net — a row still with a stage set by hand although its order left production (its status event
      // missed). One read; each is kept as an event would keep it (keepOrder clears it, `stage` where the work reached).
      const left = await asSystem(options.database, tenantId, requestId, async (client) =>
        (await client.brandOrderProduction.findMany({ where: { stageSet: { not: null }, salesOrder: { is: { status: { notIn: [...KEEPER_ORDER_STATES] } } } }, select: { salesOrderId: true, key: true }, orderBy: { salesOrderId: 'asc' } }))
          .filter((row) => row.key === `brand-production:${row.salesOrderId}`)
          .map((row) => row.salesOrderId),
      )
      const kept = new Set(ids)
      for (const orderId of [...ids, ...left.filter((id) => !kept.has(id))]) {
        orders++
        try {
          const result = await keepOrder(caller, orderId, { what: 'nightly' }, settings)
          if (result.changed) changed++
        } catch (error) {
          failed++
          options.log.error({ err: error, tenantId, orderId }, "an order's production state could not be kept")
        }
      }
    } catch (error) {
      failed++
      options.log.error({ err: error, tenantId }, "the orders' production states of a tenant could not be kept")
    }
  }
  const result = { tenants: tenants.length, orders, changed, failed }
  options.log.info({ ...result }, "customers' production states kept")
  return result
}

/** The scheduler's nightly cron (00:35 Europe/Rome). */
export function brandKeeperCron(options: KeeperNightlyOptions): CronJob {
  return defineCron({
    name: 'production.brandKeeper',
    schedule: '35 0 * * *',
    async run() {
      await runBrandKeeperNightly(options)
    },
  })
}
