import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { BRAND_HEALTHS, HEALTH_REASON_CODES } from '@nexus/factory-domain/production-brand/health'
import { BRAND_STAGES } from '@nexus/factory-domain/production-brand/stages'
import { HAND_STAGES, STAGE_SET_REASON_CODES } from '@nexus/factory-domain/production-brand/stage-set' // B-MS-006
import { BRAND_URGENCIES } from '@nexus/factory-domain/production-brand/urgency'
import { BLOCKER_KINDS, BLOCKER_SUBS, WAITING_ON } from '@nexus/factory-domain/production-brand/waiting' // B-OP-021: + BLOCKER_SUBS
import { SALES_ORDER_PRIORITY_LEVELS } from '@nexus/factory-domain/sales/orders-depth/rules'
import { GATE_KINDS, GATE_STATES, LEATHER_STATES, MILESTONE_KINDS, MILESTONE_STATES, PASS_VIAS } from '@nexus/factory-domain/planning/milestones/rules'
import { FINISH_SOURCES } from '@nexus/factory-domain/planning/promise-keep/risk' // F-SA-234b
import { gateView as planningGateView } from '../../planning/milestones/contract' // B-OO-010: a gate's version and actions, Planning's own shape
import { orderView as planningOrderView } from '../../planning/milestones/contract' // B-PT-006: mayAddGate and waiting, Planning's own shapes
import { PRODUCTION_SHARE_LEVELS } from '@nexus/factory-domain/production-brand/levels' // B-PT-005
// B-SA-050: Still to do (its kinds; who it waits on: the apply plan's teams).
import { APPLY_TEAMS, STILL_KINDS } from '@nexus/factory-domain/sales/change-requests/apply-plan'
// B-OO-008: where "Answers the customer" comes from — the threads' own owner chain.
import { OWNER_SOURCES } from '../../../platform/threads/owner'
// B-PT-001: a work order's risk, the Production list's own shape (one rule for both screens).
import { riskFacts } from '../../production/work-orders/contract'
// B-PT-004: the spec a work order is made to (the domain's states, revision statuses and change-order dispositions).
import { DISPOSITIONS, NEWER_SPEC_STATES } from '@nexus/factory-domain/product/versions/drift'
import { REVISION_STATUSES } from '@nexus/factory-domain/product/styles/revisions'
// B-OC-004: what a portal task asks (its kind).
import { PARTNER_TASK_KINDS } from '@nexus/factory-domain/portal/tasks/kinds'

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
// B-PT-018 (order production tab): `quality.issues` is gone — the page reads the order's issues from the ONE issues list
// (GET /production/issues?salesOrderId=, orders.view), never a second copy here.
export const WITHHELD_KEYS = ['work', 'people', 'headline.notes', 'quality.ncrs', 'quality.final', 'dates.forecast'] as const
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
    // ── B-MS-006 (set the stage by hand; R9) ──
    /**
     * The stage set by hand while it stands (office only; the customer never reads any of it): the stage and why, the floor's own
     * stage from the live facts (null: no goods line open), when; the office's note and who set it only with workorders.view (else
     * null and `headline.notes` withheld). null: none stands.
     */
    byHand: output({
      stage: z.enum(HAND_STAGES),
      reasonCode: z.enum(STAGE_SET_REASON_CODES),
      floor: output({ code: z.enum(BRAND_STAGES), words }).nullable(),
      /**
       * B-SC-004 (stage control B): the floor's stage when it was set or changed (null: not known). Set back (below it), the
       * stage clears by itself when the floor's counts come back to it or pass this one (the keeper's end rule E1).
       */
      floorAtSet: z.enum(BRAND_STAGES).nullable(),
      at: instant(),
      note: z.string().nullable(),
      by: person.nullable(),
      /**
       * B-MS-008 (ms-fx1; Z01 note 2): the customer's notice of that stage, from the keeper's markers — `told`, or `waitsUntil`: a
       * notice by hand still inside its 10-minute window goes then (a Clear before it leaves it untold); neither: never told (a
       * Change going down). null: not read. Office only, like the rest.
       */
      notice: output({ told: z.boolean(), waitsUntil: instant().nullable() }).nullable(),
    }).nullable(),
    /** The production state's version: a set, change or clear by hand sends it back; null: no production state yet (a set sends null). */
    version: z.number().int().nullable(),
    // ── end B-MS-006 ──
  }).nullable(),
  /** What is in work now, as counts only: the order's ACTIVE bundles and its pieces between the steps (never a person). */
  inWork: output({
    bundles: z.number().int(),
    pieces: output({ cutting: z.number().int(), sewing: z.number().int().nullable(), checking: z.number().int().nullable(), packing: z.number().int().nullable() }),
  }),
  /**
   * The order's health as the keeper keeps it (null: no state kept yet: the order read's daysLate says "Late" then).
   * B-OO-007 (F11): null too once production is over (shipped, delivered, closed, cancelled: the domain's officeStripStateOf is
   * ALL_DONE or STOPPED) — nothing is "now" then.
   */
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
    /**
     * B-PT-007 (order production tab R7): the production state's version — Mark at risk… and Remove the mark send it back
     * (PUT | DELETE /production/brand-orders/:orderId/health) from this one read, with no second GET on the order page.
     */
    version: z.number().int(),
  }).nullable(),
  waiting: output({
    on: z.enum(WAITING_ON),
    words,
    since: instant().nullable(),
    /**
     * Each thing it waits for, in words (whose move it is: `on`). B-OO-007 (F11): once production is over only the requests stay (the
     * domain's placeOf REQUEST: a customer's open request or problem, a yes asked of it, a portal task); a hold or a date is moot, and
     * `on` / `since` are then the same rule (waitingOn) over what still waits.
     */
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
        // ── B-OC-004 (order changes tab R3b; 13-backend §2) ──
        /**
         * By when it is due: an approval we asked (its request's due time; an open counter-offer's, by the request it counters) or an
         * open portal task (its due time); null for every other kind, or none set. Never the question we asked, never an amount.
         * B-OC-002: a revised order asked of the customer is an APPROVAL naming its ApprovalRequest ("…: Revised order"); L11: a
         * revision the customer said no to is a REVISION_REFUSED waiting on us, naming its SalesOrderAmendment (no due time).
         */
        due: instant().nullable(),
        /** An open portal task (PARTNER_TASK): what it asks — its kind and the label it was made with; null for every other kind. */
        task: output({ kind: z.enum(PARTNER_TASK_KINDS), label: z.string() }).nullable(),
        // ── end B-OC-004 ──
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
    /** How many times it moved (its audit rows; B-OO-007 N10b: less the one that set a first promise — that is not a move). */
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
      /**
       * The outside workshops its operations are at now (office only: never told to the customer). B-PT-001: + `since` the day its
       * first job still out there was issued, `expectedBack` the latest day a job there is due back (null: not given); a work order
       * shared with other customers keeps the names only (both null).
       */
      workshops: z.array(output({ name: z.string(), since: businessDate().nullable(), expectedBack: businessDate().nullable() })),
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
      /**
       * Its cells of THIS order's lines only (never another order's or another customer's), each with its pieces cut (null: none
       * counted). B-PT-002: + sewn and checked, from the same counts (null: not counted there — never a made-up 0).
       */
      cells: z.array(output({ id: id(), salesOrderLineId: id(), size: z.string(), quantity: z.number().int(), cut: z.number().int().nullable(), sewn: z.number().int().nullable(), checked: z.number().int().nullable() })),
      /**
       * What the reader may do to it from here, by its own rights over the work order (can(): its company, site and customer). One
       * shared with other customers (`sharedWithOtherCustomers`, made before the one-customer rule) is changed on its own page only:
       * every right false, with the words.
       */
      rights: output({ manage: z.boolean(), release: z.boolean(), hold: z.boolean(), why: words.nullable() }),
      // ── end B-OP-021 ──
      // ── B-PT-001 (order production tab R1): its risk, the Production list's own rule (production/work-orders/risk riskFactsOf) ──
      /**
       * LATE, AT_RISK (its bars on the site's WORKING plan end after its due: `planAfterDue`, `plannedEnd`; or a standing raise),
       * BLOCKED (`blockedBy`: on hold, the customer, material) or ON_TRACK — what the Production list says of the same work order.
       * null: finished, or shared with other customers (its waiting merges other customers' orders). A board drag emits nothing to
       * this page: the row is as of the read.
       */
      risk: riskFacts.nullable(),
      // ── end B-PT-001 ──
      // ── B-PT-004 (order production tab R4): the spec it is made to ──
      /**
       * Its revision (null: none chosen yet), the state by the domain's rule (CURRENT, NEWER_RELEASED, WITHDRAWN, NOT_RELEASED,
       * NO_REVISION — the screen says it in its own words; never the rule's English message), the newer released revision and its
       * day (NEWER_RELEASED only), and what a change order decided for it (NEWER_RELEASED only; null: not decided). null: shared with
       * other customers. "What changed" opens the existing compare (product.bom.view), never a diff here.
       */
      spec: output({
        revision: output({ revision: z.number().int(), status: z.enum(REVISION_STATUSES) }).nullable(),
        state: z.enum(NEWER_SPEC_STATES),
        newer: output({ revision: z.number().int(), releasedOn: businessDate().nullable() }).nullable(),
        decision: output({ disposition: z.enum(DISPOSITIONS), changeOrder: z.string() }).nullable(),
      }).nullable(),
      // ── end B-PT-004 ──
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
      // ── B-PT-003 (order production tab R3): its units by number (at most MTM_UNITS_LIMIT, number order), the rest counted ──
      /**
       * Each unit's work order and the seq of the line its first own cell makes (null: none). Never the rider (the order read's).
       * Named `unitList` (13-backend said `units`): `units` above is already the row's count and the web reads it as one.
       */
      unitList: z.array(output({ id: id(), number: z.string(), status: z.string(), lineSeq: z.number().int().nullable() })),
      unitsMore: z.number().int(),
      // ── end B-PT-003 ──
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
  // ── B-OO-010 (order overview N9; 13-backend §8) ──
  /** Its version: Planning's writes send it (POST /planning/milestones/gates/pass, PATCH …/gates/:gateId, POST …/gates/:gateId/remove, POST …/gates/:gateId/start-before). */
  version: planningGateView.shape.version,
  /**
   * What THIS reader may do to it, as Planning's own read says (readWorld: its rights over the order's company and customer, and the
   * gate's own refusals): pass, start before, edit, remove — each allowed, or refused in words with its code, or the permission it needs.
   */
  actions: planningGateView.shape.actions,
  // ── end B-OO-010 ──
  // ── B-PT-006 (order production tab R6): what Planning's own dialogs need, Planning's own shapes (readWorld built them) ──
  /** This order's production work orders not started that the waiting gate holds on the board (never a sample or a repair). */
  holds: planningGateView.shape.holds,
  passedAt: planningGateView.shape.passedAt,
  /** The office person who marked it done (null when its event passed it: `via` says which). */
  passedBy: planningGateView.shape.passedBy,
  /** Its planner and maker: who may not start before it (Planning's rule). */
  ownerId: planningGateView.shape.ownerId,
  makerId: planningGateView.shape.makerId,
  // ── end B-PT-006 ──
})

