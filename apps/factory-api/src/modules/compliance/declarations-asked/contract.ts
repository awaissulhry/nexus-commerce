import { z } from 'zod'
import { ASK_CHANNELS, DECLARATION_CHANNELS, DECLARATION_STATUSES, SHOWN_STATUSES } from '@nexus/factory-domain/compliance/declarations-asked/rules'
import { DECLARATION_KINDS, SUBSTANCE_UNITS } from '@nexus/factory-domain/compliance/substances/rules'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * Declarations asked of suppliers (B-W2b-256; PRD-304; design compliance.tests › Supplier declarations, the Request
 * declarations pop-up and the Supplier declaration record). Numbers, suppliers by code and name, materials by code and
 * name, kinds, days, counts, states; the decider's name as the supplier reads it. No price, no cost, no lab price.
 */

const version = () => z.number().int().min(1)
const day = businessDate
const listVersion = output({ id: id(), publishedOn: z.string() })

const requestView = output({
  id: id(),
  number: z.string(),
  companyId: id(),
  party: output({ id: id(), code: z.string(), name: z.string() }),
  kind: z.enum(DECLARATION_KINDS),
  /** "SVHC", "Nickel release". */
  kindShort: z.string(),
  kindWords: z.string(),
  /** REACH SVHC: the Candidate List version asked about, and the one the answer states. */
  svhcListVersion: listVersion.nullable(),
  answeredListVersion: listVersion.nullable(),
  channel: z.enum(DECLARATION_CHANNELS),
  sentAt: instant(),
  dueOn: day(),
  overdueDays: z.number().int(),
  reminderEveryDays: z.number().int().nullable(),
  remindersSent: z.number().int(),
  lastRemindedAt: instant().nullable(),
  /** The request's own cadence came (a portal request is reminded by the hourly job; one asked by the office is the office's to remind). */
  reminderDue: z.boolean(),
  status: z.enum(DECLARATION_STATUSES),
  /** What the list shows: Requested, Overdue, Answered, Accepted, Rejected, Expired, Re-request needed (the Candidate List grew), Cancelled. */
  shown: z.enum(SHOWN_STATUSES),
  answeredAt: instant().nullable(),
  validTo: day().nullable(),
  file: output({ source: z.enum(['UPLOAD', 'FILE']), uploadId: id().nullable(), fileId: id().nullable(), uploadStatus: z.string().nullable() }).nullable(),
  materials: z.array(output({ itemId: id(), code: z.string(), name: z.string(), kind: z.string(), articleLabel: z.string() })),
  lines: z.number().int(),
  answeredLines: z.number().int(),
  supersedesId: id().nullable(),
  supersededBy: output({ id: id(), number: z.string() }).nullable(),
  version: z.number().int(),
})

const lineView = output({
  id: id(),
  seq: z.number().int(),
  item: output({ id: id(), code: z.string(), name: z.string(), kind: z.string() }),
  articleLabel: z.string(),
  contains: z.boolean().nullable(),
  aboveThreshold: z.boolean().nullable(),
  substance: output({ id: id(), casNumber: z.string().nullable(), name: z.string() }).nullable(),
  substanceName: z.string().nullable(),
  concentration: z.string().nullable(),
  concentrationUnit: z.enum(SUBSTANCE_UNITS).nullable(),
  note: z.string().nullable(),
  version: z.number().int(),
})

const newestVersion = output({ id: id(), publishedOn: day(), entryCount: z.number().int() }).nullable()

const requestDetail = requestView.extend({
  message: z.string().nullable(),
  internalNote: z.string().nullable(),
  lineRows: z.array(lineView),
  upload: output({
    id: id(),
    fileId: id(),
    status: z.string(),
    category: z.string(),
    issuer: z.string().nullable(),
    documentNumber: z.string().nullable(),
    issuedOn: day().nullable(),
    expiresOn: day().nullable(),
    receivedAt: instant().nullable(),
    uploadedByName: z.string(),
    documentFileId: id().nullable(),
  }).nullable(),
  partnerTask: output({ id: id(), status: z.string(), dueAt: instant().nullable(), remindedAt: instant().nullable(), closedAt: instant().nullable() }).nullable(),
  decidedAt: instant().nullable(),
  decidedBy: output({ id: id().nullable(), name: z.string() }).nullable(),
  refuseReason: z.string().nullable(),
  cancelledAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  supersedes: output({ id: id(), number: z.string(), status: z.string() }).nullable(),
  newestListVersion: newestVersion,
})

const params = input({ requestId: id() })
const recordAnswer = { 200: output({ request: requestDetail, at: instant() }) }

