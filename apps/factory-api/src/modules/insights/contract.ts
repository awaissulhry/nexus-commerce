import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { ACTION_VERBS, LOG_VERBS, NOTE_MAX, PANEL_WIDTHS, TODAY_SECTIONS } from '@nexus/factory-domain/insights/actions'
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

const person = output({ id: id(), name: z.string(), /** The reader. */ me: z.boolean() })

/** What people did about a row, and what its reader may do (factory-domain insights/actions). */
const rowActions = output({
  /** The stored version (0: nothing stored yet): send it back with an action. */
  version: z.number().int(),
  /** ASSIGN · RESOLVE · ACKNOWLEDGE on an alert (not ACKNOWLEDGE when it is acknowledged in this condition); none on an approval or a mail. */
  verbs: z.array(z.enum(ACTION_VERBS)),
  /** "Assigned to <name>" (the assignee may act on it; it is on their Today too). */
  assigned: output({ to: person, by: person, at: instant() }).nullable(),
  /** Acknowledged in the row's present condition. */
  acknowledged: output({ by: person, at: instant() }).nullable(),
})

const item = output({
  /** `<kind>:<record id>[:<sub key>]`: stable while the row needs attention. */
  key: z.string(),
  /** The row's condition (its fingerprint): send it back with an action; a row whose condition changed is refused. */
  condition: z.string(),
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
  actions: rowActions,
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
      /** What I decided today (GET /home/today/handled lists it). */
      handled: output({ today: z.number().int() }),
      live,
    }),
  },
})

// ---- acting on a row (insights/actions) -----------------------------------------------------------------------------

const rowParams = input({ key: z.string().min(3).max(300) })
const condition = z.string().regex(/^[0-9a-f]{32}$/)
const actionVersion = z.number().int().min(0)

const actedRow = output({
  key: z.string(),
  condition: z.string(),
  /** Resolved: the row is off Today until its condition changes. */
  resolved: z.boolean(),
  actions: rowActions,
})

export const assignContract = defineContract({
  params: rowParams,
  /** `assigneeId` null: take the row back from its assignee. */
  body: input({ condition, version: actionVersion, assigneeId: id().nullable() }),
  response: { 200: actedRow },
})

export const resolveContract = defineContract({
  params: rowParams,
  /** `note`: what was done (3 to 1000 characters; required). */
  body: input({ condition, version: actionVersion, note: z.string().max(NOTE_MAX * 2) }),
  response: { 200: actedRow },
})

export const acknowledgeContract = defineContract({
  params: rowParams,
  body: input({ condition, version: actionVersion }),
  response: { 200: actedRow },
})

export const assigneesContract = defineContract({
  params: rowParams,
  response: {
    200: output({
      key: z.string(),
      condition: z.string(),
      /** ACTIVE people who may act on the row and reach Today; `suggested`: their role names its site or company. */
      people: z.array(output({ id: id(), name: z.string(), me: z.boolean(), suggested: z.boolean(), assigned: z.boolean() })),
    }),
  },
})

export const handledContract = defineContract({
  response: {
    200: output({
      today: z.string(),
      count: z.number().int(),
      items: z.array(
        output({
          at: instant(),
          /** Today's verbs, and the quote approvals I decided (APPROVED | REJECTED). */
          verb: z.enum([...LOG_VERBS, 'APPROVED', 'REJECTED']),
          kind: z.enum(ATTENTION_KINDS),
          /** The row's key (null for a quote decision). */
          key: z.string().nullable(),
          record,
          companyId: id().nullable(),
          note: z.string().nullable(),
          assignee: output({ id: id(), name: z.string() }).nullable(),
        }),
      ),
    }),
  },
})

const layoutShape = {
  /** The page's sections in order; "needs-me" is never hidden; the unlisted ones follow in the design's order. */
  sections: z.array(output({ id: z.enum(TODAY_SECTIONS), hidden: z.boolean() })).max(TODAY_SECTIONS.length * 2),
  /** "My lists" panels in order (the web's ids), hidden or not, with a width. */
  panels: z.array(output({ id: z.string().min(1).max(64), hidden: z.boolean(), width: z.enum(PANEL_WIDTHS) })).max(200),
  /** The lens the flow strip opens on ("My main role"); null: the first the person has. */
  mainLens: z.enum(FLOW_LENSES).nullable(),
}

const layoutAnswer = output({
  layout: output(layoutShape),
  /** 0: nothing saved yet (the design's order). */
  version: z.number().int(),
  updatedAt: instant().nullable(),
})

export const layoutContract = defineContract({ response: { 200: layoutAnswer } })

export const saveLayoutContract = defineContract({
  /** Checked by factory-domain insights/actions layoutProblems (in words, per field). */
  body: input({
    sections: z.array(input({ id: z.string().max(64), hidden: z.boolean() })).max(20),
    panels: z.array(input({ id: z.string().max(64), hidden: z.boolean(), width: z.string().max(20) })).max(200),
    mainLens: z.string().max(40).nullable(),
    /** The version read (0: nothing saved yet). */
    version: z.number().int().min(0),
  }),
  response: { 200: layoutAnswer },
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
