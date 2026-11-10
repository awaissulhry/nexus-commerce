import { z } from 'zod'
import { REGISTER_KINDS, REGISTER_RISKS, REGISTER_STATUSES } from '@nexus/factory-domain/compliance/register/rules'
import {
  AUTHORITY_CHANNELS,
  DISTRIBUTOR_CHANNELS,
  DISTRIBUTOR_STATUSES,
  DRAFTED_CHANNELS,
  NOTICE_DECISIONS,
  NOTICE_STATUSES,
  RECALL_KINDS,
  RECALL_LIMITS,
  RECALL_STATUSES,
  REQUEST_DUE_STATES,
  REQUEST_STATUSES,
} from '@nexus/factory-domain/compliance/recall/rules'
import { HOLD_STATUSES, HOLD_SUBJECT_TYPES } from '@nexus/factory-domain/quality/holds/rules'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * Recall, withdrawal and authority's contracts (B-W2b-260; PRD-387, PRD-388, PRD-390; RG1:01, RG1:02). Instants are UTC ISO
 * strings, days business days (Europe/Rome). No field carries money; garment counts only. A person appears by name inside
 * one record (who sent, started, closed), never as a filter or a figure.
 */

const version = () => z.number().int().min(1)
const line = (max: number) => z.string().trim().min(1).max(max)
const text = (max: number) => z.string().trim().min(1).max(max)
const language = () => z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)
const marketCode = () => z.string().trim().regex(/^[A-Z]{2}(-[A-Za-z0-9]{1,8})*$/)
const words = (max: number) => z.record(language(), z.string().min(1).max(max))
const codes = (max: number) => z.array(z.string().trim().min(1).max(RECALL_LIMITS.code)).max(max)
const ids = (max: number) => z.array(id()).max(max)
const params = <K extends string>(...keys: K[]) => input(Object.fromEntries(keys.map((key) => [key, id()])) as Record<K, ReturnType<typeof id>>)

const person = output({ id: id(), name: z.string() }).nullable()
const named = output({ id: id(), code: z.string(), name: z.string() })
const entryRef = output({ id: id(), reference: z.string(), kind: z.enum(REGISTER_KINDS), risk: z.enum(REGISTER_RISKS), status: z.enum(REGISTER_STATUSES) })
const market = output({ code: z.string(), name: z.string() }).nullable()
const publicWords = output({ title: z.string(), problem: z.string(), action: z.string(), contact: z.string() })
const publicWordsIn = input({ title: line(RECALL_LIMITS.title), problem: text(RECALL_LIMITS.problem), action: text(RECALL_LIMITS.action), contact: text(RECALL_LIMITS.contact) })
const publicNoticeIn = z.record(language(), publicWordsIn)

// ---- authority notices (PRD-387) ----------------------------------------------------------------------------------------------

export const noticeView = output({
  id: id(),
  companyId: id(),
  entryId: id(),
  entry: entryRef,
  marketCode: z.string(),
  market,
  authorityName: z.string(),
  channel: z.enum(AUTHORITY_CHANNELS),
  decision: z.enum(NOTICE_DECISIONS),
  /** What the notice reports, per language (BCP 47). */
  words: z.record(z.string(), z.string()),
  status: z.enum(NOTICE_STATUSES),
  sentAt: instant().nullable(),
  /** The person who sent it (nothing goes to an authority by itself). */
  sentBy: person,
  /** The authority's reference (the Safety Business Gateway's, the PEC's protocol …). */
  reference: z.string().nullable(),
  /** The copy as sent (a file of this notice). */
  file: output({ id: id(), name: z.string(), sizeBytes: z.number().int(), status: z.string() }).nullable(),
  cancelledAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  note: z.string().nullable(),
  law: z.string(),
  version: z.number().int(),
  createdAt: instant(),
  may: output({ edit: z.boolean(), send: z.boolean(), reference: z.boolean(), cancel: z.boolean() }),
})
export type NoticeView = z.infer<typeof noticeView>

const oneNotice = { 200: output({ notice: noticeView }) }

export const listNoticesContract = defineContract({
  querystring: input({
    status: z.enum(NOTICE_STATUSES).optional(),
    entryId: id().optional(),
    companyId: id().optional(),
    marketCode: marketCode().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  }),
  response: {
    200: output({
      notices: z.array(noticeView),
      /** The register's tile "authority notices due or sent": drafts, sent this year, and open entries with a risk and no notice sent. */
      tiles: output({ drafts: z.number().int(), sentThisYear: z.number().int(), risksWithoutNotice: z.number().int() }),
    }),
  },
})

