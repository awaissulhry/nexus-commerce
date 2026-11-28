import { z } from 'zod'
import type { ApiClient } from '../../../../../lib/api/client'
import { fileLink } from '../../../../warehouse/shipments/api'
import { presignedBytes } from '../../../../warehouse/shipments/files'

/**
 * owb-ss4 (S3 web A; settles L1, L6, L7, L8; server Shape build/briefs/owb-ss2.md § Shape, FIXED) — the calls of **Print and start the
 * work** and **Print again**: the preview (what prints, the work orders it makes and starts, the problems in words, the basket cards or
 * "at cutting on this site", how many pages have their code placed), the ONE start, a print again, and the print sheet of a print (the
 * design pages with the work order number as QR at its place, the basket cards with the BN code, the customer CODE — never a name, never
 * a price). Every answer is checked (zod; unknown fields are dropped).
 */

const enc = encodeURIComponent

export const CHECK_CLASSES = ['STRUCTURE', 'LAW', 'MONEY', 'HOLD', 'WARN'] as const
export type CheckClass = (typeof CHECK_CLASSES)[number]

export const problemSchema = z.object({ code: z.string(), class: z.enum(CHECK_CLASSES), workOrderNumber: z.string().nullable(), words: z.string() })
export type PrintProblem = z.infer<typeof problemSchema>

export const previewSchema = z.object({
  orderId: z.string(),
  version: z.number(),
  state: z.enum(['READY', 'PRINTED', 'NOT_CONFIRMED']),
  printedAt: z.string().nullable(),
  /** The site switch (ProductionSettings.basketsAtPrint): off → the cards print at cutting on this site. */
  basketsAtPrint: z.boolean(),
  /** A null id: the work order will be made. */
  workOrders: z.array(z.object({ workOrderId: z.string().nullable(), number: z.string().nullable(), styleCode: z.string(), pieces: z.number(), status: z.string().nullable() })),
  problems: z.array(problemSchema),
  refused: z.boolean(),
  needsMaterialReason: z.boolean(),
  /** count 0 while the switch is off. */
  baskets: z.object({ count: z.number(), lines: z.array(z.object({ salesOrderLineId: z.string(), label: z.string(), baskets: z.number() })) }),
  pages: z.array(z.object({ salesOrderLineId: z.string(), label: z.string(), fileId: z.string().nullable(), pageCount: z.number().nullable(), placed: z.boolean() })),
  placed: z.object({ done: z.number(), of: z.number() }),
})
export type PrintPreview = z.infer<typeof previewSchema>

