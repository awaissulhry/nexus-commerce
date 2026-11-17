import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'

/**
 * B-TH-265 (agreement T9 with the production lane, their B-PR-44 route #1563): the work order's "Order files (n)".
 * - `GET /production/work-orders/:workOrderId/order-files` (workorders.view): one group per order the work order's cells make — the
 *   order's own files, its lines' and their quote lines' artwork, the made-to-measure worksheets (only with sales.measurements.view),
 *   whether the reader may read the order's thread, and what was left out, COUNTED and never named (files of a company the reader
 *   does not read, body data without the measurements right, whole orders of a customer the reader does not reach).
 * - `POST …/order-files/:fileId/open` (workorders.view): ONE file through that route's own wall, a 60-second address; a body-data file's
 *   opening is recorded on its order. The generic file preview (files/:id/preview) is never what the work order links to.
 */

const lineRef = z.object({ id: z.string(), seq: z.number() })

const orderFile = z.object({
  id: z.string(),
  from: z.enum(['ORDER', 'LINE', 'QUOTE_LINE']),
  line: lineRef.nullable(),
  name: z.string(),
  contentType: z.string(),
  kind: z.string(),
  category: z.string().nullable(),
  sizeBytes: z.number(),
  versionNo: z.number(),
  at: z.string(),
  bodyData: z.boolean(),
})
export type OrderFile = z.infer<typeof orderFile>

const worksheet = z.object({ documentId: z.string(), profileId: z.string(), line: lineRef, version: z.number(), number: z.string().nullable(), language: z.string(), createdAt: z.string() })
export type OrderWorksheet = z.infer<typeof worksheet>

const group = z.object({
  order: z.object({ id: z.string(), number: z.string(), customerRef: z.string().nullable(), status: z.string(), orderDate: z.string() }),
  thread: z.object({ recordType: z.literal('SalesOrder'), recordId: z.string(), threadId: z.string().nullable() }).nullable(),
  files: z.array(orderFile),
  worksheets: z.array(worksheet),
  measurementsLeftOut: z.number(),
  filesLeftOut: z.number(),
})
export type OrderFilesGroup = z.infer<typeof group>

export const orderFilesSchema = z.object({ workOrder: z.object({ id: z.string(), number: z.string() }), groups: z.array(group), ordersLeftOut: z.number() })
export type WorkOrderOrderFiles = z.infer<typeof orderFilesSchema>

const opened = z.object({
  file: z.object({ id: z.string(), name: z.string(), contentType: z.string() }),
  open: z.object({ mode: z.enum(['inline', 'download']), method: z.literal('GET'), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: z.string() }),
})
export type OpenedOrderFile = z.infer<typeof opened>

const path = (workOrderId: string) => `/production/work-orders/${encodeURIComponent(workOrderId)}/order-files`

export function readOrderFiles(api: ApiClient, workOrderId: string, signal?: AbortSignal): Promise<WorkOrderOrderFiles> {
  return api.get(path(workOrderId), { schema: orderFilesSchema, ...(signal ? { signal } : {}) })
}

/** One order file's short-lived address: `preview` opens a picture or a PDF in the browser, any other kind downloads; `download` always a file. */
export function openOrderFile(api: ApiClient, workOrderId: string, fileId: string, mode: 'preview' | 'download'): Promise<OpenedOrderFile> {
  return api.post(`${path(workOrderId)}/${encodeURIComponent(fileId)}/open`, { body: { mode }, schema: opened, idempotencyKey: newIdempotencyKey() })
}
