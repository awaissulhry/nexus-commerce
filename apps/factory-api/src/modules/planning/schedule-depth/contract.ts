import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { SCHEDULE_STATUSES } from '@nexus/factory-domain/planning/schedule/backward'
import { SKIP_CODES } from '@nexus/factory-domain/planning/schedule/refusals'
import { SCHEDULE_LANE_KINDS, SLOT_LIMITS } from '@nexus/factory-domain/planning/schedule/slots'
import { KEPT_CODES, MOVE_WHYS } from '@nexus/factory-domain/planning/schedule-depth/forward'
import { WHAT_IF_CONFLICTS, WHAT_IF_LIMITS, WHAT_IF_MOVE_KINDS } from '@nexus/factory-domain/planning/schedule-depth/whatif'
import { overView, siteView, storedSlot } from '../schedule/contract'
import { materialCheckView, materialStartView } from './material-contract'

/**
 * Scheduling in depth (B-W2b-312; PLN-130 forward scheduling for late orders, PLN-134 moves that know the material, PLN-139
 * pinned operations, PLN-141 the backlog reschedule; design planning.board "What-if", "Reschedule backlog", "Pin (W2b)",
 * "Material-aware (W2b)"). Instants are UTC ISO strings; minutes decimal strings (standard minutes, one decimal); dates the
 * site's days. No money anywhere; per line, work centre, workshop and work order only, never a worker; a planner's name
 * only on the slot (who moved or pinned it) and inside one scenario's conflicts ("moved by … since").
 */

const laneRef = output({ kind: z.enum(SCHEDULE_LANE_KINDS), id: id() })
const laneInput = input({ kind: z.enum(SCHEDULE_LANE_KINDS), id: id() })
const minutes = () => z.string()
const span = output({ startAt: instant(), endAt: instant() })

// ---- pins (PLN-139) ----------------------------------------------------------------------------------------------------

export const pinSlotContract = defineContract({
  params: input({ slotId: id() }),
  body: input({
    /** The slot's version as read (409 with who moved it and when). */
    version: z.number().int().min(1),
    /** true: pin it where it is; false: unpin it. */
    pinned: z.boolean(),
  }),
  response: { 200: output({ slot: storedSlot, planVersion: z.number().int(), replayed: z.boolean() }) },
})
export type PinSlotBody = z.infer<typeof pinSlotContract.body>

export const pinWorkOrderContract = defineContract({
  params: input({ workOrderId: id() }),
  body: input({
    pinned: z.boolean(),
    /** The working plan's version as read (optional: 409 when it moved since). */
    planVersion: z.number().int().min(1).optional(),
  }),
  response: { 200: output({ workOrderId: id(), pinned: z.boolean(), changed: z.number().int(), slots: z.array(storedSlot), planVersion: z.number().int(), replayed: z.boolean() }) },
})
export type PinWorkOrderBody = z.infer<typeof pinWorkOrderContract.body>

// ---- material (PLN-134) ------------------------------------------------------------------------------------------------

export const materialContract = defineContract({
  params: input({ workOrderId: id() }),
  querystring: input({
    /** A drop being tried: its start (the check answers whether it is in time and where to snap it). */
    startAt: instant().optional(),
    /** Its lane (default: the lane of the work order's first operation with work left). */
    laneKind: z.enum(SCHEDULE_LANE_KINDS).optional(),
    laneId: id().optional(),
  }),
  response: {
    200: output({
      site: siteView,
      asOf: instant(),
      workOrder: output({ id: id(), number: z.string() }),
      materialStart: materialStartView,
      /** Per material: its readiness word, when it arrives and from when it can be used. */
      materials: z.array(
        output({
          itemId: id(),
          itemColourId: id().nullable(),
          label: z.string(),
          word: z.string(),
          arrives: businessDate().nullable(),
          overdue: z.boolean(),
          purchaseOrderNumber: z.string().nullable(),
          source: z.enum(['PURCHASE_ORDER', 'FIRM']).nullable(),
          usableFrom: businessDate().nullable(),
          notCovered: z.boolean(),
        }),
      ),
      check: materialCheckView.nullable(),
    }),
  },
})
export type MaterialQuery = z.infer<typeof materialContract.querystring>

// ---- forward scheduling (PLN-130) and the backlog reschedule (PLN-141) ------------------------------------------------

const runMove = output({
  workOrderId: id(),
  number: z.string(),
  operationId: id(),
  operation: output({ seq: z.number().int(), code: z.string(), name: z.string() }),
  /** The bar it moves; null: placed from the tray (forward scheduling only). */
  slotId: id().nullable(),
  lane: laneRef,
  from: span.nullable(),
  to: span,
  /** Standard minutes it books. */
  minutes: minutes(),
  /** FORWARD: from today on free time · PAST: left in the past · PUSHED: moved on by the operation before it · PLACED: from the tray. */
  why: z.enum(MOVE_WHYS),
  over: z.array(overView),
})

