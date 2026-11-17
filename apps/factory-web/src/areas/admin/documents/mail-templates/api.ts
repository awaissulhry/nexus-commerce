import { z } from 'zod'
import { MAIL_EVENTS } from '@nexus/factory-domain/templates/mail'
import { TEMPLATE_LANGUAGES } from '@nexus/factory-domain/templates/language'
// th-backend-g step 3 (B-TH-098's web half): a mail's words in the five message languages; German, French and Spanish start from
// Claude's drafts, "to be read once" until LANGUAGE_REVIEW names who read them.
import { MESSAGE_LANGUAGES, type MessageLanguage } from '@nexus/factory-domain/templates/message-languages'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { personSchema, slotVersionSchema, TEMPLATE_STATUSES } from '../doc-templates/api'

/**
 * E-mail templates' calls (B-W2b-432 on B-W2b-422's API): the events whose mail takes a template (placeholders, the code's
 * words per language), a company's slots (one per event and language: what the mail is sent with now — the company's
 * own, every company's, the code's words) with the versions, one version, its preview filled with made-up sample values,
 * and the writes. Nothing here sends a mail. Mirrors apps/factory-api platform/templates/contract.ts.
 */

export type MailEvent = (typeof MAIL_EVENTS)[number]
export const IN_USE = ['COMPANY', 'ALL', 'CODE'] as const
export type InUse = (typeof IN_USE)[number]

export const emailTemplateSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  event: z.enum(MAIL_EVENTS),
  language: z.string(),
  revision: z.number(),
  status: z.enum(TEMPLATE_STATUSES),
  subject: z.string(),
  body: z.string(),
  publishedAt: z.string().nullable(),
  publishedBy: personSchema.nullable(),
  retiredAt: z.string().nullable(),
  createdAt: z.string(),
  createdBy: personSchema.nullable(),
  updatedAt: z.string(),
  version: z.number(),
})
export type EmailTemplate = z.infer<typeof emailTemplateSchema>

const pairSchema = z.object({ active: slotVersionSchema.nullable(), draft: slotVersionSchema.nullable() })
export const mailSlotSchema = z.object({
  event: z.enum(MAIL_EVENTS),
  language: z.enum(MESSAGE_LANGUAGES), // th-backend-g step 3
  inUse: z.enum(IN_USE),
  company: pairSchema,
  all: pairSchema,
  lastChangedAt: z.string().nullable(),
})
export type MailSlot = z.infer<typeof mailSlotSchema>

const listAnswer = z.object({ templates: z.array(emailTemplateSchema), slots: z.array(mailSlotSchema), mayManage: z.object({ company: z.boolean(), all: z.boolean() }) })
export type EmailTemplatesAnswer = z.infer<typeof listAnswer>

export const mailEventSchema = z.object({
  event: z.enum(MAIL_EVENTS),
  recordType: z.string(),
  placeholders: z.array(z.string()),
  words: z.record(z.string(), z.object({ subject: z.string(), body: z.string() })),
  /** th-backend-g step 3: the code's words in German, French and Spanish — Claude's drafts (absent: an answer of before). */
  drafts: z.record(z.string(), z.object({ subject: z.string(), body: z.string() })).optional(),
})
export type MailEventInfo = z.infer<typeof mailEventSchema>
const reviewSchema = z.object({ readBy: z.string().nullable(), readOn: z.string().nullable() })
const eventsAnswer = z.object({
  events: z.array(mailEventSchema),
  languages: z.array(z.enum(TEMPLATE_LANGUAGES)),
  // ---- th-backend-g step 3: the five message languages and who read each drafted one once (readBy null: to be read once).
  messageLanguages: z.array(z.enum(MESSAGE_LANGUAGES)).optional(),
  review: z.object({ de: reviewSchema, fr: reviewSchema, es: reviewSchema }).optional(),
})
export type MailEventsAnswer = z.infer<typeof eventsAnswer>

const oneAnswer = z.object({ template: emailTemplateSchema, mayManage: z.boolean() })
export type EmailTemplateAnswer = z.infer<typeof oneAnswer>
const written = z.object({ template: emailTemplateSchema })
const published = z.object({ template: emailTemplateSchema, retired: z.object({ id: z.string(), revision: z.number() }).nullable() })
const previewAnswer = z.object({ subject: z.string(), body: z.string(), missing: z.array(z.string()) })
export type MailPreview = z.infer<typeof previewAnswer>

const path = (templateId: string, rest = '') => `/templates/mail/${encodeURIComponent(templateId)}${rest}`

export const mailEvents = (api: ApiClient, signal?: AbortSignal) => api.get('/templates/mail/events', { schema: eventsAnswer, signal })

export const listEmailTemplates = (api: ApiClient, query: { companyId: string; event?: MailEvent; language?: MessageLanguage }, signal?: AbortSignal) =>
  api.get('/templates/mail', { query, schema: listAnswer, signal })

export const getEmailTemplate = (api: ApiClient, templateId: string, signal?: AbortSignal) => api.get(path(templateId), { schema: oneAnswer, signal })

/** The saved words filled with the event's made-up sample and the company's names. Nothing is sent. */
export const previewEmailTemplate = (api: ApiClient, templateId: string, companyId?: string | null) =>
  api.post(path(templateId, '/preview'), { body: companyId ? { companyId } : {}, schema: previewAnswer })

/** A new draft (companyId null: every company's), from `from`, else the version in use, else the code's words. */
export const createEmailTemplate = (api: ApiClient, body: { companyId: string | null; event: MailEvent; language: MessageLanguage; from?: string }, idempotencyKey: string = newIdempotencyKey()) =>
  api.post('/templates/mail', { body, idempotencyKey, schema: written }).then((answer) => answer.template)

export const saveEmailTemplate = (api: ApiClient, template: Pick<EmailTemplate, 'id' | 'version'>, words: { subject?: string; body?: string }) =>
  api.request('PUT', path(template.id), { body: { version: template.version, ...words }, idempotencyKey: newIdempotencyKey(), schema: written }).then((answer) => answer.template)

export const publishEmailTemplate = (api: ApiClient, template: Pick<EmailTemplate, 'id' | 'version'>) =>
  api.post(path(template.id, '/publish'), { body: { version: template.version }, idempotencyKey: newIdempotencyKey(), schema: published })

export const retireEmailTemplate = (api: ApiClient, template: Pick<EmailTemplate, 'id' | 'version'>) =>
  api.post(path(template.id, '/retire'), { body: { version: template.version }, idempotencyKey: newIdempotencyKey(), schema: written }).then((answer) => answer.template)

export const deleteEmailTemplate = (api: ApiClient, template: Pick<EmailTemplate, 'id' | 'version'>) =>
  api.request('DELETE', path(template.id), { query: { version: template.version }, idempotencyKey: newIdempotencyKey(), schema: z.object({ deleted: z.string() }) }).then((answer) => answer.deleted)