export const datesView = output({
  /** Its gates (B-OO-010: each with its version and what this reader may do; the writes stay Planning's routes). */
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
  // ── B-PT-005 (order production tab R5): what this order's customer is shown (PortalSettings.productionLevel; no row: STATUS) ──
  /** STATUS · PROGRESS · GATES (+ its gates and the published plan's days) · QUALITY (+ the quality of its own work). Office only. */
  customer: output({ level: z.enum(PRODUCTION_SHARE_LEVELS) }),
  // ── end B-PT-005 ──
  // ── B-PT-006 (R6): Planning's own order fields, as readWorld built them for THIS reader ──
  /** The reader may add a gate to this order (planning.milestones.manage over it, the order not closed), else the right or the refusal. */
  mayAddGate: planningOrderView.shape.mayAddGate,
  /** The kinds of its gates that wait (the order cannot go on the planning board while one does). */
  waiting: planningOrderView.shape.waiting,
  // ── end B-PT-006 ──
})

export const qualityView = output({
  /** Its open NCRs behind the brand wall, quality.ncr.view; null: withheld. */
  // B-PT-009 (order production tab R9): + its title (at most NCR_TITLE_LIMIT characters, cut with "…"); never its description, cost
  // or who found it. Severity and stage words are the web's quality catalogue.
  ncrs: z.array(output({ id: id(), number: z.string(), stage: z.string(), severity: z.string(), sharedWorkOrder: z.boolean(), title: z.string() })).nullable(),
  /**
   * The final inspections of the work orders the reader reaches, quality.inspections.view; null: withheld. B-PT-008 (R8): + its id
   * (the row's key: a failed and a re-inspected one of one work order are two rows), the lot, the units inspected so far (null: not
   * counted), the garments with a defect per class (null while OPEN) and whether its work order is shared with other customers.
   * Never the inspector.
   */
  final: z
    .array(
      output({
        workOrderId: id(),
        number: z.string().nullable(),
        status: z.string(),
        sampleSize: z.number().int(),
        on: businessDate().nullable(),
        // ── B-PT-008 ──
        id: id(),
        lotSize: z.number().int(),
        inspectedCount: z.number().int().nullable(),
        defects: output({ critical: z.number().int(), major: z.number().int(), minor: z.number().int() }).nullable(),
        sharedWorkOrder: z.boolean(),
        // ── end B-PT-008 ──
      }),
    )
    .nullable(),
})

