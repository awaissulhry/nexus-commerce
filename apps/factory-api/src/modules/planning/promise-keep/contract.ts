import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { FINISH_SOURCES, PROMISE_TILES, RISK_STATES } from '@nexus/factory-domain/planning/promise-keep/risk'
import { PROPOSAL_DECISIONS, PROPOSAL_STATES } from '@nexus/factory-domain/planning/promise-keep/repromise'
import { PROMISE_REASON_CODES, SIZE_STATES } from '@nexus/factory-domain/planning/promise/rules'
import { CERTIFICATE_STATES } from '../promise/certificates'

/**
 * Keeping promises (B-W2b-317; PLN-173, PLN-174, PLN-175; design planning.promise › tiles, lines, the Re-promise modal):
 * the open order lines with their promise against the planned finish, one line's promise history, the re-promise workflow.
 * Days are the site's calendar days; quantities whole garments; no money anywhere; a person only inside one record (the
 * history, a proposal), never in the list.
 */

const named = output({ id: id(), code: z.string(), name: z.string() })
const person = output({ id: id(), name: z.string() })
const sizeCode = z.string().trim().min(1).max(20)
const MAX_SIZES = 200

const certificateCover = output({ state: z.enum(CERTIFICATE_STATES), certificate: z.string().nullable().optional(), validTo: businessDate().nullable(), words: z.string() })

const lineSize = output({
  size: z.string().nullable(),
  ordered: z.number().int(),
  shipped: z.number().int(),
  open: z.number().int(),
  /** The first promise of the size, kept forever. */
  first: businessDate().nullable(),
  /** Its promise now (B-W2b-301's rule). */
  current: businessDate().nullable(),
  currentSource: z.enum(['RECORD', 'TYPED']).nullable(),
  /** The day the plan says it is ready; null: open pieces nothing says when (no date within the horizon, a material not covered). */
  finish: businessDate().nullable(),
  finishSource: z.enum(FINISH_SOURCES),
  /** Days to spare (+) or short (−). */
  slackDays: z.number().int().nullable(),
  risk: z.enum(RISK_STATES).nullable(),
  certificate: certificateCover.nullable(),
  workOrders: z.array(
    output({
      id: id(),
      number: z.string(),
      status: z.string(),
      pieces: z.number().int(),
      plannedFinish: businessDate().nullable(),
      /** The first day it can start with every material (B-W2b-312); null: no limit or none known. */
      materialStart: businessDate().nullable(),
      /** Days its finish moves because its material comes after its planned start (PLN-200). */
      delayDays: z.number().int(),
      finish: businessDate().nullable(),
      words: z.string().nullable(),
    }),
  ),
  engine: output({ state: z.enum(SIZE_STATES), date: businessDate().nullable() }).nullable(),
  words: z.string(),
})

export const promiseLine = output({
  id: id(),
  seq: z.number().int(),
  kind: z.string(),
  order: output({ id: id(), number: z.string(), status: z.string(), priorityLevel: z.string(), backlogPosition: z.number().int().nullable() }),
  customer: named,
  style: named,
  colourway: named,
  sizes: z.array(lineSize),
  first: businessDate().nullable(),
  current: businessDate().nullable(),
  finish: businessDate().nullable(),
  finishSource: z.enum(FINISH_SOURCES),
  slackDays: z.number().int().nullable(),
  risk: z.enum(RISK_STATES).nullable(),
  certificate: certificateCover.nullable(),
  /** Changes of its promise after the first (rows), and the slips among them (moves later). */
  changes: output({ count: z.number().int(), slips: z.number().int(), lastChangeAt: instant().nullable() }),
  /** A re-promise waiting for sales. */
  waiting: output({ proposalId: id(), proposedAt: instant(), sizes: z.array(output({ size: z.string().nullable(), from: businessDate().nullable(), to: businessDate() })) }).nullable(),
  tiles: z.array(z.enum(PROMISE_TILES)),
  may: output({ repromise: z.boolean() }),
  words: z.string(),
})

const siteView = output({ id: id(), code: z.string(), name: z.string() })

