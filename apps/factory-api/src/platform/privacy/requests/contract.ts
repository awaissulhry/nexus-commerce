import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { ERASURE_BLOCKED, ERASURE_LIMITS, KEPT_WHY } from '@nexus/factory-domain/privacy/retention/erasure'
import { DATA_REQUEST_KINDS, DATA_REQUEST_STATUSES, DATA_SUBJECT_KINDS, REQUEST_HELD, REQUEST_LIMITS } from '@nexus/factory-domain/privacy/retention/requests'
import { ERASURE_METHODS } from '@nexus/factory-domain/privacy/retention/retention'
import { presignedView } from '../../files/contract'

/**
 * Data requests, a person's package and their erasure (B-W2b-405; PLT-202, PLT-203; design admin.privacy "Data requests", "New
 * data request", "Anonymise …?"; shell.profile "Download my data"). Lengths here only stop oversized bodies; the domain answers
 * the rules in words. Every code comes with its words.
 */

const count = () => z.number().int().min(0)
const version = z.number().int().min(1)
const companyRef = output({ id: id(), code: z.string(), name: z.string() })
const personRef = output({ id: id(), name: z.string() })
const may = output({ allowed: z.boolean(), held: output({ code: z.enum(REQUEST_HELD), words: z.string() }).nullable() })

const packageView = output({ fileId: id(), name: z.string(), sizeBytes: z.number().int(), sha256: z.string(), madeAt: instant().nullable() })
const collectView = output({
  /** NONE: never asked; RUNNING: being collected (JobProgress); READY: the package is there; FAILED: why in `failure`. */
  state: z.enum(['NONE', 'RUNNING', 'READY', 'FAILED']),
  at: instant().nullable(),
  failure: z.string().nullable(),
})

export const requestView = output({
  id: id(),
  company: companyRef,
  person: output({ kind: z.enum(DATA_SUBJECT_KINDS), recordType: z.string(), recordId: id(), name: z.string(), erased: z.boolean() }),
  kind: z.enum(DATA_REQUEST_KINDS),
  receivedAt: instant(),
  /** The due time in force (the extended one once extended): the Countdown. */
  dueAt: instant(),
  originalDueAt: instant(),
  extended: z.boolean(),
  extensionReason: z.string().nullable(),
  overdue: z.boolean(),
  /** Whole hours left (negative when late). */
  hoursLeft: z.number().int(),
  note: z.string().nullable(),
  identityCheckedAt: instant().nullable(),
  identityCheckedBy: personRef.nullable(),
  status: z.enum(DATA_REQUEST_STATUSES),
  decidedAt: instant().nullable(),
  decidedBy: personRef.nullable(),
  refusalReason: z.string().nullable(),
  package: packageView.nullable(),
  /** An access request's package collection (null for the other kinds). */
  collect: collectView.nullable(),
  /** What an erasure did (null for the other kinds). */
  erasure: output({ records: count(), anonymised: count(), deleted: count(), kept: count() }).nullable(),
  version: z.number().int(),
  actions: output({ checkIdentity: may, extend: may, collect: may, openPackage: may, erase: may, close: may, refuse: may, withdraw: may }),
})

const requestParams = input({ requestId: id() })
const requestAnswer = { 200: output({ request: requestView }) }

export const listRequestsContract = defineContract({
  querystring: input({
    companyId: id().optional(),
    view: z.enum(['open', 'closed', 'all']).optional(),
    kind: z.enum(DATA_REQUEST_KINDS).optional(),
    personKind: z.enum(DATA_SUBJECT_KINDS).optional(),
  }),
  response: { 200: output({ requests: z.array(requestView), counts: output({ open: count(), overdue: count() }) }) },
})

export const getRequestContract = defineContract({ params: requestParams, response: requestAnswer })

export const createRequestContract = defineContract({
  body: input({
    companyId: id(),
    personKind: z.enum(DATA_SUBJECT_KINDS),
    /** WORKER: Worker or Employee; the other kinds have one record type (left out: that one). */
    personRecordType: z.string().max(60).optional(),
    personRecordId: id(),
    kind: z.enum(DATA_REQUEST_KINDS),
    /** When it came in (default now): the 30-day clock starts there. */
    receivedAt: z.string().max(40).optional(),
    note: z.string().max(REQUEST_LIMITS.note + 100).nullable().optional(),
  }),
  response: { 201: output({ request: requestView }) },
})

export const identityContract = defineContract({ params: requestParams, body: input({ version, how: z.string().max(REQUEST_LIMITS.reason + 100) }), response: requestAnswer })
export const extendContract = defineContract({ params: requestParams, body: input({ version, months: z.union([z.literal(1), z.literal(2)]), reason: z.string().max(REQUEST_LIMITS.extensionReason + 100) }), response: requestAnswer })
export const finishContract = defineContract({ params: requestParams, body: input({ version }), response: requestAnswer })
export const refuseRequestContract = defineContract({ params: requestParams, body: input({ version, reason: z.string().max(REQUEST_LIMITS.refusalReason + 100) }), response: requestAnswer })
export const withdrawContract = defineContract({ params: requestParams, body: input({ version, reason: z.string().max(REQUEST_LIMITS.reason + 100).optional() }), response: requestAnswer })
export const collectContract = defineContract({ params: requestParams, response: { 202: output({ request: requestView }) } })
export const packageContract = defineContract({ params: requestParams, response: { 200: output({ download: presignedView }) } })

// --- the erasure (PLT-203) ------------------------------------------------------------------------------------------------

const planGroup = output({
  recordType: z.string(),
  method: z.enum(ERASURE_METHODS),
  count: count(),
  erasedFields: z.array(z.string()),
  keptFields: z.array(z.string()),
  why: output({ code: z.enum(KEPT_WHY), words: z.string() }).nullable(),
})

export const erasurePreviewContract = defineContract({
  params: requestParams,
  response: {
    200: output({
      person: output({ kind: z.enum(DATA_SUBJECT_KINDS), recordType: z.string(), recordId: id(), name: z.string(), erased: z.boolean() }),
      /** Why the erasure cannot run now (a 409 at the erase), or null. */
      blocked: output({ code: z.enum(ERASURE_BLOCKED), words: z.string() }).nullable(),
      anonymised: z.array(planGroup),
      deleted: z.array(planGroup),
      /** What stays because the law requires it (or the database keeps it for now), with why. */
      kept: z.array(planGroup),
      records: count(),
      action: may,
    }),
  },
})

export const eraseContract = defineContract({
  params: requestParams,
  body: input({ version, reason: z.string().max(ERASURE_LIMITS.reason + 100), confirmName: z.string().max(ERASURE_LIMITS.confirmName) }),
  response: { 200: output({ request: requestView, erased: output({ anonymised: count(), deleted: count(), kept: count() }) }) },
})

// --- download my data (shell.profile) --------------------------------------------------------------------------------------

const myRequest = output({ id: id(), company: companyRef, kind: z.enum(DATA_REQUEST_KINDS), status: z.enum(DATA_REQUEST_STATUSES), receivedAt: instant(), dueAt: instant(), package: packageView.nullable(), collect: collectView.nullable() })
const myDataBody = { requests: z.array(myRequest), mayAsk: z.boolean(), companyId: id().nullable() }

export const myDataContract = defineContract({ response: { 200: output(myDataBody) } })
export const askMyDataContract = defineContract({ response: { 202: output({ requestId: id(), ...myDataBody }) } })
export const myPackageContract = defineContract({ params: requestParams, response: { 200: output({ download: presignedView }) } })