export const getNoticeContract = defineContract({ params: params('noticeId'), response: oneNotice })

export const draftNoticeContract = defineContract({
  params: params('entryId'),
  body: input({
    marketCode: marketCode(),
    authorityName: line(RECALL_LIMITS.authorityName),
    channel: z.enum(AUTHORITY_CHANNELS),
    /** Default: RISK when the entry's risk is YES, else NOT_CONFORMING. */
    decision: z.enum(NOTICE_DECISIONS).optional(),
    /** The words per language; default drafted from the entry in the market's DoC languages (else English). */
    words: words(RECALL_LIMITS.noticeWords).optional(),
    note: text(RECALL_LIMITS.note).optional(),
  }),
  response: { 201: output({ notice: noticeView }) },
})

export const editNoticeContract = defineContract({
  params: params('noticeId'),
  body: input({
    version: version(),
    authorityName: line(RECALL_LIMITS.authorityName).optional(),
    channel: z.enum(AUTHORITY_CHANNELS).optional(),
    decision: z.enum(NOTICE_DECISIONS).optional(),
    words: words(RECALL_LIMITS.noticeWords).optional(),
    note: text(RECALL_LIMITS.note).nullish(),
  }),
  response: oneNotice,
})

export const sendNoticeContract = defineContract({
  params: params('noticeId'),
  body: input({
    version: version(),
    /** When the person sent it; default now. */
    sentAt: instant().optional(),
    reference: line(RECALL_LIMITS.reference).optional(),
    /** The copy as sent: a file uploaded to this notice (POST /files with recordType AuthorityNotice). */
    fileId: id().optional(),
    note: text(RECALL_LIMITS.note).optional(),
  }),
  response: oneNotice,
})

export const noticeReferenceContract = defineContract({
  params: params('noticeId'),
  body: input({ version: version(), reference: line(RECALL_LIMITS.reference).optional(), fileId: id().optional() }),
  response: oneNotice,
})

const cancelContract = <K extends string, V extends z.ZodType>(key: K, view: V) =>
  defineContract({ params: params(key), body: input({ version: version(), reason: line(RECALL_LIMITS.reason) }), response: { 200: view } })

export const cancelNoticeContract = cancelContract('noticeId', output({ notice: noticeView }))

export const noticePdfContract = defineContract({
  params: params('noticeId'),
  querystring: input({ language: language().optional() }),
  /** application/pdf (the bytes). */
  response: {},
})

// ---- recalls and withdrawals (PRD-388) -------------------------------------------------------------------------------------

const progressSummary = output({
  customers: z.number().int(),
  unitsSent: z.number().int(),
  unitsReturned: z.number().int(),
  unitsRepaired: z.number().int(),
  unitsDestroyed: z.number().int(),
  unitsStillOut: z.number().int(),
  percentDone: z.number().int(),
})

export const recallRow = output({
  id: id(),
  companyId: id(),
  number: z.string(),
  kind: z.enum(RECALL_KINDS),
  status: z.enum(RECALL_STATUSES),
  entryId: id(),
  entry: entryRef,
  style: named,
  scope: output({ wholeStyle: z.boolean(), batchNumbers: z.array(z.string()), serialCount: z.number().int(), workOrderCount: z.number().int(), shipmentCount: z.number().int() }),
  notice: output({ languages: z.array(z.string()), publishedAt: instant().nullable(), publishedBy: person, withdrawnAt: instant().nullable(), live: z.boolean() }),
  progress: progressSummary,
  startedAt: instant().nullable(),
  startedBy: person,
  closedAt: instant().nullable(),
  closedBy: person,
  closeNote: z.string().nullable(),
  cancelledAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  note: z.string().nullable(),
  version: z.number().int(),
  createdAt: instant(),
})
export type RecallRow = z.infer<typeof recallRow>

const progressRow = output({
  id: id(),
  party: named,
  shipment: output({ id: id(), number: z.string() }).nullable(),
  unitsSent: z.number().int(),
  unitsReturned: z.number().int(),
  unitsRepaired: z.number().int(),
  unitsDestroyed: z.number().int(),
  unitsStillOut: z.number().int(),
  note: z.string().nullable(),
  version: z.number().int(),
})