export const listRequestsContract = defineContract({
  querystring: input({
    /** A status or several, comma separated (SENT,OVERDUE). */
    status: z.string().trim().regex(/^[A-Z,]{1,80}$/).optional(),
    shown: z.enum(SHOWN_STATUSES).optional(),
    kind: z.enum(DECLARATION_KINDS).optional(),
    partyId: id().optional(),
    itemId: id().optional(),
    q: z.string().trim().min(1).max(100).optional(),
  }),
  response: {
    200: output({
      requests: z.array(requestView),
      more: z.boolean(),
      /** The tiles: open, overdue, answered (to decide), to ask again (the Candidate List grew), expired. */
      counts: output({ open: z.number().int(), overdue: z.number().int(), answered: z.number().int(), rerequest: z.number().int(), expired: z.number().int() }),
      newestListVersion: newestVersion,
      mayAsk: z.boolean(),
      asOf: instant(),
    }),
  },
})

export const getRequestContract = defineContract({ params, response: { 200: output({ request: requestDetail, mayManage: z.boolean(), asOf: instant() }) } })

const groupView = output({
  party: output({ id: id(), code: z.string(), name: z.string(), portalOn: z.boolean() }),
  kind: z.enum(DECLARATION_KINDS),
  kindShort: z.string(),
  channel: z.enum(ASK_CHANNELS).nullable(),
  /** SEND a new request, ADD the materials to the supplier's open one of that kind, SKIP (why). */
  outcome: z.enum(['SEND', 'ADD', 'SKIP']),
  why: z.string().nullable(),
  materials: z.array(output({ itemId: id(), code: z.string(), name: z.string(), articleLabel: z.string() })),
  request: output({ requestId: id(), number: z.string() }).nullable(),
})

export const askContract = defineContract({
  body: input({
    materials: z.array(input({ itemId: id(), partyId: id().nullable().optional() })).min(1).max(100),
    kinds: z.array(z.enum(DECLARATION_KINDS)).min(1).max(DECLARATION_KINDS.length),
    dueOn: day(),
    reminderEveryDays: z.number().int().min(1).max(90).nullable().optional(),
    message: z.string().max(2000).nullable().optional(),
    channel: z.enum(DECLARATION_CHANNELS).nullable().optional(),
    companyId: id().nullable().optional(),
    /** true: the review per supplier, nothing written. */
    dryRun: z.boolean().optional(),
  }),
  response: {
    200: output({
      sent: z.boolean(),
      companyId: id(),
      svhcListVersion: output({ id: id(), publishedOn: day(), entryCount: z.number().int() }).nullable(),
      groups: z.array(groupView),
      counts: output({ send: z.number().int(), add: z.number().int(), skip: z.number().int() }),
    }),
  },
})

export const remindContract = defineContract({ params, body: input({ version: version() }), response: recordAnswer })

const lineBody = input({
  lineId: id().nullable().optional(),
  itemId: id().nullable().optional(),
  contains: z.boolean().nullable(),
  aboveThreshold: z.boolean().nullable().optional(),
  substanceId: id().nullable().optional(),
  substanceName: z.string().max(300).nullable().optional(),
  /** A number from 0, up to 6 decimals ("0.15"). */
  concentration: z.string().trim().max(24).nullable().optional(),
  concentrationUnit: z.enum(SUBSTANCE_UNITS).nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
})

export const answerContract = defineContract({
  params,
  body: input({
    version: version(),
    uploadId: id().nullable().optional(),
    fileId: id().nullable().optional(),
    validTo: day().nullable().optional(),
    answeredListVersionId: id().nullable().optional(),
    lines: z.array(lineBody).max(200).optional(),
  }),
  response: recordAnswer,
})

export const linesContract = defineContract({ params, body: input({ version: version(), lines: z.array(lineBody).max(200), removeLineIds: z.array(id()).max(200).optional() }), response: recordAnswer })

export const acceptContract = defineContract({ params, body: input({ version: version(), validTo: day().nullable().optional(), answeredListVersionId: id().nullable().optional() }), response: recordAnswer })

export const refuseContract = defineContract({ params, body: input({ version: version(), reason: z.string().max(600) }), response: recordAnswer })

export const cancelContract = defineContract({ params, body: input({ version: version(), reason: z.string().max(600) }), response: { 200: output({ request: requestView }) } })

export const askAgainContract = defineContract({
  params,
  body: input({
    version: version(),
    dueOn: day(),
    reminderEveryDays: z.number().int().min(1).max(90).nullable().optional(),
    message: z.string().max(2000).nullable().optional(),
    channel: z.enum(DECLARATION_CHANNELS).nullable().optional(),
  }),
  response: { 200: output({ request: requestView, previous: output({ id: id(), number: z.string(), status: z.enum(DECLARATION_STATUSES) }), at: instant() }) },
})
