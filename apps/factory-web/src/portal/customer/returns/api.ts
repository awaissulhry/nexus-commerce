import { z } from 'zod'
import { CASE_CHIPS, CASE_TYPES, MILESTONE_STEPS, OUTCOMES_WANTED, RECORDED_OUTCOMES_WANTED } from '@nexus/factory-domain/sales/portal-returns/rules'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * Every call of the customer's Returns & claims (B-W2b-197, SCR-187; design portal.customer.returns), each answer checked
 * against the API's contracts (apps/factory-api modules/sales/portal-returns, B-W2b-192; the wave-23 columns of F13b): the
 * cases, the Quality role's complaints, one return or complaint (Request, Status, the investigation), the cancel, the
 * photos (announced, PUT to the store, confirmed), a case's files (one logged open each), the return instructions PDF,
 * the credit note's PDF through the customer documents (B-W2b-178), what may come back and the two asks. No money is
 * shown on this page: the returnable price the API sends with the price grain is not read. Every write carries an
 * Idempotency-Key. The web reads only what it uses: a field the API adds never breaks the page.
 */

export { CASE_CHIPS, CASE_TYPES, MILESTONE_STEPS, OUTCOMES_WANTED }
export type CaseChip = (typeof CASE_CHIPS)[number]
export type CaseType = (typeof CASE_TYPES)[number]
export type OutcomeWanted = (typeof OUTCOMES_WANTED)[number]
export type MilestoneStepCode = (typeof MILESTONE_STEPS)[number]
export const isCaseChip = (value: unknown): value is CaseChip => typeof value === 'string' && (CASE_CHIPS as readonly string[]).includes(value)

const words = z.object({ it: z.string(), en: z.string() })
export type Words = z.infer<typeof words>
const next = z.object({ forYou: z.boolean(), code: z.string(), words })
export type NextStep = z.infer<typeof next>
const held = z.object({ allowed: z.boolean(), held: words.nullable() })
const codeWords = z.object({ code: z.string(), words })
const fileSchema = z.object({ id: z.string(), role: z.enum(['PHOTO', 'ANSWER_LETTER', 'EIGHT_D', 'DOCUMENT']), name: z.string(), contentType: z.string(), sizeBytes: z.number(), addedAt: z.string() })
export type CaseFile = z.infer<typeof fileSchema>

// ── the cases ────────────────────────────────────────────────────────────────────────────────────────────────────────
export const caseItemSchema = z.object({
  type: z.enum(CASE_TYPES),
  id: z.string(),
  number: z.string(),
  yourRef: z.string().nullable(),
  opened: z.string(),
  status: z.string(),
  /** The state in customer words' code (RETURN_CASE_STATES / COMPLAINT_CASE_STATES). */
  state: z.string(),
  words,
  next,
  open: z.boolean(),
  items: z.array(z.object({ description: z.string(), size: z.string().nullable(), serial: z.string().nullable(), pieces: z.number().nullable() })),
  lines: z.number(),
  pieces: z.number().nullable(),
  lastUpdate: z.string(),
  chips: z.array(z.string()),
})
export type CaseItem = z.infer<typeof caseItemSchema>

export const casesSchema = z.object({
  chip: z.enum(CASE_CHIPS),
  chips: z.array(z.object({ chip: z.enum(CASE_CHIPS), count: z.number() })),
  items: z.array(caseItemSchema),
  mayRequest: z.boolean(),
  readsComplaints: z.boolean(),
  asOf: z.string(),
})
export type CasesRead = z.infer<typeof casesSchema>

export const fetchCases = (api: ApiClient, query: { chip?: CaseChip | null; q?: string | null }, signal?: AbortSignal): Promise<CasesRead> =>
  api.get('/portal/returns', { query: { chip: query.chip ?? undefined, q: query.q?.trim() ? query.q.trim() : undefined }, schema: casesSchema, signal })

