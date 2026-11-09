import { z } from 'zod'
import { ANSWER_STATES, LINK_STATES } from '@nexus/factory-domain/purchasing/questionnaire/rules'
import { DOCUMENT_CATEGORIES, SITE_STEPS } from '@nexus/factory-domain/purchasing/questionnaire/questions'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { questionSchema } from '@nexus/factory-domain/purchasing/questionnaire/schema'
import { previewLink } from '../../../../record-panels/files/api'
import { readFromStore } from '../../../../record-panels/store'

/**
 * The supplier's questionnaire on its record (apps/factory-api modules/purchasing/questionnaire, B-W2b-172):
 *
 *   GET  /purchasing/suppliers/:partyId/questionnaire           the company's questionnaire, the links sent, the answers
 *   POST /purchasing/suppliers/:partyId/questionnaire-link      send it by link (mailed, or the address once)
 *   POST /purchasing/questionnaire-answers/:responseId/review   accepted, or questions back on the supplier's thread
 *   POST /purchasing/questionnaires {from: STARTER} + …/:id/publish   the starter questionnaire, published
 *   GET  /files/:id/preview                                     the answer's PDF or a document, read once and opened
 *
 * Every write carries its own Idempotency-Key; the API's refusals are English sentences with codes and paths: the screen
 * speaks its own words.
 */


const versionSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  revision: z.number(),
  title: z.string(),
  questions: z.array(questionSchema),
  published: z.boolean(),
  publishedAt: z.string().nullable(),
  version: z.number(),
  updatedAt: z.string(),
})
export type QuestionnaireVersion = z.infer<typeof versionSchema>

const siteSchema = z.object({ name: z.string(), country: z.string(), town: z.string().nullish(), steps: z.array(z.enum(SITE_STEPS)) })
export type SiteView = z.infer<typeof siteSchema>

const answerSchema = z.object({
  id: z.string(),
  questionnaireId: z.string(),
  revision: z.number(),
  state: z.enum(ANSWER_STATES),
  via: z.enum(['LINK', 'PORTAL']),
  linkId: z.string().nullable(),
  submittedAt: z.string(),
  signedName: z.string(),
  signedRole: z.string().nullable(),
  answers: z.record(z.string(), z.object({ value: z.unknown().optional(), explain: z.string().nullish() })),
  sites: z.array(siteSchema),
  subTierSites: z.array(siteSchema),
  documents: z.array(
    z.object({
      key: z.string(),
      fileId: z.string(),
      name: z.string(),
      contentType: z.string(),
      status: z.string(),
      category: z.enum(DOCUMENT_CATEGORIES),
      issuer: z.string().nullable(),
      number: z.string().nullable(),
      issuedOn: z.string().nullable(),
      expiresOn: z.string().nullable(),
      inForce: z.boolean(),
    }),
  ),
  pdf: z.object({ fileId: z.string(), name: z.string() }).nullable(),
  review: z.object({ at: z.string(), byName: z.string().nullable(), note: z.string().nullable() }).nullable(),
  task: z.object({ id: z.string(), open: z.boolean(), assigneeName: z.string().nullable(), dueDate: z.string().nullable() }).nullable(),
  version: z.number(),
})
export type AnswerView = z.infer<typeof answerSchema>

const linkSchema = z.object({
  id: z.string(),
  state: z.enum(LINK_STATES),
  email: z.string().nullable(),
  note: z.string().nullable(),
  sentAt: z.string(),
  sentByName: z.string().nullable(),
  expiresAt: z.string(),
  answerId: z.string().nullable(),
})
export type LinkView = z.infer<typeof linkSchema>

export const supplierQuestionnaireSchema = z.object({
  party: z.object({ id: z.string(), code: z.string(), name: z.string(), language: z.string() }),
  companyId: z.string(),
  current: versionSchema.nullable(),
  draft: z.object({ id: z.string(), revision: z.number() }).nullable(),
  versions: z.array(versionSchema),
  links: z.array(linkSchema),
  answers: z.array(answerSchema),
  contacts: z.array(z.object({ id: z.string(), name: z.string(), email: z.string(), language: z.string().nullable() })),
  may: z.object({ send: z.boolean(), review: z.boolean(), manage: z.boolean() }),
  live: z.object({ events: z.array(z.string()) }),
})
export type SupplierQuestionnaire = z.infer<typeof supplierQuestionnaireSchema>

export function readSupplierQuestionnaire(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<SupplierQuestionnaire> {
  return api.get(`/purchasing/suppliers/${encodeURIComponent(partyId)}/questionnaire`, { schema: supplierQuestionnaireSchema, signal })
}

export interface SendBody {
  contactId?: string
  email?: string
  send: boolean
  language?: 'it' | 'en'
  expiresInDays?: number
  note?: string
}

const sentSchema = z.object({
  link: z.object({ id: z.string(), expiresAt: z.string(), email: z.string().nullable(), withdrawn: z.number() }),
  url: z.string().nullable(),
  delivery: z.enum(['SENT', 'FAILED', 'QUEUED']).nullable(),
})
export type LinkSent = z.infer<typeof sentSchema>

export function sendQuestionnaireLink(api: ApiClient, partyId: string, body: SendBody, idempotencyKey: string): Promise<LinkSent> {
  return api.post(`/purchasing/suppliers/${encodeURIComponent(partyId)}/questionnaire-link`, { body, schema: sentSchema, idempotencyKey })
}

export interface ReviewBody {
  decision: 'ACCEPTED' | 'QUESTIONS'
  note: string | null
  questions: string | null
  version: number
}

const reviewedSchema = z.object({ id: z.string(), state: z.enum(ANSWER_STATES), documents: z.number(), messageId: z.string().nullable() })

export function reviewAnswer(api: ApiClient, responseId: string, body: ReviewBody): Promise<z.infer<typeof reviewedSchema>> {
  return api.post(`/purchasing/questionnaire-answers/${encodeURIComponent(responseId)}/review`, { body, schema: reviewedSchema, idempotencyKey: newIdempotencyKey() })
}

const versionAnswer = z.object({ version: versionSchema })

/** The starter questionnaire made the company's next version and published (two writes, each its own key). */
export async function publishStarter(api: ApiClient): Promise<QuestionnaireVersion> {
  const made = await api.post('/purchasing/questionnaires', { body: { from: 'STARTER' }, schema: versionAnswer, idempotencyKey: newIdempotencyKey() })
  const published = await api.post(`/purchasing/questionnaires/${encodeURIComponent(made.version.id)}/publish`, { body: { version: made.version.version }, schema: versionAnswer, idempotencyKey: newIdempotencyKey() })
  return published.version
}

/** A file's bytes (the answer's PDF, a document), read once through its 60-second address. */
export async function fileBytes(api: ApiClient, fileId: string): Promise<Uint8Array> {
  const { preview } = await previewLink(api, fileId)
  return readFromStore({ method: 'GET', url: preview.url, headers: preview.headers, expiresAt: preview.expiresAt })
}
