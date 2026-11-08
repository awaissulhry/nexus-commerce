import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import { cutLogSchema } from '../../_shared/api'

/**
 * The work order's cut log with its W2b facts (B-W2b-130; SCR-071 wo-cutlog "row → docked drawer (pieces, hide photo W2b)"): the
 * same GET …/cut-log as W1, its entries read with the photo of the hide taken at the table (B-W2b-103: a file of the Hide, never a
 * face, COL-017) and the thickness measured there; and the photo's address for an image (GET /files/:id/preview, a presigned
 * address that lives 60 seconds, inline for a picture). Nothing names who cut beyond W1's own gated field.
 */

const entrySchema = cutLogSchema.shape.entries.element.extend({
  photoFileId: z.string().nullable().optional(),
  measuredThicknessMm: z.string().nullable().optional(),
})

export const cutLogW2bSchema = cutLogSchema.extend({ entries: z.array(entrySchema) })
export type CutLogW2b = z.infer<typeof cutLogW2bSchema>
export type CutEntryW2b = CutLogW2b['entries'][number]

export function getCutLogW2b(api: ApiClient, workOrderId: string, signal?: AbortSignal): Promise<CutLogW2b> {
  return api.get(`/production/cutting/work-orders/${encodeURIComponent(workOrderId)}/cut-log`, { schema: cutLogW2bSchema, signal })
}

const previewSchema = z.object({ preview: z.object({ url: z.string(), mode: z.enum(['inline', 'download']) }) })

/** The hide photo's address for an <img> (a same-origin path goes through this app's /api); null when the store gives no picture. */
export async function hidePhotoAddress(api: ApiClient, fileId: string): Promise<string | null> {
  const { preview } = await api.get(`/files/${encodeURIComponent(fileId)}/preview`, { schema: previewSchema })
  if (preview.mode !== 'inline') return null
  return preview.url.startsWith('/') && !preview.url.startsWith('//') ? `/api${preview.url}` : preview.url
}