export const recallDetail = recallRow.extend({
  serials: z.array(z.string()),
  workOrders: z.array(output({ id: id(), number: z.string(), batchNumber: z.string().nullable(), status: z.string() })),
  shipments: z.array(output({ id: id(), number: z.string(), status: z.string(), partyId: id() })),
  publicNotice: z.record(z.string(), publicWords).nullable(),
  progressRows: z.array(progressRow),
  /** Where the garments it calls back are (the register's trace over the scope). */
  trace: output({
    counts: output({ workOrders: z.number().int(), concerned: z.number().int(), released: z.number().int(), packed: z.number().int(), shipped: z.number().int(), returned: z.number().int(), customers: z.number().int() }),
    customers: z.array(output({ partyId: id(), code: z.string(), name: z.string(), garments: z.number().int(), shipmentNumbers: z.array(z.string()) })),
    problems: z.array(output({ path: z.string(), code: z.string(), message: z.string() })),
  }),
  /** The holds placed for it (quality/holds, sourceType RecallAction). */
  holds: z.array(output({ id: id(), number: z.string().nullable(), status: z.enum(HOLD_STATUSES), subjectType: z.enum(HOLD_SUBJECT_TYPES), subjects: z.number().int(), siteId: id() })),
  /** What could still be held now (not yet on hold): work orders, garments by serial, shipments not left. */
  holdable: output({ workOrders: z.number().int(), serials: z.number().int(), shipments: z.number().int() }),
  distributors: output({ told: z.number().int(), of: z.number().int(), allTold: z.boolean() }),
  law: output({ correctiveAction: z.string(), publicNotice: z.string(), distributors: z.string() }),
  may: output({ edit: z.boolean(), start: z.boolean(), hold: z.boolean(), publish: z.boolean(), withdrawNotice: z.boolean(), progress: z.boolean(), close: z.boolean(), cancel: z.boolean() }),
})
export type RecallDetail = z.infer<typeof recallDetail>

const oneRecall = { 200: output({ recall: recallDetail }) }

export const listRecallsContract = defineContract({
  querystring: input({
    status: z.enum(RECALL_STATUSES).optional(),
    kind: z.enum(RECALL_KINDS).optional(),
    entryId: id().optional(),
    styleId: id().optional(),
    companyId: id().optional(),
    q: z.string().trim().min(1).max(120).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  }),
  response: {
    200: output({
      recalls: z.array(recallRow),
      /** The register's tile "recalls in progress", and the units still out over them. */
      tiles: output({ active: z.number().int(), drafts: z.number().int(), noticesLive: z.number().int(), unitsStillOut: z.number().int() }),
    }),
  },
})

export const getRecallContract = defineContract({ params: params('recallId'), response: oneRecall })

const scopeIn = {
  wholeStyle: z.boolean().optional(),
  batchNumbers: codes(RECALL_LIMITS.batchNumbers).optional(),
  serials: codes(RECALL_LIMITS.serials).optional(),
  workOrderIds: ids(RECALL_LIMITS.workOrderIds).optional(),
  shipmentIds: ids(RECALL_LIMITS.shipmentIds).optional(),
}

export const draftRecallContract = defineContract({
  params: params('entryId'),
  body: input({
    kind: z.enum(RECALL_KINDS),
    /** The scope; left out entirely: the entry's own (its batches, serials, work orders, shipments, and its lots' work orders). */
    ...scopeIn,
    /** Material lots of the company: the work orders they were issued to join the scope (the trace). */
    lotIds: ids(50).optional(),
    /** The public notice; default drafted in these languages (default it, en). */
    publicNotice: publicNoticeIn.optional(),
    noticeLanguages: z.array(language()).max(RECALL_LIMITS.languages).optional(),
    note: text(RECALL_LIMITS.note).optional(),
  }),
  response: { 201: output({ recall: recallDetail }) },
})

export const editRecallContract = defineContract({
  params: params('recallId'),
  body: input({
    version: version(),
    /** A DRAFT's scope is replaced by what is given; once started, what is given is ADDED (a scope only widens). */
    ...scopeIn,
    /** Before it is published: the words; after: only new languages are added. */
    publicNotice: publicNoticeIn.optional(),
    note: text(RECALL_LIMITS.note).nullish(),
  }),
  response: oneRecall,
})

export const startRecallContract = defineContract({ params: params('recallId'), body: input({ version: version() }), response: oneRecall })

