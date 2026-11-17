import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { BRAND_HEALTHS, HEALTH_REASON_CODES } from '@nexus/factory-domain/production-brand/health'
import { PRODUCTION_SHARE_LEVELS } from '@nexus/factory-domain/production-brand/levels'
import { APPROVAL_STATES, BRAND_GATE_KINDS, BRAND_GATE_STATES, BRAND_HOLD_READS } from '@nexus/factory-domain/production-brand/portal-read'
import { BRAND_STAGES } from '@nexus/factory-domain/production-brand/stages'
import { BRAND_URGENCIES, URGENCY_BATCH_MAX, URGENCY_OUTCOMES } from '@nexus/factory-domain/production-brand/urgency'
import { BRAND_SIDES } from '@nexus/factory-domain/production-brand/waiting'
import { PROGRESS_STAGES } from '@nexus/factory-domain/sales/portal-orders/progress'
import { PROMISE_REASON_CODES } from '@nexus/factory-domain/sales/portal-orders/promise'

/**
 * B-PR-18: the customer's own production in its portal (see ./read.ts). Every state comes with its words in Italian and English
 * (`words`). No money on these pages, for any role; no person of the office or the floor, no note, no place in our queue, no
 * line, lane, load, lot or work order (factory-domain production-brand/portal-read FORBIDDEN_BRAND_KEYS); a section the
 * customer's level does not share is null (not drawn).
 */

const words = output({ it: z.string(), en: z.string() })
const day = businessDate()
const live = output({ events: z.array(z.string()) })
/** The customer's own running number of the order ("Your order 12"; B-TH-105). */
const yourNumber = output({ seq: z.number().int(), words }).nullable()
const named = output({ code: z.string(), name: z.string() })

export const PRODUCTION_CHIPS = ['ALL', 'URGENT', 'WAITING_ON_YOU', 'AT_RISK', 'LATE', 'ON_HOLD', 'READY'] as const
export type ProductionChip = (typeof PRODUCTION_CHIPS)[number]

const stage = output({
  code: z.enum(BRAND_STAGES),
  words,
  /** Since when the order is at this stage (null: our keeper has not written the order's row yet). */
  since: day.nullable(),
  next: output({ code: z.enum(BRAND_STAGES), words }).nullable(),
})

const health = output({
  code: z.enum(BRAND_HEALTHS),
  words,
  /** The reason code of a person's raise to At risk (in the promise's own curated words); never the office's note. */
  reason: output({ code: z.enum(HEALTH_REASON_CODES), words }).nullable(),
})

/** Who acts next: You or Us (a supplier or a workshop is ours), since when. */
const waiting = output({ code: z.enum(BRAND_SIDES), words, since: day.nullable() })

/** The customer's urgency of the order (null in every row while its urgency is off: the marks are kept, not used). */
const urgency = output({
  code: z.enum(BRAND_URGENCIES),
  words,
  /** Its place in the customer's OWN urgent list (1 first); null when Regular. Never a place in our plan. */
  urgentRank: z.number().int().nullable(),
  /** An "Urgent – asked" of it waits for our answer. */
  asked: z.boolean(),
  askedWords: words.nullable(),
  /** We set it last ("Changed by us"; never who). */
  byUs: z.boolean(),
  byUsWords: words.nullable(),
  /** We set it to Regular and locked it, with the reason it reads. */
  locked: z.boolean(),
  lockWords: words.nullable(),
})

/** "2 of 3 urgent used" ("4 of 3 · 1 agreed with us"): the customer's own open orders only. */
const urgentUse = output({ used: z.number().int(), max: z.number().int(), agreed: z.number().int(), left: z.number().int(), over: z.boolean(), words })

const marks = output({
  onHold: z.boolean(),
  paused: z.boolean(),
  partlyShipped: z.boolean(),
  changePending: z.boolean(),
  words: z.array(words),
})

/** The state of the problems it reported on the order ("Waiting on us since 16 Nov", "Answered", "Answered in SO-…"). */
const problem = output({
  state: z.enum(['WAITING_ON_US', 'ANSWERED', 'ANSWERED_IN']),
  since: day.nullable(),
  on: day.nullable(),
  /** ANSWERED_IN: its own order whose thread holds our answer. */
  inOrder: output({ id: id(), number: z.string(), customerRef: z.string().nullable(), yourNumber }).nullable(),
  words,
})

