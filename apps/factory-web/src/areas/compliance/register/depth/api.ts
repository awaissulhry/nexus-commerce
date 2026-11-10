import { z } from 'zod'
import {
  AUTHORITY_CHANNELS,
  DISTRIBUTOR_CHANNELS,
  DISTRIBUTOR_STATUSES,
  DRAFTED_CHANNELS,
  NOTICE_DECISIONS,
  NOTICE_STATUSES,
  RECALL_KINDS,
  RECALL_STATUSES,
  REQUEST_DUE_STATES,
  REQUEST_STATUSES,
} from '@nexus/factory-domain/compliance/recall/rules'
import { REGISTER_KINDS, REGISTER_RISKS, REGISTER_STATUSES } from '@nexus/factory-domain/compliance/register/rules'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { completeUpload, requestUpload } from '../../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../../record-panels/store'

/**
 * Every call of the register in depth (B-W2b-271 on B-W2b-260's API, apps/factory-api modules/compliance/recall): the
 * entry's W2b parts in one read (`/surveillance`), authority notices (draft, words, the PDF, marked as sent by a person
 * with a fresh code, the reference and the copy later), recalls and withdrawals (scope, holds, start, the public notice,
 * progress, close), the distributors told one by one, and the authority requests. Each answer is checked with a zod shape
 * that mirrors the API's contract (unknown fields are ignored). The API's English sentences are data (a refusal's facts),
 * never the screen's words.
 */

export { AUTHORITY_CHANNELS, DISTRIBUTOR_CHANNELS, DISTRIBUTOR_STATUSES, DRAFTED_CHANNELS, NOTICE_DECISIONS, NOTICE_STATUSES, RECALL_KINDS, RECALL_STATUSES, REQUEST_DUE_STATES, REQUEST_STATUSES }
export type AuthorityChannel = (typeof AUTHORITY_CHANNELS)[number]
export type NoticeDecision = (typeof NOTICE_DECISIONS)[number]
export type NoticeStatus = (typeof NOTICE_STATUSES)[number]
export type RecallKind = (typeof RECALL_KINDS)[number]
export type RecallStatus = (typeof RECALL_STATUSES)[number]
export type DistributorChannel = (typeof DISTRIBUTOR_CHANNELS)[number]
export type DraftedChannel = (typeof DRAFTED_CHANNELS)[number]
export type DistributorStatus = (typeof DISTRIBUTOR_STATUSES)[number]
export type RequestStatus = (typeof REQUEST_STATUSES)[number]
export type RequestDueState = (typeof REQUEST_DUE_STATES)[number]

const seg = encodeURIComponent
const person = z.object({ id: z.string(), name: z.string() }).nullable()
const named = z.object({ id: z.string(), code: z.string(), name: z.string() })
const entryRef = z.object({ id: z.string(), reference: z.string(), kind: z.enum(REGISTER_KINDS), risk: z.enum(REGISTER_RISKS), status: z.enum(REGISTER_STATUSES) })
const market = z.object({ code: z.string(), name: z.string() }).nullable()
const publicWords = z.object({ title: z.string(), problem: z.string(), action: z.string(), contact: z.string() })
export type PublicWords = z.infer<typeof publicWords>

// ---- authority notices --------------------------------------------------------------------------------------------------------

export const noticeSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  entryId: z.string(),
  entry: entryRef,
  marketCode: z.string(),
  market,
  authorityName: z.string(),
  channel: z.enum(AUTHORITY_CHANNELS),
  decision: z.enum(NOTICE_DECISIONS),
  words: z.record(z.string(), z.string()),
  status: z.enum(NOTICE_STATUSES),
  sentAt: z.string().nullable(),
  sentBy: person,
  reference: z.string().nullable(),
  file: z.object({ id: z.string(), name: z.string(), sizeBytes: z.number(), status: z.string() }).nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  note: z.string().nullable(),
  law: z.string(),
  version: z.number(),
  createdAt: z.string(),
  may: z.object({ edit: z.boolean(), send: z.boolean(), reference: z.boolean(), cancel: z.boolean() }),
})
export type AuthorityNotice = z.infer<typeof noticeSchema>
const oneNotice = z.object({ notice: noticeSchema })

