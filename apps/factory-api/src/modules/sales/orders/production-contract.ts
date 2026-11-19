import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { BRAND_HEALTHS, HEALTH_REASON_CODES } from '@nexus/factory-domain/production-brand/health'
import { BRAND_STAGES } from '@nexus/factory-domain/production-brand/stages'
import { BRAND_URGENCIES } from '@nexus/factory-domain/production-brand/urgency'
import { BLOCKER_KINDS, BLOCKER_SUBS, WAITING_ON } from '@nexus/factory-domain/production-brand/waiting' // B-OP-021: + BLOCKER_SUBS
import { SALES_ORDER_PRIORITY_LEVELS } from '@nexus/factory-domain/sales/orders-depth/rules'
import { GATE_KINDS, GATE_STATES, LEATHER_STATES, MILESTONE_KINDS, MILESTONE_STATES, PASS_VIAS } from '@nexus/factory-domain/planning/milestones/rules'
import { FINISH_SOURCES } from '@nexus/factory-domain/planning/promise-keep/risk' // F-SA-234b
// B-SA-050: Still to do (its kinds; who it waits on: the apply plan's teams).
import { APPLY_TEAMS, STILL_KINDS } from '@nexus/factory-domain/sales/change-requests/apply-plan'

/**
 * B-SA-031 / B-SA-032 (Sales page plan P2, P3, P4, P15, P16; 13-backend B1, B12; 10-order-page OR1, OR2): the office's read of ONE
 * sales order's production — the office twin of the customer's `GET /portal/production/:orderId` — and its dates alone.
 *
 *   GET /sales/orders/:orderId/production?parts=headline,lines,work,dates,quality,people,changes   (default: every part)
 *   GET /sales/orders/:orderId/milestones                                                          (the `dates` part alone)
 *
 * orders.view over the order's company and customer (else "Sales order not found.", the words of an unknown id). Each part by
 * its right: one the reader may not read is null and named in `withheld` (never an empty part that looks like "none"); a part
 * not asked is absent. Every piece counted is the ORDER'S OWN (the cells of its own lines); a work order that also makes other
 * work lends nothing of another customer — no other customer's name, number or count. No money in this read; no operator's name,
 * no per-person or per-station output (Statuto dei Lavoratori art. 4): places are a line, a team by name, or an outside workshop.
 */

export const PRODUCTION_PARTS = ['headline', 'lines', 'work', 'dates', 'quality', 'people', 'changes'] as const
export type ProductionPart = (typeof PRODUCTION_PARTS)[number]

/** What `withheld` may name: a whole part, or one block of a part. */
export const WITHHELD_KEYS = ['work', 'people', 'headline.notes', 'quality.issues', 'quality.ncrs', 'quality.final', 'dates.forecast'] as const
export type WithheldKey = (typeof WITHHELD_KEYS)[number]

const words = output({ it: z.string(), en: z.string() })
const named = output({ code: z.string(), name: z.string() })
const person = output({ id: id(), name: z.string(), active: z.boolean() })

/** Pieces of the order's own cells at each step; null: the step is not counted there (never a made-up 0). */
const pieces = {
  ordered: z.number().int(),
  cut: z.number().int().nullable(),
  sewn: z.number().int().nullable(),
  checked: z.number().int().nullable(),
  packed: z.number().int().nullable(),
  shipped: z.number().int(),
}