const next = output({
  kind: z.enum(['STAGE', 'GATE']),
  stage: z.enum(BRAND_STAGES).nullable(),
  gate: z.enum(BRAND_GATE_KINDS).nullable(),
  /** + Gates & dates: the gate's target day, or the stage's planned start in the published plan; else null. */
  date: day.nullable(),
  words,
})

const count = output({ done: z.number().int(), of: z.number().int(), words })

const promiseMoves = z.array(output({ on: day, from: day.nullable(), to: day, lines: z.array(z.number().int()), reason: output({ code: z.enum(PROMISE_REASON_CODES), words }) }))

const row = output({
  id: id(),
  /** Their purchase order number (first in the row). */
  customerRef: z.string().nullable(),
  number: z.string(),
  yourNumber,
  /** The day the order was sent (SalesOrder.orderDate): Regular orders are listed by it, oldest first. */
  orderedOn: day,
  styles: z.array(named),
  /** Pieces ordered on its goods lines. */
  pieces: z.number().int(),
  /** The ex-factory date (the promise now), the first one, and the moved mark. */
  promiseDate: day.nullable(),
  originalPromiseDate: day.nullable(),
  promiseMoved: z.boolean(),
  stage: stage.nullable(),
  health: health.nullable(),
  waiting,
  marks,
  urgency: urgency.nullable(),
  next: next.nullable(),
  /** + Progress: how far the stage it is at went ("32 of 40 sewn"). */
  count: count.nullable(),
  problem: problem.nullable(),
})

const levelFields = {
  level: z.enum(PRODUCTION_SHARE_LEVELS),
  levelWords: words,
  /** The old switch, kept in every contract until B-PR-40: true from + Progress. */
  progressShared: z.boolean(),
  /** The customer's urgency switch (off: no urgency in the read; its marks are kept, not used). */
  urgencyOn: z.boolean(),
  urgentUse: urgentUse.nullable(),
}

export const listContract = defineContract({
  querystring: input({
    chip: z.enum(PRODUCTION_CHIPS).default('ALL'),
    /** Their PO number, our order number, or a style's code or name. */
    q: z.string().trim().max(80).optional(),
    /** csv: the rows of the chip and search as a file ("Export"; all of them, written here). */
    format: z.enum(['json', 'csv']).default('json'),
    /** The file's language (default: the person's). */
    locale: z.enum(['it', 'en']).optional(),
  }),
  response: {
    200: output({
      asOf: instant(),
      ...levelFields,
      chip: z.enum(PRODUCTION_CHIPS),
      chips: z.array(output({ chip: z.enum(PRODUCTION_CHIPS), count: z.number().int(), words })),
      /** Rows in the chip (after the search): every one is in `items` (no page, no cut). */
      count: z.number().int(),
      items: z.array(row),
      live,
    }),
  },
})

const stageFigures = { ordered: z.number().int(), cut: z.number().int().nullable(), sewn: z.number().int().nullable(), inspected: z.number().int().nullable(), packed: z.number().int().nullable() }

const progress = output({
  asOf: instant(),
  refreshSeconds: z.number().int(),
  stages: z.array(output({ key: z.enum(PROGRESS_STAGES), words })),
  lines: z.array(output({ lineId: id(), seq: z.number().int(), style: named.nullable(), colourway: named.nullable(), ...stageFigures, sizes: z.array(output({ size: z.string().nullable(), ...stageFigures })) })),
  whole: output(stageFigures),
  percent: z.number().int().nullable(),
})

const gates = output({
  gates: z.array(output({ kind: z.enum(BRAND_GATE_KINDS), words, state: z.enum(BRAND_GATE_STATES), stateWords: words, targetDate: day.nullable(), doneOn: day.nullable() })),
  /** Its swatch answers (colour, leather, fabric, trims): approvals, not gates. */
  approvals: z.array(output({ kind: z.string(), words, state: z.enum(APPROVAL_STATES), stateWords: words, sentOn: day.nullable(), answeredOn: day.nullable() })),
  /** Its own work in the PUBLISHED plan only: days, never a line or a load. */
  planned: output({ cutStart: day.nullable(), sewStart: day.nullable(), finish: day.nullable() }),
})

