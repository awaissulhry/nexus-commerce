import { z } from 'zod'
import { periodLockOverride } from '@nexus/factory-domain/accounting/contracts'
import { amountMinor, businessDate, currency, defineContract, id, input, instant, output, quantity, unitPrice } from '@nexus/factory-domain/core/contracts'
import { DOCUMENT_LANGUAGES } from '@nexus/factory-domain/documents/model'
import { COUNT_ITEM_KINDS, COUNT_LIMITS, COUNT_LINE_ORIGINS, COUNT_LIST_VIEWS, STOCK_COUNT_KINDS, STOCK_COUNT_STATUSES } from '@nexus/factory-domain/inventory/counts/rules'
import { ITEM_TRACKINGS } from '@nexus/factory-domain/inventory/ledger/moves'
import { money } from '@nexus/factory-domain/money/marked'
import { UOMS } from '@nexus/factory-domain/product/units/units'

/**
 * Stock counts and the year-end physical inventory (B-W2a-15; SCM-224, SCM-230; design warehouse.counts, SCR-132):
 * the counts list and its tiles, a count's record (header, summary, approval, what the caller may do), its lines, and
 * the writes: make (DRAFT or straight COUNTING), edit the team and note, start (freeze the expected quantities), type
 * counts, recounts and reasons, add what was found, remove such a line, ask recounts, submit, approve or send back,
 * apply the differences as COUNT moves, sign off a year-end inventory with its valued list, cancel. Paths start
 * `/inventory/stock-counts`: W1's one-location count posting keeps `POST /inventory/counts` (modules/inventory/ledger).
 * Values (the differences' worth, unit costs) carry the cost grain and are dropped without it.
 */

const version = z.number().int().min(1)
const flag = z.enum(['true', 'false']).optional()
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional()
const reasonCode = z.string().trim().min(1).max(40).regex(/^\S+$/, { message: 'A reason code has no spaces.' })
const countParams = input({ countId: id() })
const language = z.enum(DOCUMENT_LANGUAGES).optional()

const ref = output({ id: id(), code: z.string(), name: z.string() })
const lotRef = output({ id: id(), code: z.string() })
const person = z.string().nullable()

