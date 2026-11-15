import { z } from 'zod'
import type { ApiClient } from '../../lib/api/client'
import { fieldSchema, RECORD_KEYS, type RecordKey } from '../../areas/admin/fields/api'

/**
 * The custom-fields section of a record (B-W2b-431 on B-W2b-421's API): a record's values (`GET /fields/values/:type/:id`,
 * the RECORD's own view permission over it, else 404) and their change (`PUT`, the record's edit permission; each value at
 * the version read, null when it had none; a null value clears it). Shapes mirror platform/fields/contract.ts.
 */

export const valueSchema = z.object({
  code: z.string(),
  /** The stored value; money arrives unwrapped for a holder of its grain (the field is absent without it). */
  value: z.unknown(),
  wordsIt: z.string().nullable(),
  wordsEn: z.string().nullable(),
  version: z.number(),
  changedAt: z.string(),
  changedById: z.string(),
})
export type RecordValue = z.infer<typeof valueSchema>

const recordValuesSchema = z.object({
  recordType: z.enum(RECORD_KEYS),
  recordId: z.string(),
  fields: z.array(fieldSchema),
  values: z.array(valueSchema),
  canEdit: z.boolean(),
})
export type RecordValues = z.infer<typeof recordValuesSchema>

const seg = (value: string) => encodeURIComponent(value)

export const readValues = (api: ApiClient, recordType: RecordKey, recordId: string, signal?: AbortSignal) =>
  api.get(`/fields/values/${seg(recordType)}/${seg(recordId)}`, { schema: recordValuesSchema, signal })

export interface ValueEntry {
  code: string
  value: unknown
  version: number | null
}

export const writeValues = (api: ApiClient, recordType: RecordKey, recordId: string, values: readonly ValueEntry[], idempotencyKey: string) =>
  api.request('PUT', `/fields/values/${seg(recordType)}/${seg(recordId)}`, {
    body: { values },
    schema: recordValuesSchema.extend({ set: z.array(z.string()), cleared: z.array(z.string()) }),
    idempotencyKey,
  })