export const headlineView = output({
  /** The plain stage (the customer's words): its slowest open line; null before any goods line is open or after it left. */
  stage: output({
    code: z.enum(BRAND_STAGES),
    words,
    /** When the keeper saw it reach this stage (null: read live, no state kept yet). */
    since: businessDate().nullable(),
    ahead: z.number().int(),
    aheadWords: words.nullable(),
    sewingNotCounted: z.boolean(),
    sewingNotCountedWords: words.nullable(),
    next: output({ code: z.enum(BRAND_STAGES), words }).nullable(),
    partlyShipped: z.boolean(),
  }).nullable(),
  /** What is in work now, as counts only: the order's ACTIVE bundles and its pieces between the steps (never a person). */
  inWork: output({
    bundles: z.number().int(),
    pieces: output({ cutting: z.number().int(), sewing: z.number().int().nullable(), checking: z.number().int().nullable(), packing: z.number().int().nullable() }),
  }),
  /** The order's health as the keeper keeps it (null: no state kept yet: the order read's daysLate says "Late" then). */
  health: output({
    code: z.enum(BRAND_HEALTHS),
    words,
    computed: z.enum(BRAND_HEALTHS).nullable(),
    /** A person raised it to At risk (it stands until the day before `until`). */
    raise: output({
      reasonCode: z.enum(HEALTH_REASON_CODES),
      words,
      until: businessDate(),
      /** Office only, with workorders.view (else null and `headline.notes` withheld). */
      note: z.string().nullable(),
      by: person.nullable(),
      at: instant().nullable(),
    }).nullable(),
  }).nullable(),
  waiting: output({
    on: z.enum(WAITING_ON),
    words,
    since: instant().nullable(),
    /** Each thing it waits for, in words (whose move it is: `on`). */
    blockers: z.array(
      output({
        kind: z.enum(BLOCKER_KINDS),
        on: z.enum(WAITING_ON),
        words,
        since: instant().nullable(),
        // ── B-OP-021 (13-backend §3 B4): the ONE waiting list of the order page (its band, its card and its pill read these rows) ──
        /**
         * The record it is about, the door to it: OrderChangeRequest, ProductionIssue, ApprovalRequest, PartnerTask, DepositRequest,
         * OrderGate or WorkOrder (a work order only for a reader who reaches it with workorders.view); null: no one record, or one
         * the reader may not open.
         */
        // F-OP-103: + a reported problem's message in the order's own thread (the page replies to it in place).
        ref: output({ type: z.string(), id: id(), messageId: id().optional() }).nullable(),
        /** A BRAND_REQUEST waiting on us: a request still open, a counter-offer agreed or lapsed, a reported problem, a refused new date. */
        sub: z.enum(BLOCKER_SUBS).nullable(),
        // ── end B-OP-021 ──
      }),
    ),
  }),
  /** A live work order of its lines is on hold. */
  held: z.boolean(),
  /** What holds its work, in plain words (a hold of a work order that also makes other work reads its reason's words only). */
  holds: z.array(output({ kind: z.enum(['QUALITY', 'PRODUCTION', 'BRAND']), words, since: businessDate() })),
  /** Office only, with workorders.view: the notes of the plain holds on the work orders this reader reaches (else null). */
  holdNotes: z.array(output({ workOrderId: id(), number: z.string(), kind: z.string(), note: z.string(), since: instant() })).nullable(),
  promise: output({
    date: businessDate().nullable(),
    first: businessDate().nullable(),
    moved: z.boolean(),
    /** How many times it was changed (its audit rows). */
    moves: z.number().int(),
    /** Days the promise moved since the first one (later: positive). */
    slipDays: z.number().int().nullable(),
  }),
  urgency: output({
    /** The customer's own mark (counted only while its urgency switch is on); null: none. */
    customer: output({ code: z.enum(BRAND_URGENCIES), urgentRank: z.number().int().nullable(), words }).nullable(),
    /** A live work order of its lines is a factory rush ("Urgent"). */
    factoryRush: z.boolean(),
    officePriority: output({ level: z.enum(SALES_ORDER_PRIORITY_LEVELS), words, reason: z.string().nullable() }),
  }),
})

const sizeView = output({
  size: z.string().nullable(),
  ...pieces,
  /** B-SA-043 (office only): pieces cut of the order's own cells beyond what the size now wants ("Made extra: 4 M"); 0: none. */
  madeExtra: z.number().int(),
  madeExtraWords: words.nullable(),
})

export const lineView = output({
  lineId: id(),
  seq: z.number().int(),
  kind: z.string(),
  style: named.nullable(),
  colourway: named.nullable(),
  ...pieces,
  /** Pieces of the line in live work orders (its own cells). */
  inWorkOrders: z.number().int(),
  /** No live work order makes the line yet. */
  notInWorkOrders: z.boolean(),
  sizes: z.array(sizeView),
  /** B-SA-043 (office only): the line's extra pieces, all sizes together (a change lowered it after cutting). */
  madeExtra: z.number().int(),
})

const ownShare = output({ cells: z.number().int(), pieces: z.number().int(), cut: z.number().int().nullable(), sewn: z.number().int().nullable(), checked: z.number().int().nullable() })

