import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { BULK_LIMITS, BULK_REFUSALS } from '@nexus/factory-domain/views/bulk/rules'
import { LIST_KEY, VIEW_LIMITS } from '@nexus/factory-domain/views/state'

/**
 * Bulk edit with preview and inline edit (B-W2b-13; PLT-182, PLT-166; design shell.lists pop:bulk-edit,
 * sec:selection-row "→ ReviewChangesModal (old → new per row, conflicts) → Done with Undo", sec:grid "autosaved per
 * cell … with a version check"). Office only. A field is named by the list frame's column id; its value is a day
 * (YYYY-MM-DD), a whole number, a text or a choice's code, or null. Every refusal is a code (the screen says its own
 * words): held (the record's state keeps the field; `status` names it), stale (changed since it was reviewed), missing
 * (not found or not in the person's sites), forbidden, invalid (`field`), failed.
 */

const listKey = z.string().regex(LIST_KEY).max(VIEW_LIMITS.listKey)
const fieldId = z.string().regex(/^[A-Za-z0-9_.:-]+$/).max(VIEW_LIMITS.columnId)
const valueIn = z.union([z.string().max(BULK_LIMITS.text), z.number().finite(), z.null()])
const changesIn = z.record(fieldId, valueIn)
const unique = (ids: readonly string[]) => new Set(ids).size === ids.length

const value = z.union([z.string(), z.number(), z.null()])
// B-W2b-51: `reasons`, what holds a row in the record's own codes (a work order's blocking release checks).
const refusal = output({ code: z.enum(BULK_REFUSALS), field: z.string().nullable(), status: z.string().nullable(), reasons: z.array(z.string()).optional() })
const values = z.record(z.string(), value)

export const previewBulkContract = defineContract({
  body: input({
    listKey,
    /** The selected rows (the list frame's row ids), each once. */
    ids: z.array(id()).min(1).max(BULK_LIMITS.rows).refine(unique, { message: 'Each row once.' }),
    /** The same new values for every row. */
    changes: changesIn,
  }),
  response: {
    200: output({
      /** In the order of `ids`: old → new per field that would change, or why the row is not changed. */
      rows: z.array(
        output({
          id: id(),
          /** The record's number; empty for a row that could not be read (missing). */
          label: z.string(),
          /** The version reviewed: the apply sends it back. */
          version: z.number().int(),
          changes: z.array(output({ field: z.string(), now: value, next: value })),
          refusal: refusal.nullable(),
        }),
      ),
    }),
  },
})
export type PreviewBulkBody = z.infer<typeof previewBulkContract.body>

export const applyBulkContract = defineContract({
  body: input({
    listKey,
    /** Each row with the version reviewed and its values (a bulk edit: the same on every row; Undo: each row's own). */
    rows: z
      .array(input({ id: id(), version: z.number().int().min(1), changes: changesIn }))
      .min(1)
      .max(BULK_LIMITS.rows)
      .refine((rows) => unique(rows.map((row) => row.id)), { message: 'Each row once.' }),
    /** The web's Undo of an apply it just made: the same writes (each row's earlier values, from the version the change gave it). */
    undo: z.boolean().optional(),
  }),
  response: {
    200: output({
      /** In the order of `rows`: what became of each (one refused row never stops the others). */
      results: z.array(
        output({
          id: id(),
          label: z.string(),
          ok: z.boolean(),
          refusal: refusal.nullable(),
          /** The asked fields before and after (equal when nothing was written). */
          before: values,
          after: values,
          /** The row's version after the write (as read when refused). */
          version: z.number().int(),
        }),
      ),
    }),
  },
})
export type ApplyBulkBody = z.infer<typeof applyBulkContract.body>