export const countView = output({
  id: id(),
  number: z.string(),
  kind: z.enum(STOCK_COUNT_KINDS),
  status: z.enum(STOCK_COUNT_STATUSES),
  companyId: id(),
  site: ref,
  /** What it counts, all together (a location: with everything under it); every part null: the whole site. */
  scope: output({
    location: output({ id: id(), code: z.string(), name: z.string(), path: z.string() }).nullable(),
    item: ref.nullable(),
    lot: lotRef.nullable(),
    itemKind: z.enum(COUNT_ITEM_KINDS).nullable(),
  }),
  inventoryDate: businessDate().nullable(),
  countTeam: z.string().nullable(),
  note: z.string().nullable(),
  startedAt: instant().nullable(),
  snapshotAt: instant().nullable(),
  submittedAt: instant().nullable(),
  /** From SUBMITTED on: whether a second person approves; null before. */
  approvalRequired: z.boolean().nullable(),
  /** From SUBMITTED on: what the differences are worth (what the approval rule read), in the company's currency. */
  differenceAmount: money.cost(amountMinor().nullable()),
  currency: currency(),
  approvedAt: instant().nullable(),
  approvalNote: z.string().nullable(),
  rejectedAt: instant().nullable(),
  rejectReason: z.string().nullable(),
  appliedAt: instant().nullable(),
  signedOffAt: instant().nullable(),
  /** A signed-off year-end inventory's frozen valued list: the PDF (the count's valuedListFileId) and the spreadsheet. */
  valuedList: output({ pdfFileId: id(), sheetFileId: id().nullable() }).nullable(),
  cancelledAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  /** Its lines, counted lines (`84 of 120`) and lines that differ. */
  lines: output({ all: z.number().int(), counted: z.number().int(), differing: z.number().int() }),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type CountView = z.infer<typeof countView>

const action = output({ allowed: z.boolean(), reason: z.string().nullable() })

export const countRecordView = countView.extend({
  /** Who did what, by name, inside this one record only (never in the list, a filter or a figure per person). */
  people: output({ createdBy: person, submittedBy: person, approvedBy: person, rejectedBy: person, appliedBy: person, signedOffBy: person }),
  summary: output({
    lines: z.number().int(),
    counted: z.number().int(),
    uncounted: z.number().int(),
    recountsDue: z.number().int(),
    differing: z.number().int(),
    /** Lines that differ and say no reason (submit refuses them). */
    unreasoned: z.number().int(),
    recountSuggested: z.number().int(),
    /** Lines whose stock moved at their location since the snapshot (no freeze until W2b). */
    movedSinceSnapshot: z.number().int(),
    /** The differences' worth now (counted so far), in the company's currency; the stored figure once SUBMITTED. */
    differenceAmount: money.cost(amountMinor()),
    /** Lines that differ without a unit cost (or in another currency): their worth is unknown. */
    unvalued: z.number().int(),
  }),
  approval: output({
    /** Whether the differences need a second person: stored from SUBMITTED on, else what they would need now. */
    required: z.boolean(),
    /** The limit over which they do (a domain default until the Warehouse settings, W2b). */
    limitAmount: money.cost(amountMinor()),
    mayApprove: z.boolean(),
    /** Why the caller cannot approve, or null. */
    held: z.enum(['NOT_SUBMITTED', 'NO_RIGHT', 'OWN_VARIANCE']).nullable(),
    heldReason: z.string().nullable(),
  }),
  actions: output({
    edit: action,
    start: action,
    record: action,
    submit: action,
    approve: action,
    sendBack: action,
    apply: action,
    signOff: action,
    cancel: action,
  }),
})
export type CountRecordView = z.infer<typeof countRecordView>

export const lineView = output({
  id: id(),
  seq: z.number().int(),
  location: ref,
  item: output({ id: id(), code: z.string(), name: z.string(), kind: z.string(), tracking: z.enum(ITEM_TRACKINGS), uom: z.enum(UOMS) }),
  colour: ref.nullable(),
  lot: lotRef.nullable(),
  hide: output({ id: id(), code: z.string(), area: quantity() }).nullable(),
  origin: z.enum(COUNT_LINE_ORIGINS),
  expected: quantity(),
  counted: quantity().nullable(),
  countedAt: instant().nullable(),
  /** The caller typed the count (or the recount): never another person's name in a line. */
  countedByYou: z.boolean(),
  recount: output({ requestedAt: instant(), quantity: quantity().nullable(), at: instant().nullable() }).nullable(),
  /** The recount, else the count. */
  final: quantity().nullable(),
  difference: z.string().nullable(),
  /** Of what was expected, one decimal; null when nothing was expected. */
  percent: z.string().nullable(),
  status: z.enum(['UNCOUNTED', 'RECOUNT_DUE', 'COUNTED']),
  recountSuggested: z.boolean(),
  reasonCode: z.string().nullable(),
  reasonNote: z.string().nullable(),
  /** The COUNT move: posted (its id) once applied, else the one the difference would post. */
  move: output({ id: id().nullable(), direction: z.enum(['IN', 'OUT']), baseQuantity: quantity() }).nullable(),
  unitCost: money.cost(unitPrice().nullable()),
  /** The difference at the unit cost, signed like it. */
  differenceAmount: money.cost(amountMinor().nullable()),
  movedSinceSnapshot: z.boolean(),
  version: z.number().int(),
})
export type LineView = z.infer<typeof lineView>

// ---- reads ----------------------------------------------------------------------------------------------------------------

export const listCountsContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    status: z.enum(STOCK_COUNT_STATUSES).optional(),
    kind: z.enum(STOCK_COUNT_KINDS).optional(),
    /** Only counts not done yet (DRAFT to APPROVED, and an APPLIED year-end inventory not signed off). */
    open: flag,
    /**
     * B-W2b-15: the tiles' saved rows the state alone cannot say — waitingApproval (submitted over the limit) and toApply
     * (approved, or submitted under the limit): the same rows the tiles count.
     */
    view: z.enum(COUNT_LIST_VIEWS).optional(),
    /** In the number, the team or the note. */
    q: z.string().trim().min(1).max(80).optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
  response: { 200: output({ counts: z.array(countView), nextCursor: id().nullable() }) },
})