export const complaintRowSchema = z.object({
  id: z.string(),
  number: z.string(),
  yourRef: z.string().nullable(),
  subject: z.string(),
  opened: z.string(),
  status: z.string(),
  words,
  stepReached: words.nullable(),
  answerDueOn: z.string().nullable(),
  answeredAt: z.string().nullable(),
})
export type ComplaintRow = z.infer<typeof complaintRowSchema>
export const complaintsSchema = z.object({ items: z.array(complaintRowSchema), asOf: z.string() })
export type ComplaintsRead = z.infer<typeof complaintsSchema>

/** The Quality role's complaints with their investigation (portal.complaints.view; 403 for anyone else). */
export const fetchComplaints = (api: ApiClient, signal?: AbortSignal): Promise<ComplaintsRead> => api.get('/portal/complaints', { schema: complaintsSchema, signal })

// ── one return ───────────────────────────────────────────────────────────────────────────────────────────────────────
const milestone = z.object({ step: z.enum(MILESTONE_STEPS), state: z.enum(['DONE', 'CURRENT', 'TODO', 'SKIPPED']), at: z.string().nullable(), words })
export type ReturnMilestone = z.infer<typeof milestone>

export const returnRecordSchema = z.object({
  type: z.literal('RETURN'),
  id: z.string(),
  number: z.string(),
  yourRef: z.string().nullable(),
  status: z.string(),
  state: z.string(),
  words,
  next,
  version: z.number(),
  request: z.object({
    opened: z.string(),
    via: z.string(),
    // B-W2b-368 (XF1:03): a remake asked records the wish REMAKE (wave 45); a request offers the other three.
    outcomeWanted: z.object({ code: z.enum(RECORDED_OUTCOMES_WANTED), words }).nullable(),
    note: z.string().nullable(),
    photos: z.array(fileSchema),
    lines: z.array(
      z.object({ id: z.string(), seq: z.number(), description: z.string(), size: z.string().nullable(), serial: z.string().nullable(), pieces: z.number(), reason: codeWords, reasonNote: z.string().nullable(), photos: z.array(fileSchema) }),
    ),
  }),
  progress: z.object({
    milestones: z.array(milestone),
    decision: words.nullable(),
    goodsDueBy: z.string().nullable(),
    sendTo: z.string().nullable(),
    instructions: z.boolean(),
    parcels: z.array(z.object({ receivedAt: z.string(), parcels: z.number(), carrier: z.string().nullable(), trackingNumber: z.string().nullable() })),
    inspection: z.array(z.object({ seq: z.number(), received: z.number(), grade: codeWords.nullable(), outcome: codeWords.nullable() })),
    creditNotes: z.array(z.object({ id: z.string(), number: z.string().nullable(), issueDate: z.string().nullable(), pdfFileId: z.string().nullable() })),
    replacementOrder: z.object({ id: z.string(), number: z.string() }).nullable(),
  }),
  actions: z.object({ cancel: held, addPhotos: held }),
})
export type ReturnRecord = z.infer<typeof returnRecordSchema>
export type ReturnLine = ReturnRecord['request']['lines'][number]

const returnAnswer = z.object({ return: returnRecordSchema })
export const fetchReturn = (api: ApiClient, id: string, signal?: AbortSignal): Promise<ReturnRecord> =>
  api.get(`/portal/returns/${encodeURIComponent(id)}`, { schema: returnAnswer, signal }).then((read) => read.return)

/** "Cancel this request?": REQUESTED or AUTHORISED → CANCELLED (409 once the goods are back). */
export const cancelReturn = (api: ApiClient, id: string, body: { version: number; reason?: string | null }, idempotencyKey: string): Promise<ReturnRecord> =>
  api.post(`/portal/returns/${encodeURIComponent(id)}/cancel`, { body, schema: returnAnswer, idempotencyKey }).then((read) => read.return)

/** The return instructions PDF (tab:return-label): the API makes it on each read, in the page's language. */
export const instructionsHref = (id: string, language: 'it' | 'en'): string => `/api/portal/returns/${encodeURIComponent(id)}/instructions?language=${language}`

