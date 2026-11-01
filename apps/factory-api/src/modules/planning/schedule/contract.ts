import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { ALLOCATION_LANE_KINDS } from '@nexus/factory-domain/planning/schedule/allocation'
import { SCHEDULE_REASONS, SCHEDULE_STATUSES } from '@nexus/factory-domain/planning/schedule/backward'
import { PUBLISH_LIMITS, SCHEDULE_LANE_KINDS, SLOT_LIMITS } from '@nexus/factory-domain/planning/schedule/slots'
import { READINESS_WORDS } from '@nexus/factory-domain/planning/readiness/readiness'
import { PUBLISH_HOLDS, SKIP_CODES } from '@nexus/factory-domain/planning/schedule/refusals'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { CALENDAR_STATES } from '../capacity/contract'
import { materialArrival } from '../readiness/contract'

/**
 * The planning board (B-W2a-34; PLN-129 backward scheduling and latest safe start, PLN-131 the board, PLN-132 order and
 * resource views, PLN-147 publish to the floor, PLN-160 allocation to lines and workshops; design planning.board,
 * planning.allocation; Owner answer P3). Instants are UTC ISO strings; minutes decimal strings with one decimal (standard
 * minutes) or whole working minutes (how long a bar takes on its lane); dates the site's days. No money anywhere; per
 * line, work centre, workshop and work order only, never a person (Statuto dei Lavoratori art. 4); a planner's name
 * only on the slot they moved last ("Moved by … at …") and on the version they published.
 */

export const BOARD_BUCKETS = ['DAY', 'WEEK', 'MONTH'] as const
export const TRAY_CHIPS = ['PAST_LATEST_SAFE_START', 'START_SOON', 'MATERIAL_NOT_READY', 'ON_HOLD', 'DRAFT', 'NO_DUE_DATE'] as const
export const PROBLEM_KINDS = ['OVERBOOKED', 'FINISHES_LATE'] as const
export const CHECK_CODES = ['OVERBOOKED', 'IN_THE_PAST', 'MATERIAL_NOT_READY'] as const

const named = output({ id: id(), code: z.string(), name: z.string() })
const laneRef = output({ kind: z.enum(SCHEDULE_LANE_KINDS), id: id() })
const laneInput = input({ kind: z.enum(SCHEDULE_LANE_KINDS), id: id() })
const person = output({ id: id(), name: z.string() }).nullable()
const minutes = () => z.string()

export const scheduleView = output({
  status: z.enum(SCHEDULE_STATUSES),
  /** Started later than this, it cannot finish by its due date (backward from the due date, nothing else in the way). */
  latestSafeStart: instant().nullable(),
  /** The end of work on its due date. */
  latestFinish: instant().nullable(),
  /** Started now: when it would finish. */
  earliestFinish: instant().nullable(),
  /** The working plan's first start and last finish of its bars (and whole-order slots). */
  plannedStart: instant().nullable(),
  plannedFinish: instant().nullable(),
  placed: z.enum(['ALL', 'PART', 'NONE']),
  /** Why it is late, at risk or on time, in words (the first reason's). */
  words: z.string(),
  reasons: z.array(output({ code: z.enum(SCHEDULE_REASONS), words: z.string() })),
})

const storedSlot = output({
  id: id(),
  version: z.number().int(),
  planVersionId: id(),
  lane: laneRef,
  workOrderId: id(),
  /** null: a whole-order slot (part of an order on a lane: the allocation board's card). */
  operationId: id().nullable(),
  startAt: instant(),
  endAt: instant(),
  /** A whole-order slot's garments (null: all of the order's). */
  pieces: z.number().int().nullable(),
  /** Standard minutes it booked when placed or moved. */
  minutes: minutes(),
  overloadReason: z.string().nullable(),
  note: z.string().nullable(),
  updatedAt: instant(),
  /** "Moved by … at …": the planner who placed or moved it last. */
  updatedBy: person,
})

export const slotView = storedSlot.extend({
  /** The work order books capacity (released or in progress); a draft's or held one's bar books none. */
  booksCapacity: z.boolean(),
  latestStart: instant().nullable(),
  latestFinish: instant().nullable(),
  /** It starts after its latest start: the operations after it have no time to spare. */
  startsLate: z.boolean(),
})