// ── B-OO-008 (order overview N8): what a place is — our own plant (a site and its line) or an outside workshop ──
export const PLACE_KINDS = ['PLANT', 'WORKSHOP'] as const
export type PlaceKind = (typeof PLACE_KINDS)[number]

export const peopleView = output({
  supervisor: output({ id: id(), name: z.string(), active: z.boolean(), from: z.enum(['ORDER', 'BRAND']), me: z.boolean() }).nullable(),
  /** The customer's backup (an order has none of its own). */
  backup: person.nullable(),
  /**
   * B-OO-008 (N7): "Answers the customer" — the conversation's owner by the threads' ONE chain (platform/threads/owner.ts) and where
   * it comes from: the thread's own owner (SET), else the order's production supervisor (SUPERVISOR), else the order's maker (MAKER).
   * Null: nobody (a portal-made order with no supervisor). Office only: the portal's thread answers never name the owner (W08).
   */
  answersCustomer: person.extend({ source: z.enum(OWNER_SOURCES) }).nullable(),
  /**
   * Where it is made, from its LIVE work orders only (B-OO-008: a cancelled or closed one names no place): our plant (`kind`
   * PLANT: a site and line, a team by name only) or an outside workshop (WORKSHOP: its name, and `since` the day its first job
   * still out there was issued) — never an operator, a count or an output.
   */
  places: z.array(
    output({ kind: z.enum(PLACE_KINDS), site: named.nullable(), line: named.nullable(), team: named.nullable(), workshop: output({ name: z.string() }).nullable(), since: businessDate().nullable() }),
  ),
})
// ── end B-OO-008 ──

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
        /** B-OC-005: a production task (WORK_IN_PROGRESS_TASK): its assignee, or workorders.manage over its work order. */
        mayAct: z.boolean(),
        requestId: id().nullable(),
        // ── B-OC-006 / B-OC-007 (order changes tab R4b, R4c; 13-backend §3) ──
        /** The order's revision the row comes from (a work-order change and its extra pieces: the change's amendment); null: none. */
        amendmentId: id().nullable(),
        /** That revision's number ("Office change, revision 3"); null with `amendmentId`. */
        revision: z.number().int().nullable(),
        /** TELL_WORKSHOP: the PROPOSED work-order change of the same request on the same work order (told by itself when applied); else null. */
        waitsOn: id().nullable(),
        // ── end B-OC-006 / B-OC-007 ──
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
