import { z } from 'zod'
import type { ApiClient } from '../../../../../lib/api/client'
import { FINISH_SOURCES } from '../../depth/api' // F-SA-234b
import { GATE_REFUSALS } from '@nexus/factory-domain/planning/milestones/rules' // F-OO-208: a gate's refusal codes, as Planning reads them
import { BLOCKED_BY, WORK_ORDER_RISKS } from '../../../../production/_shared/api' // F-PT-104: the Production list's risk words
import { PRODUCTION_SHARE_LEVELS } from '@nexus/factory-domain/production-brand/levels' // F-PT-201: what the customer is shown

/**
 * F-SA-232 (sales page plan N2; 10-order-page §3 OR1, OR2) — the order page's reads of production, the office twin of the portal's
 * production read (B-SA-031 / B-SA-032, `apps/factory-api/src/modules/sales/orders/production-contract.ts`):
 *
 *   GET /sales/orders/:orderId/production?parts=headline,lines,work,dates,quality,people,changes   orders.view (each part by its right)
 *   GET /sales/orders/:orderId/milestones                                                          the `dates` part alone
 *
 * Every piece counted is the ORDER'S OWN (its lines' cells); a work order that also makes other work lends nothing of another
 * customer. A part the reader may not read is null and named in `withheld` (never an empty part that looks like "none"). The API's
 * `words` are read for what they say in the page's language (the domain's own words, it + en); never a code shown raw.
 */

const words = z.object({ it: z.string(), en: z.string() })
export type Words = z.infer<typeof words>
const named = z.object({ code: z.string(), name: z.string() })
const person = z.object({ id: z.string(), name: z.string(), active: z.boolean() })
const day = z.string()
const instant = z.string()

export const PRODUCTION_PARTS = ['headline', 'lines', 'work', 'dates', 'quality', 'people', 'changes'] as const
export type ProductionPart = (typeof PRODUCTION_PARTS)[number]
export const BRAND_STAGES = ['PREPARING', 'CUTTING', 'SEWING', 'QUALITY', 'READY'] as const
export type BrandStage = (typeof BRAND_STAGES)[number]
export const BRAND_HEALTHS = ['LATE', 'AT_RISK', 'NO_DATE', 'ON_TRACK'] as const
export type BrandHealth = (typeof BRAND_HEALTHS)[number]
export const WAITING_ON = ['BRAND', 'SUPPLIER', 'WORKSHOP', 'US'] as const
export type WaitingOn = (typeof WAITING_ON)[number]
/** F-OP-103 (B-OP-021): what a customer request waiting on us is (the domain's BLOCKER_SUBS). */
export const BLOCKER_SUBS = ['REQUEST', 'COUNTER', 'PROBLEM', 'REPROMISE'] as const
export type BlockerSub = (typeof BLOCKER_SUBS)[number]
// ---- F-OO-208 (B-OO-008): where "Answers the customer" comes from (the thread owner's chain, the API's platform/threads/owner.ts
// OWNER_SOURCES: set on the thread, the record's assignee, the order's supervisor, its maker), and what a place is ----
export const OWNER_SOURCES = ['SET', 'ASSIGNEE', 'SUPERVISOR', 'MAKER'] as const
export type OwnerSource = (typeof OWNER_SOURCES)[number]
export const PLACE_KINDS = ['PLANT', 'WORKSHOP'] as const
export type PlaceKind = (typeof PLACE_KINDS)[number]
// ---- end F-OO-208

const pieces = {
  ordered: z.number(),
  cut: z.number().nullable(),
  sewn: z.number().nullable(),
  checked: z.number().nullable(),
  packed: z.number().nullable(),
  shipped: z.number(),
}

