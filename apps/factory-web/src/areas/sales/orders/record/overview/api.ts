import { z } from 'zod'
import type { ApiClient } from '../../../../../lib/api/client'
import { FINISH_SOURCES } from '../../depth/api' // F-SA-234b

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
    })
    .nullable(),
  inWork: z.object({ bundles: z.number(), pieces: z.object({ cutting: z.number(), sewing: z.number().nullable(), checking: z.number().nullable(), packing: z.number().nullable() }) }),
  health: z
    .object({
      code: z.enum(BRAND_HEALTHS),
      words,
      computed: z.enum(BRAND_HEALTHS).nullable(),
      raise: z.object({ reasonCode: z.string(), words, until: day, note: z.string().nullable(), by: person.nullable(), at: instant.nullable() }).nullable(),
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
      workshops: z.array(z.object({ name: z.string() })),
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
      cells: z.array(z.object({ id: z.string(), salesOrderLineId: z.string(), size: z.string(), quantity: z.number(), cut: z.number().nullable() })).optional(),
      rights: z.object({ manage: z.boolean(), release: z.boolean(), hold: z.boolean(), why: words.nullable() }).optional(),
      // ---- end F-OP-113
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
    }),
  ),
  workOrdersLeftOut: z.number(),
  notInProduction: z.object({ lines: z.number(), pieces: z.number() }),
})
export type Work = z.infer<typeof workSchema>
export type WorkOrderOwn = Work['workOrders'][number]
export type MtmGroupRead = Work['mtm'][number]

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
})
export type Dates = z.infer<typeof datesSchema>
export type Gate = Dates['gates'][number]
export type DateMilestone = Dates['milestones'][number]

export const qualitySchema = z.object({
  issues: z.array(z.object({ id: z.string(), source: z.string(), recordType: z.string(), since: instant, dueOn: day, escalation: z.number() })).nullable(),
  ncrs: z.array(z.object({ id: z.string(), number: z.string(), stage: z.string(), severity: z.string(), sharedWorkOrder: z.boolean() })).nullable(),
  final: z.array(z.object({ workOrderId: z.string(), number: z.string().nullable(), status: z.string(), sampleSize: z.number(), on: day.nullable() })).nullable(),
})
export type Quality = z.infer<typeof qualitySchema>

export const peopleSchema = z.object({
  supervisor: z.object({ id: z.string(), name: z.string(), active: z.boolean(), from: z.enum(['ORDER', 'BRAND']), me: z.boolean() }).nullable(),
  backup: person.nullable(),
  answersCustomer: person.nullable(),
  places: z.array(z.object({ site: named.nullable(), line: named.nullable(), team: named.nullable(), workshop: z.object({ name: z.string() }).nullable() })),
})
export type People = z.infer<typeof peopleSchema>

// F-SA-243 (B-SA-050): "Still to do" after the accepted changes, computed from the records — each row names the record that closes it.
const stillRowSchema = z.object({
  kind: z.string(),
  ref: z.object({ type: z.string(), id: z.string(), number: z.string().nullable() }).nullable(),
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

export const WITHHELD_KEYS = ['work', 'people', 'headline.notes', 'quality.issues', 'quality.ncrs', 'quality.final', 'dates.forecast'] as const
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