export const noticeTilesSchema = z.object({ drafts: z.number(), sentThisYear: z.number(), risksWithoutNotice: z.number() })
export type NoticeTiles = z.infer<typeof noticeTilesSchema>

/** The register's tile "Authority notices due or sent" (`GET /compliance/authority-notices`, one row asked: the tiles count every notice). */
export const noticeTiles = (api: ApiClient, signal?: AbortSignal): Promise<NoticeTiles> =>
  api.get('/compliance/authority-notices', { query: { limit: 1 }, schema: z.object({ tiles: noticeTilesSchema }), signal }).then((answer) => answer.tiles)

export interface DraftNoticeBody {
  readonly marketCode: string
  readonly authorityName: string
  readonly channel: AuthorityChannel
  readonly decision?: NoticeDecision
  readonly note?: string
}

export const draftNotice = (api: ApiClient, entryId: string, body: DraftNoticeBody, idempotencyKey: string): Promise<AuthorityNotice> =>
  api.post(`/compliance/register/${seg(entryId)}/authority-notices`, { body, schema: oneNotice, idempotencyKey }).then((answer) => answer.notice)

export const getNotice = (api: ApiClient, noticeId: string, signal?: AbortSignal): Promise<AuthorityNotice> =>
  api.get(`/compliance/authority-notices/${seg(noticeId)}`, { schema: oneNotice, signal }).then((answer) => answer.notice)

export interface EditNoticeBody {
  readonly authorityName?: string
  readonly channel?: AuthorityChannel
  readonly decision?: NoticeDecision
  readonly words?: Readonly<Record<string, string>>
}