export const headlineSchema = z.object({
  stage: z
    .object({
      code: z.enum(BRAND_STAGES),
      words,
      since: day.nullable(),
      ahead: z.number(),
      aheadWords: words.nullable(),
      sewingNotCounted: z.boolean(),
      sewingNotCountedWords: words.nullable(),
      next: z.object({ code: z.enum(BRAND_STAGES), words }).nullable(),
      partlyShipped: z.boolean(),
      // ---- F-MS-101 (set the stage by hand; B-MS-006's shape, R9, R17): the stage set by hand while it stands — which, why (a reason
      // code: office only), the floor's own stage read live, when, the office's note and who (both null without workorders.view) —
      // and the production row's version (every set, change and clear sends it; null: no row yet, the set makes it). Optional: an
      // older answer without them offers the set as before B-MS-006 (no hand stage, version null).
      byHand: z
        .object({
          stage: z.enum(BRAND_STAGES),
          reasonCode: z.string(),
          floor: z.object({ code: z.enum(BRAND_STAGES), words }).nullable(),
          at: instant,
          note: z.string().nullable(),
          by: z.object({ id: z.string(), name: z.string(), active: z.boolean().optional() }).nullable(),
          // B-MS-008 (ms-fx1; Z01 note 2): the customer's notice of that stage, from the keeper's markers (B-MS-006's read) — told, or
          // when a notice by hand still inside its window goes (`waitsUntil`), or neither (never told: a Change going down). null /
          // absent: not read — Clear… then says nothing of it rather than guess from the set's time.
          notice: z.object({ told: z.boolean(), waitsUntil: instant.nullable() }).nullable().optional(),
          // F-SC-W1 (stage control B, 40-stage-plan §2): the floor's stage when the hand stage was set or changed (office only) — a set
          // below it is a correction and stands until the floor's counts come back to it or pass this one. Optional: an older answer
          // without it judges against the floor now.
          floorAtSet: z.enum(BRAND_STAGES).nullable().optional(),
        })
        .nullable()
        .optional(),
      version: z.number().nullable().optional(),
      // ---- end F-MS-101
    })
    .nullable(),
  inWork: z.object({ bundles: z.number(), pieces: z.object({ cutting: z.number(), sewing: z.number().nullable(), checking: z.number().nullable(), packing: z.number().nullable() }) }),
  health: z
    .object({
      code: z.enum(BRAND_HEALTHS),
      words,
      computed: z.enum(BRAND_HEALTHS).nullable(),
      raise: z.object({ reasonCode: z.string(), words, until: day, note: z.string().nullable(), by: person.nullable(), at: instant.nullable() }).nullable(),
      // F-PT-404 (B-PT-007; optional in an older answer): the production state's version — the mark's writes send it from this read.
      version: z.number().int().optional(),
    })
    .nullable(),
  waiting: z.object({
    on: z.enum(WAITING_ON),
    words,
    since: instant.nullable(),
    // F-OP-103 (B-OP-021): + the record each is about (the ONE waiting list's door; a problem with its message) and what a request
    // waiting on us is; absent in an older answer.
    blockers: z.array(
      z.object({
        kind: z.string(),
        on: z.enum(WAITING_ON),
        words,
        since: instant.nullable(),
        ref: z.object({ type: z.string(), id: z.string(), messageId: z.string().optional() }).nullable().optional(),
        sub: z.enum(BLOCKER_SUBS).nullable().optional(),
        // F-OC-103 (B-OC-004): by when the customer answers (an approval, a portal task) and what a portal task asks — absent until the
        // server sends them: the row then says its kind only (no due day, no "late").
        due: instant.nullable().optional(),
        task: z.object({ kind: z.string(), label: z.string() }).nullable().optional(),
      }),
    ),
  }),
  held: z.boolean(),
  holds: z.array(z.object({ kind: z.enum(['QUALITY', 'PRODUCTION', 'BRAND']), words, since: day })),
  holdNotes: z.array(z.object({ workOrderId: z.string(), number: z.string(), kind: z.string(), note: z.string(), since: instant })).nullable(),
  promise: z.object({ date: day.nullable(), first: day.nullable(), moved: z.boolean(), moves: z.number(), slipDays: z.number().nullable() }),
  urgency: z.object({
    customer: z.object({ code: z.enum(['URGENT', 'REGULAR']), urgentRank: z.number().nullable(), words }).nullable(),
    factoryRush: z.boolean(),
    officePriority: z.object({ level: z.string(), words, reason: z.string().nullable() }),
  }),
})
export type Headline = z.infer<typeof headlineSchema>

