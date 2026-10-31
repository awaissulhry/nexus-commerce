import { z } from 'zod'
import { DOCUMENT_KINDS } from '@nexus/factory-domain/numbering/kinds'
import { OVERRIDE_REFUSALS } from '@nexus/factory-domain/numbering/override'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * The number preview and the typed number of a migrated document (B-W2b-24; PLT-125; design admin.documents popup
 * `override`): `GET /numbering/preview` (the number a new document would get now, not reserved) and
 * `POST /numbering/override/check` (what a typed number meets, read only). Mirrors apps/factory-api numbering/contract.ts.
 */

export type DocumentKind = (typeof DOCUMENT_KINDS)[number]
export const OVERRIDE_CODES = Object.keys(OVERRIDE_REFUSALS) as [keyof typeof OVERRIDE_REFUSALS, ...(keyof typeof OVERRIDE_REFUSALS)[]]
export type OverrideCode = (typeof OVERRIDE_CODES)[number]
export const PREVIEW_HELD = ['noSeries', 'several', 'closed', 'exhausted'] as const
export type PreviewHeld = (typeof PREVIEW_HELD)[number]

export const previewSchema = z.object({
  companyId: z.string(),
  kind: z.enum(DOCUMENT_KINDS),
  date: z.string(),
  code: z.string().nullable(),
  scopeKey: z.string().nullable(),
  number: z.string().nullable(),
  fiscal: z.boolean(),
  newPeriod: z.boolean(),
  held: z.enum(PREVIEW_HELD).nullable(),
})
export type NumberPreview = z.infer<typeof previewSchema>

export const checkSchema = z.object({
  number: z.string(),
  ok: z.boolean(),
  refusal: z.object({ code: z.enum(OVERRIDE_CODES), message: z.string() }).nullable(),
})
export type OverrideCheck = z.infer<typeof checkSchema>

export const previewNumber = (api: ApiClient, query: { companyId: string; kind: DocumentKind; date?: string }) =>
  api.get('/numbering/preview', { query, schema: z.object({ preview: previewSchema }) }).then((answer) => answer.preview)

export const checkTypedNumber = (api: ApiClient, body: { companyId: string; kind: DocumentKind; number: string }) => api.post('/numbering/override/check', { body, schema: checkSchema })
