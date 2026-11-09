import { z } from 'zod'
import { CASE_TYPES, COMPLAINT_CASE_STATES, OUTCOMES_WANTED, RETURN_CASE_STATES } from '@nexus/factory-domain/sales/portal-returns/rules'
import { newIdempotencyKey, type ApiClient } from '../../lib/api/client'
import { presignedSchema } from '../../record-panels/api'
import { putToStore, readFromStore, sha256Hex } from '../../record-panels/store'

/**
 * "Report a problem" by link (apps/factory-api modules/sales/portal-returns/link.ts, B-W2b-192; a CLAIM link of a
 * shipment that left us or of an order). Reading uses nothing; the one send uses one of the link's uses:
 *
 *   GET  /link/claim?language=                     the sender, the shipment or order, what may come back (never a price),
 *                                                  the return reasons and outcomes, the cases this link opened
 *   GET|PUT /link/draft                            the form kept with us (B-W2b-163; CLAIM keeps a draft; the send drops it)
 *   POST /link/claim?language=  (Idempotency-Key)  a return request or a quality complaint: the page again + `sent`
 *   GET  /link/claim/cases/RETURN/:id              a return this link opened (its lines, to put a photo on the right one)
 *   POST /link/claim/photos (+ /:fileId/complete)  a photo of a case this link opened, the bytes PUT to the store between
 *   POST /link/claim/files/:fileId/open            a document of a case (the answer letter, the 8D) for 60 seconds
 *   GET  /link/claim/returns/:id/instructions      the return instructions PDF once the return is approved
 *
 * The API's words come in Italian and English (`words`); this page shows its own catalogue's words from the codes and
 * numbers, and the API's localized words only where they carry what the codes do not (a case's next step, a reason).
 * The token travels only in `x-factory-link` (the client the link landing made).
 */

export const CLAIM_TYPES = CASE_TYPES
export type ClaimType = (typeof CASE_TYPES)[number]
export const OUTCOMES = OUTCOMES_WANTED
export type Outcome = (typeof OUTCOMES_WANTED)[number]
export const CASE_STATES = [...RETURN_CASE_STATES, ...COMPLAINT_CASE_STATES] as const

const words = z.object({ it: z.string(), en: z.string() })
export type Words = z.infer<typeof words>

const itemSchema = z.object({
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
  /** Set when the goods reached the customer longer ago than the return period (the API's English: only its presence is used). */
  windowWarning: z.string().nullable(),
})
export type ClaimItem = z.infer<typeof itemSchema>

const caseSchema = z.object({
  type: z.enum(CASE_TYPES),
  id: z.string(),
  number: z.string(),
  yourRef: z.string().nullable(),
  opened: z.string(),
  status: z.string(),
  state: z.string(),
  next: z.object({ forYou: z.boolean(), code: z.string(), words }),
  open: z.boolean(),
  items: z.array(z.object({ description: z.string(), size: z.string().nullable(), serial: z.string().nullable(), pieces: z.number().nullable() })),
})
export type ClaimCase = z.infer<typeof caseSchema>

const documentSchema = z.object({ id: z.string(), role: z.string(), name: z.string(), contentType: z.string(), version: z.number().nullable(), current: z.boolean() })
export type CaseDocument = z.infer<typeof documentSchema>

const complaintSchema = z.object({
  id: z.string(),
  number: z.string(),
  investigation: z.object({ documents: z.array(documentSchema) }).nullable(),
})

export const claimPageSchema = z.object({
  sender: z.object({ companyName: z.string() }),
  record: z.object({ type: z.string(), id: z.string(), label: z.string() }),
  types: z.array(z.enum(CASE_TYPES)),
  items: z.array(itemSchema),
  reasons: z.array(z.object({ code: z.string(), words, needsNote: z.boolean() })),
  outcomes: z.array(z.object({ code: z.enum(OUTCOMES_WANTED), words })),
  cases: z.array(caseSchema),
  complaints: z.array(complaintSchema),
  link: z.object({ expiresAt: z.string(), usesLeft: z.number(), live: z.boolean() }),
  locale: z.enum(['it', 'en']),
})
export type ClaimPage = z.infer<typeof claimPageSchema>
export type ClaimReason = ClaimPage['reasons'][number]

const sentSchema = z.object({ type: z.enum(CASE_TYPES), id: z.string(), number: z.string(), answerBy: z.string().nullable() })
export type ClaimSent = z.infer<typeof sentSchema>
const submittedSchema = claimPageSchema.extend({ sent: sentSchema })

/** What the page sends: a return request or a quality complaint (the API's body shapes; lengths checked by the page first). */
export type ClaimBody =
  | {
      type: 'RETURN'
      typedName: string | null
      lines: Array<{ invoiceLineId: string | null; salesOrderLineId: string | null; size: string | null; quantity: number; reasonCode: string; reasonNote: string | null; serial: string | null }>
      outcomeWanted: Outcome | null
      customerRef: string | null
      note: string | null
    }
  | { type: 'COMPLAINT'; typedName: string | null; description: string; salesOrderLineId: string | null; size: string | null; serial: string | null; batchNumber: string | null; customerRef: string | null }