const sizeSchema = z.object({ size: z.string().nullable(), ...pieces, madeExtra: z.number().default(0), madeExtraWords: words.nullable().default(null) })
export const productionLineSchema = z.object({
  lineId: z.string(),
  seq: z.number(),
  kind: z.string(),
  style: named.nullable(),
  colourway: named.nullable(),
  ...pieces,
  inWorkOrders: z.number(),
  notInWorkOrders: z.boolean(),
  sizes: z.array(sizeSchema),
  madeExtra: z.number().default(0),
})
export type ProductionLine = z.infer<typeof productionLineSchema>

// ---- F-PT-104 / F-PT-105: the shapes the server's S1 adds (B-PT-001, B-PT-003), each read only when it is there ----
const workOrderRisk = z.object({ state: z.enum(WORK_ORDER_RISKS), daysLate: z.number().nullable(), plannedEnd: day.nullable(), planAfterDue: z.boolean(), raised: z.string().nullable(), blockedBy: z.enum(BLOCKED_BY).nullable() })
export type WorkOrderRiskRead = z.infer<typeof workOrderRisk>
const mtmUnit = z.object({ id: z.string(), number: z.string(), status: z.string(), lineSeq: z.number().nullable() })
export type MtmUnitRead = z.infer<typeof mtmUnit>
// ---- end F-PT-104 / F-PT-105
const ownShare = z.object({ cells: z.number(), pieces: z.number(), cut: z.number().nullable(), sewn: z.number().nullable(), checked: z.number().nullable() })
export const workSchema = z.object({
  workOrders: z.array(
    z.object({
      id: z.string(),
      number: z.string(),
      status: z.string(),
      held: z.boolean(),
      rush: z.boolean(),
      style: named.nullable(),
      colourways: z.array(named),
      site: named.nullable(),
      line: named.nullable(),
      // F-PT-104 (B-PT-001, optional until S1): + an outside workshop's issue day and the day it is expected back.
      workshops: z.array(z.object({ name: z.string(), since: day.nullable().optional(), expectedBack: day.nullable().optional() })),
      own: ownShare,
      alsoMakes: z.object({ orders: z.array(z.object({ id: z.string(), number: z.string() })), more: z.number() }),
      sharedWithOtherCustomers: z.boolean(),
      cutWithOtherWork: z.boolean(),
      due: day.nullable(),
      daysLate: z.number().nullable(),
      // ---- F-OP-113 (B-OP-021, B6; review R-11): what the row acts on in place — its version (every write sends it), kind,
      // release and priority, its cells of THIS order's lines, and the reader's rights over it (a shared one: none, with the words).
      // Optional: an older read without them offers nothing in place.
      version: z.number().optional(),
      kind: z.string().optional(),
      releasedAt: z.string().nullable().optional(),
      priority: z.number().optional(),
      // F-PT-105 (B-PT-002, optional until S1): + sewn and checked per cell (null: not counted there — never a made-up 0).
      cells: z.array(z.object({ id: z.string(), salesOrderLineId: z.string(), size: z.string(), quantity: z.number(), cut: z.number().nullable(), sewn: z.number().nullable().optional(), checked: z.number().nullable().optional() })).optional(),
      rights: z.object({ manage: z.boolean(), release: z.boolean(), hold: z.boolean(), why: words.nullable() }).optional(),
      // ---- end F-OP-113
      // ---- F-PT-104 (B-PT-001; optional until the server's S1 lands — absent: hidden, never a made-up 0): the row's risk, the
      // Production list's own facts (null: finished, or shared with other customers).
      risk: workOrderRisk.nullable().optional(),
      // ---- end F-PT-104
      // ---- F-PT-401 (B-PT-004; optional in an older answer): the pattern this work order is made to, whether a newer one is in force
      // and the change order's decision; null for a work order shared with other customers. Revision numbers only, never words.
      spec: z
        .object({
          revision: z.object({ revision: z.number().int(), status: z.string() }).nullable(),
          state: z.string(),
          newer: z.object({ revision: z.number().int(), releasedOn: day.nullable() }).nullable(),
          decision: z.object({ disposition: z.string(), changeOrder: z.string() }).nullable(),
        })
        .nullable()
        .optional(),
      // ---- end F-PT-401
    }),
  ),
  mtm: z.array(
    z.object({
      style: named.nullable(),
      colourway: named.nullable(),
      units: z.number(),
      workOrders: z.number(),
      byStatus: z.array(z.object({ status: z.string(), count: z.number() })),
      own: ownShare,
      // ---- F-PT-105 (B-PT-003; optional until S1): the group's units by number and state (never the rider), at most 50, and how many
      // more (`units` above stays the group's count).
      unitList: z.array(mtmUnit).optional(),
      unitsMore: z.number().optional(),
      // ---- end F-PT-105
    }),
  ),
  workOrdersLeftOut: z.number(),
  notInProduction: z.object({ lines: z.number(), pieces: z.number() }),
})
export type Work = z.infer<typeof workSchema>
export type WorkOrderOwn = Work['workOrders'][number]
export type MtmGroupRead = Work['mtm'][number]

