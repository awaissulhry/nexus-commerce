import { z } from 'zod'
import { SHIPMENT_STATUSES } from '@nexus/factory-domain/shipping/shipments'
import type { ApiClient } from '../../../../lib/api/client'
import { DAY_SHEET_REFUSALS } from './model'

/**
 * The day's close (B-W2b-412 on B-W2b-395's API; apps/factory-api modules/shipping/manifest): a site's day per carrier (the
 * sheet, what it holds or what a close puts on it, what waits for the next day's, what is let go, what is still packed at the
 * dock), the sheet's preview PDF, the close (one sheet per carrier, printed on the site's A4 printer), a closed sheet and its
 * PDF (the End-of-day manifest window); and the hand-over of one shipment (W1's `…/ship`) for the selection row's "Mark
 * handed over". A refusal comes as a code (`refusal.code`); its English `message`, and a print problem's English words, are
 * never drawn. No money; who closed a sheet is a person or the system, never named here.
 */

const sheetShipmentSchema = z.object({
  id: z.string(),
  number: z.string(),
  consignee: z.string(),
  city: z.string(),
  country: z.string(),
  parcels: z.number(),
  weightKg: z.string(),
  trackingNumbers: z.array(z.string()),
  ddtNumber: z.string().nullable(),
  shippedAt: z.string().nullable(),
  /** It left on a day before, after that day's sheet had closed (a late hand-over). */
  earlier: z.boolean(),
})
export type SheetShipment = z.infer<typeof sheetShipmentSchema>

const refusalSchema = z.object({ code: z.enum(DAY_SHEET_REFUSALS) })
const totalsSchema = z.object({ shipments: z.number(), parcels: z.number(), weightKg: z.string() })

const sheetSchema = z.object({
  id: z.string(),
  state: z.enum(['OPEN', 'CLOSED']),
  closedAt: z.string().nullable(),
  closedBy: z.enum(['PERSON', 'SYSTEM']).nullable(),
  fileId: z.string().nullable(),
  version: z.number(),
})

const carrierDaySchema = z.object({
  carrierCode: z.string(),
  carrierName: z.string(),
  sheet: sheetSchema.nullable(),
  shipments: z.array(sheetShipmentSchema),
  waiting: z.array(sheetShipmentSchema),
  letGo: z.array(z.object({ id: z.string(), number: z.string(), status: z.enum(SHIPMENT_STATUSES) })),
  stillPacked: z.array(z.object({ id: z.string(), number: z.string(), parcels: z.number() })),
  totals: totalsSchema,
  may: z.object({ close: z.object({ allowed: z.boolean(), refusal: refusalSchema.nullable() }) }),
})
export type CarrierDay = z.infer<typeof carrierDaySchema>

export const endOfDaySchema = z.object({
  siteId: z.string(),
  companyId: z.string(),
  site: z.object({ code: z.string(), name: z.string(), timeZone: z.string() }),
  day: z.string(),
  today: z.string(),
  carriers: z.array(carrierDaySchema),
  toClose: z.array(z.string()),
})
export type EndOfDay = z.infer<typeof endOfDaySchema>

/** GET /shipping/end-of-day?siteId&day (default the site's today). */
export const readEndOfDay = (api: ApiClient, siteId: string, day: string | null, signal?: AbortSignal): Promise<EndOfDay> =>
  api.get('/shipping/end-of-day', { query: { siteId, day: day ?? undefined }, schema: endOfDaySchema, signal })

/** GET /shipping/end-of-day/preview: the carrier's sheet as it would close now ("ANTEPRIMA / PREVIEW"), stored nowhere. */
export const previewSheet = (api: ApiClient, query: { siteId: string; carrierCode: string; day: string }, signal?: AbortSignal): Promise<Uint8Array> =>
  api.bytes('/shipping/end-of-day/preview', { query, signal })

export const closeOutcomeSchema = z.object({
  carrierCode: z.string(),
  closed: z.boolean(),
  manifestId: z.string().optional(),
  shipments: z.number().optional(),
  parcels: z.number().optional(),
  letGo: z.array(z.string()).optional(),
  refusal: refusalSchema.optional(),
  printJob: z.object({ id: z.string(), status: z.string() }).nullable(),
  /** English words of why nothing printed: only whether there is one is read. */
  printProblem: z.string().nullable(),
})
export type CloseOutcome = z.infer<typeof closeOutcomeSchema>

const closeSchema = z.object({ siteId: z.string(), day: z.string(), outcomes: z.array(closeOutcomeSchema) })

/** POST /shipping/end-of-day/close (shipping.manage): one sheet per carrier, each printed on the site's A4 printer. */
export const closeDay = (api: ApiClient, body: { siteId: string; day: string; carrierCodes: string[]; print: boolean }, idempotencyKey: string): Promise<CloseOutcome[]> =>
  api.post('/shipping/end-of-day/close', { body, schema: closeSchema, idempotencyKey }).then((answer) => answer.outcomes)

export const manifestSchema = z.object({
  id: z.string(),
  site: z.object({ code: z.string(), name: z.string() }),
  carrierCode: z.string(),
  carrierName: z.string(),
  day: z.string(),
  state: z.enum(['OPEN', 'CLOSED']),
  closedAt: z.string().nullable(),
  closedBy: z.enum(['PERSON', 'SYSTEM']).nullable(),
  fileId: z.string().nullable(),
  shipments: z.array(sheetShipmentSchema),
  totals: totalsSchema,
})
export type Manifest = z.infer<typeof manifestSchema>

/** GET /shipping/manifests/:id: one sheet with its shipments and totals. */
export const readManifest = (api: ApiClient, manifestId: string, signal?: AbortSignal): Promise<Manifest> =>
  api.get(`/shipping/manifests/${encodeURIComponent(manifestId)}`, { schema: z.object({ manifest: manifestSchema }), signal }).then((answer) => answer.manifest)

const presigned = z.object({ url: z.string(), headers: z.record(z.string(), z.string()) })

/** GET /shipping/manifests/:id/pdf (+ files.read): the closed sheet's PDF, a presigned GET (409 NOT_CLOSED while open). */
export const manifestPdfLink = (api: ApiClient, manifestId: string, signal?: AbortSignal): Promise<{ url: string; headers: Record<string, string>; name: string }> =>
  api
    .get(`/shipping/manifests/${encodeURIComponent(manifestId)}/pdf`, { schema: z.object({ file: z.object({ originalName: z.string() }), download: presigned }), signal })
    .then((answer) => ({ ...answer.download, name: answer.file.originalName }))

/** POST /shipping/shipments/:id/ship (W1; shipping.manage): the goods handed over (each its own command). */
export const handOver = (api: ApiClient, shipmentId: string, version: number | null, idempotencyKey: string): Promise<void> =>
  api.post(`/shipping/shipments/${encodeURIComponent(shipmentId)}/ship`, { body: version ? { version } : {}, schema: z.object({ shipment: z.object({ id: z.string(), status: z.enum(SHIPMENT_STATUSES) }) }), idempotencyKey }).then(() => undefined)