export const listPromisesContract = defineContract({
  querystring: input({
    siteId: id(),
    tile: z.enum(PROMISE_TILES).optional(),
    risk: z.enum(RISK_STATES).optional(),
    q: z.string().trim().max(100).optional(),
    partyId: id().optional(),
    styleId: id().optional(),
    limit: z.coerce.number().int().min(1).max(300).optional(),
  }),
  response: {
    200: output({
      site: output({ id: id(), companyId: id(), code: z.string(), name: z.string() }),
      today: businessDate(),
      asOf: instant(),
      /** The saved filters: At risk (at risk or late), Slipped this month, Re-promise waiting for sales, No valid certificate through ship date. */
      tiles: output({ AT_RISK: z.number().int(), SLIPPED_THIS_MONTH: z.number().int(), REPROMISE_WAITING: z.number().int(), NO_CERTIFICATE: z.number().int() }),
      counts: output({ LATE: z.number().int(), AT_RISK: z.number().int(), NOT_PROMISED: z.number().int(), ON_TIME: z.number().int() }),
      complete: z.boolean(),
      lines: z.array(promiseLine),
      words: z.string(),
    }),
  },
})

const promiseRef = output({ date: businessDate(), source: z.enum(['RECORD', 'TYPED']) })

export const historyContract = defineContract({
  params: input({ orderLineId: id() }),
  response: {
    200: output({
      site: siteView,
      today: businessDate(),
      asOf: instant(),
      order: output({ id: id(), number: z.string(), status: z.string(), promiseDate: businessDate().nullable(), originalPromiseDate: businessDate().nullable() }),
      line: output({ id: id(), seq: z.number().int(), kind: z.string(), style: named, colourway: named, promiseDate: businessDate().nullable() }),
      first: businessDate().nullable(),
      current: businessDate().nullable(),
      changes: z.number().int(),
      slips: z.number().int(),
      sizes: z.array(
        output({
          size: z.string().nullable(),
          ordered: z.number().int(),
          open: z.number().int(),
          first: promiseRef.nullable(),
          current: output({ date: businessDate(), source: z.enum(['RECORD', 'TYPED']), kind: z.enum(['FIRST', 'RE_PROMISE']).nullable() }).nullable(),
          changes: z.number().int(),
          slips: z.number().int(),
          driftDays: z.number().int().nullable(),
        }),
      ),
      rows: z.array(
        output({
          id: id(),
          size: z.string().nullable(),
          promisedDate: businessDate(),
          kind: z.enum(['FIRST', 'RE_PROMISE']),
          reasonCode: z.string().nullable(),
          /** The reason in the customer's curated words (both languages); null: no code of the list. */
          reasonWords: output({ it: z.string(), en: z.string() }).nullable(),
          /** The office's words (never shown to the customer). */
          reason: z.string().nullable(),
          promisedAt: instant(),
          promisedBy: person.nullable(),
          customerToldAt: instant().nullable(),
          fromPlan: z.boolean(),
          shiftDays: z.number().int().nullable(),
          words: z.string(),
        }),
      ),
      proposals: z.array(
        output({
          id: id(),
          state: z.enum(PROPOSAL_STATES),
          sizes: z.array(output({ size: z.string().nullable(), from: businessDate().nullable(), to: businessDate() })),
          reasonCode: z.string(),
          reason: z.string().nullable(),
          proposedAt: instant(),
          proposedBy: person.nullable(),
          decidedAt: instant().nullable(),
          decidedBy: person.nullable(),
          decisionReason: z.string().nullable(),
          told: z.boolean(),
        }),
      ),
    }),
  },
})

const proposalSize = output({ size: z.string().nullable(), from: businessDate().nullable(), to: businessDate() })
const message = output({ language: z.enum(['it', 'en']), subject: z.string(), body: z.string() })

export const proposalView = output({
  id: id(),
  state: z.enum(PROPOSAL_STATES),
  order: output({ id: id(), number: z.string(), status: z.string() }),
  line: output({ id: id(), seq: z.number().int(), style: named, colourway: named }),
  customer: named,
  siteId: id(),
  sizes: z.array(proposalSize),
  reasonCode: z.string(),
  reason: z.string().nullable(),
  message,
  recipients: z.array(z.string()),
  proposedAt: instant(),
  proposedBy: person.nullable(),
  decision: output({ decision: z.enum(PROPOSAL_DECISIONS), at: instant(), by: person.nullable(), reason: z.string().nullable(), told: z.boolean(), outboundId: id().nullable() }).nullable(),
  /** Its task on the order for sales (the same id). */
  task: output({ id: id(), status: z.enum(['OPEN', 'DONE', 'CANCELLED']).nullable(), assignee: person.nullable() }),
  words: z.string(),
  may: output({ accept: z.boolean(), tell: z.boolean(), decline: z.boolean(), withdraw: z.boolean() }),
})

