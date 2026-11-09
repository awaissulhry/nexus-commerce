import { z } from 'zod'
import { SITE_STEPS } from '@nexus/factory-domain/purchasing/questionnaire/questions'
import { questionSchema } from '@nexus/factory-domain/purchasing/questionnaire/schema'
import { newIdempotencyKey, type ApiClient } from '../../lib/api/client'
import { presignedSchema } from '../../record-panels/api'
import { putToStore, sha256Hex } from '../../record-panels/store'

/**
 * The supplier questionnaire by link (apps/factory-api modules/purchasing/questionnaire/link.ts, B-W2b-172; a
 * SUPPLIER_ONBOARD link of the supplier itself). Reading uses nothing; the one send uses the link's one use:
 *
 *   GET  /link/supplier-questionnaire?language=        who asks and who reviews, the buyer's note, the supplier as we hold
 *                                                      it, the questionnaire (its questions in Italian and English), the
 *                                                      documents this link uploaded
 *   GET|PUT /link/draft                                the form kept with us (B-W2b-163; the send drops it)
 *   POST /link/supplier-questionnaire/vat-check        the VAT number's shape, an EU number outside Italy checked in VIES
 *   POST /link/supplier-questionnaire/documents (+ /:fileId/complete)   a document, its bytes PUT to the store between
 *   GET  /link/supplier-questionnaire/code-of-conduct  the code of conduct, a PDF (opened in a new tab)
 *   POST /link/supplier-questionnaire?language=        the signed answer (Idempotency-Key: a retry replays it)
 *
 * The API's refusals are English sentences with codes and paths; this page speaks its own words from those. The token
 * travels only in `x-factory-link` (the client the link landing made).
 */

export type QuestionView = z.infer<typeof questionSchema>

const uploadedSchema = z.object({ id: z.string(), name: z.string(), contentType: z.string(), sizeBytes: z.number(), status: z.string() })
export type Uploaded = z.infer<typeof uploadedSchema>

export const onboardPageSchema = z.object({
  sender: z.object({ companyName: z.string() }),
  reviewer: z.object({ name: z.string() }).nullable(),
  note: z.string().nullable(),
  supplier: z.object({ code: z.string(), legalName: z.string(), vatNumber: z.string().nullable(), address: z.string().nullable(), website: z.string().nullable() }),
  questionnaire: z.object({ id: z.string(), revision: z.number(), title: z.string(), questions: z.array(questionSchema), hasCode: z.boolean() }),
  uploaded: z.array(uploadedSchema),
  link: z.object({ expiresAt: z.string(), usesLeft: z.number() }),
  locale: z.enum(['it', 'en']),
})
export type OnboardPage = z.infer<typeof onboardPageSchema>

export const STEPS_OF_SITES = SITE_STEPS
export type SiteStep = (typeof SITE_STEPS)[number]

export interface SiteBody {
  name: string
  country: string
  town: string | null
  steps: SiteStep[]
}

export interface OnboardBody {
  questionnaireId: string
  answers: Record<string, { value?: unknown; explain?: string | null }>
  sites: SiteBody[]
  subTierSites: SiteBody[]
  signedName: string
  signedRole: string
  truthful: boolean
}

const sentSchema = z.object({
  sent: z.object({ id: z.string(), revision: z.number(), submittedAt: z.string(), documents: z.number() }),
  reviewer: z.object({ name: z.string() }).nullable(),
  sender: z.object({ companyName: z.string() }),
})
export type OnboardSent = z.infer<typeof sentSchema>

/** `GET /link/supplier-questionnaire?language=`. */
export function readOnboardPage(api: ApiClient, language: 'it' | 'en', signal?: AbortSignal): Promise<OnboardPage> {
  return api.get('/link/supplier-questionnaire', { query: { language }, schema: onboardPageSchema, signal })
}

/** `POST /link/supplier-questionnaire`: the signed answer. The same key on a retry replays it. */
export function sendOnboard(api: ApiClient, body: OnboardBody, language: 'it' | 'en', idempotencyKey: string): Promise<OnboardSent> {
  return api.post('/link/supplier-questionnaire', { query: { language }, body, schema: sentSchema, idempotencyKey })
}

const vatSchema = z.object({ result: z.enum(['VALID', 'INVALID', 'ERROR', 'NOT_CHECKED', 'FORMAT']), nameMatches: z.boolean().nullable(), vatNumber: z.string() })
export type VatCheck = z.infer<typeof vatSchema>

/** `POST /link/supplier-questionnaire/vat-check`: nothing is kept. */
export function checkVat(api: ApiClient, vatNumber: string, legalName: string): Promise<VatCheck> {
  return api.post('/link/supplier-questionnaire/vat-check', { body: legalName.trim() ? { vatNumber, legalName: legalName.trim() } : { vatNumber }, schema: vatSchema })
}

// ---- the draft kept with us (B-W2b-163) -----------------------------------------------------------------------------------

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

// ---- documents and the code of conduct ------------------------------------------------------------------------------------

const announcedSchema = z.object({ file: uploadedSchema, upload: presignedSchema })
const completedSchema = z.object({ file: uploadedSchema })

/**
 * One document of a question: announced with its SHA-256, its bytes PUT straight to the store, then confirmed. Each step has
 * its own key, so a retry of the same file starts again cleanly.
 */
export async function uploadDocument(api: ApiClient, questionKey: string, file: File, put: typeof putToStore = putToStore): Promise<Uploaded> {
  const bytes = await file.arrayBuffer()
  const sha256 = await sha256Hex(bytes)
  const announced = await api.post('/link/supplier-questionnaire/documents', {
    body: { questionKey, originalName: file.name, contentType: file.type || 'application/pdf', sizeBytes: bytes.byteLength, sha256 },
    schema: announcedSchema,
    idempotencyKey: newIdempotencyKey(),
  })
  await put(announced.upload, bytes)
  const done = await api.post(`/link/supplier-questionnaire/documents/${encodeURIComponent(announced.file.id)}/complete`, { schema: completedSchema, idempotencyKey: newIdempotencyKey() })
  return done.file
}

/** The code of conduct's PDF, in the reader's language. */
export function codeOfConduct(api: ApiClient, language: 'it' | 'en'): Promise<Uint8Array> {
  return api.bytes('/link/supplier-questionnaire/code-of-conduct', { query: { language } })
}