export const workView = output({
  workOrders: z.array(
    output({
      id: id(),
      number: z.string(),
      status: z.string(),
      held: z.boolean(),
      /** A factory rush ("Urgent"). */
      rush: z.boolean(),
      style: named.nullable(),
      colourways: z.array(named),
      site: named.nullable(),
      line: named.nullable(),
      /** The outside workshops its operations are at now (office only: never told to the customer). */
      workshops: z.array(output({ name: z.string() })),
      /** What it makes for THIS order (its cells of this order's lines). */
      own: ownShare,
      /** Other orders of this order's customer it also makes, that the reader reaches; `more`: this customer's others, counted. */
      alsoMakes: output({ orders: z.array(output({ id: id(), number: z.string() })), more: z.number().int() }),
      /** It also makes work of other customers (a work order made before the one-customer rule): "made together with other work". */
      sharedWithOtherCustomers: z.boolean(),
      /** One of its cells of this order is on a cut order that also cuts other work: "cut together with other work" (no other id, no count). */
      cutWithOtherWork: z.boolean(),
      due: businessDate().nullable(),
      daysLate: z.number().int().nullable(),
      // ── B-OP-021 (13-backend §3 B6; review R-11): what the order page acts on in place ──
      /** Its version (every write sends it), kind, release and priority. */
      version: z.number().int(),
      kind: z.string(),
      releasedAt: instant().nullable(),
      priority: z.number().int(),
      /** Its cells of THIS order's lines only (never another order's or another customer's), each with its pieces cut (null: none counted). */
      cells: z.array(output({ id: id(), salesOrderLineId: id(), size: z.string(), quantity: z.number().int(), cut: z.number().int().nullable() })),
      /**
       * What the reader may do to it from here, by its own rights over the work order (can(): its company, site and customer). One
       * shared with other customers (`sharedWithOtherCustomers`, made before the one-customer rule) is changed on its own page only:
       * every right false, with the words.
       */
      rights: output({ manage: z.boolean(), release: z.boolean(), hold: z.boolean(), why: words.nullable() }),
      // ── end B-OP-021 ──
    }),
  ),
  /** Made to measure: one work order per unit, grouped per style × colourway (one row, never twelve). */
  mtm: z.array(
    output({
      style: named.nullable(),
      colourway: named.nullable(),
      units: z.number().int(),
      workOrders: z.number().int(),
      byStatus: z.array(output({ status: z.string(), count: z.number().int() })),
      own: ownShare,
    }),
  ),
  /** Live work orders of the order's lines the reader does not reach: counted, never named ("1 work order not shown"). */
  workOrdersLeftOut: z.number().int(),
  /** Goods lines no live work order makes yet, and their pieces. */
  notInProduction: output({ lines: z.number().int(), pieces: z.number().int() }),
})

const gateRow = output({
  id: id(),
  kind: z.enum(GATE_KINDS),
  label: z.string().nullable(),
  targetDate: businessDate().nullable(),
  sampleRound: output({ id: id(), number: z.string(), kind: z.string(), decision: z.string().nullable() }).nullable(),
  owner: output({ id: id(), name: z.string() }).nullable(),
  state: z.enum(GATE_STATES),
  passedOn: businessDate().nullable(),
  via: z.enum(PASS_VIAS).nullable(),
  startedBefore: output({ at: instant(), by: output({ id: id(), name: z.string() }).nullable(), reason: z.string() }).nullable(),
  leather: z.enum(LEATHER_STATES).nullable(),
})

export const datesView = output({
  /** Its gates, read only (keeping them stays Planning's: no action here). */
  gates: z.array(gateRow),
  milestones: z.array(
    output({
      id: z.string(),
      kind: z.enum(MILESTONE_KINDS),
      gateId: id().nullable(),
      gateKind: z.enum(GATE_KINDS).nullable(),
      label: z.string().nullable(),
      target: businessDate().nullable(),
      actual: businessDate().nullable(),
      state: z.enum(MILESTONE_STATES),
      late: z.number().int().nullable(),
      owner: output({ id: id(), name: z.string() }).nullable(),
    }),
  ),
  late: z.number().int(),
  next: z.string().nullable(),
  /** The cut, sewing and finish days of its own work in the PUBLISHED plan (what the customer is told). */
  planned: output({ cutStart: businessDate().nullable(), sewStart: businessDate().nullable(), finish: businessDate().nullable() }),
  /** Per open line, the day the plan says it is ready (planning.promise.view; else null and `dates.forecast` withheld). */
  forecast: z
    .array(
      output({
        lineId: id(),
        seq: z.number().int(),
        finish: businessDate().nullable(),
        risk: z.string().nullable(),
        slackDays: z.number().int().nullable(),
        // F-SA-234b: what sets the day (the board, a work order's due day, a planned order, …): the order page's by-line forecast says it.
        source: z.enum(FINISH_SOURCES),
        sizes: z.array(output({ size: z.string().nullable(), finish: businessDate().nullable(), risk: z.string().nullable() })),
      }),
    )
    .nullable(),
})