/** Print and start the work: the preview (production.print.start). */
export function printStartPreview(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<PrintPreview> {
  return api.get(`/production/orders/${enc(orderId)}/print-start`, { schema: previewSchema, signal })
}

export interface StartBody {
  readonly version: number
  /** MATERIAL goes on with a reason (today's materialOverride.reason); absent when no MATERIAL warning. */
  readonly materialReason?: string
}

export const startedSchema = z.object({ printId: z.string(), orderId: z.string(), workOrders: z.array(z.object({ id: z.string(), number: z.string() })), baskets: z.number(), version: z.number() })
export type Started = z.infer<typeof startedSchema>

/** Print and start the work: ONE command per order (409 with the problems in words when refused; then the preview says them again). */
export function printAndStart(api: ApiClient, orderId: string, body: StartBody, idempotencyKey: string): Promise<Started> {
  return api.post(`/production/orders/${enc(orderId)}/print-and-start`, { body, schema: startedSchema, idempotencyKey })
}

export const AGAIN_REASONS = ['LOST', 'DAMAGED', 'SMALL_CHANGE', 'ONE_MORE_COPY'] as const
export type AgainReason = (typeof AGAIN_REASONS)[number]

export interface AgainBody {
  readonly reason: AgainReason
  /** Required on SMALL_CHANGE (≤ 140): the floor reads it on the basket ("The design changed: …"). */
  readonly note?: string
  readonly pages: readonly { readonly salesOrderLineId: string; readonly page: number }[]
  readonly cards: readonly { readonly bundleId: string }[]
}

export const againSchema = z.object({ printId: z.string(), printNo: z.number(), solvedCalls: z.number() })
export type Again = z.infer<typeof againSchema>

/** Print again: the SAME codes, nothing starts (production.print.start). */
export function printAgain(api: ApiClient, orderId: string, body: AgainBody, idempotencyKey: string): Promise<Again> {
  return api.post(`/production/orders/${enc(orderId)}/prints`, { body, schema: againSchema, idempotencyKey })
}

export const sheetStepSchema = z.object({ departmentNumber: z.number(), shortName: z.string(), name: z.string(), nameUr: z.string().nullable(), tone: z.string(), icon: z.string() })
export const sheetPageSchema = z.object({
  salesOrderLineId: z.string(),
  label: z.string(),
  styleCode: z.string(),
  fileId: z.string(),
  page: z.number(),
  contentType: z.string(),
  /** The work order number (the traveller's QR form). */
  qr: z.string(),
  workOrderNumber: z.string(),
  /** null: the usual place, top right, 20 mm. */
  placement: z.object({ xMm: z.number(), yMm: z.number(), sizeMm: z.number() }).nullable(),
  printNo: z.number(),
})
export const sheetCardSchema = z.object({
  bundleId: z.string(),
  code: z.string(),
  basketNo: z.string(),
  pieces: z.number(),
  styleCode: z.string(),
  label: z.string(),
  pictureFileId: z.string().nullable(),
  customerCode: z.string(),
  dueDate: z.string().nullable(),
  printNo: z.number(),
  steps: z.array(sheetStepSchema),
  /** Not in the Shape: when the server says it, a shipped basket's card is never offered again (L7). */
  shipped: z.boolean().optional(),
})
export const sheetSchema = z.object({
  printId: z.string(),
  kind: z.enum(['FIRST', 'AGAIN']),
  printedAt: z.string(),
  order: z.object({ number: z.string(), customerCode: z.string(), dueDate: z.string().nullable() }),
  pages: z.array(sheetPageSchema),
  cards: z.array(sheetCardSchema),
})
export type PrintSheetAnswer = z.infer<typeof sheetSchema>
export type SheetPage = PrintSheetAnswer['pages'][number]
export type SheetCard = PrintSheetAnswer['cards'][number]

/**
 * The print sheet of a print. Without `printId` (Print again's list of cards): the order's first print, as the server picks it — an
 * ask to the server (the Shape names `printId` only).
 */
export function printSheet(api: ApiClient, orderId: string, printId: string | null, signal?: AbortSignal): Promise<PrintSheetAnswer> {
  return api.get(`/production/orders/${enc(orderId)}/print-sheet`, { query: { printId: printId ?? undefined }, schema: sheetSchema, signal })
}

/** A stored file's bytes (a mockup PDF): the generic files route (files.read), then the store. */
export async function fileBytes(api: ApiClient, fileId: string): Promise<Uint8Array> {
  return presignedBytes(await fileLink(api, fileId))
}

/**
 * A stored picture's address for an `<img>`: its bytes read with the store's own headers (the store through this app's /api when local),
 * kept as an object address for the life of the page (a print sheet holds a few).
 */
export async function fileAddress(api: ApiClient, fileId: string): Promise<string> {
  const bytes = await fileBytes(api, fileId)
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return URL.createObjectURL(new Blob([copy]))
}

// ---- owb-ss4b: Place the scan code (server owb-ss2b) ----------------------------------------------------------------------------

export const placementSchema = z.object({
  salesOrderLineId: z.string(),
  fileId: z.string(),
  page: z.number(),
  xMm: z.number(),
  yMm: z.number(),
  sizeMm: z.number(),
  version: z.number(),
  placedAt: z.string(),
  placedBy: z.object({ name: z.string() }),
})
export type Placement = z.infer<typeof placementSchema>

/** The order's saved places (production.print.start, or the Factory designer on the order; anyone else: 404). */
export function listPlacements(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<Placement[]> {
  return api.get(`/production/orders/${enc(orderId)}/placements`, { schema: z.object({ placements: z.array(placementSchema) }), signal }).then((answer) => answer.placements)
}

export interface PlacementBody {
  readonly fileId: string
  readonly page: number
  readonly xMm: number
  readonly yMm: number
  readonly sizeMm: number
  readonly pageWidthMm: number
  readonly pageHeightMm: number
  /** The saved place's version (a move); absent for a new place. */
  readonly version?: number
}

/** Save one page's place (≥ 20 mm, wholly on the page; 400 on body/sizeMm|xMm|yMm|page|fileId; a version that moved: 409). */
export function savePlacement(api: ApiClient, orderId: string, salesOrderLineId: string, body: PlacementBody): Promise<Placement> {
  return api.request('PUT', `/production/orders/${enc(orderId)}/placements/${enc(salesOrderLineId)}`, { body, schema: placementSchema })
}