// ---- F-OO-208 (B-OO-010): what THIS reader may do with a gate — each move allowed or refused in words with its code and the right it
// needs — exactly as Planning's own read builds it (api/planning/milestones/world.ts); the writes stay Planning's routes ----
const gateRefusal = z.object({ code: z.enum(GATE_REFUSALS), message: z.string() })
const gateAction = z.object({ allowed: z.boolean(), refusal: gateRefusal.nullable(), needs: z.string().nullable() })
export type GateAction = z.infer<typeof gateAction>
// ---- end F-OO-208
const gateRow = z.object({
  id: z.string(),
  kind: z.string(),
  label: z.string().nullable(),
  targetDate: day.nullable(),
  sampleRound: z.object({ id: z.string(), number: z.string(), kind: z.string(), decision: z.string().nullable() }).nullable(),
  owner: z.object({ id: z.string(), name: z.string() }).nullable(),
  state: z.string(),
  passedOn: day.nullable(),
  via: z.string().nullable(),
  startedBefore: z.object({ at: instant, by: z.object({ id: z.string(), name: z.string() }).nullable(), reason: z.string() }).nullable(),
  leather: z.string().nullable(),
  // F-OO-208 (B-OO-010): + the gate's version (every write sends it) and this reader's moves; absent in an older answer.
  version: z.number().optional(),
  actions: z.object({ pass: gateAction, startBefore: gateAction, edit: gateAction, remove: gateAction }).optional(),
  // ---- F-PT-202 (B-PT-006): what Planning's own dialogs read — the work orders it holds, who passed it and when, its planner and
  // maker (who may not start before it); optional: an older answer fills them as before ----
  holds: z.number().optional(),
  passedAt: instant.nullable().optional(),
  passedBy: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
  ownerId: z.string().nullable().optional(),
  makerId: z.string().nullable().optional(),
  // ---- end F-PT-202
})
export const datesSchema = z.object({
  gates: z.array(gateRow),
  milestones: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      gateId: z.string().nullable(),
      gateKind: z.string().nullable(),
      label: z.string().nullable(),
      target: day.nullable(),
      actual: day.nullable(),
      state: z.string(),
      late: z.number().nullable(),
      owner: z.object({ id: z.string(), name: z.string() }).nullable(),
    }),
  ),
  late: z.number(),
  next: z.string().nullable(),
  planned: z.object({ cutStart: day.nullable(), sewStart: day.nullable(), finish: day.nullable() }),
  forecast: z
    // F-SA-234b: + source (what sets the day): the by-line finish forecast on Production reads it from here.
    .array(z.object({ lineId: z.string(), seq: z.number(), finish: day.nullable(), risk: z.string().nullable(), slackDays: z.number().nullable(), source: z.enum(FINISH_SOURCES), sizes: z.array(z.object({ size: z.string().nullable(), finish: day.nullable(), risk: z.string().nullable() })) }))
    .nullable(),
  // ---- F-PT-201 / F-PT-202 (B-PT-005, B-PT-006; optional — absent: no "Customer sees" claim, no Add a gate…) ----
  /** What this order's customer is shown (STATUS · PROGRESS · GATES · QUALITY): the plan's days only from GATES on. */
  customer: z.object({ level: z.enum(PRODUCTION_SHARE_LEVELS) }).optional(),
  /** Planning's own: whether this reader may add a gate (the right it needs, or its refusal). */
  mayAddGate: z.object({ allowed: z.boolean(), needs: z.string().nullable(), refusal: gateRefusal.nullable() }).optional(),
  /** The kinds of its gates that wait. */
  waiting: z.array(z.string()).optional(),
  // ---- end F-PT-201 / F-PT-202
})
export type Dates = z.infer<typeof datesSchema>
export type Gate = Dates['gates'][number]
export type DateMilestone = Dates['milestones'][number]