export const holdRecallContract = defineContract({
  params: params('recallId'),
  body: input({
    version: version(),
    /** A code of the HOLD reason list (Admin › Reasons). */
    reasonCode: z.string().trim().min(1).max(60),
    reasonNote: text(500).optional(),
    ownerId: id().optional(),
    note: text(2000).optional(),
  }),
  response: {
    200: output({
      recall: recallDetail,
      placed: z.array(output({ id: id(), number: z.string().nullable(), subjectType: z.enum(HOLD_SUBJECT_TYPES), subjects: z.number().int(), siteId: id() })),
      /** Already on hold (another hold names them): left as they are. */
      alreadyHeld: z.number().int(),
    }),
  },
})

export const publishNoticeContract = defineContract({
  params: params('recallId'),
  body: input({ version: version(), publicNotice: publicNoticeIn.optional() }),
  response: oneRecall,
})

export const withdrawNoticeContract = defineContract({ params: params('recallId'), body: input({ version: version(), note: text(RECALL_LIMITS.note).optional() }), response: oneRecall })

export const addProgressContract = defineContract({
  params: params('recallId'),
  body: input({
    partyId: id(),
    shipmentId: id().optional(),
    unitsSent: z.number().int().min(0).max(1_000_000),
    unitsReturned: z.number().int().min(0).max(1_000_000).optional(),
    unitsRepaired: z.number().int().min(0).max(1_000_000).optional(),
    unitsDestroyed: z.number().int().min(0).max(1_000_000).optional(),
    note: text(RECALL_LIMITS.note).optional(),
  }),
  response: { 201: output({ recall: recallDetail }) },
})

export const recordProgressContract = defineContract({
  params: params('recallId', 'progressId'),
  body: input({
    version: version(),
    unitsSent: z.number().int().min(0).max(1_000_000).optional(),
    unitsReturned: z.number().int().min(0).max(1_000_000).optional(),
    unitsRepaired: z.number().int().min(0).max(1_000_000).optional(),
    unitsDestroyed: z.number().int().min(0).max(1_000_000).optional(),
    note: text(RECALL_LIMITS.note).nullish(),
  }),
  response: oneRecall,
})

export const closeRecallContract = defineContract({
  params: params('recallId'),
  body: input({ version: version(), closeNote: text(RECALL_LIMITS.closeNote) }),
  response: oneRecall,
})

export const cancelRecallContract = cancelContract('recallId', output({ recall: recallDetail }))

// ---- distributors (RG1:02) -------------------------------------------------------------------------------------------------

export const distributorNoticeView = output({
  id: id(),
  companyId: id(),
  entryId: id(),
  recallId: id().nullable(),
  recallNumber: z.string().nullable(),
  party: named,
  channel: z.enum(DISTRIBUTOR_CHANNELS),
  contactName: z.string().nullable(),
  contact: z.string().nullable(),
  language: z.string(),
  subject: z.string().nullable(),
  message: z.string(),
  status: z.enum(DISTRIBUTOR_STATUSES),
  sentAt: instant().nullable(),
  sentBy: person,
  answeredAt: instant().nullable(),
  answer: z.string().nullable(),
  answeredByName: z.string().nullable(),
  failedAt: instant().nullable(),
  failureReason: z.string().nullable(),
  cancelledAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  /** The e-mail's state in the outbox (EMAIL only, once sent). */
  mail: output({ status: z.string() }).nullable(),
  note: z.string().nullable(),
  version: z.number().int(),
  createdAt: instant(),
  may: output({ edit: z.boolean(), send: z.boolean(), answer: z.boolean(), fail: z.boolean(), cancel: z.boolean() }),
})
export type DistributorNoticeView = z.infer<typeof distributorNoticeView>

const oneDistributorNotice = { 200: output({ notice: distributorNoticeView }) }

export const recipientsContract = defineContract({
  params: params('entryId'),
  response: {
    200: output({
      entryId: id(),
      /** "3 of 5 informed": recipients told (a notice to them left) of the customers that got the garments. */
      told: z.number().int(),
      of: z.number().int(),
      allTold: z.boolean(),
      /** W1's date on the entry (typed by hand, or set when the last recipient was told). */
      informedAt: instant().nullable(),
      recipients: z.array(
        output({
          party: output({ id: id(), code: z.string(), name: z.string(), language: z.string() }),
          garments: z.number().int(),
          shipmentNumbers: z.array(z.string()),
          contacts: z.array(output({ id: id(), name: z.string(), email: z.string().nullable(), phone: z.string().nullable(), language: z.string().nullable(), quality: z.boolean() })),
          told: z.boolean(),
          notices: z.array(distributorNoticeView),
        }),
      ),
      /** Notices to parties the trace does not name (a distributor told on purpose). */
      others: z.array(distributorNoticeView),
      law: z.string(),
      may: output({ draft: z.boolean(), send: z.boolean() }),
    }),
  },
})