const runOrder = output({
  workOrderId: id(),
  number: z.string(),
  dueDate: businessDate().nullable(),
  /** As the working plan has it now, and after the run. */
  before: output({ status: z.enum(SCHEDULE_STATUSES), plannedFinish: instant().nullable(), earliestFinish: instant().nullable(), words: z.string() }),
  after: output({ status: z.enum(SCHEDULE_STATUSES), plannedFinish: instant().nullable(), words: z.string() }),
  /** The run's finish of its last operation on the lanes' free time. */
  finish: instant().nullable(),
  /** Calendar days after the due date it finishes (null: no due date or not finished on the board). */
  daysLate: z.number().int().nullable(),
  /** The earliest start with material it was scheduled from. */
  material: output({ state: z.string(), earliestStart: instant().nullable(), words: z.string() }),
  moves: z.number().int(),
  words: z.string(),
})

const runAnswer = output({
  planVersion: z.number().int().nullable(),
  applied: z.boolean(),
  mode: z.enum(['FORWARD', 'BACKLOG']),
  moves: z.array(runMove),
  orders: z.array(runOrder),
  /** What stays where it is, and why (a pinned bar left in the past, a pinned bar before the one before it, no working time). */
  kept: z.array(output({ workOrderId: id(), operationId: id(), slotId: id().nullable(), code: z.enum(KEPT_CODES), words: z.string() })),
  /** Work orders (or operations) left out: NOT_OPEN · ON_HOLD · NO_DUE_DATE · LANE_NOT_ACTIVE · NO_WORKING_TIME · GATE_NOT_PASSED. */
  skipped: z.array(output({ workOrderId: id(), operationId: id().nullable(), code: z.enum(SKIP_CODES), words: z.string() })),
  overbooked: z.number().int(),
  words: z.string(),
  replayed: z.boolean(),
})

const runBody = {
  siteId: id(),
  /** false: the preview only. */
  apply: z.boolean(),
  /** Required to apply when a move overbooks a lane. */
  overloadReason: z.string().max(SLOT_LIMITS.reason).nullable().optional(),
  /** The working plan's version the preview was read at (apply). */
  version: z.number().int().min(1).optional(),
}

export const forwardContract = defineContract({
  body: input({
    ...runBody,
    /** Default: every open work order of the site that cannot meet its due date scheduled backwards (it should have started already). */
    workOrderIds: z.array(id()).min(1).max(SLOT_LIMITS.perBatch).optional(),
  }),
  response: { 200: runAnswer },
})
export type ForwardBody = z.infer<typeof forwardContract.body>

export const backlogContract = defineContract({
  body: input(runBody),
  response: { 200: runAnswer },
})
export type BacklogBody = z.infer<typeof backlogContract.body>

// ---- what-if (design planning.board sec:whatif) ---------------------------------------------------------------------

const placeView = output({ lane: laneRef, startAt: instant(), endAt: instant() })

const moveView = output({
  kind: z.enum(WHAT_IF_MOVE_KINDS),
  slotId: id().nullable(),
  slotVersion: z.number().int().nullable(),
  workOrderId: id(),
  number: z.string(),
  operationId: id().nullable(),
  operation: output({ seq: z.number().int(), code: z.string(), name: z.string() }).nullable(),
  from: placeView.nullable(),
  to: placeView.nullable(),
  /** Why it cannot be applied as it is now (null: it can). */
  conflict: output({ code: z.enum(WHAT_IF_CONFLICTS), words: z.string() }).nullable(),
  /** Its start against the work order's material (MOVE, PLACE). */
  material: materialCheckView.nullable(),
})

const effectView = output({
  lateOrders: output({ before: z.number().int(), after: z.number().int() }),
  /** Standard minutes over the lanes' available minutes over the window, before and after (overtime needed). */
  overMinutes: output({ before: minutes(), after: minutes() }),
  window: output({ from: businessDate(), to: businessDate() }),
  /** Each touched lane's load on its busiest day among the days its moves touch (from `from` to `to`), before and after. */
  lanes: z.array(output({ lane: laneRef, code: z.string(), name: z.string(), from: businessDate(), to: businessDate(), beforePct: z.string().nullable(), afterPct: z.string().nullable() })),
  /** Work orders whose planned start or finish changes. */
  orders: z.array(
    output({
      workOrderId: id(),
      number: z.string(),
      before: output({ status: z.enum(SCHEDULE_STATUSES), plannedStart: instant().nullable(), plannedFinish: instant().nullable() }),
      after: output({ status: z.enum(SCHEDULE_STATUSES), plannedStart: instant().nullable(), plannedFinish: instant().nullable() }),
    }),
  ),
  /** "late orders 4 → 2 · overtime needed 0 → 6 h · L1 load 104% → 92% · orders that move: 7". */
  words: z.string(),
})

