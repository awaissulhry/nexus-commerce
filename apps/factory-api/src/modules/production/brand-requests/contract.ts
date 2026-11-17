import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { MAX_ANSWER, ORDER_REQUEST_KINDS, REQUEST_STATUSES } from '@nexus/factory-domain/sales/change-requests/rules'
import { COUNTER_LIMITS } from '@nexus/factory-domain/sales/change-requests/counter'
import { askImpact, cancelFee, requestFields } from '../../sales/change-requests/contract'

/**
 * B-PR-26 — the office's read of every customer request and its answers (production plan §3 "We accept, counter or refuse with
 * words it reads", §5 Home › Approvals "Customer request"; R-05, R-32). A request reads as the customer's own view of it
 * (sales/change-requests requestFields: kind, cells, dates, words, the impact kept at Send, our counter-offer) plus the office's
 * fields: the customer, who of them asked, who of us answered, who answers its kind (`answeredWith`), where its accept goes
 * (`answeredIn`), what accepting does in words, who it waits on, what THIS reader may answer now, and its batch. Money only by
 * grain: a cancel's fee and the counter's fee are money.price (dropped for a reader without the price grain).
 */

const words = output({ it: z.string(), en: z.string() })
const live = output({ events: z.array(z.string()) })
const version = z.number().int().min(1)
const day = businessDate()

export const LIST_STATUSES = ['WAITING', ...REQUEST_STATUSES, 'ALL'] as const

const brandRequest = output({
  ...requestFields,
  companyId: id(),
  party: output({ id: id(), code: z.string(), name: z.string() }),
  /** The customer's person who asked. */
  askedBy: z.string().nullable(),
  /** Who of us answered (the office's only: the customer never reads it). */
  answeredBy: z.string().nullable(),
  /** The amendment an accepted change made. */
  amendment: output({ id: id(), revision: z.number().int() }).nullable(),
  /** The office permission that answers this kind, over the order's company and customer (plan §3). */
  answeredWith: z.string(),
  /** Where its accept goes: SALES (/sales/change-requests/:id/accept: change, cancel, ship what is ready) or PRODUCTION (here). */
  answeredIn: z.enum(['SALES', 'PRODUCTION']),
  /** What accepting it does, in words (the customer read the same before Send). */
  acceptWords: words,
  /** Who it waits on now: US (we answer), CUSTOMER (our counter-offer), or nobody (null: answered or withdrawn). */
  waitingOn: z.enum(['US', 'CUSTOMER']).nullable(),
  /** Where it stands, in the office's words. */
  standing: words,
  /** What this reader may answer now (the request's state and the kind's permission); a counter with a price needs the grain. */
  may: output({ accept: z.boolean(), refuse: z.boolean(), counter: z.boolean(), counterWithPrice: notMoney(z.boolean()) }),
  /** Its batch (a bulk ask of one customer and one kind): how many requests it holds and how many still wait on us. */
  batch: output({ id: id(), count: z.number().int(), waiting: z.number().int() }).nullable(),
})

export const listContract = defineContract({
  querystring: input({
    /** WAITING (default): OPEN and COUNTERED — what waits on us or on the customer. */
    status: z.enum(LIST_STATUSES).default('WAITING'),
    kind: z.enum(ORDER_REQUEST_KINDS).optional(),
    partyId: id().optional(),
    orderId: id().optional(),
    /** One batch's requests (the review window of a batch's group row). */
    batchId: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  }),
  response: {
    200: output({
      asOf: instant(),
      items: z.array(brandRequest),
      /** Rows in the status asked (and the filters). */
      count: z.number().int(),
      counts: output({ OPEN: z.number().int(), COUNTERED: z.number().int(), ACCEPTED: z.number().int(), REFUSED: z.number().int(), WITHDRAWN: z.number().int() }),
      /** The requests that wait (OPEN or COUNTERED) per kind, over the filters (the tile, the Overview). */
      waitingByKind: z.array(output({ kind: z.enum(ORDER_REQUEST_KINDS), count: z.number().int() })),
      live,
    }),
  },
})

const requestParams = input({ requestId: id() })

export const recordContract = defineContract({
  params: requestParams,
  response: {
    200: output({
      asOf: instant(),
      request: brandRequest,
      /** Our counter-offer's approval request: its state, due time, and the customer's answer (their words, the name they signed). */
      counterApproval: output({ id: id(), status: z.string(), dueAt: instant(), answeredAt: instant().nullable(), typedName: z.string().nullable(), answer: z.string().nullable() }).nullable(),
      /** The other requests of its batch the reader reaches (one customer, one kind), oldest first. */
      batch: z.array(output({ id: id(), orderId: id(), orderNumber: z.string(), status: z.enum(REQUEST_STATUSES), version: z.number().int() })),
      live,
    }),
  },
})