// ── one complaint ────────────────────────────────────────────────────────────────────────────────────────────────────
const documentSchema = fileSchema.extend({ version: z.number().nullable(), current: z.boolean() })
export type CaseDocument = z.infer<typeof documentSchema>
export const complaintRecordSchema = z.object({
  type: z.literal('COMPLAINT'),
  id: z.string(),
  number: z.string(),
  yourRef: z.string().nullable(),
  status: z.string(),
  state: z.string(),
  words,
  next,
  version: z.number(),
  request: z.object({
    opened: z.string(),
    via: z.string(),
    description: z.string(),
    item: z.object({ style: z.object({ code: z.string(), name: z.string() }).nullable(), size: z.string().nullable(), serial: z.string().nullable(), batchNumber: z.string().nullable() }),
    order: z.object({ id: z.string(), number: z.string(), yourRef: z.string().nullable() }).nullable(),
    shipment: z.object({ id: z.string(), number: z.string() }).nullable(),
    photos: z.array(fileSchema),
  }),
  progress: z.object({ answerBy: z.string().nullable(), answeredAt: z.string().nullable() }),
  investigation: z
    .object({
      capa: z.object({ number: z.string(), type: z.enum(['CAPA', 'EIGHT_D']), stepReached: words.nullable() }).nullable(),
      steps: z.array(z.object({ stage: z.string(), state: z.enum(['DONE', 'CURRENT', 'TODO']), on: z.string().nullable(), words })).nullable(),
      answeredAt: z.string().nullable(),
      answeredVia: z.enum(['EMAIL', 'PORTAL']).nullable(),
      documents: z.array(documentSchema),
    })
    .nullable(),
  actions: z.object({ addPhotos: held }),
})
export type ComplaintRecord = z.infer<typeof complaintRecordSchema>

const complaintAnswer = z.object({ complaint: complaintRecordSchema })
export const fetchComplaint = (api: ApiClient, id: string, signal?: AbortSignal): Promise<ComplaintRecord> =>
  api.get(`/portal/complaints/${encodeURIComponent(id)}`, { schema: complaintAnswer, signal }).then((read) => read.complaint)

// ── files ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const presigned = z.object({ method: z.enum(['PUT', 'GET']), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: z.string() })
export type Presigned = z.infer<typeof presigned>
const uploadSchema = z.object({ file: z.object({ id: z.string(), originalName: z.string(), sizeBytes: z.number(), status: z.string() }), upload: presigned })
export type PhotoUpload = z.infer<typeof uploadSchema>
const doneSchema = z.object({ file: z.object({ id: z.string(), originalName: z.string(), sizeBytes: z.number(), status: z.string() }) })

const casePath = (type: CaseType, id: string) => `/portal/${type === 'RETURN' ? 'returns' : 'complaints'}/${encodeURIComponent(id)}`

export interface PhotoBody {
  originalName: string
  contentType: string
  sizeBytes: number
  sha256: string
  /** A return's line the photo shows (null: the request as a whole). */
  lineId?: string | null
}

/** Announces a photo of a case (a return, one of its lines, a complaint): the answer holds the store's presigned PUT. */
export const announcePhoto = (api: ApiClient, type: CaseType, id: string, body: PhotoBody, idempotencyKey: string): Promise<PhotoUpload> =>
  api.post(`${casePath(type, id)}/photos`, { body: type === 'RETURN' ? body : { originalName: body.originalName, contentType: body.contentType, sizeBytes: body.sizeBytes, sha256: body.sha256 }, schema: uploadSchema, idempotencyKey })

/** Confirms a photo once its bytes are in the store. */
export const completePhoto = (api: ApiClient, type: CaseType, id: string, fileId: string, idempotencyKey: string) =>
  api.post(`${casePath(type, id)}/photos/${encodeURIComponent(fileId)}/complete`, { schema: doneSchema, idempotencyKey })

const openSchema = z.object({ file: z.object({ id: z.string(), name: z.string(), contentType: z.string() }), download: presigned.extend({ mode: z.enum(['inline', 'download']) }) })
export type OpenedFile = z.infer<typeof openSchema>