export const qualitySchema = z.object({
  // B-PT-018: no issues block — the tab reads the order's issues from the ONE issues list (B-PT-010).
  // F-PT-302 (B-PT-009, optional): + the NCR's title (cut at 80 characters by the server).
  ncrs: z.array(z.object({ id: z.string(), number: z.string(), stage: z.string(), severity: z.string(), sharedWorkOrder: z.boolean(), title: z.string().optional() })).nullable(),
  // F-PT-302 (B-PT-008, optional): + the inspection's id (the row's key), lot, inspected so far, defects per class, shared work order.
  final: z
    .array(
      z.object({
        workOrderId: z.string(),
        number: z.string().nullable(),
        status: z.string(),
        sampleSize: z.number(),
        on: day.nullable(),
        id: z.string().optional(),
        lotSize: z.number().optional(),
        inspectedCount: z.number().nullable().optional(),
        defects: z.object({ critical: z.number(), major: z.number(), minor: z.number() }).nullable().optional(),
        sharedWorkOrder: z.boolean().optional(),
      }),
    )
    .nullable(),
})
export type Quality = z.infer<typeof qualitySchema>

export const peopleSchema = z.object({
  supervisor: z.object({ id: z.string(), name: z.string(), active: z.boolean(), from: z.enum(['ORDER', 'BRAND']), me: z.boolean() }).nullable(),
  backup: person.nullable(),
  // F-OO-208 (B-OO-008): + where the answerer comes from (the owner chain's step); absent in an older answer.
  answersCustomer: person.extend({ source: z.enum(OWNER_SOURCES).optional() }).nullable(),
  // F-OO-208 (B-OO-008): + a plant or an outside workshop, and a workshop's issued day (`since`); absent in an older answer.
  places: z.array(z.object({ site: named.nullable(), line: named.nullable(), team: named.nullable(), workshop: z.object({ name: z.string() }).nullable(), kind: z.enum(PLACE_KINDS).optional(), since: day.nullable().optional() })),
})
export type People = z.infer<typeof peopleSchema>

// F-SA-243 (B-SA-050): "Still to do" after the accepted changes, computed from the records — each row names the record that closes it.
const stillRowSchema = z.object({
  kind: z.string(),
  // F-OP-116 (B-OP-021): + the record's version (a production task's Done sends it).
  ref: z.object({ type: z.string(), id: z.string(), number: z.string().nullable(), version: z.number().nullable().optional() }).nullable(),
  words: z.object({ en: z.string(), it: z.string() }),
  since: instant,
  waitingOn: z.string(),
  mayAct: z.boolean(),
  requestId: z.string().nullable(),
})
export type StillRow = z.infer<typeof stillRowSchema>
export const changesSchema = z.object({
  openRequests: z.array(z.object({ id: z.string(), kind: z.string(), status: z.string(), since: instant, batchId: z.string().nullable() })),
  stillToDo: z.object({ rows: z.array(stillRowSchema), count: z.number(), workOrdersLeftOut: z.number() }).optional(),
})

// B-PT-018: `quality.issues` is gone from the read (the order's issues are the ONE issues list's, production/api listOrderIssues).
export const WITHHELD_KEYS = ['work', 'people', 'headline.notes', 'quality.ncrs', 'quality.final', 'dates.forecast'] as const
export type WithheldKey = (typeof WITHHELD_KEYS)[number]