export const draftContract = defineContract({
  params: input({ orderLineId: id() }),
  response: {
    200: output({
      site: siteView,
      today: businessDate(),
      asOf: instant(),
      order: output({ id: id(), number: z.string(), status: z.string(), customerRef: z.string().nullable() }),
      line: output({ id: id(), seq: z.number().int(), kind: z.string(), style: named, colourway: named }),
      customer: named,
      /** B-W2b-301's per size: its promise now and the plan's day. */
      plan: z.array(output({ size: z.string().nullable(), open: z.number().int(), current: businessDate().nullable(), proposed: businessDate().nullable(), state: z.enum(SIZE_STATES), certificate: certificateCover.nullable(), words: z.string() })),
      groupsWords: z.string(),
      /** The sizes the plan moves (proposed per size from the plan). */
      proposed: z.array(proposalSize),
      reasons: z.array(output({ code: z.string(), it: z.string(), en: z.string() })),
      reasonCode: z.string().nullable(),
      language: z.enum(['it', 'en']),
      /** The message to the customer in their language (a preview: the planner may write other words). */
      message: message.nullable(),
      recipients: z.array(z.string()),
      waiting: proposalView.nullable(),
      may: output({ propose: z.boolean() }),
      words: z.string(),
    }),
  },
})

export const proposeContract = defineContract({
  params: input({ orderLineId: id() }),
  body: input({
    /** The new date per size (size left out: every size; a made-to-measure line's unit). */
    sizes: z.array(input({ size: sizeCode.nullable().optional(), date: businessDate() })).min(1).max(MAX_SIZES),
    /** Why (the customer reads it in its curated words). */
    reasonCode: z.enum(PROMISE_REASON_CODES),
    /** The office's note (never shown to the customer). */
    reason: z.string().trim().min(1).max(2000).optional(),
    /** Other words to the customer than the composed ones. */
    message: input({ subject: z.string().trim().min(1).max(200).optional(), body: z.string().trim().min(1).max(10_000).optional() }).optional(),
  }),
  response: { 200: output({ proposal: proposalView, replayed: z.boolean() }) },
})

const proposalParams = input({ proposalId: id() })

export const listRepromisesContract = defineContract({
  querystring: input({ siteId: id(), state: z.enum([...PROPOSAL_STATES, 'ALL']).optional() }),
  response: { 200: output({ site: siteView, today: businessDate(), asOf: instant(), proposals: z.array(proposalView) }) },
})

export const getRepromiseContract = defineContract({ params: proposalParams, response: { 200: proposalView } })

export const acceptContract = defineContract({
  params: proposalParams,
  body: input({
    /** Send the message to the customer now, on the order's thread (by e-mail). */
    tell: z.boolean(),
    to: z.array(z.string().trim().email().max(254)).min(1).max(10).optional(),
    subject: z.string().trim().min(1).max(200).optional(),
    body: z.string().trim().min(1).max(10_000).optional(),
  }),
  response: {
    200: output({
      written: z.array(output({ id: id(), size: z.string().nullable(), promisedDate: businessDate(), kind: z.enum(['FIRST', 'RE_PROMISE']), reasonCode: z.string().nullable(), backfill: z.boolean(), words: z.string() })),
      told: z.boolean(),
      outboundId: id().nullable(),
      /** The line's date (W1) moved to its latest size; null: it did not move (the same day, or the order shipped in part). */
      lineDate: businessDate().nullable(),
      replayed: z.boolean(),
      proposal: proposalView,
    }),
  },
})

export const declineContract = defineContract({
  params: proposalParams,
  body: input({ reason: z.string().trim().min(1).max(2000) }),
  response: { 200: output({ replayed: z.boolean(), proposal: proposalView }) },
})

export const withdrawContract = defineContract({
  params: proposalParams,
  body: input({}).optional(),
  response: { 200: output({ replayed: z.boolean(), proposal: proposalView }) },
})
