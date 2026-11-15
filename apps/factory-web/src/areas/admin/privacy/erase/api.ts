import { z } from 'zod'
import { ERASURE_BLOCKED, KEPT_WHY } from '@nexus/factory-domain/privacy/retention/erasure'
import { DATA_SUBJECT_KINDS, REQUEST_HELD } from '@nexus/factory-domain/privacy/retention/requests'
import { ERASURE_METHODS } from '@nexus/factory-domain/privacy/retention/retention'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { requestSchema } from '../requests/api'

/**
 * Anonymise …? (B-W2b-414 on B-W2b-405's API; PLT-203; GDPR art. 17; design admin.privacy pop:erase): the preview of what an
 * erasure does — per record type anonymised, deleted, or kept because the law requires it (with the law's why as a code) — and
 * the erasure itself (privacy.erase, a fresh code every time, the reason and the typed name). The API's English is left out:
 * the screen words each code.
 */

const group = z.object({
  recordType: z.string(),
  method: z.enum(ERASURE_METHODS),
  count: z.number(),
  erasedFields: z.array(z.string()),
  keptFields: z.array(z.string()),
  why: z.object({ code: z.enum(KEPT_WHY) }).nullable(),
})
export type ErasureGroup = z.infer<typeof group>

export const previewSchema = z.object({
  person: z.object({ kind: z.enum(DATA_SUBJECT_KINDS), recordType: z.string(), recordId: z.string(), name: z.string(), erased: z.boolean() }),
  blocked: z.object({ code: z.enum(ERASURE_BLOCKED) }).nullable(),
  anonymised: z.array(group),
  deleted: z.array(group),
  kept: z.array(group),
  records: z.number(),
  action: z.object({ allowed: z.boolean(), held: z.object({ code: z.enum(REQUEST_HELD) }).nullable() }),
})
export type ErasurePreview = z.infer<typeof previewSchema>

const erased = z.object({ request: requestSchema, erased: z.object({ anonymised: z.number(), deleted: z.number(), kept: z.number() }) })
export type Erased = z.infer<typeof erased>

const at = (requestId: string, rest: string) => `/privacy/requests/${encodeURIComponent(requestId)}${rest}`

/** What the erasure would do now (nothing is changed); `person.name` is the phrase to type. */
export const erasurePreview = (api: ApiClient, requestId: string, signal?: AbortSignal): Promise<ErasurePreview> => api.get(at(requestId, '/erasure'), { schema: previewSchema, signal })

/** Erases on the request (403 `stepUp` without a fresh code; 409 `privacy/<CODE>` while blocked). */
export const erasePerson = (api: ApiClient, requestId: string, body: { version: number; reason: string; confirmName: string }, idempotencyKey?: string): Promise<Erased> =>
  api.post(at(requestId, '/erase'), { body, schema: erased, idempotencyKey: idempotencyKey ?? newIdempotencyKey() })