export const countTilesContract = defineContract({
  querystring: input({ siteId: id().optional() }),
  response: {
    200: output({
      drafts: z.number().int(),
      counting: z.number().int(),
      waitingApproval: z.number().int(),
      toApply: z.number().int(),
      /** Year-end inventories not signed off yet. */
      yearEnd: z.number().int(),
    }),
  },
})

/** B-W2b-15: the lines of a count per place (the Lines tab's place filter: every place with its line counts). */
export const placesContract = defineContract({
  params: countParams,
  response: {
    200: output({
      places: z.array(output({ location: output({ id: id(), code: z.string(), name: z.string(), path: z.string() }), lines: z.number().int(), counted: z.number().int(), differing: z.number().int() })),
    }),
  },
})

/**
 * B-W2b-15 (follow-up Z2:06): what a count names, by code or name — every item kind of the site's company and the
 * tenant's shared ones, finished garments (FINISHED, one per SKU) included, with their colours.
 */
export const countItemsContract = defineContract({
  querystring: input({
    siteId: id(),
    q: z.string().trim().min(1).max(80),
    kind: z.enum(COUNT_ITEM_KINDS).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  }),
  response: {
    200: output({
      items: z.array(
        output({
          id: id(),
          code: z.string(),
          name: z.string(),
          kind: z.enum(COUNT_ITEM_KINDS),
          baseUom: z.enum(UOMS),
          tracking: z.enum(ITEM_TRACKINGS),
          colours: z.array(output({ id: id(), code: z.string(), name: z.string() })),
        }),
      ),
    }),
  },
})

export const reasonsContract = defineContract({
  response: { 200: output({ reasons: z.array(output({ code: z.string(), labelIt: z.string(), labelEn: z.string(), needsDetail: z.boolean() })) }) },
})

export const getCountContract = defineContract({
  params: countParams,
  response: { 200: output({ count: countRecordView }) },
})

export const LINE_FILTERS = ['all', 'uncounted', 'differs', 'recount', 'added'] as const

export const listLinesContract = defineContract({
  params: countParams,
  querystring: input({
    filter: z.enum(LINE_FILTERS).default('all'),
    locationId: id().optional(),
    /** In the item, lot or hide code. */
    q: z.string().trim().min(1).max(80).optional(),
    /** The last line's seq of the page before. */
    cursor: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(COUNT_LIMITS.page).default(200),
  }),
  response: { 200: output({ lines: z.array(lineView), nextCursor: z.number().int().nullable() }) },
})

export const sheetsContract = defineContract({
  params: countParams,
  querystring: input({ expected: flag, language }),
  response: {},
})

export const valuedListContract = defineContract({
  params: countParams,
  querystring: input({ format: z.enum(['pdf', 'xlsx']).default('pdf'), language }),
  response: {},
})

// ---- writes ---------------------------------------------------------------------------------------------------------------

export const createCountContract = defineContract({
  body: input({
    siteId: id(),
    kind: z.enum(STOCK_COUNT_KINDS),
    /** A location and everything under it. */
    locationId: id().optional(),
    itemId: id().optional(),
    /** One lot (its item is the scope's item). */
    lotId: id().optional(),
    itemKind: z.enum(COUNT_ITEM_KINDS).optional(),
    /** YEAR_END only: the fiscal year's last day. */
    inventoryDate: businessDate().optional(),
    countTeam: z.string().trim().min(1).max(COUNT_LIMITS.team).optional(),
    note: z.string().trim().min(1).max(COUNT_LIMITS.note).optional(),
    /** Start counting at once (freeze the expected quantities in the same command). */
    start: z.boolean().optional(),
  }),
  response: { 201: output({ count: countRecordView }) },
})
export type CreateCountBody = z.infer<typeof createCountContract.body>