export const orderContract = defineContract({
  params: input({ orderId: id() }),
  response: {
    200: output({
      asOf: instant(),
      ...levelFields,
      order: output({
        id: id(),
        customerRef: z.string().nullable(),
        number: z.string(),
        yourNumber,
        orderedOn: day,
        promiseDate: day.nullable(),
        originalPromiseDate: day.nullable(),
        promiseMoved: z.boolean(),
      }),
      /** Still in production (confirmed and not shipped in full); false: the state kept as history. */
      inProduction: z.boolean(),
      stage: stage
        .extend({
          /** How many of its own lines are further on ("1 line ahead"). */
          ahead: z.number().int(),
          aheadWords: words.nullable(),
          /** At Cutting where a line's sewing is not scanned. */
          sewingNotCounted: z.boolean(),
          sewingNotCountedWords: words.nullable(),
        })
        .nullable(),
      health: health.nullable(),
      waiting,
      marks,
      /** What holds its work, in plain words (every level): quality's check, our hold (its reason), its own pause. */
      holds: z.array(output({ kind: z.enum(BRAND_HOLD_READS), since: day, words })),
      urgency: urgency.nullable(),
      problem: problem.nullable(),
      /** The ex-factory date's moves with their reason codes (every level). */
      promiseHistory: promiseMoves,
      /** + Progress: the pieces per line and size (cut and bundled, sewn, checked, packed) of its own cells. */
      progress: progress.nullable(),
      /** + Gates & dates: its real gates, its swatch answers, the published plan's dates. */
      gates: gates.nullable(),
      live,
    }),
  },
})

// ── B-PR-22a ──
/**
 * B-PR-22a: the customer's urgency commands (./urgency.ts). One result per OWN order; an id that is not one of its own orders is
 * only counted (`notFound`), never named. Refusals that change nothing come back as 409 with each order's words at
 * `body/orderIds/<index>/<outcome>` (ASK_CUT / ASK_OVER_QUOTA = "Ask us"; URGENCY_OFF, NOT_OPEN, LOCKED, UNCHANGED, NOT_KEPT).
 * Every write takes an Idempotency-Key.
 */
const urgencyResult = output({
  orderId: id(),
  number: z.string(),
  customerRef: z.string().nullable(),
  outcome: z.enum(URGENCY_OUTCOMES),
  done: z.boolean(),
  words: words.nullable(),
  /** "Ask us" beside a mark over the quota or from Cutting (the way to "Urgent – asked"). */
  ask: words.nullable(),
  urgency: z.enum(BRAND_URGENCIES).nullable(),
  /** Its place in the customer's OWN Urgent list after the command (1 first); never a place in our plan. */
  urgentRank: z.number().int().nullable(),
})

const urgencyAnswer = output({
  /** The batch this command made: send it to Undo. */
  batchId: id().nullable(),
  results: z.array(urgencyResult),
  /** Ids named that are not its own orders: counted, never named. */
  notFound: z.number().int(),
  use: urgentUse.nullable(),
  replayed: z.boolean(),
})

const orderIds = (max: number) => z.array(id()).min(1).max(max)

export const markUrgencyContract = defineContract({
  body: input({ orderIds: orderIds(URGENCY_BATCH_MAX), urgency: z.enum(BRAND_URGENCIES) }),
  response: { 200: urgencyAnswer },
})

export const urgentOrderContract = defineContract({
  body: input({
    /** Its WHOLE Urgent list in the new order ("Move to top": the list with that order first). */
    orderIds: orderIds(200),
    /** The list's `asOf` as read: a change after it is named in the refusal ("Changed at 10:42", "Changed by us"). */
    asOf: instant().optional(),
  }),
  response: { 200: urgencyAnswer },
})

export const undoUrgencyContract = defineContract({
  body: input({ batchId: id() }),
  response: {
    200: urgencyAnswer.extend({
      /** The batch put back. */
      undone: id(),
      /** Its orders left as they are, with why ("Changed since: left as it is", or the mark's own rule now). */
      skipped: z.array(output({ orderId: id(), number: z.string(), customerRef: z.string().nullable(), words })),
    }),
  },
})
// ── end B-PR-22a ──