export const productionSchema = z.object({
  order: z.object({ id: z.string(), number: z.string(), status: z.string(), version: z.number() }),
  asOf: instant,
  refreshSeconds: z.number(),
  parts: z.array(z.enum(PRODUCTION_PARTS)),
  withheld: z.array(z.string()),
  headline: headlineSchema.optional(),
  lines: z.array(productionLineSchema).optional(),
  work: workSchema.nullable().optional(),
  dates: datesSchema.optional(),
  quality: qualitySchema.optional(),
  people: peopleSchema.nullable().optional(),
  changes: changesSchema.optional(),
})
export type OrderProduction = z.infer<typeof productionSchema>

const seg = (value: string) => encodeURIComponent(value)

/** GET /sales/orders/:orderId/production — the parts asked (none: every part); a live re-read names only what an event touched. */
export function getOrderProduction(api: ApiClient, orderId: string, parts?: readonly ProductionPart[], signal?: AbortSignal): Promise<OrderProduction> {
  return api.get(`/sales/orders/${seg(orderId)}/production`, { query: parts && parts.length > 0 ? { parts: parts.join(',') } : undefined, schema: productionSchema, signal })
}

export const milestonesSchema = z.object({ order: z.object({ id: z.string(), number: z.string(), status: z.string(), version: z.number() }), asOf: instant, withheld: z.array(z.string()), dates: datesSchema })
export type OrderMilestones = z.infer<typeof milestonesSchema>

/** GET /sales/orders/:orderId/milestones — the order's own dates under orders.view (P16: not Planning's right). */
export function getOrderMilestones(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<OrderMilestones> {
  return api.get(`/sales/orders/${seg(orderId)}/milestones`, { schema: milestonesSchema, signal })
}

// ---- F-MS-103 (set the stage by hand; B-MS-005's shape, R1, R9): set, change and clear the order's stage by hand ----------------------
/**
 *   PUT    /production/brand-orders/:orderId/stage   {stage: any of the five, reasonCode, note?, version}             production.brand.manage
 *   DELETE /production/brand-orders/:orderId/stage?version=                                                         production.brand.manage
 *
 * `version` is the production row's as the headline read it — a required key, null only when the order has no row yet (the set makes it
 * under the keeper's lock, R1); a stale one is a 409 ("The stage changed meanwhile"). The API judges against the live floor under the
 * lock; another customer's order answers 404 in the words of an unknown id (the brand wall). The answer: the floor's stage, the stage
 * the customer reads now, the hand stage standing (or null) and the row's new version.
 */
export const stageByHandAnswerSchema = z.object({
  orderId: z.string(),
  floor: z.enum(BRAND_STAGES).nullable(),
  stage: z.enum(BRAND_STAGES).nullable(),
  byHand: z.object({ stage: z.enum(BRAND_STAGES), reasonCode: z.string(), note: z.string().nullable(), setAt: instant, setBy: z.object({ id: z.string(), name: z.string() }).nullable() }).nullable(),
  version: z.number(),
})
export type StageByHandAnswer = z.infer<typeof stageByHandAnswerSchema>

const stagePath = (orderId: string) => `/production/brand-orders/${seg(orderId)}/stage`

/** PUT — set the stage by hand, or change it (the note only when typed; the version always, null only without a row). */
export function setBrandStage(api: ApiClient, orderId: string, body: { readonly stage: string; readonly reasonCode: string; readonly note?: string; readonly version: number | null }, idempotencyKey: string): Promise<StageByHandAnswer> {
  return api.request('PUT', stagePath(orderId), { body: { stage: body.stage, reasonCode: body.reasonCode, ...(body.note ? { note: body.note } : {}), version: body.version }, schema: stageByHandAnswerSchema, idempotencyKey })
}

/** DELETE — clear it: the stage goes back to the floor's (its own day), never told. */
export function clearBrandStage(api: ApiClient, orderId: string, version: number | null, idempotencyKey: string): Promise<StageByHandAnswer> {
  return api.request('DELETE', stagePath(orderId), { query: version !== null ? { version } : {}, schema: stageByHandAnswerSchema, idempotencyKey })
}
// ---- end F-MS-103