/** A photo or document of the party's case (ONE logged open; a 60-second address; a picture as its copy without location). */
export const openCaseFile = (api: ApiClient, fileId: string, mode: 'preview' | 'download'): Promise<OpenedFile> =>
  api.post(`/portal/returns/files/${encodeURIComponent(fileId)}/open`, { body: { mode }, schema: openSchema, idempotencyKey: newIdempotencyKey() })

const documentOpenSchema = z.object({ download: presigned.extend({ mode: z.enum(['inline', 'download']) }) })
/** A credit note's PDF through the customer documents (B-W2b-178; logged; its finance documents' permission decides). */
export const openCreditNote = (api: ApiClient, fileId: string): Promise<Presigned> =>
  api.post(`/portal/customer-documents/${encodeURIComponent(fileId)}/download`, { body: { mode: 'preview' }, schema: documentOpenSchema, idempotencyKey: newIdempotencyKey() }).then((read) => read.download)

// ── asking: what may come back, a return, a complaint ────────────────────────────────────────────────────────────────
export const returnableItemSchema = z.object({
  key: z.string(),
  invoiceLineId: z.string().nullable(),
  salesOrderLineId: z.string().nullable(),
  size: z.string().nullable(),
  description: z.string(),
  order: z.object({ id: z.string(), number: z.string(), lineSeq: z.number() }).nullable(),
  invoice: z.object({ id: z.string(), number: z.string().nullable(), issueDate: z.string().nullable() }).nullable(),
  style: z.object({ code: z.string(), name: z.string() }).nullable(),
  colourway: z.object({ code: z.string(), name: z.string() }).nullable(),
  ppe: z.boolean(),
  received: z.number(),
  canReturn: z.number(),
  deliveredOn: z.string().nullable(),
  windowWarning: z.string().nullable(),
})
export type ReturnableItem = z.infer<typeof returnableItemSchema>
export const returnableSchema = z.object({
  items: z.array(returnableItemSchema),
  reasons: z.array(z.object({ code: z.string(), words, needsNote: z.boolean() })),
  outcomes: z.array(z.object({ code: z.enum(OUTCOMES_WANTED), words })),
  mayRequest: z.boolean(),
  mayUpload: z.boolean(),
})
export type ReturnableRead = z.infer<typeof returnableSchema>
export type ReturnReason = ReturnableRead['reasons'][number]

export const fetchReturnable = (api: ApiClient, salesOrderId: string | null, signal?: AbortSignal): Promise<ReturnableRead> =>
  api.get('/portal/returns/returnable', { query: { salesOrderId: salesOrderId ?? undefined }, schema: returnableSchema, signal })

export interface ReturnRequestBody {
  lines: { invoiceLineId?: string | null; salesOrderLineId?: string | null; size?: string | null; quantity: number; reasonCode: string; reasonNote?: string | null; serial?: string | null }[]
  outcomeWanted?: OutcomeWanted | null
  customerRef?: string | null
  note?: string | null
}
export interface ComplaintBody {
  description: string
  salesOrderLineId?: string | null
  size?: string | null
  serial?: string | null
  batchNumber?: string | null
  customerRef?: string | null
}

const sentSchema = z.object({ number: z.string(), answerBy: z.string().nullable(), words })
export type Sent = z.infer<typeof sentSchema>

export const requestReturn = (api: ApiClient, body: ReturnRequestBody, idempotencyKey: string): Promise<{ id: string; sent: Sent }> =>
  api.post('/portal/returns', { body, schema: z.object({ return: z.object({ id: z.string() }), sent: sentSchema }), idempotencyKey }).then((read) => ({ id: read.return.id, sent: read.sent }))

export const reportComplaint = (api: ApiClient, body: ComplaintBody, idempotencyKey: string): Promise<{ id: string; sent: Sent }> =>
  api.post('/portal/complaints', { body, schema: z.object({ complaint: z.object({ id: z.string() }), sent: sentSchema }), idempotencyKey }).then((read) => ({ id: read.complaint.id, sent: read.sent }))