export const qualityView = output({
  /** Its open problems (on the order, or on its work orders), workorders.view; null: withheld. */
  issues: z.array(output({ id: id(), source: z.string(), recordType: z.string(), since: instant(), dueOn: businessDate(), escalation: z.number().int() })).nullable(),
  /** Its open NCRs behind the brand wall, quality.ncr.view; null: withheld. */
  ncrs: z.array(output({ id: id(), number: z.string(), stage: z.string(), severity: z.string(), sharedWorkOrder: z.boolean() })).nullable(),
  /** The final inspections of the work orders the reader reaches, quality.inspections.view; null: withheld. */
  final: z.array(output({ workOrderId: id(), number: z.string().nullable(), status: z.string(), sampleSize: z.number().int(), on: businessDate().nullable() })).nullable(),
})

export const peopleView = output({
  supervisor: output({ id: id(), name: z.string(), active: z.boolean(), from: z.enum(['ORDER', 'BRAND']), me: z.boolean() }).nullable(),
  /** The customer's backup (an order has none of its own). */
  backup: person.nullable(),
  /** "Answers the customer": the owner of the order's thread (no other sales owner is kept). */
  answersCustomer: person.nullable(),
  /** Where it is made: a site and line (a team by name only), or an outside workshop — never an operator, a count or an output. */
  places: z.array(output({ site: named.nullable(), line: named.nullable(), team: named.nullable(), workshop: output({ name: z.string() }).nullable() })),
})

export const changesView = output({
  /** The customer's requests still waiting (open, or countered and waiting on the customer). */
  openRequests: z.array(output({ id: id(), kind: z.string(), status: z.string(), since: instant(), batchId: id().nullable() })),
  /**
   * B-SA-050 (R1, P6; review C-8): what is still to do after the accepted changes, computed from the records — each row names the
   * record that closes it (a work order the reader does not reach: no door, counted in `workOrdersLeftOut`).
   */
  stillToDo: output({
    rows: z.array(
      output({
        kind: z.enum(STILL_KINDS),
        /** B-OP-021: + the record's version, for the act done in place (null: a record with none — an amendment, a re-promise). */
        ref: output({ type: z.string(), id: id(), number: z.string().nullable(), version: z.number().int().nullable() }).nullable(),
        words,
        since: instant(),
        waitingOn: z.enum(APPLY_TEAMS),
        mayAct: z.boolean(),
        requestId: id().nullable(),
      }),
    ),
    count: z.number().int(),
    workOrdersLeftOut: z.number().int(),
  }),
})

export const productionAnswer = output({
  order: output({ id: id(), number: z.string(), status: z.string(), version: z.number().int() }),
  asOf: instant(),
  refreshSeconds: z.number().int(),
  /** The parts asked (in their order). */
  parts: z.array(z.enum(PRODUCTION_PARTS)),
  withheld: z.array(z.enum(WITHHELD_KEYS)),
  headline: headlineView.optional(),
  lines: z.array(lineView).optional(),
  work: workView.nullable().optional(),
  dates: datesView.optional(),
  quality: qualityView.optional(),
  people: peopleView.nullable().optional(),
  changes: changesView.optional(),
})

const orderParams = input({ orderId: id() })

export const orderProductionContract = defineContract({
  params: orderParams,
  querystring: input({
    /** The parts to read, comma-separated (a live re-read names only what an event touched); none: every part. */
    parts: z.string().trim().min(1).max(200).optional(),
  }),
  response: { 200: productionAnswer },
})

export const orderMilestonesContract = defineContract({
  params: orderParams,
  response: {
    200: output({
      order: output({ id: id(), number: z.string(), status: z.string(), version: z.number().int() }),
      asOf: instant(),
      withheld: z.array(z.enum(WITHHELD_KEYS)),
      dates: datesView,
    }),
  },
})