const operationView = output({
  id: id(),
  seq: z.number().int(),
  code: z.string(),
  name: z.string(),
  workCentre: named,
  /** Per garment (the frozen routing's). */
  standardMinutes: z.string(),
  remainingPieces: z.number().int(),
  /** Standard minutes still to do there. */
  minutes: minutes(),
  /** How long it takes on its lane: working minutes (people × efficiency), or a workshop's transit days in minutes. */
  workingMinutes: z.number().int(),
  /** The lane it is scheduled on: its own bar's, else the work order's line, the routing step's workshop, its work centre. */
  lane: laneRef,
  outside: output({ partyId: id(), transitDays: z.number().int().nullable() }).nullable(),
  latestStart: instant().nullable(),
  latestFinish: instant().nullable(),
  earliestStart: instant().nullable(),
  earliestFinish: instant().nullable(),
  plannedStart: instant().nullable(),
  plannedFinish: instant().nullable(),
  startsLate: z.boolean(),
  slotIds: z.array(id()),
})

const readinessView = output({
  word: z.enum(READINESS_WORDS),
  label: z.string(),
  date: businessDate().nullable(),
  reason: z.string(),
  /** B-W2b-20: per material (component): its word, the day it is needed, what is short and what arrives for it, by date. */
  materials: z.array(
    output({
      itemId: id(),
      itemColourId: id().nullable(),
      label: z.string(),
      uom: z.enum(UOMS),
      word: z.enum(READINESS_WORDS),
      date: businessDate().nullable(),
      neededOn: businessDate().nullable(),
      /** Base unit, four decimals. */
      needed: z.string(),
      short: z.string(),
      reason: z.string(),
      arrivals: z.array(materialArrival),
    }),
  ),
}).nullable()

export const workOrderView = output({
  id: id(),
  number: z.string(),
  status: z.string(),
  kind: z.string(),
  priority: z.number().int(),
  /** The work order's rush flag (B-W2b-51, MES-009): first in the dispatch lists. */
  rush: z.boolean(),
  version: z.number().int(),
  dueDate: businessDate().nullable(),
  style: named,
  /** B-W2b-20: the style's family (its product type: JACKET, TROUSERS, SUIT, GLOVES, VEST, OTHER). */
  family: z.string(),
  /** B-W2b-20: the customer whose order lines it makes; null when none or several (`customers` names them). */
  customer: named.nullable(),
  customers: z.array(named),
  garments: z.number().int(),
  line: named.nullable(),
  holdReason: z.string().nullable(),
  booksCapacity: z.boolean(),
  /** Standard minutes still to do, every operation. */
  minutes: minutes(),
  schedule: scheduleView,
  /** Material readiness now (planning/readiness); null when not asked. */
  readiness: readinessView,
  operations: z.array(operationView),
})
export type WorkOrderView = z.infer<typeof workOrderView>

const cellView = output({
  key: z.string(),
  from: businessDate(),
  to: businessDate(),
  availableMinutes: minutes(),
  bookedMinutes: minutes(),
  scheduledMinutes: minutes(),
  loadPct: z.string().nullable(),
  overMinutes: minutes(),
  closedDays: z.array(output({ date: businessDate(), reason: z.enum(['HOLIDAY', 'CLOSURE']), name: z.string() })),
  /** How the available minutes are made. */
  words: z.string(),
})

export const laneView = output({
  kind: z.enum(SCHEDULE_LANE_KINDS),
  id: id(),
  code: z.string(),
  name: z.string(),
  workCentreKind: z.string().nullable(),
  /** A line's people or a work centre's stations, and the efficiency (null for a workshop). */
  people: z.number().int().nullable(),
  efficiencyPct: z.string().nullable(),
  /** A line: the work centres it does; null: every operation (or not a line). */
  does: z.array(id()).nullable(),
  /** A workshop's location at the site (its stock). */
  location: output({ id: id(), code: z.string() }).nullable(),
  /**
   * B-W2b-20: where its working time comes from (planning/capacity `calendarState`: OWN, INHERITED, NONE = no calendar,
   * the planning default) and the calendars, most specific first; null for a workshop.
   */
  calendar: output({ state: z.enum(CALENDAR_STATES), calendars: z.array(output({ id: id(), scope: z.string(), name: z.string() })) }).nullable(),
  /** Load per bucket; null for a workshop (no capacity in standard minutes: W2b). */
  cells: z.array(cellView).nullable(),
})

const versionHeader = output({
  id: id(),
  number: z.number().int(),
  previousId: id().nullable(),
  coversFrom: businessDate(),
  coversTo: businessDate(),
  effectiveFrom: instant(),
  publishedAt: instant(),
  publishedBy: person,
  note: z.string().nullable(),
})

