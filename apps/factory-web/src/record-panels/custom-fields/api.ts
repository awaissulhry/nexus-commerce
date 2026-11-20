import { z } from 'zod'
import type { ApiClient } from '../../lib/api/client'
import { fieldSchema, RECORD_KEYS, type RecordKey } from '../../areas/admin/fields/api'

/**
 * The custom-fields section of a record (B-W2b-431 on B-W2b-421's API): a record's values (`GET /fields/values/:type/:id`,
 * the RECORD's own view permission over it, else 404) and their change (`PUT`, the record's edit permission; each value at
 * the version read, null when it had none; a null value clears it). Shapes mirror platform/fields/contract.ts.
 * F-OO-213 (B-OO-014): a sales order's values are part of the order — the read says its version and whether a closed or cancelled
 * order holds them (`editHeld`); a save sends the order's version back (`recordVersion`) and moves it.
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
  // ---- F-OO-213 (B-OO-014; order overview 11-design §8.3): the record's own state for its values — optional: an older answer lacks them.
  /** Why the values may not change now: FINAL (a closed or cancelled sales order: nobody may), ROLE (the reader's role); null: they may. */
  editHeld: z.enum(['FINAL', 'ROLE']).nullable().optional(),
  /** The record's own version its values are written at (a sales order's; null: a type that keeps none). */
  recordVersion: z.number().int().nullable().optional(),
  // ---- end F-OO-213
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

/**
 * F-OO-213: `recordVersion` — the record's own version as this page read it (a sales order's): only when given. The API refuses a
 * sales order that moved since (409, "changed since it was read") and writes nothing; left out, only each value's version is checked.
 */
export const writeValues = (api: ApiClient, recordType: RecordKey, recordId: string, values: readonly ValueEntry[], idempotencyKey: string, recordVersion?: number) =>
  api.request('PUT', `/fields/values/${seg(recordType)}/${seg(recordId)}`, {
    body: { values, ...(recordVersion === undefined ? {} : { recordVersion }) /* F-OO-213 */ },
    schema: recordValuesSchema.extend({ set: z.array(z.string()), cleared: z.array(z.string()) }),
    idempotencyKey,
  })