export const impactContract = defineContract({
  params: requestParams,
  response: {
    200: output({
      asOf: instant(),
      request: output({ id: id(), kind: z.enum(ORDER_REQUEST_KINDS), status: z.enum(REQUEST_STATUSES), version: z.number().int() }),
      /** What the customer saw before Send (null: asked before B-PR-25). */
      kept: askImpact.nullable(),
      /** The same impact read now: what is frozen now, priced or not, the earliest date now (a date only). */
      now: askImpact,
      /** The work orders of the order the reader sees (their state, held, made before the one-customer rule). */
      workOrders: z.array(output({ id: id(), number: z.string(), status: z.string(), held: z.boolean(), mixed: z.boolean() })),
      /** The order's other work orders, counted: the reader does not reach them (never named). */
      workOrdersNotShown: z.number().int(),
      /** A cancel's fee as the settings say it now (prices: dropped without the grain); null: not a cancel. */
      cancelFee: cancelFee.nullable(),
      live,
    }),
  },
})

export const refuseContract = defineContract({
  params: requestParams,
  body: input({ version, answer: z.string().trim().min(1).max(MAX_ANSWER) }),
  response: { 200: output({ request: brandRequest }) },
})

export const counterContract = defineContract({
  params: requestParams,
  body: input({
    version,
    /** The date we offer (from today on). */
    date: day.nullable().optional(),
    /** A price: whole minor units of the order's currency, 0 or more (0: explicitly free); only with the price grain. */
    fee: money.price(z.number().int().min(0).max(COUNTER_LIMITS.fee).nullable()),
    /** Our words to the customer. */
    note: z.string().max(COUNTER_LIMITS.note).nullable().optional(),
  }),
  response: { 200: output({ request: brandRequest, approvalRequestId: id() }) },
})

// ── B-PR-27a: accepting carries the ask out (./accept.ts) ───────────────────────────────────────────────────────────────────────
const acceptedWorkOrder = output({
  id: id(),
  number: z.string(),
  status: z.string(),
  /** HOLD: it went ON_HOLD now (false: held already by another hold, the pause stands beside it). RESUME: it left ON_HOLD now. */
  changed: z.boolean(),
})

export const acceptContract = defineContract({
  params: requestParams,
  body: input({
    version,
    /** Our words to the customer (optional on an accept). */
    answer: z.string().trim().max(MAX_ANSWER).nullable().optional(),
    /** B-PR-27b, RUSH only: true = "Accept and rush the floor" (also first on every tablet); false or left out = "Accept as urgent". */
    rushFloor: z.boolean().optional(),
  }),
  response: {
    200: output({
      request: brandRequest,
      /** What accepting did (the order's own work orders only). */
      done: output({
        kind: z.enum(ORDER_REQUEST_KINDS),
        /** HOLD: the work orders paused now. */
        paused: z.array(acceptedWorkOrder),
        /** RESUME: the work orders whose pause was lifted now. */
        resumed: z.array(acceptedWorkOrder),
        // ── B-PR-27b ──
        /** RUSH: the order's urgency in the customer's own list after the accept, and "4 of 3 urgent used · 1 agreed with us". */
        urgency: output({
          urgency: z.enum(['URGENT', 'REGULAR']),
          urgentRank: z.number().int().nullable(),
          /** It was Urgent already: its place kept, nothing written. */
          already: z.boolean(),
          batchId: id().nullable(),
          use: output({ used: z.number().int(), max: z.number().int(), agreed: z.number().int(), left: z.number().int(), over: z.boolean(), words }),
        }).nullable(),
        /** RUSH with rushFloor: the work orders rushed now (changed) or rushed already. */
        rushed: z.array(acceptedWorkOrder),
        /** RUSH with rushFloor: the mixed work orders left alone (rush them by hand). */
        rushSkipped: words.nullable(),
        /** RUSH: the new date proposed to sales per line (each a re-promise sales accepts), and the lines left out with why. */
        repromise: output({
          proposals: z.array(output({ id: id(), orderLineId: id(), seq: z.number().int(), sizes: z.array(output({ size: z.string().nullable(), from: businessDate().nullable(), to: businessDate() })) })),
          skipped: z.array(output({ orderLineId: id(), seq: z.number().int(), words })),
        }).nullable(),
        /** SAMPLE_ROUND: the round it made (named on the request). */
        sampleRound: output({ id: id(), number: z.string(), kind: z.string() }).nullable(),
        // ── end B-PR-27b ──
        words,
      }),
    }),
  },
})
// ── end B-PR-27a ──