export const editCountContract = defineContract({
  params: countParams,
  body: input({ version, countTeam: optionalText(COUNT_LIMITS.team), note: optionalText(COUNT_LIMITS.note) }),
  response: { 200: output({ count: countRecordView }) },
})
export type EditCountBody = z.infer<typeof editCountContract.body>

const versionBody = input({ version })
export const startCountContract = defineContract({ params: countParams, body: versionBody, response: { 200: output({ count: countRecordView }) } })
export const submitCountContract = defineContract({ params: countParams, body: versionBody, response: { 200: output({ count: countRecordView }) } })

export const recordLinesContract = defineContract({
  params: countParams,
  body: input({
    lines: z
      .array(
        input({
          lineId: id(),
          version,
          /** What was counted (0: not found); null takes a typed count back. Left out: unchanged. */
          counted: z.string().trim().nullable().optional(),
          /** The recount asked for (replaces the count). */
          recount: z.string().trim().optional(),
          reasonCode: reasonCode.nullable().optional(),
          reasonNote: optionalText(COUNT_LIMITS.reasonNote),
        }),
      )
      .min(1)
      .max(COUNT_LIMITS.batch),
  }),
  response: { 200: output({ lines: z.array(lineView), counted: z.number().int(), all: z.number().int() }) },
})
export type RecordLinesBody = z.infer<typeof recordLinesContract.body>

export const addLineContract = defineContract({
  params: countParams,
  body: input({
    locationId: id(),
    itemId: id(),
    itemColourId: id().optional(),
    lotId: id().optional(),
    hideId: id().optional(),
    counted: z.string().trim(),
    reasonCode: reasonCode.optional(),
    reasonNote: z.string().trim().min(1).max(COUNT_LIMITS.reasonNote).optional(),
  }),
  response: { 201: output({ line: lineView }) },
})
export type AddLineBody = z.infer<typeof addLineContract.body>

export const removeLineContract = defineContract({
  params: input({ countId: id(), lineId: id() }),
  body: versionBody,
  response: { 200: output({ removed: id() }) },
})

export const recountContract = defineContract({
  params: countParams,
  body: input({ lineIds: z.array(id()).min(1).max(COUNT_LIMITS.batch) }),
  response: { 200: output({ lines: z.array(lineView) }) },
})

export const approveCountContract = defineContract({
  params: countParams,
  body: input({ version, note: z.string().trim().min(1).max(COUNT_LIMITS.note).optional() }),
  response: { 200: output({ count: countRecordView }) },
})

export const sendBackContract = defineContract({
  params: countParams,
  body: input({
    version,
    reason: z.string().trim().min(3).max(COUNT_LIMITS.reason),
    /** Lines to count again, asked in the same command. */
    recountLineIds: z.array(id()).max(COUNT_LIMITS.batch).optional(),
  }),
  response: { 200: output({ count: countRecordView }) },
})

export const applyCountContract = defineContract({
  params: countParams,
  body: versionBody.extend({
    periodLockOverride: periodLockOverride.optional(),
  }),
  response: {
    200: output({
      count: countRecordView,
      moves: z.array(output({ id: id(), lineId: id(), seq: z.number().int(), direction: z.enum(['IN', 'OUT']), baseQuantity: quantity() })),
    }),
  },
})

export const signOffContract = defineContract({
  params: countParams,
  body: input({
    version,
    /** The inventory's number, typed. */
    phrase: z.string().trim().min(1).max(80),
    /** The valued list's language (default Italian: the inventory book). */
    language,
  }),
  response: { 200: output({ count: countRecordView }) },
})

export const cancelCountContract = defineContract({
  params: countParams,
  body: input({ version, reason: z.string().trim().min(3).max(COUNT_LIMITS.reason) }),
  response: { 200: output({ count: countRecordView }) },
})