const recipientIn = input({
  partyId: id(),
  channel: z.enum(DRAFTED_CHANNELS),
  /** The contact (PartyContact) to reach: its name, address or number and language fill what is left out. */
  contactId: id().optional(),
  contactName: line(RECALL_LIMITS.contactName).optional(),
  contact: line(320).optional(),
  language: z.string().regex(/^[a-z]{2,3}$/).optional(),
  subject: line(RECALL_LIMITS.subject).optional(),
  message: text(RECALL_LIMITS.message).optional(),
})

export const draftDistributorNoticesContract = defineContract({
  params: params('entryId'),
  body: input({
    /** The recall or withdrawal the notices tell of (of this entry). */
    recallId: id().optional(),
    /** Left out: every recipient of the trace not told yet, by e-mail to their quality (else first) contact with an address. */
    recipients: z.array(recipientIn).min(1).max(RECALL_LIMITS.recipients).optional(),
    note: text(RECALL_LIMITS.note).optional(),
  }),
  response: { 201: output({ notices: z.array(distributorNoticeView), skipped: z.array(output({ partyId: id(), reason: z.string() })) }) },
})

export const editDistributorNoticeContract = defineContract({
  params: params('noticeId'),
  body: input({
    version: version(),
    channel: z.enum(DRAFTED_CHANNELS).optional(),
    contactName: line(RECALL_LIMITS.contactName).nullish(),
    contact: line(320).nullish(),
    language: z.string().regex(/^[a-z]{2,3}$/).optional(),
    subject: line(RECALL_LIMITS.subject).nullish(),
    message: text(RECALL_LIMITS.message).optional(),
    note: text(RECALL_LIMITS.note).nullish(),
  }),
  response: oneDistributorNotice,
})

export const sendDistributorNoticesContract = defineContract({
  params: params('entryId'),
  body: input({
    /** The DRAFT notices to send, each once ("Send to 5 distributors"). */
    noticeIds: z.array(id()).min(1).max(RECALL_LIMITS.recipients),
    /** When a call or portal message was made; default now (an e-mail leaves now). */
    sentAt: instant().optional(),
  }),
  response: {
    200: output({
      notices: z.array(distributorNoticeView),
      /** A result per recipient: sent, or the problem in words (the others are sent all the same). */
      results: z.array(output({ noticeId: id(), sent: z.boolean(), problem: z.string().nullable() })),
      /** Whether this send told the last recipient, and W1's date was set on the entry. */
      distributorsInformed: z.boolean(),
      told: z.number().int(),
      of: z.number().int(),
    }),
  },
})

export const answerDistributorNoticeContract = defineContract({
  params: params('noticeId'),
  body: input({ version: version(), answeredAt: instant().optional(), answer: text(RECALL_LIMITS.answer), answeredByName: line(RECALL_LIMITS.answeredByName).optional() }),
  response: oneDistributorNotice,
})

export const failDistributorNoticeContract = defineContract({
  params: params('noticeId'),
  body: input({ version: version(), failedAt: instant().optional(), reason: line(RECALL_LIMITS.reason) }),
  response: oneDistributorNotice,
})

export const cancelDistributorNoticeContract = cancelContract('noticeId', output({ notice: distributorNoticeView }))

// ---- authority requests (PRD-390) -----------------------------------------------------------------------------------------

export const requestView = output({
  id: id(),
  companyId: id(),
  number: z.string(),
  authorityName: z.string(),
  marketCode: z.string(),
  market,
  authorityReference: z.string().nullable(),
  channel: z.enum(AUTHORITY_CHANNELS),
  receivedAt: instant(),
  style: named.nullable(),
  batchNumbers: z.array(z.string()),
  request: z.string(),
  dueOn: businessDate(),
  /** The Countdown: OVERDUE, DUE_TODAY, DUE_SOON (≤ 7 days), OPEN; ANSWERED or CANCELLED once done. */
  due: output({ state: z.enum(REQUEST_DUE_STATES), daysLeft: z.number().int().nullable() }),
  status: z.enum(REQUEST_STATUSES),
  answeredAt: instant().nullable(),
  answeredBy: person,
  answerSummary: z.string().nullable(),
  /** The evidence sent (B-W2b-251's evidence pack, by record type + id), with the pack's state when it is one. */
  evidence: output({
    type: z.string(),
    id: id(),
    pack: output({ id: id(), number: z.string(), status: z.string(), purpose: z.string(), links: z.number().int(), builtAt: instant().nullable() }).nullable(),
  }).nullable(),
  entry: entryRef.nullable(),
  cancelledAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  note: z.string().nullable(),
  law: z.string(),
  version: z.number().int(),
  createdAt: instant(),
  may: output({ edit: z.boolean(), answer: z.boolean(), cancel: z.boolean(), entry: z.boolean(), evidence: z.boolean() }),
})
export type RequestView = z.infer<typeof requestView>