const diffView = output({ moved: z.number().int(), added: z.number().int(), removed: z.number().int(), words: z.string() })

/** B-W2b-20: why publishing is held: NOTHING_CHANGED (since `previousVersion`), NOTHING_ON_DAYS, NO_PERMISSION, RANGE_NOT_VALID. */
const publishHold = output({ code: z.enum(PUBLISH_HOLDS), previousVersion: z.number().int().nullable(), coversFrom: businessDate().nullable(), coversTo: businessDate().nullable() })

const problemView = output({
  kind: z.enum(PROBLEM_KINDS),
  words: z.string(),
  lane: laneRef.nullable(),
  date: businessDate().nullable(),
  bucketKey: z.string().nullable(),
  overMinutes: minutes().nullable(),
  loadPct: z.string().nullable(),
  workOrderId: id().nullable(),
  /** Calendar days after the due date it finishes (the plan's finish, else the earliest one). */
  daysLate: z.number().int().nullable(),
})

const siteView = output({ id: id(), companyId: id(), code: z.string(), name: z.string(), timeZone: z.string() })

const boardQuery = {
  siteId: id(),
  /** Default today (the site's day). */
  from: businessDate().optional(),
  /** Default: two weeks on (DAY), eight weeks (WEEK), six months (MONTH). */
  to: businessDate().optional(),
  bucket: z.enum(BOARD_BUCKETS).optional(),
  /** Material readiness per work order (one netting of the site's plan); default true. */
  readiness: z.enum(['true', 'false']).optional(),
}

export const boardContract = defineContract({
  querystring: input(boardQuery),
  response: {
    200: output({
      site: siteView,
      from: businessDate(),
      to: businessDate(),
      bucket: z.enum(BOARD_BUCKETS),
      today: businessDate(),
      asOf: instant(),
      plan: output({
        /** The site's working plan (null until its first move). */
        id: id().nullable(),
        version: z.number().int().nullable(),
        updatedAt: instant().nullable(),
        published: versionHeader.nullable(),
        /** The working plan against the last published version, over the days it covered. */
        changesSincePublished: diffView.nullable(),
        mayChange: z.boolean(),
        mayPublish: z.boolean(),
        /** Why "Publish to floor" is held, in words; null: it may be published. */
        publishHeld: z.string().nullable(),
        /** B-W2b-20: why it is held as a stable code with its facts (the version nothing changed since, the days); null: it may be published. */
        publishHold: publishHold.nullable(),
      }),
      buckets: z.array(output({ key: z.string(), kind: z.enum(BOARD_BUCKETS), from: businessDate(), to: businessDate() })),
      lanes: z.array(laneView),
      /** The working plan's slots reaching into the period. */
      slots: z.array(slotView),
      /** The order view: every open work order with its operations (the resource view's bars point at them). */
      workOrders: z.array(workOrderView),
      /** Not on the board (wholly or partly), the earliest latest safe start first. */
      tray: z.array(output({ workOrderId: id(), unplacedOperations: z.number().int(), minutes: minutes(), latestSafeStart: instant().nullable(), chips: z.array(z.enum(TRAY_CHIPS)) })),
      problems: z.array(problemView),
    }),
  },
})
export type BoardQuery = z.infer<typeof boardContract.querystring>

export const workOrderScheduleContract = defineContract({
  params: input({ workOrderId: id() }),
  response: {
    200: output({
      site: siteView,
      asOf: instant(),
      workOrder: workOrderView,
      sizes: z.array(output({ colourway: z.string(), size: z.string(), quantity: z.number().int() })),
      slots: z.array(slotView),
      lanes: z.array(laneView.omit({ cells: true })),
    }),
  },
})

const overView = output({ lane: laneRef, date: businessDate(), availableMinutes: minutes(), bookedMinutes: minutes(), overMinutes: minutes(), loadPct: z.string().nullable() })

const slotAnswer = {
  201: output({ slot: storedSlot, planVersion: z.number().int(), schedule: scheduleView.nullable(), over: z.array(overView), replayed: z.boolean() }),
}