const scenarioView = output({
  id: id(),
  siteId: id(),
  name: z.string().nullable(),
  status: z.enum(['DRAFT', 'APPLIED', 'DISCARDED']),
  version: z.number().int(),
  basedAt: instant(),
  /** The working plan changed since the scenario was based on it (Apply lists the conflicts). */
  planChanged: z.boolean(),
  planVersion: z.number().int().nullable(),
  appliedAt: instant().nullable(),
  discardedAt: instant().nullable(),
  /** The banner's words. */
  banner: z.string(),
  moves: z.array(moveView),
  conflicts: z.number().int(),
  effect: effectView,
})

const scenarioAnswer = output({ site: siteView, asOf: instant(), scenario: scenarioView, replayed: z.boolean() })

export const createWhatIfContract = defineContract({
  body: input({ siteId: id(), name: z.string().max(WHAT_IF_LIMITS.name).nullable().optional() }),
  response: { 201: scenarioAnswer },
})
export type CreateWhatIfBody = z.infer<typeof createWhatIfContract.body>

export const listWhatIfsContract = defineContract({
  querystring: input({ siteId: id() }),
  response: {
    200: output({
      site: siteView,
      /** The caller's own DRAFT scenarios at the site (nobody else's: they are private). */
      scenarios: z.array(output({ id: id(), name: z.string().nullable(), status: z.enum(['DRAFT', 'APPLIED', 'DISCARDED']), version: z.number().int(), basedAt: instant(), moves: z.number().int(), updatedAt: instant() })),
    }),
  },
})

export const getWhatIfContract = defineContract({
  params: input({ scenarioId: id() }),
  response: { 200: scenarioAnswer },
})

const moveInput = input({
  kind: z.enum(WHAT_IF_MOVE_KINDS),
  /** MOVE, REMOVE: the bar (or part of an order) of the working plan. */
  slotId: id().optional(),
  /** PLACE: the work order and its operation (with work left, not on the board). */
  workOrderId: id().optional(),
  operationId: id().optional(),
  /** MOVE (default: where it is), PLACE: the lane. */
  lane: laneInput.optional(),
  /** MOVE, PLACE: the start; the end defaults to what the work takes on the lane. */
  startAt: instant().optional(),
  endAt: instant().optional(),
})
export type WhatIfMoveInput = z.infer<typeof moveInput>

export const setWhatIfMovesContract = defineContract({
  params: input({ scenarioId: id() }),
  body: input({
    /** The scenario's version as read. */
    version: z.number().int().min(1),
    /** Every move of the scenario, in the order tried (a bar tried again replaces its entry); [] clears it. */
    moves: z.array(moveInput).max(WHAT_IF_LIMITS.moves),
  }),
  response: { 200: scenarioAnswer },
})
export type SetWhatIfMovesBody = z.infer<typeof setWhatIfMovesContract.body>

export const applyWhatIfContract = defineContract({
  params: input({ scenarioId: id() }),
  body: input({
    version: z.number().int().min(1),
    /** Required when an applied move overbooks a lane. */
    overloadReason: z.string().max(SLOT_LIMITS.reason).nullable().optional(),
    /** true: apply the moves without a conflict and leave the others (the ReviewChangesModal's "Apply the rest"). */
    skipConflicts: z.boolean().optional(),
  }),
  response: {
    200: output({
      site: siteView,
      scenario: output({ id: id(), status: z.enum(['DRAFT', 'APPLIED', 'DISCARDED']), version: z.number().int(), appliedAt: instant().nullable() }),
      applied: z.number().int(),
      skipped: z.array(output({ index: z.number().int(), code: z.enum(WHAT_IF_CONFLICTS), words: z.string() })),
      planVersion: z.number().int(),
      replayed: z.boolean(),
    }),
  },
})
export type ApplyWhatIfBody = z.infer<typeof applyWhatIfContract.body>

export const discardWhatIfContract = defineContract({
  params: input({ scenarioId: id() }),
  body: input({ version: z.number().int().min(1) }),
  response: { 200: output({ scenario: output({ id: id(), status: z.enum(['DRAFT', 'APPLIED', 'DISCARDED']), version: z.number().int(), discardedAt: instant().nullable() }), replayed: z.boolean() }) },
})