const oneRequest = { 200: output({ request: requestView }) }

export const listRequestsContract = defineContract({
  querystring: input({
    status: z.enum(REQUEST_STATUSES).optional(),
    due: z.enum(['OVERDUE', 'DUE_SOON']).optional(),
    entryId: id().optional(),
    styleId: id().optional(),
    companyId: id().optional(),
    q: z.string().trim().min(1).max(120).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  }),
  response: {
    200: output({
      requests: z.array(requestView),
      tiles: output({ open: z.number().int(), overdue: z.number().int(), dueSoon: z.number().int(), answeredThisYear: z.number().int() }),
    }),
  },
})

export const getRequestContract = defineContract({ params: params('requestId'), response: oneRequest })

export const logRequestContract = defineContract({
  body: input({
    companyId: id(),
    authorityName: line(RECALL_LIMITS.authorityName),
    marketCode: marketCode(),
    authorityReference: line(RECALL_LIMITS.reference).optional(),
    channel: z.enum(AUTHORITY_CHANNELS),
    receivedAt: instant(),
    styleId: id().optional(),
    batchNumbers: codes(1000).optional(),
    request: text(RECALL_LIMITS.requestText),
    dueOn: businessDate(),
    registerEntryId: id().optional(),
    note: text(RECALL_LIMITS.note).optional(),
  }),
  response: { 201: output({ request: requestView }) },
})

export const editRequestContract = defineContract({
  params: params('requestId'),
  body: input({
    version: version(),
    authorityName: line(RECALL_LIMITS.authorityName).optional(),
    marketCode: marketCode().optional(),
    authorityReference: line(RECALL_LIMITS.reference).nullish(),
    channel: z.enum(AUTHORITY_CHANNELS).optional(),
    receivedAt: instant().optional(),
    styleId: id().nullish(),
    batchNumbers: codes(1000).optional(),
    request: text(RECALL_LIMITS.requestText).optional(),
    dueOn: businessDate().optional(),
    note: text(RECALL_LIMITS.note).nullish(),
  }),
  response: oneRequest,
})

export const requestEntryContract = defineContract({
  params: params('requestId'),
  /** Name an entry of the request's style, or leave it out to open a new AUTHORITY_REQUEST entry from the request. */
  body: input({ version: version(), registerEntryId: id().optional() }),
  response: oneRequest,
})

export const requestEvidenceContract = defineContract({
  params: params('requestId'),
  /** Name an evidence pack built already, or ask one built from the style's technical file for the request's batches. */
  body: input({ version: version(), packId: id().optional(), language: z.string().regex(/^[a-z]{2,3}$/).optional(), note: text(1000).optional() }),
  response: oneRequest,
})

export const answerRequestContract = defineContract({
  params: params('requestId'),
  body: input({ version: version(), answeredAt: instant().optional(), answerSummary: text(RECALL_LIMITS.answerSummary), packId: id().optional() }),
  response: oneRequest,
})

export const cancelRequestContract = cancelContract('requestId', output({ request: requestView }))

// ---- an entry's W2b parts ---------------------------------------------------------------------------------------------------

export const surveillanceContract = defineContract({
  params: params('entryId'),
  response: {
    200: output({
      entry: entryRef.extend({ authorityNotifiedAt: instant().nullable(), authorityReference: z.string().nullable(), distributorsInformedAt: instant().nullable() }),
      notices: z.array(noticeView),
      requests: z.array(requestView),
      recalls: z.array(recallRow),
      distributors: output({ told: z.number().int(), of: z.number().int(), allTold: z.boolean() }),
      law: output({ authorityNotice: z.string(), authorityRequest: z.string(), distributors: z.string(), correctiveAction: z.string(), publicNotice: z.string() }),
      may: output({ manage: z.boolean(), send: z.boolean() }),
    }),
  },
})
