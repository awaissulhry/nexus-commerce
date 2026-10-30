import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { presignedSchema } from '../../../record-panels/api'

/**
 * Every call of the shipping office screens (SCR-066 the shipments list, SCR-067 a shipment), with the answer's shape
 * checked (zod; unknown fields are dropped, so a new API field never breaks a page). The shapes mirror
 * apps/factory-api modules/shipping: shipments (what is released and not shipped, the list, the record, lines, cancel,
 * the packing list), packing (parcels, garments into parcels, DRAFT ⇄ PACKED), the DDT (preview, issue, read, PDF,
 * annul), carrier labels and tracking (Sendcloud, FAKE locally), the documents that travel (the DDT, the DoC and the
 * user information) and the customer's document link, and the site's shipping settings (the cut-off). No money
 * anywhere: a shipment carries none. The API's English words (problems, refusals) are never drawn as they are when the
 * screen has its own words for the case.
 */

export const SHIPMENT_STATUSES = ['DRAFT', 'PACKED', 'SHIPPED', 'DELIVERED', 'RETURNED', 'CANCELLED'] as const
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number]
export const TRANSPORT_BY = ['SENDER', 'RECIPIENT', 'CARRIER'] as const
export type TransportBy = (typeof TRANSPORT_BY)[number]
/** The DDT reasons a shipment to a customer may carry (factory-domain shipping/ddt SHIPMENT_DDT_REASONS). */
export const DDT_REASONS = ['SALE', 'RETURN_FROM_WORK', 'ON_APPROVAL', 'REPAIR', 'SAMPLE', 'OTHER'] as const
export type DdtReason = (typeof DDT_REASONS)[number]
export const DDT_FREIGHT = ['FREE', 'FORWARD'] as const
export const TRACKING_STATUSES = ['LABEL_CREATED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'EXCEPTION', 'RETURNED'] as const
export type TrackingStatus = (typeof TRACKING_STATUSES)[number]
export const DOCUMENT_KINDS = ['DDT', 'PACKING_LIST', 'DECLARATION_OF_CONFORMITY', 'USER_INFORMATION'] as const
export const DOCUMENT_STATES = ['ATTACHED', 'ON_FILE', 'MISSING', 'NOT_REQUIRED'] as const
export const LINK_STATES = ['LIVE', 'REVOKED', 'USED_UP', 'EXPIRED'] as const
/** DOCUMENT_VIEW's longest (packages/factory-domain links/purposes). */
export const LINK_EXPIRY_DAYS = 365

const instant = z.string()
const status = z.enum(SHIPMENT_STATUSES)
const transportBy = z.enum(TRANSPORT_BY)
const enc = encodeURIComponent

// ---- the list -----------------------------------------------------------------------------------------------------------

export const shipmentRowSchema = z.object({
  id: z.string(),
  number: z.string(),
  status,
  version: z.number(),
  companyId: z.string(),
  siteId: z.string(),
  partyId: z.string(),
  partyName: z.string(),
  salesOrderId: z.string(),
  salesOrderNumber: z.string(),
  transportBy,
  carrierCode: z.string().nullable(),
  carrierName: z.string().nullable(),
  serviceCode: z.string().nullable(),
  shipTo: z.object({ city: z.string().nullable(), country: z.string().nullable() }),
  lines: z.number(),
  garments: z.number(),
  parcels: z.number(),
  grossWeightKg: z.string().nullable(),
  labelled: z.number(),
  trackingNumbers: z.array(z.string()),
  ddt: z.object({ id: z.string(), number: z.string() }).nullable(),
  packedAt: instant.nullable(),
  shippedAt: instant.nullable(),
  cancelledAt: instant.nullable(),
  createdAt: instant,
})
export type ShipmentRow = z.infer<typeof shipmentRowSchema>

const pageSchema = z.object({ shipments: z.array(shipmentRowSchema), nextCursor: z.string().nullable() })
export type ShipmentPage = z.infer<typeof pageSchema>

/** The list's filters as the API reads them. */
export interface ShipmentQuery {
  status?: ShipmentStatus | null
  /** The ship-today queue: DRAFT and PACKED. */
  open?: boolean | null
  q?: string
  cursor?: string | null
  limit?: number
}

export function listShipments(api: ApiClient, query: ShipmentQuery, signal?: AbortSignal): Promise<ShipmentPage> {
  return api.get('/shipping/shipments', {
    query: {
      status: query.status ?? undefined,
      open: query.open === true ? 'true' : query.open === false ? 'false' : undefined,
      q: query.q?.trim() || undefined,
      cursor: query.cursor ?? undefined,
      limit: query.limit ?? 50,
    },
    schema: pageSchema,
    signal,
  })
}

// ---- the site's shipping settings (the cut-off) ------------------------------------------------------------------------

const siteSettingsSchema = z.object({
  site: z.object({ id: z.string(), companyId: z.string(), code: z.string(), name: z.string() }),
  settings: z
    .object({
      integrationAccountId: z.string().nullable(),
      defaultCarrierCode: z.string().nullable(),
      defaultServiceCode: z.string().nullable(),
      defaultTransportBy: transportBy,
      labelPrinterId: z.string().nullable(),
      documentPrinterId: z.string().nullable(),
      cutOffTime: z.string().nullable(),
    })
    .nullable(),
})
export type SiteSettings = z.infer<typeof siteSettingsSchema>

/** Every site the person reaches with its shipping settings (shipping.settings.view). */
export function listSiteSettings(api: ApiClient, signal?: AbortSignal): Promise<SiteSettings[]> {
  return api.get('/shipping/settings', { schema: z.object({ sites: z.array(siteSettingsSchema) }), signal }).then((answer) => answer.sites)
}

// ---- what is released and not shipped yet ----------------------------------------------------------------------------

export const readyCellSchema = z.object({
  workOrderSizeId: z.string(),
  workOrderId: z.string(),
  workOrderNumber: z.string(),
  batchNumber: z.string().nullable(),
  siteId: z.string(),
  salesOrderLineId: z.string(),
  lineSeq: z.number(),
  styleCode: z.string(),
  styleName: z.string(),
  colourwayCode: z.string(),
  colourwayName: z.string(),
  size: z.string(),
  pieces: z.number(),
  released: z.number(),
  reversed: z.number(),
  onShipments: z.number(),
  shippable: z.number(),
  serialTracked: z.boolean(),
})
export type ReadyCell = z.infer<typeof readyCellSchema>

export const readyOrderSchema = z.object({
  salesOrderId: z.string(),
  number: z.string(),
  customerRef: z.string().nullable(),
  status: z.string(),
  companyId: z.string(),
  partyId: z.string(),
  party: z.object({ code: z.string(), legalName: z.string() }),
  cells: z.array(readyCellSchema),
})
export type ReadyOrder = z.infer<typeof readyOrderSchema>

export function readyToShip(api: ApiClient, query: { salesOrderId?: string | null } = {}, signal?: AbortSignal): Promise<ReadyOrder[]> {
  return api.get('/shipping/ready', { query: { salesOrderId: query.salesOrderId ?? undefined }, schema: z.object({ orders: z.array(readyOrderSchema) }), signal }).then((answer) => answer.orders)
}

// ---- the record -----------------------------------------------------------------------------------------------------------

export const lineSchema = z.object({
  id: z.string(),
  version: z.number(),
  parcelId: z.string().nullable(),
  workOrderId: z.string(),
  workOrderNumber: z.string(),
  batchNumber: z.string().nullable(),
  workOrderSizeId: z.string(),
  salesOrderLineId: z.string(),
  styleId: z.string(),
  styleCode: z.string(),
  styleName: z.string(),
  colourwayId: z.string(),
  colourwayCode: z.string(),
  colourwayName: z.string(),
  size: z.string(),
  quantity: z.number(),
  serialTracked: z.boolean(),
  serials: z.array(z.object({ id: z.string(), serial: z.string() })),
})
export type ShipmentLine = z.infer<typeof lineSchema>

export const parcelSchema = z.object({
  id: z.string(),
  version: z.number(),
  seq: z.number(),
  grossWeightKg: z.string().nullable(),
  lengthCm: z.string().nullable(),
  widthCm: z.string().nullable(),
  heightCm: z.string().nullable(),
  trackingNumber: z.string().nullable(),
  labelledAt: instant.nullable(),
  garments: z.number(),
})
export type Parcel = z.infer<typeof parcelSchema>

export const shipmentSchema = z.object({
  id: z.string(),
  number: z.string(),
  status,
  version: z.number(),
  companyId: z.string(),
  siteId: z.string(),
  partyId: z.string(),
  party: z.object({ code: z.string(), legalName: z.string() }),
  salesOrderId: z.string(),
  salesOrder: z.object({ number: z.string(), customerRef: z.string().nullable(), status: z.string() }),
  shipToAddressId: z.string().nullable(),
  shipTo: z.record(z.string(), z.unknown()),
  transportBy,
  carrierCode: z.string().nullable(),
  carrierName: z.string().nullable(),
  serviceCode: z.string().nullable(),
  ddtRequired: z.boolean(),
  packedAt: instant.nullable(),
  shippedAt: instant.nullable(),
  deliveredAt: instant.nullable(),
  returnedAt: instant.nullable(),
  cancelledAt: instant.nullable(),
  cancelReason: z.string().nullable(),
  internalNote: z.string().nullable(),
  createdAt: instant,
  updatedAt: instant,
  lines: z.array(lineSchema),
  parcels: z.array(parcelSchema),
  garments: z.number(),
  packingProblems: z.array(z.string()),
})
export type Shipment = z.infer<typeof shipmentSchema>
const oneShipment = z.object({ shipment: shipmentSchema })

export function getShipment(api: ApiClient, id: string, signal?: AbortSignal): Promise<Shipment> {
  return api.get(`/shipping/shipments/${enc(id)}`, { schema: oneShipment, signal }).then((answer) => answer.shipment)
}

export interface NewShipmentBody {
  salesOrderId: string
  transportBy?: TransportBy
  carrierCode?: string | null
  serviceCode?: string | null
  internalNote?: string | null
  lines: { workOrderSizeId: string; quantity: number }[]
}

export function createShipment(api: ApiClient, body: NewShipmentBody, idempotencyKey: string): Promise<Shipment> {
  return api.post('/shipping/shipments', { body, schema: oneShipment, idempotencyKey }).then((answer) => answer.shipment)
}

export interface DeliveryBody {
  version: number
  transportBy?: TransportBy
  carrierCode?: string | null
  serviceCode?: string | null
  internalNote?: string | null
}

export function updateShipment(api: ApiClient, id: string, body: DeliveryBody): Promise<Shipment> {
  return api.request('PATCH', `/shipping/shipments/${enc(id)}`, { body, schema: oneShipment }).then((answer) => answer.shipment)
}

export function addLines(api: ApiClient, id: string, version: number, lines: { workOrderSizeId: string; quantity: number }[]): Promise<Shipment> {
  return api.post(`/shipping/shipments/${enc(id)}/lines`, { body: { version, lines }, schema: oneShipment }).then((answer) => answer.shipment)
}

export function changeLine(api: ApiClient, id: string, lineId: string, version: number, quantity: number): Promise<Shipment> {
  return api.request('PATCH', `/shipping/shipments/${enc(id)}/lines/${enc(lineId)}`, { body: { version, quantity }, schema: oneShipment }).then((answer) => answer.shipment)
}

export function removeLine(api: ApiClient, id: string, lineId: string, version: number): Promise<Shipment> {
  return api.request('DELETE', `/shipping/shipments/${enc(id)}/lines/${enc(lineId)}`, { query: { version }, schema: oneShipment }).then((answer) => answer.shipment)
}

export function cancelShipment(api: ApiClient, id: string, version: number, reason: string): Promise<Shipment> {
  return api.post(`/shipping/shipments/${enc(id)}/cancel`, { body: { version, reason }, schema: oneShipment }).then((answer) => answer.shipment)
}

const storedFileSchema = z.object({ id: z.string(), originalName: z.string(), contentType: z.string(), sizeBytes: z.number(), createdAt: instant })

/** The packing list PDF (stored on the shipment, shared with the site's floor, which prints it at the packing station). */
export function makePackingList(api: ApiClient, id: string): Promise<z.infer<typeof storedFileSchema>> {
  return api.post(`/shipping/shipments/${enc(id)}/packing-list`, { body: {}, schema: z.object({ file: storedFileSchema }) }).then((answer) => answer.file)
}

// ---- packing in the office (the same routes as the floor's) --------------------------------------------------------------

const packingAnswer = z.object({ shipment: z.object({ id: z.string(), version: z.number(), status }) })

export interface Measures {
  grossWeightKg?: string | null
  lengthCm?: string | null
  widthCm?: string | null
  heightCm?: string | null
}

export function addParcel(api: ApiClient, id: string, version: number, measures: Measures = {}): Promise<{ parcelId: string }> {
  return api.post(`/shipping/packing/${enc(id)}/parcels`, { body: { version, ...measures }, schema: z.object({ parcelId: z.string() }) })
}

export function changeParcel(api: ApiClient, id: string, parcelId: string, version: number, measures: Measures): Promise<unknown> {
  return api.request('PATCH', `/shipping/packing/${enc(id)}/parcels/${enc(parcelId)}`, { body: { version, ...measures }, schema: packingAnswer })
}

export function removeParcel(api: ApiClient, id: string, parcelId: string, version: number): Promise<unknown> {
  return api.request('DELETE', `/shipping/packing/${enc(id)}/parcels/${enc(parcelId)}`, { query: { version }, schema: packingAnswer })
}

export function placeLine(api: ApiClient, id: string, lineId: string, version: number, parcelId: string | null, quantity?: number): Promise<unknown> {
  return api.request('PUT', `/shipping/packing/${enc(id)}/lines/${enc(lineId)}/parcel`, { body: { version, parcelId, ...(quantity ? { quantity } : {}) }, schema: packingAnswer })
}

export function markPacked(api: ApiClient, id: string, version: number): Promise<unknown> {
  return api.post(`/shipping/packing/${enc(id)}/pack`, { body: { version }, schema: packingAnswer })
}

export function unpack(api: ApiClient, id: string, version: number): Promise<unknown> {
  return api.post(`/shipping/packing/${enc(id)}/unpack`, { body: { version }, schema: packingAnswer })
}

// ---- the DDT ------------------------------------------------------------------------------------------------------------------

const addressSchema = z.object({ line1: z.string(), line2: z.string().nullable().optional(), postalCode: z.string(), city: z.string(), province: z.string().nullable().optional(), country: z.string() })
const partySchema = z.object({ name: z.string(), address: addressSchema.nullable(), vatNumber: z.string().nullable().optional(), fiscalCode: z.string().nullable().optional() })

const printedSchema = {
  documentDate: z.string(),
  reason: z.string(),
  reasonText: z.string().nullable(),
  transportBy,
  carrier: z.object({ name: z.string(), address: addressSchema.nullable().optional(), vatNumber: z.string().nullable().optional() }).nullable(),
  startAt: instant,
  appearance: z.string(),
  packages: z.number(),
  grossWeightKg: z.string(),
  netWeightKg: z.string().nullable(),
  freight: z.enum(DDT_FREIGHT).nullable(),
  sender: partySchema,
  recipient: partySchema,
  destination: addressSchema.extend({ name: z.string().nullable().optional() }).nullable(),
  lines: z.array(
    z.object({
      seq: z.number(),
      code: z.string().nullable(),
      description: z.string(),
      quantity: z.string(),
      uom: z.string(),
      size: z.string(),
      batchNumber: z.string().nullable(),
      serials: z.array(z.string()),
    }),
  ),
  documentRefs: z.array(z.object({ kind: z.string(), number: z.string(), date: z.string().nullable().optional() })),
  remarks: z.string().nullable(),
}
export const draftSchema = z.object(printedSchema)
export type DdtDraft = z.infer<typeof draftSchema>

export const ddtSchema = z.object({
  id: z.string(),
  number: z.string(),
  status: z.enum(['LIVE', 'CANCELLED']),
  ...printedSchema,
  shipmentId: z.string(),
  shipmentNumber: z.string(),
  issuedAt: instant,
  cancellation: z.object({ id: z.string(), reason: z.string(), cancelledAt: instant }).nullable(),
  fileId: z.string().nullable(),
})
export type Ddt = z.infer<typeof ddtSchema>

/** What the office says on a DDT; everything else comes from the shipment, its order, its parcels and the company. */
export interface DdtRequest {
  version?: number
  reason?: DdtReason
  reasonText?: string | null
  carrier?: { name: string; vatNumber?: string | null } | null
  startAt?: string | null
  appearance?: string | null
  netWeightKg?: string | null
  freight?: 'FREE' | 'FORWARD' | null
  remarks?: string | null
  /** The goods leave now: PACKED → SHIPPED in the same command (own van, customer pickup). */
  ship?: boolean
}

export const previewSchema = z.object({
  draft: draftSchema,
  problems: z.array(z.object({ path: z.string(), message: z.string() })),
  expectedNumber: z.string().nullable(),
  language: z.string(),
})
export type DdtPreview = z.infer<typeof previewSchema>

export function previewDdt(api: ApiClient, shipmentId: string, body: DdtRequest, signal?: AbortSignal): Promise<DdtPreview> {
  return api.post(`/shipping/shipments/${enc(shipmentId)}/ddt/preview`, { body, schema: previewSchema, signal })
}

/** The draft as a PDF with the "SAMPLE" banner: stored nowhere, no number used. */
export function previewDdtPdf(api: ApiClient, shipmentId: string, body: DdtRequest, signal?: AbortSignal): Promise<Uint8Array> {
  return api.bytes(`/shipping/shipments/${enc(shipmentId)}/ddt/preview/pdf`, { method: 'POST', body, signal })
}

export const issueAnswerSchema = z.object({
  ddt: ddtSchema,
  shipment: z.object({ id: z.string(), number: z.string(), status, version: z.number() }),
  file: z.object({ id: z.string() }).nullable(),
  pdfProblem: z.string().nullable(),
})
export type IssueAnswer = z.infer<typeof issueAnswerSchema>

export function issueDdt(api: ApiClient, shipmentId: string, body: DdtRequest, idempotencyKey: string): Promise<IssueAnswer> {
  return api.post(`/shipping/shipments/${enc(shipmentId)}/ddt`, { body, schema: issueAnswerSchema, idempotencyKey })
}

export function shipShipment(api: ApiClient, shipmentId: string, version: number): Promise<Shipment> {
  return api.post(`/shipping/shipments/${enc(shipmentId)}/ship`, { body: { version }, schema: oneShipment }).then((answer) => answer.shipment)
}

const ddtRowSchema = z.object({ id: z.string(), number: z.string(), documentDate: z.string(), status: z.enum(['LIVE', 'CANCELLED']), issuedAt: instant, cancelledAt: instant.nullable(), fileId: z.string().nullable() })
export type DdtRow = z.infer<typeof ddtRowSchema>

export function listDdts(api: ApiClient, shipmentId: string, signal?: AbortSignal): Promise<DdtRow[]> {
  return api.get('/shipping/ddts', { query: { shipmentId, limit: 50 }, schema: z.object({ ddts: z.array(ddtRowSchema) }), signal }).then((answer) => answer.ddts)
}

export function getDdt(api: ApiClient, ddtId: string, signal?: AbortSignal): Promise<Ddt> {
  return api.get(`/shipping/ddts/${enc(ddtId)}`, { schema: z.object({ ddt: ddtSchema }), signal }).then((answer) => answer.ddt)
}

/** The issued DDT's PDF: a presigned GET (files.read too). */
export function ddtPdfLink(api: ApiClient, ddtId: string): Promise<z.infer<typeof presignedSchema>> {
  return api.get(`/shipping/ddts/${enc(ddtId)}/pdf`, { schema: z.object({ download: presignedSchema }) }).then((answer) => answer.download)
}

/** Prints a missing PDF of an issued DDT again (the DDT itself never changes). */
export function printDdtAgain(api: ApiClient, ddtId: string): Promise<unknown> {
  return api.post(`/shipping/ddts/${enc(ddtId)}/pdf`, { body: {}, schema: z.object({ file: z.object({ id: z.string() }) }) })
}

export const cancelAnswerSchema = z.object({
  ddt: ddtSchema,
  shipment: z.object({ id: z.string(), status, version: z.number(), needsDdt: z.boolean() }),
  draftInvoiceIds: z.array(z.string()),
  warning: z.string().nullable(),
})

export function annulDdt(api: ApiClient, ddtId: string, version: number, reason: string): Promise<z.infer<typeof cancelAnswerSchema>> {
  return api.post(`/shipping/ddts/${enc(ddtId)}/cancel`, { body: { version, reason }, schema: cancelAnswerSchema })
}

// ---- carrier labels and tracking -----------------------------------------------------------------------------------------------

const labelParcelSchema = z.object({
  parcelId: z.string(),
  seq: z.number(),
  version: z.number(),
  grossWeightKg: z.string().nullable(),
  trackingNumber: z.string().nullable(),
  labelledAt: instant.nullable(),
  files: z.array(z.object({ fileId: z.string(), format: z.enum(['PDF', 'ZPL']), name: z.string() })),
  print: z.object({ jobId: z.string(), status: z.string(), createdAt: instant }).nullable(),
})
export const labelsSchema = z.object({
  labelPrinterId: z.string().nullable(),
  cutOff: z.object({ time: z.string(), at: instant, passed: z.boolean() }).nullable(),
  toLabel: z.number(),
  parcels: z.array(labelParcelSchema),
})
export type Labels = z.infer<typeof labelsSchema>

export function getLabels(api: ApiClient, shipmentId: string, signal?: AbortSignal): Promise<Labels> {
  return api.get(`/shipping/shipments/${enc(shipmentId)}/labels`, { schema: labelsSchema, signal })
}

export const boughtSchema = labelsSchema.extend({
  outcomes: z.array(z.object({ parcelId: z.string(), seq: z.number(), ok: z.boolean(), problem: z.string().optional() })),
  problem: z.string().nullable(),
})
export type Bought = z.infer<typeof boughtSchema>

export function buyLabels(api: ApiClient, shipmentId: string, version: number, idempotencyKey: string): Promise<Bought> {
  return api.post(`/shipping/shipments/${enc(shipmentId)}/labels`, { body: { version }, schema: boughtSchema, idempotencyKey })
}

export function printLabels(api: ApiClient, shipmentId: string): Promise<{ jobs: { jobId: string; parcelId: string; seq: number; status: string }[] }> {
  return api.post(`/shipping/shipments/${enc(shipmentId)}/labels/print`, { body: {}, schema: z.object({ jobs: z.array(z.object({ jobId: z.string(), parcelId: z.string(), seq: z.number(), status: z.string() })) }) })
}

/** A label file (PDF) to download: the generic files route (files.read). */
export function fileLink(api: ApiClient, fileId: string): Promise<z.infer<typeof presignedSchema>> {
  return api.get(`/files/${enc(fileId)}/download`, { schema: z.object({ download: presignedSchema }) }).then((answer) => answer.download)
}

export const trackingSchema = z.object({
  shipment: z.object({ status, carrierName: z.string().nullable(), shippedAt: instant.nullable(), deliveredAt: instant.nullable(), returnedAt: instant.nullable() }),
  parcels: z.array(z.object({ parcelId: z.string(), seq: z.number(), trackingNumber: z.string().nullable(), labelledAt: instant.nullable(), status: z.enum(TRACKING_STATUSES).nullable(), lastEventAt: instant.nullable() })),
  events: z.array(
    z.object({
      id: z.string(),
      parcelId: z.string().nullable(),
      seq: z.number().nullable(),
      status: z.enum(TRACKING_STATUSES),
      description: z.string().nullable(),
      location: z.string().nullable(),
      occurredAt: instant,
      source: z.enum(['WEBHOOK', 'POLL', 'MANUAL']),
    }),
  ),
  problem: z.string().nullable(),
})
export type Tracking = z.infer<typeof trackingSchema>

export function getTracking(api: ApiClient, shipmentId: string, signal?: AbortSignal): Promise<Tracking> {
  return api.get(`/shipping/shipments/${enc(shipmentId)}/tracking`, { schema: trackingSchema, signal })
}

// ---- the documents that travel, and the customer's link ------------------------------------------------------------------------

const travelFileSchema = z.object({ id: z.string(), originalName: z.string(), sizeBytes: z.number() })

export const travelDocumentSchema = z.object({
  key: z.string(),
  kind: z.enum(DOCUMENT_KINDS),
  state: z.enum(DOCUMENT_STATES),
  byLink: z.boolean(),
  style: z.object({ id: z.string(), code: z.string(), name: z.string(), revision: z.number().nullable() }).nullable(),
  wantedLanguage: z.string().nullable(),
  language: z.string().nullable(),
  fallback: z.boolean(),
  number: z.string().nullable(),
  date: z.string().nullable(),
  source: travelFileSchema.nullable(),
  copy: travelFileSchema.nullable(),
  message: z.string(),
})
export type TravelDocument = z.infer<typeof travelDocumentSchema>

const checkSchema = z.object({ code: z.string(), state: z.string(), blocks: z.array(z.string()), message: z.string(), problems: z.array(z.object({ path: z.string(), message: z.string() })) })

export const documentLinkSchema = z.object({
  id: z.string(),
  email: z.string().nullable(),
  state: z.enum(LINK_STATES),
  expiresAt: instant,
  maxUses: z.number(),
  uses: z.number(),
  lastUsedAt: instant.nullable(),
  revokedAt: instant.nullable(),
  createdAt: instant,
  automatic: z.boolean(),
})
export type DocumentLink = z.infer<typeof documentLinkSchema>

export const documentsSchema = z.object({
  languages: z.array(z.string()),
  documents: z.array(travelDocumentSchema),
  checks: z.array(checkSchema),
  blockers: z.array(checkSchema),
  warnings: z.array(z.object({ path: z.string(), message: z.string() })),
  counts: z.object({ attached: z.number(), toAttach: z.number(), missing: z.number() }),
  recipients: z.array(z.object({ contactId: z.string(), name: z.string(), email: z.string() })),
  links: z.array(documentLinkSchema),
})
export type Documents = z.infer<typeof documentsSchema>

export function getDocuments(api: ApiClient, shipmentId: string, signal?: AbortSignal): Promise<Documents> {
  return api.get(`/shipping/shipments/${enc(shipmentId)}/documents`, { schema: z.object({ documents: documentsSchema }), signal }).then((answer) => answer.documents)
}

export function attachDocuments(api: ApiClient, shipmentId: string): Promise<{ attached: number; documents: Documents }> {
  return api.post(`/shipping/shipments/${enc(shipmentId)}/documents/attach`, { body: {}, schema: z.object({ attached: z.number(), documents: documentsSchema }) })
}

export const sentLinksSchema = z.object({
  links: z.array(z.object({ linkId: z.string(), email: z.string(), expiresAt: instant, maxUses: z.number(), delivery: z.string() })),
  skipped: z.array(z.object({ email: z.string(), reason: z.enum(['SUPPRESSED', 'ALREADY_SENT', 'ASKED_RECENTLY']) })),
  attached: z.number(),
  documents: documentsSchema,
})
export type SentLinks = z.infer<typeof sentLinksSchema>

export function sendDocumentLink(api: ApiClient, shipmentId: string, body: { contactIds?: string[]; expiresInDays?: number }, idempotencyKey: string): Promise<SentLinks> {
  return api.post(`/shipping/shipments/${enc(shipmentId)}/documents/link`, { body, schema: sentLinksSchema, idempotencyKey })
}
