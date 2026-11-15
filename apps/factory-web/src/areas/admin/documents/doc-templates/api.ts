import { z } from 'zod'
import { COLUMN_KEYS } from '@nexus/factory-domain/documents/layouts'
import { DOCUMENT_TEMPLATE_KINDS, MANDATORY_PARTS } from '@nexus/factory-domain/templates/documents'
import { TEMPLATE_LANGUAGES } from '@nexus/factory-domain/templates/language'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'

/**
 * Document templates' calls (B-W2b-432 on B-W2b-422's API, platform/templates): the slots of a company (one per kind and
 * language) with every version, the kinds (the editor's sections, locked parts and placeholders), one version, its PDF
 * preview, and the writes — a new draft, its words saved, publish, retire, delete a draft. Each JSON answer is checked
 * against its shape; codes only (kinds, statuses, columns, parts), never the API's words. Mirrors apps/factory-api
 * platform/templates/contract.ts.
 */

export const TEMPLATE_STATUSES = ['DRAFT', 'ACTIVE', 'RETIRED'] as const
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number]
export type DocumentTemplateKind = (typeof DOCUMENT_TEMPLATE_KINDS)[number]
export type TemplateLanguage = (typeof TEMPLATE_LANGUAGES)[number]
export type ColumnKey = (typeof COLUMN_KEYS)[number]
export type MandatoryPart = (typeof MANDATORY_PARTS)[number]

export const personSchema = z.object({ id: z.string(), name: z.string() })

export const documentTemplateSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  kind: z.enum(DOCUMENT_TEMPLATE_KINDS),
  language: z.string(),
  revision: z.number(),
  status: z.enum(TEMPLATE_STATUSES),
  header: z.string().nullable(),
  terms: z.string().nullable(),
  footer: z.string().nullable(),
  fieldsShown: z.array(z.string()),
  layout: z.string(),
  publishedAt: z.string().nullable(),
  publishedBy: personSchema.nullable(),
  retiredAt: z.string().nullable(),
  createdAt: z.string(),
  createdBy: personSchema.nullable(),
  updatedAt: z.string(),
  version: z.number(),
})
export type DocumentTemplate = z.infer<typeof documentTemplateSchema>

export const slotVersionSchema = z.object({ id: z.string(), revision: z.number(), at: z.string() })
export type SlotVersion = z.infer<typeof slotVersionSchema>

export const documentSlotSchema = z.object({
  kind: z.enum(DOCUMENT_TEMPLATE_KINDS),
  language: z.enum(TEMPLATE_LANGUAGES),
  layout: z.string(),
  active: slotVersionSchema.nullable(),
  draft: slotVersionSchema.nullable(),
  versions: z.number(),
  lastChangedAt: z.string().nullable(),
})
export type DocumentSlot = z.infer<typeof documentSlotSchema>

const listAnswer = z.object({ templates: z.array(documentTemplateSchema), slots: z.array(documentSlotSchema), mayManage: z.boolean() })
export type DocumentTemplatesAnswer = z.infer<typeof listAnswer>

export const documentKindSchema = z.object({
  kind: z.enum(DOCUMENT_TEMPLATE_KINDS),
  layout: z.string(),
  optionalColumns: z.array(z.enum(COLUMN_KEYS)),
  mandatoryColumns: z.array(z.enum(COLUMN_KEYS)),
  mandatoryParts: z.array(z.enum(MANDATORY_PARTS)),
  placeholders: z.array(z.string()),
  limits: z.object({ header: z.number(), terms: z.number(), footer: z.number() }),
})
export type DocumentKind = z.infer<typeof documentKindSchema>
const kindsAnswer = z.object({ kinds: z.array(documentKindSchema), languages: z.array(z.enum(TEMPLATE_LANGUAGES)) })
export type DocumentKindsAnswer = z.infer<typeof kindsAnswer>

const oneAnswer = z.object({ template: documentTemplateSchema, mayManage: z.boolean() })
export type DocumentTemplateAnswer = z.infer<typeof oneAnswer>
const written = z.object({ template: documentTemplateSchema })
const published = z.object({ template: documentTemplateSchema, retired: z.object({ id: z.string(), revision: z.number() }).nullable() })
export type PublishAnswer = z.infer<typeof published>

const path = (templateId: string, rest = '') => `/templates/documents/${encodeURIComponent(templateId)}${rest}`

export const listDocumentTemplates = (api: ApiClient, query: { companyId: string; kind?: DocumentTemplateKind; language?: TemplateLanguage }, signal?: AbortSignal) =>
  api.get('/templates/documents', { query, schema: listAnswer, signal })

export const documentKinds = (api: ApiClient, signal?: AbortSignal) => api.get('/templates/documents/kinds', { schema: kindsAnswer, signal })

export const getDocumentTemplate = (api: ApiClient, templateId: string, signal?: AbortSignal) => api.get(path(templateId), { schema: oneAnswer, signal })

/** The version's PDF (a sample on the company's legal data with this version's words, any status; stored nowhere). */
export const documentTemplatePreview = (api: ApiClient, templateId: string, signal?: AbortSignal) => api.bytes(path(templateId, '/preview'), { signal })

/** The same PDF for a new tab (the browser's own GET through this app's `/api`). */
export const documentTemplatePreviewHref = (templateId: string) => `/api${path(templateId, '/preview')}`

export interface DocumentWords {
  header?: string | null
  terms?: string | null
  footer?: string | null
  fieldsShown?: string[]
}

/** A new draft (from `from`, else the version in use, else the code's layout); 409 refusal/DRAFT_OPEN while one is open. */
export const createDocumentTemplate = (api: ApiClient, body: { companyId: string; kind: DocumentTemplateKind; language: TemplateLanguage; from?: string } & DocumentWords, idempotencyKey: string = newIdempotencyKey()) =>
  api.post('/templates/documents', { body, idempotencyKey, schema: written }).then((answer) => answer.template)

export const saveDocumentTemplate = (api: ApiClient, template: Pick<DocumentTemplate, 'id' | 'version'>, words: DocumentWords) =>
  api.request('PUT', path(template.id), { body: { version: template.version, ...words }, idempotencyKey: newIdempotencyKey(), schema: written }).then((answer) => answer.template)

export const publishDocumentTemplate = (api: ApiClient, template: Pick<DocumentTemplate, 'id' | 'version'>) =>
  api.post(path(template.id, '/publish'), { body: { version: template.version }, idempotencyKey: newIdempotencyKey(), schema: published })

export const retireDocumentTemplate = (api: ApiClient, template: Pick<DocumentTemplate, 'id' | 'version'>) =>
  api.post(path(template.id, '/retire'), { body: { version: template.version }, idempotencyKey: newIdempotencyKey(), schema: written }).then((answer) => answer.template)

export const deleteDocumentTemplate = (api: ApiClient, template: Pick<DocumentTemplate, 'id' | 'version'>) =>
  api.request('DELETE', path(template.id), { query: { version: template.version }, idempotencyKey: newIdempotencyKey(), schema: z.object({ deleted: z.string() }) }).then((answer) => answer.deleted)

/**
 * What a kind prints NOW for a company in a language (platform/documents `GET /documents/sample`, a PDF in a new tab): the
 * sample prints through the company's legal data, so with the version in use, else the code's fixed layout.
 */
export const printsNowHref = (companyId: string, kind: DocumentTemplateKind, language: TemplateLanguage) =>
  `/api/documents/sample?${new URLSearchParams({ companyId, type: kind, language }).toString()}`