/** `GET /link/claim?language=`. */
export function readClaimPage(api: ApiClient, language: 'it' | 'en', signal?: AbortSignal): Promise<ClaimPage> {
  return api.get('/link/claim', { query: { language }, schema: claimPageSchema, signal })
}

/** `POST /link/claim`: the case is made and the page comes back with `sent`. The same key on a retry replays it. */
export function sendClaim(api: ApiClient, body: ClaimBody, language: 'it' | 'en', idempotencyKey: string): Promise<ClaimPage & { sent: ClaimSent }> {
  return api.post('/link/claim', { query: { language }, body, schema: submittedSchema, idempotencyKey })
}

// ---- the draft kept with us (B-W2b-163) -----------------------------------------------------------------------------

const draftSchema = z.object({
  draft: z.object({ data: z.record(z.string(), z.unknown()), version: z.number(), savedAt: z.string(), purgeAfter: z.string() }).nullable(),
  link: z.object({ expiresAt: z.string() }),
})
export type DraftRead = z.infer<typeof draftSchema>
const savedSchema = z.object({ draft: z.object({ version: z.number(), savedAt: z.string(), purgeAfter: z.string() }) })
export type DraftSaved = z.infer<typeof savedSchema>['draft']

export function readDraft(api: ApiClient, signal?: AbortSignal): Promise<DraftRead> {
  return api.get('/link/draft', { schema: draftSchema, signal })
}

/** A link write: each save carries its own Idempotency-Key (the API refuses a link write without one). */
export function saveDraft(api: ApiClient, data: Record<string, unknown>, version: number | null, idempotencyKey: string = newIdempotencyKey()): Promise<DraftSaved> {
  return api.request('PUT', '/link/draft', { body: version === null ? { data } : { data, version }, schema: savedSchema, idempotencyKey }).then((answer) => answer.draft)
}

// ---- after the send: photos, the return's lines, the documents ------------------------------------------------------

const returnLinesSchema = z.object({ return: z.object({ request: z.object({ lines: z.array(z.object({ id: z.string(), seq: z.number() })) }) }).optional() })

/** The lines of a return this link opened (id and seq), to put each photo on its item. */
export async function readReturnLines(api: ApiClient, returnId: string): Promise<Array<{ id: string; seq: number }>> {
  const answer = await api.get(`/link/claim/cases/RETURN/${encodeURIComponent(returnId)}`, { schema: returnLinesSchema })
  return answer.return?.request.lines ?? []
}

const uploadSchema = z.object({ file: z.object({ id: z.string() }), upload: presignedSchema })
const completeSchema = z.object({ file: z.object({ id: z.string(), status: z.string() }) })

/**
 * One photo onto a case this link opened (or one line of its return): announced with its SHA-256, its bytes PUT straight
 * to the store, then confirmed. Each step has its own key, so a retry of the same photo starts again cleanly.
 */
export async function uploadClaimPhoto(
  api: ApiClient,
  target: { caseType: ClaimType; caseId: string; lineId: string | null },
  photo: { blob: Blob; name: string },
  keys: { announce: string; complete: string },
  put: typeof putToStore = putToStore,
): Promise<{ fileId: string; status: string }> {
  const bytes = await photo.blob.arrayBuffer()
  const sha256 = await sha256Hex(bytes)
  const announced = await api.post('/link/claim/photos', {
    body: { caseType: target.caseType, caseId: target.caseId, lineId: target.lineId, originalName: photo.name, contentType: photo.blob.type || 'image/jpeg', sizeBytes: bytes.byteLength, sha256 },
    schema: uploadSchema,
    idempotencyKey: keys.announce,
  })
  await put(announced.upload, bytes)
  const done = await api.post(`/link/claim/photos/${encodeURIComponent(announced.file.id)}/complete`, { schema: completeSchema, idempotencyKey: keys.complete })
  return { fileId: done.file.id, status: done.file.status }
}

const openSchema = z.object({ file: z.object({ id: z.string(), name: z.string(), contentType: z.string() }), download: presignedSchema.extend({ mode: z.enum(['inline', 'download']) }) })

/** A document of a case this link opened (the answer letter, the 8D): its bytes, read once (logged by the API). */
export async function openCaseDocument(api: ApiClient, fileId: string): Promise<{ bytes: Uint8Array; name: string; contentType: string }> {
  const opened = await api.post(`/link/claim/files/${encodeURIComponent(fileId)}/open`, { body: { mode: 'preview' }, schema: openSchema })
  const bytes = await readFromStore(opened.download)
  return { bytes, name: opened.file.name, contentType: opened.file.contentType }
}

/** The return instructions PDF of an approved return this link opened, in the reader's language. */
export function returnInstructions(api: ApiClient, returnId: string, language: 'it' | 'en'): Promise<Uint8Array> {
  return api.bytes(`/link/claim/returns/${encodeURIComponent(returnId)}/instructions`, { query: { language } })
}