export const editNotice = (api: ApiClient, noticeId: string, version: number, body: EditNoticeBody): Promise<AuthorityNotice> =>
  api.request('PATCH', `/compliance/authority-notices/${seg(noticeId)}`, { body: { version, ...body }, schema: oneNotice, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.notice)

/** "Mark notice as sent" (compliance.recall.send + a fresh code): the person who sent it, when, the authority's reference, the copy. */
export const markNoticeSent = (api: ApiClient, noticeId: string, version: number, body: { sentAt?: string; reference?: string; fileId?: string }, idempotencyKey: string): Promise<AuthorityNotice> =>
  api.post(`/compliance/authority-notices/${seg(noticeId)}/sent`, { body: { version, ...body }, schema: oneNotice, idempotencyKey }).then((answer) => answer.notice)

/** A SENT notice's reference or copy, each once. */
export const noticeReference = (api: ApiClient, noticeId: string, version: number, body: { reference?: string; fileId?: string }): Promise<AuthorityNotice> =>
  api.post(`/compliance/authority-notices/${seg(noticeId)}/reference`, { body: { version, ...body }, schema: oneNotice, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.notice)

export const cancelNotice = (api: ApiClient, noticeId: string, version: number, reason: string): Promise<AuthorityNotice> =>
  api.post(`/compliance/authority-notices/${seg(noticeId)}/cancel`, { body: { version, reason }, schema: oneNotice, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.notice)

/** The notice as the authority's paper, made on the fly (a DRAFT says so on the page). */
export const noticePdfBytes = (api: ApiClient, noticeId: string, language: string | null, signal?: AbortSignal): Promise<Uint8Array> =>
  api.bytes(`/compliance/authority-notices/${seg(noticeId)}/pdf`, { ...(language ? { query: { language } } : {}), signal })

/** The copy as sent onto the notice (files.upload: announce, send the bytes, confirm); its id back. */
export async function uploadNoticeCopy(api: ApiClient, notice: Pick<AuthorityNotice, 'id' | 'companyId'>, file: File): Promise<string> {
  const bytes = await file.arrayBuffer()
  const contentType = file.type || 'application/pdf'
  const { file: stored, upload } = await requestUpload(api, {
    companyId: notice.companyId,
    record: { type: 'AuthorityNotice', id: notice.id },
    kind: contentType === 'application/pdf' ? 'DOCUMENT' : 'ATTACHMENT',
    name: file.name || 'notice.pdf',
    contentType,
    sizeBytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    visibility: ['OFFICE'],
    floorSiteId: null,
    partyId: null,
  })
  await putToStore(upload, bytes)
  await completeUpload(api, stored.id)
  return stored.id
}

// ---- markets (the notice's market: B-W2b-249's profiles) --------------------------------------------------------------------

export const marketOptionSchema = z.object({ code: z.string(), name: z.string(), docLanguages: z.array(z.string()), status: z.enum(['ACTIVE', 'ARCHIVED']) })
export type MarketOption = z.infer<typeof marketOptionSchema>

/** The tenant's market profiles (compliance.certificates.view); a notice names one. */
export const listMarkets = (api: ApiClient, signal?: AbortSignal): Promise<MarketOption[]> =>
  api.get('/compliance/rules/markets', { query: { status: 'ACTIVE' }, schema: z.object({ markets: z.array(marketOptionSchema) }), signal }).then((answer) => answer.markets)

// ---- recalls and withdrawals ----------------------------------------------------------------------------------------------

const progressSummary = z.object({
  customers: z.number(),
  unitsSent: z.number(),
  unitsReturned: z.number(),
  unitsRepaired: z.number(),
  unitsDestroyed: z.number(),
  unitsStillOut: z.number(),
  percentDone: z.number(),
})
export type ProgressSummary = z.infer<typeof progressSummary>

export const recallRowSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  number: z.string(),
  kind: z.enum(RECALL_KINDS),
  status: z.enum(RECALL_STATUSES),
  entryId: z.string(),
  entry: entryRef,
  style: named,
  scope: z.object({ wholeStyle: z.boolean(), batchNumbers: z.array(z.string()), serialCount: z.number(), workOrderCount: z.number(), shipmentCount: z.number() }),
  notice: z.object({ languages: z.array(z.string()), publishedAt: z.string().nullable(), publishedBy: person, withdrawnAt: z.string().nullable(), live: z.boolean() }),
  progress: progressSummary,
  startedAt: z.string().nullable(),
  startedBy: person,
  closedAt: z.string().nullable(),
  closedBy: person,
  closeNote: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  note: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
})
export type RecallRow = z.infer<typeof recallRowSchema>

export const progressRowSchema = z.object({
  id: z.string(),
  party: named,
  shipment: z.object({ id: z.string(), number: z.string() }).nullable(),
  unitsSent: z.number(),
  unitsReturned: z.number(),
  unitsRepaired: z.number(),
  unitsDestroyed: z.number(),
  unitsStillOut: z.number(),
  note: z.string().nullable(),
  version: z.number(),
})
export type ProgressRow = z.infer<typeof progressRowSchema>

export const recallDetailSchema = recallRowSchema.extend({
  serials: z.array(z.string()),
  workOrders: z.array(z.object({ id: z.string(), number: z.string(), batchNumber: z.string().nullable(), status: z.string() })),
  shipments: z.array(z.object({ id: z.string(), number: z.string(), status: z.string(), partyId: z.string() })),
  publicNotice: z.record(z.string(), publicWords).nullable(),
  progressRows: z.array(progressRowSchema),
  trace: z.object({
    counts: z.object({ workOrders: z.number(), concerned: z.number(), released: z.number(), packed: z.number(), shipped: z.number(), returned: z.number(), customers: z.number() }),
    customers: z.array(z.object({ partyId: z.string(), code: z.string(), name: z.string(), garments: z.number(), shipmentNumbers: z.array(z.string()) })),
    problems: z.array(z.object({ path: z.string(), code: z.string(), message: z.string() })),
  }),
  holds: z.array(z.object({ id: z.string(), number: z.string().nullable(), status: z.string(), subjectType: z.string(), subjects: z.number(), siteId: z.string() })),
  holdable: z.object({ workOrders: z.number(), serials: z.number(), shipments: z.number() }),
  distributors: z.object({ told: z.number(), of: z.number(), allTold: z.boolean() }),
  law: z.object({ correctiveAction: z.string(), publicNotice: z.string(), distributors: z.string() }),
  may: z.object({ edit: z.boolean(), start: z.boolean(), hold: z.boolean(), publish: z.boolean(), withdrawNotice: z.boolean(), progress: z.boolean(), close: z.boolean(), cancel: z.boolean() }),
})
export type RecallDetail = z.infer<typeof recallDetailSchema>
const oneRecall = z.object({ recall: recallDetailSchema })

export const recallTilesSchema = z.object({ active: z.number(), drafts: z.number(), noticesLive: z.number(), unitsStillOut: z.number() })
export type RecallTiles = z.infer<typeof recallTilesSchema>

/** The register's tile "Recalls in progress": the ACTIVE ones (their entries) and the tiles over every recall. */
export const activeRecalls = (api: ApiClient, signal?: AbortSignal): Promise<{ recalls: RecallRow[]; tiles: RecallTiles }> =>
  api.get('/compliance/recalls', { query: { status: 'ACTIVE', limit: 500 }, schema: z.object({ recalls: z.array(recallRowSchema), tiles: recallTilesSchema }), signal })

export const getRecall = (api: ApiClient, recallId: string, signal?: AbortSignal): Promise<RecallDetail> =>
  api.get(`/compliance/recalls/${seg(recallId)}`, { schema: oneRecall, signal }).then((answer) => answer.recall)

/** A new recall or withdrawal of the entry: its scope the entry's own (batches, serials, work orders, shipments, lots). */
export const draftRecall = (api: ApiClient, entryId: string, kind: RecallKind, idempotencyKey: string): Promise<RecallDetail> =>
  api.post(`/compliance/register/${seg(entryId)}/recalls`, { body: { kind }, schema: oneRecall, idempotencyKey }).then((answer) => answer.recall)

export interface RecallScopeBody {
  readonly wholeStyle?: boolean
  readonly batchNumbers?: readonly string[]
  readonly serials?: readonly string[]
}

/** A DRAFT's scope is replaced by what is given; an ACTIVE one only widens. The public notice: its words (a published one only gains languages). */
export const editRecall = (api: ApiClient, recallId: string, version: number, body: RecallScopeBody & { publicNotice?: Readonly<Record<string, PublicWords>> }): Promise<RecallDetail> =>
  api
    .request('PATCH', `/compliance/recalls/${seg(recallId)}`, {
      body: {
        version,
        ...(body.wholeStyle !== undefined ? { wholeStyle: body.wholeStyle } : {}),
        ...(body.batchNumbers ? { batchNumbers: [...body.batchNumbers] } : {}),
        ...(body.serials ? { serials: [...body.serials] } : {}),
        ...(body.publicNotice ? { publicNotice: body.publicNotice } : {}),
      },
      schema: oneRecall,
      idempotencyKey: newIdempotencyKey(),
    })
    .then((answer) => answer.recall)

export const holdsAnswer = z.object({
  recall: recallDetailSchema,
  placed: z.array(z.object({ id: z.string(), number: z.string().nullable(), subjectType: z.string(), subjects: z.number(), siteId: z.string() })),
  alreadyHeld: z.number(),
})
export type HoldsAnswer = z.infer<typeof holdsAnswer>

/** Block what is still here: one hold per kind and site (quality/holds, sourceType RecallAction). */
export const holdRecall = (api: ApiClient, recallId: string, version: number, body: { reasonCode: string; reasonNote?: string }, idempotencyKey: string): Promise<HoldsAnswer> =>
  api.post(`/compliance/recalls/${seg(recallId)}/holds`, { body: { version, ...body }, schema: holdsAnswer, idempotencyKey })

export const startRecall = (api: ApiClient, recallId: string, version: number, idempotencyKey: string): Promise<RecallDetail> =>
  api.post(`/compliance/recalls/${seg(recallId)}/start`, { body: { version }, schema: oneRecall, idempotencyKey }).then((answer) => answer.recall)

/** Publish the public notice (compliance.recall.send + a fresh code): then first on the public DoC page. */
export const publishRecallNotice = (api: ApiClient, recallId: string, version: number, publicNotice: Readonly<Record<string, PublicWords>> | null, idempotencyKey: string): Promise<RecallDetail> =>
  api.post(`/compliance/recalls/${seg(recallId)}/notice/publish`, { body: { version, ...(publicNotice ? { publicNotice } : {}) }, schema: oneRecall, idempotencyKey }).then((answer) => answer.recall)

export const withdrawRecallNotice = (api: ApiClient, recallId: string, version: number): Promise<RecallDetail> =>
  api.post(`/compliance/recalls/${seg(recallId)}/notice/withdraw`, { body: { version }, schema: oneRecall, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.recall)

export interface ProgressCountsBody {
  readonly unitsReturned: number
  readonly unitsRepaired: number
  readonly unitsDestroyed: number
}

export const recordProgress = (api: ApiClient, recallId: string, progressId: string, version: number, body: ProgressCountsBody): Promise<RecallDetail> =>
  api
    .request('PATCH', `/compliance/recalls/${seg(recallId)}/progress/${seg(progressId)}`, { body: { version, ...body }, schema: oneRecall, idempotencyKey: newIdempotencyKey() })
    .then((answer) => answer.recall)

export const closeRecall = (api: ApiClient, recallId: string, version: number, closeNote: string): Promise<RecallDetail> =>
  api.post(`/compliance/recalls/${seg(recallId)}/close`, { body: { version, closeNote }, schema: oneRecall, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.recall)

export const cancelRecall = (api: ApiClient, recallId: string, version: number, reason: string): Promise<RecallDetail> =>
  api.post(`/compliance/recalls/${seg(recallId)}/cancel`, { body: { version, reason }, schema: oneRecall, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.recall)

// ---- distributors told --------------------------------------------------------------------------------------------------------

export const distributorNoticeSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  entryId: z.string(),
  recallId: z.string().nullable(),
  recallNumber: z.string().nullable(),
  party: named,
  channel: z.enum(DISTRIBUTOR_CHANNELS),
  contactName: z.string().nullable(),
  contact: z.string().nullable(),
  language: z.string(),
  subject: z.string().nullable(),
  message: z.string(),
  status: z.enum(DISTRIBUTOR_STATUSES),
  sentAt: z.string().nullable(),
  sentBy: person,
  answeredAt: z.string().nullable(),
  answer: z.string().nullable(),
  answeredByName: z.string().nullable(),
  failedAt: z.string().nullable(),
  failureReason: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  mail: z.object({ status: z.string() }).nullable(),
  note: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
  may: z.object({ edit: z.boolean(), send: z.boolean(), answer: z.boolean(), fail: z.boolean(), cancel: z.boolean() }),
})
export type DistributorNotice = z.infer<typeof distributorNoticeSchema>
const oneDistributorNotice = z.object({ notice: distributorNoticeSchema })

export const recipientsSchema = z.object({
  entryId: z.string(),
  told: z.number(),
  of: z.number(),
  allTold: z.boolean(),
  informedAt: z.string().nullable(),
  recipients: z.array(
    z.object({
      party: z.object({ id: z.string(), code: z.string(), name: z.string(), language: z.string() }),
      garments: z.number(),
      shipmentNumbers: z.array(z.string()),
      contacts: z.array(z.object({ id: z.string(), name: z.string(), email: z.string().nullable(), phone: z.string().nullable(), language: z.string().nullable(), quality: z.boolean() })),
      told: z.boolean(),
      notices: z.array(distributorNoticeSchema),
    }),
  ),
  others: z.array(distributorNoticeSchema),
  law: z.string(),
  may: z.object({ draft: z.boolean(), send: z.boolean() }),
})
export type Recipients = z.infer<typeof recipientsSchema>
export type Recipient = Recipients['recipients'][number]

export const getRecipients = (api: ApiClient, entryId: string, signal?: AbortSignal): Promise<Recipients> =>
  api.get(`/compliance/register/${seg(entryId)}/distributors`, { schema: recipientsSchema, signal })

/** Draft a notice for every recipient not told yet (by e-mail to their quality contact); the API says who it skipped and why. */
export const draftDistributorNotices = (api: ApiClient, entryId: string, recallId: string | null, idempotencyKey: string) =>
  api.post(`/compliance/register/${seg(entryId)}/distributor-notices`, {
    body: recallId ? { recallId } : {},
    schema: z.object({ notices: z.array(distributorNoticeSchema), skipped: z.array(z.object({ partyId: z.string(), reason: z.string() })) }),
    idempotencyKey,
  })

export const editDistributorNotice = (api: ApiClient, noticeId: string, version: number, body: { subject?: string | null; message?: string }): Promise<DistributorNotice> =>
  api
    .request('PATCH', `/compliance/distributor-notices/${seg(noticeId)}`, { body: { version, ...body }, schema: oneDistributorNotice, idempotencyKey: newIdempotencyKey() })
    .then((answer) => answer.notice)

export const sendAnswer = z.object({
  notices: z.array(distributorNoticeSchema),
  results: z.array(z.object({ noticeId: z.string(), sent: z.boolean(), problem: z.string().nullable() })),
  distributorsInformed: z.boolean(),
  told: z.number(),
  of: z.number(),
})
export type SendAnswer = z.infer<typeof sendAnswer>

/** "Send to N distributors" (compliance.recall.send + a fresh code): each in its own command, a result per recipient. */
export const sendDistributorNotices = (api: ApiClient, entryId: string, noticeIds: readonly string[], idempotencyKey: string): Promise<SendAnswer> =>
  api.post(`/compliance/register/${seg(entryId)}/distributor-notices/send`, { body: { noticeIds: [...noticeIds] }, schema: sendAnswer, idempotencyKey })

export const answerDistributorNotice = (api: ApiClient, noticeId: string, version: number, body: { answer: string; answeredAt?: string; answeredByName?: string }): Promise<DistributorNotice> =>
  api.post(`/compliance/distributor-notices/${seg(noticeId)}/answer`, { body: { version, ...body }, schema: oneDistributorNotice, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.notice)

export const failDistributorNotice = (api: ApiClient, noticeId: string, version: number, reason: string): Promise<DistributorNotice> =>
  api.post(`/compliance/distributor-notices/${seg(noticeId)}/failed`, { body: { version, reason }, schema: oneDistributorNotice, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.notice)

export const cancelDistributorNotice = (api: ApiClient, noticeId: string, version: number, reason: string): Promise<DistributorNotice> =>
  api.post(`/compliance/distributor-notices/${seg(noticeId)}/cancel`, { body: { version, reason }, schema: oneDistributorNotice, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.notice)

// ---- authority requests ---------------------------------------------------------------------------------------------------

export const requestSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  number: z.string(),
  authorityName: z.string(),
  marketCode: z.string(),
  market,
  authorityReference: z.string().nullable(),
  channel: z.enum(AUTHORITY_CHANNELS),
  receivedAt: z.string(),
  style: named.nullable(),
  batchNumbers: z.array(z.string()),
  request: z.string(),
  dueOn: z.string(),
  due: z.object({ state: z.enum(REQUEST_DUE_STATES), daysLeft: z.number().nullable() }),
  status: z.enum(REQUEST_STATUSES),
  answeredAt: z.string().nullable(),
  answeredBy: person,
  answerSummary: z.string().nullable(),
  evidence: z
    .object({
      type: z.string(),
      id: z.string(),
      pack: z.object({ id: z.string(), number: z.string(), status: z.string(), purpose: z.string(), links: z.number(), builtAt: z.string().nullable() }).nullable(),
    })
    .nullable(),
  entry: entryRef.nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  note: z.string().nullable(),
  law: z.string(),
  version: z.number(),
  createdAt: z.string(),
  may: z.object({ edit: z.boolean(), answer: z.boolean(), cancel: z.boolean(), entry: z.boolean(), evidence: z.boolean() }),
})
export type AuthorityRequest = z.infer<typeof requestSchema>
const oneRequest = z.object({ request: requestSchema })

export interface LogRequestBody {
  readonly companyId: string
  readonly authorityName: string
  readonly marketCode: string
  readonly authorityReference?: string
  readonly channel: AuthorityChannel
  readonly receivedAt: string
  readonly styleId?: string
  readonly batchNumbers?: readonly string[]
  readonly request: string
  readonly dueOn: string
  readonly registerEntryId?: string
}

/** Log what an authority asks, on this entry (AR-… numbered from the company's series). */
export const logRequest = (api: ApiClient, body: LogRequestBody, idempotencyKey: string): Promise<AuthorityRequest> =>
  api
    .post('/compliance/authority-requests', { body: { ...body, ...(body.batchNumbers ? { batchNumbers: [...body.batchNumbers] } : {}) }, schema: oneRequest, idempotencyKey })
    .then((answer) => answer.request)

/** Ask an evidence pack built from the style's live technical file for the request's batches (built by the worker). */
export const requestEvidence = (api: ApiClient, requestId: string, version: number, language: string | null): Promise<AuthorityRequest> =>
  api
    .post(`/compliance/authority-requests/${seg(requestId)}/evidence`, { body: { version, ...(language ? { language } : {}) }, schema: oneRequest, idempotencyKey: newIdempotencyKey() })
    .then((answer) => answer.request)

export const answerRequest = (api: ApiClient, requestId: string, version: number, body: { answerSummary: string; answeredAt?: string }): Promise<AuthorityRequest> =>
  api.post(`/compliance/authority-requests/${seg(requestId)}/answer`, { body: { version, ...body }, schema: oneRequest, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.request)

export const cancelRequest = (api: ApiClient, requestId: string, version: number, reason: string): Promise<AuthorityRequest> =>
  api.post(`/compliance/authority-requests/${seg(requestId)}/cancel`, { body: { version, reason }, schema: oneRequest, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.request)

// ---- the entry's W2b parts in one read ------------------------------------------------------------------------------------

export const surveillanceSchema = z.object({
  entry: entryRef.extend({ authorityNotifiedAt: z.string().nullable(), authorityReference: z.string().nullable(), distributorsInformedAt: z.string().nullable() }),
  notices: z.array(noticeSchema),
  requests: z.array(requestSchema),
  recalls: z.array(recallRowSchema),
  distributors: z.object({ told: z.number(), of: z.number(), allTold: z.boolean() }),
  law: z.object({ authorityNotice: z.string(), authorityRequest: z.string(), distributors: z.string(), correctiveAction: z.string(), publicNotice: z.string() }),
  may: z.object({ manage: z.boolean(), send: z.boolean() }),
})
export type Surveillance = z.infer<typeof surveillanceSchema>

export const getSurveillance = (api: ApiClient, entryId: string, signal?: AbortSignal): Promise<Surveillance> =>
  api.get(`/compliance/register/${seg(entryId)}/surveillance`, { schema: surveillanceSchema, signal })