export const placeSlotContract = defineContract({
  body: input({
    workOrderId: id(),
    /** null: the whole work order (part of an order on a lane: prefer the allocation). */
    operationId: id().nullable(),
    lane: laneInput,
    startAt: instant(),
    /** Default: the start plus what the work takes on the lane (its people × efficiency, its working time). */
    endAt: instant().optional(),
    /** A whole-order slot's garments. */
    pieces: z.number().int().optional(),
    /** "Keep with a reason": required when the drop overbooks the lane. */
    overloadReason: z.string().max(SLOT_LIMITS.reason).nullable().optional(),
    note: z.string().max(SLOT_LIMITS.note).nullable().optional(),
  }),
  response: slotAnswer,
})
export type PlaceSlotBody = z.infer<typeof placeSlotContract.body>

export const moveSlotContract = defineContract({
  params: input({ slotId: id() }),
  body: input({
    /** The slot's version as read (409 with who moved it and when). */
    version: z.number().int().min(1),
    lane: laneInput.optional(),
    startAt: instant().optional(),
    /** Default: the new start plus what the work takes on the (new) lane. */
    endAt: instant().optional(),
    pieces: z.number().int().nullable().optional(),
    overloadReason: z.string().max(SLOT_LIMITS.reason).nullable().optional(),
    note: z.string().max(SLOT_LIMITS.note).nullable().optional(),
  }),
  response: { 200: slotAnswer[201] },
})
export type MoveSlotBody = z.infer<typeof moveSlotContract.body>

export const removeSlotContract = defineContract({
  params: input({ slotId: id() }),
  body: input({ version: z.number().int().min(1) }),
  response: { 200: output({ removed: id(), workOrderId: id(), planVersion: z.number().int(), replayed: z.boolean() }) },
})

const proposalView = output({
  workOrderId: id(),
  operationId: id(),
  lane: laneRef,
  startAt: instant(),
  endAt: instant(),
  minutes: minutes(),
  /** BACKWARD: at its latest start; FORWARD: its latest start has passed, so from now (it will be late). */
  placedBy: z.enum(['BACKWARD', 'FORWARD']),
  over: z.array(overView),
})

export const placeByDueDateContract = defineContract({
  body: input({
    siteId: id(),
    /** Default: every work order of the tray. */
    workOrderIds: z.array(id()).min(1).max(SLOT_LIMITS.perBatch).optional(),
    /** false: the preview only. */
    apply: z.boolean(),
    /** Required to apply when a placement overbooks a lane. */
    overloadReason: z.string().max(SLOT_LIMITS.reason).nullable().optional(),
    /** The working plan's version the preview was read at (apply). */
    version: z.number().int().min(1).optional(),
  }),
  response: {
    200: output({
      planVersion: z.number().int().nullable(),
      applied: z.boolean(),
      slots: z.array(proposalView),
      /** B-W2b-20: `code` NOT_OPEN · ON_HOLD · NO_DUE_DATE · LANE_NOT_ACTIVE · NO_WORKING_TIME. */
      skipped: z.array(output({ workOrderId: id(), operationId: id().nullable(), code: z.enum(SKIP_CODES), words: z.string() })),
      overbooked: z.number().int(),
      replayed: z.boolean(),
    }),
  },
})
export type PlaceByDueDateBody = z.infer<typeof placeByDueDateContract.body>

const checkView = output({
  code: z.enum(CHECK_CODES),
  state: z.enum(['PASS', 'WARNING']),
  count: z.number().int(),
  words: z.string(),
  items: z.array(output({ words: z.string(), workOrderId: id().nullable(), slotId: id().nullable(), lane: laneRef.nullable(), date: businessDate().nullable() })),
})

const publishQuery = {
  siteId: id(),
  /** Default: the site's next working day … the fifth working day from it. */
  coversFrom: businessDate().optional(),
  coversTo: businessDate().optional(),
  /** Default: the first shift of the first day (now, when that has passed). */
  effectiveFrom: instant().optional(),
}

export const publishPreviewContract = defineContract({
  querystring: input(publishQuery),
  response: {
    200: output({
      site: siteView,
      asOf: instant(),
      plan: output({ id: id().nullable(), version: z.number().int().nullable() }),
      next: z.number().int(),
      previous: versionHeader.nullable(),
      range: output({ coversFrom: businessDate(), coversTo: businessDate(), effectiveFrom: instant(), workingDays: z.number().int(), isDefault: z.boolean() }),
      /** Slots the version would carry. */
      slots: z.number().int(),
      diff: diffView.extend({ byLane: z.array(output({ lane: laneRef, code: z.string(), name: z.string(), moved: z.number().int(), added: z.number().int(), removed: z.number().int() })) }),
      checks: z.array(checkView),
      mayPublish: z.boolean(),
      /** Why publishing is held, in words; null: it may be published. */
      heldReason: z.string().nullable(),
      /** B-W2b-20: the hold's stable code and facts; null: it may be published. */
      heldCode: z.enum(PUBLISH_HOLDS).nullable(),
      hold: publishHold.nullable(),
    }),
  },
})
export type PublishQuery = z.infer<typeof publishPreviewContract.querystring>

