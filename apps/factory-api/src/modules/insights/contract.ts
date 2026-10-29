import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { AMOUNT_FIELDS, ATTENTION_KINDS, CATEGORIES, DECIDE_MODES, GROUPS, SEVERITIES } from '@nexus/factory-domain/insights/attention'
import { FLOW_LENSES } from '@nexus/factory-domain/insights/flow'
import { WAITING_KINDS } from '@nexus/factory-domain/insights/waiting'
import { money, notMoney } from '@nexus/factory-domain/money/marked'

/**
 * Today's contracts (B-W1-52; A2 SCR-029; design home.today). Every amount is marked with its grain: the API drops it for
 * a caller without the grain (the rows were built without it already: factory-domain insights/attention presentItem).
 * `live.events` names the events after which the web reads the section again (GET /live).
 */

const scopeQuery = {
  companyId: id().optional(),
  siteId: id().optional(),
}

const record = output({ type: z.string(), id: id(), label: z.string() })

/** A row's money: the document's net value (price), a purchase order's value (cost), a quote's margin (margin; its amount: cost). */
const figures = output({
  currency: z.string(),
  netAmount: money.price(z.number().int()),
  purchaseAmount: money.cost(z.number().int()),
  marginPct: money.margin(z.string()),
  marginAmount: money.cost(z.number().int()),
}).nullable()

const live = output({ events: z.array(z.string()) })

/** A phrase in the reader's language: the web's `today.w.<key>` with these params (factory-domain insights/words). */
const phraseRef = output({ key: z.string(), params: z.record(z.string(), z.union([z.string(), z.number(), z.array(z.string()).readonly()])) })

const item = output({
  /** `<kind>:<record id>[:<sub key>]`: stable while the row needs attention. */
  key: z.string(),
  kind: z.enum(ATTENTION_KINDS),
  /** The kind's state of the row (LATE | AT_RISK, QUARANTINE | BLOCKED, REJECTED | ERROR | NOT_DELIVERABLE | FILES_PENDING, …). */
  state: z.string(),
  category: z.enum(CATEGORIES),
  severity: z.enum(SEVERITIES),
  severityWord: z.string(),
  group: z.enum(GROUPS),
  record,
  companyId: id().nullable(),
  siteId: id().nullable(),
  partyId: id().nullable(),
  sentence: z.string(),
  /** Why it is the reader's. */
  why: z.string(),
  /** What waits on it. */
  blocks: z.string().nullable(),
  /** The sentence, the why and the blocks as phrases (the English above is the same words). */
  words: output({ sentence: phraseRef, why: phraseRef, blocks: phraseRef.nullable() }),
  /** The figure the sentence quotes (a field of `figures`), only when the reader holds its grain. */
  sentenceFigure: z.enum(AMOUNT_FIELDS).nullable(),
  due: output({ date: z.string(), days: z.number().int(), word: z.enum(['OVERDUE', 'TODAY', 'SOON']).nullable() }).nullable(),
  since: instant(),
  ageDays: z.number().int(),
  /** REVIEW: the approval review opens (O3 = A: no W1 kind is a one-field change); OPEN: the record opens. */
  decide: z.enum(DECIDE_MODES),
  figures,
})

export const todayContract = defineContract({
  querystring: input({
    /** One kind only (a deep link). */
    kind: z.enum(ATTENTION_KINDS).optional(),
    /** One of the design's tiles: APPROVAL (the decisions to review) or ALERT (late, on hold, rejected, a duty open). */
    category: z.enum(CATEGORIES).optional(),
    ...scopeQuery,
    cursor: z.string().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: {
    200: output({
      asOf: instant(),
      today: z.string(),
      /** Under the company and site filters, never the kind or tile filter. */
      counts: output({
        total: notMoney(z.number().int()),
        /** Overdue or urgent. */
        now: z.number().int(),
        /** The design's three tiles, always: ALL (every row), APPROVAL, ALERT; `complete` false: a count is a lower bound. */
        tiles: z.array(output({ tile: z.enum(['ALL', ...CATEGORIES]), count: z.number().int(), complete: z.boolean() })),
        /** Per kind the reader acts on (0 is an answer), for a deep link's chip. */
        byKind: z.array(output({ kind: z.enum(ATTENTION_KINDS), label: z.string(), count: z.number().int(), complete: z.boolean() })),
      }),
      /** The rows under every filter (the kind's too). */
      total: notMoney(z.number().int()),
      items: z.array(item),
      nextCursor: z.string().nullable(),
      live,
    }),
  },
})

const stage = output({
  key: z.string(),
  label: z.string(),
  count: z.number().int(),
  /** null: the stage has no date to be late against. */
  late: z.number().int().nullable(),
  oldestDays: z.number().int().nullable(),
  /** The area list's query for the stage; null when no list filter matches it. */
  filter: z.record(z.string(), z.string()).nullable(),
  /** The filtered list shows exactly the stage's rows. */
  exact: z.boolean(),
})

export const flowContract = defineContract({
  querystring: input(scopeQuery),
  response: {
    200: output({
      asOf: instant(),
      today: z.string(),
      lenses: z.array(output({ lens: z.enum(FLOW_LENSES), label: z.string(), list: z.string().nullable(), stages: z.array(stage), complete: z.boolean(), live })),
    }),
  },
})

export const waitingContract = defineContract({
  querystring: input(scopeQuery),
  response: {
    200: output({
      asOf: instant(),
      counts: output({ total: notMoney(z.number().int()), byKind: z.array(output({ kind: z.enum(WAITING_KINDS), label: z.string(), count: z.number().int() })) }),
      items: z.array(
        output({
          key: z.string(),
          kind: z.enum(WAITING_KINDS),
          record,
          companyId: id().nullable(),
          siteId: id().nullable(),
          partyId: id().nullable(),
          sentence: z.string(),
          /** Whom the reader waits for. */
          waitingFor: z.string(),
          since: instant(),
          ageDays: z.number().int(),
          due: z.string().nullable(),
          figures,
        }),
      ),
      live,
    }),
  },
})