export const publishContract = defineContract({
  body: input({
    ...publishQuery,
    /** The working plan's version the dialog reviewed (409 when it moved since). */
    version: z.number().int().min(1),
    note: z.string().max(PUBLISH_LIMITS.note).nullable().optional(),
  }),
  response: { 201: output({ version: versionHeader, slots: z.number().int(), diff: diffView, replayed: z.boolean() }) },
})
export type PublishBody = z.infer<typeof publishContract.body>

export const versionsContract = defineContract({
  querystring: input({ siteId: id() }),
  response: { 200: output({ site: siteView, versions: z.array(versionHeader.extend({ slots: z.number().int() })) }) },
})

export const versionContract = defineContract({
  params: input({ versionId: id() }),
  response: {
    200: output({
      site: siteView,
      version: versionHeader,
      slots: z.array(storedSlot.extend({ workOrder: output({ id: id(), number: z.string() }), operation: output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string() }).nullable(), laneCode: z.string(), laneName: z.string() })),
    }),
  },
})

// ---- allocation (PLN-160) --------------------------------------------------------------------------------------------

const allocationLane = input({ kind: z.enum(ALLOCATION_LANE_KINDS), id: id() })

const cardView = output({
  /** `<workOrderId>:LINE` for the work order's line part (or not allocated), `<workOrderId>:<slotId>` for a part. */
  id: z.string(),
  workOrder: output({
    id: id(),
    number: z.string(),
    status: z.string(),
    version: z.number().int(),
    dueDate: businessDate().nullable(),
    style: named,
    /** B-W2b-20: the style's family (product type) and the customer (null when none or several). */
    family: z.string(),
    customer: named.nullable(),
    garments: z.number().int(),
    holdReason: z.string().nullable(),
  }),
  /** Its column: a line or workshop; null: not allocated. */
  lane: output({ kind: z.enum(ALLOCATION_LANE_KINDS), id: id() }).nullable(),
  pieces: z.number().int(),
  /** Standard minutes of its garments still to do (the lane's operations; a workshop: every operation). */
  minutes: minutes(),
  slot: output({ id: id(), version: z.number().int() }).nullable(),
  schedule: output({ status: z.enum(SCHEDULE_STATUSES), words: z.string(), latestSafeStart: instant().nullable() }),
})

const allocationLaneView = output({
  kind: z.enum(ALLOCATION_LANE_KINDS),
  id: id(),
  code: z.string(),
  name: z.string(),
  /** A line: its load over the next four weeks; null for a workshop. */
  load: output({ availableMinutes: minutes(), bookedMinutes: minutes(), loadPct: z.string().nullable(), overMinutes: minutes() }).nullable(),
  /** Garments allocated to it (open work orders). */
  piecesBooked: z.number().int(),
  location: output({ id: id(), code: z.string() }).nullable(),
  /** A workshop's live subcontract orders at the site. */
  subcontractOrders: z.number().int().nullable(),
})

export const allocationContract = defineContract({
  querystring: input({ siteId: id() }),
  response: {
    200: output({
      site: siteView,
      asOf: instant(),
      today: businessDate(),
      plan: output({ id: id().nullable(), version: z.number().int().nullable() }),
      mayChange: z.boolean(),
      lanes: z.array(allocationLaneView),
      cards: z.array(cardView),
    }),
  },
})

export const allocateContract = defineContract({
  params: input({ workOrderId: id() }),
  body: input({
    /** The work order's version as read on the allocation board. */
    version: z.number().int().min(1),
    /** The line that makes the garments no part names; null: not allocated. */
    lineId: id().nullable(),
    parts: z.array(input({ lane: allocationLane, pieces: z.number().int() })).max(20),
  }),
  response: { 200: output({ workOrder: output({ id: id(), version: z.number().int(), lineId: id().nullable() }), cards: z.array(cardView), planVersion: z.number().int(), replayed: z.boolean() }) },
})
export type AllocateBody = z.infer<typeof allocateContract.body>
