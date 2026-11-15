import { z } from 'zod'
import { BROKER_PACK_REFUSALS, PACK_PART_STATES, PACK_PARTS } from '@nexus/factory-domain/shipping/broker-pack/rules'
import { CN23_BECAUSE, CUSTOMS_REFUSALS, DECLARATION_STATUSES, DESTINATION_CLASSES, POSTAL_FORMS } from '@nexus/factory-domain/shipping/customs/rules'
import type { ApiClient } from '../../../../lib/api/client'
import { completeUpload, requestUpload } from '../../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../../record-panels/store'

/**
 * A shipment's export papers (B-W2b-412 on B-W2b-409's API; apps/factory-api modules/shipping/customs and broker-pack): the
 * Export tab's read, the commercial invoice and the CN 22 / CN 23 (and their PDFs), the export declaration (opened with the
 * broker or the carrier filing, its MRN, the issued invoice it names, the proof of exit, removed when sent by mistake), and the
 * broker's pack (its parts, the one merged PDF, a link to the broker). Codes only: the API's English `heldWords`,
 * `becauseWords`, `linkWords` and a part's `words` are dropped; the screen says the codes. No amount (the papers' values are
 * in their PDFs, behind the price grain).
 */

const base = (shipmentId: string) => `/shipping/shipments/${encodeURIComponent(shipmentId)}/export`

export const documentSchema = z.object({
  documentId: z.string(),
  kind: z.enum(['COMMERCIAL_INVOICE', 'CN22', 'CN23']),
  version: z.number(),
  number: z.string(),
  language: z.enum(['it', 'en']),
  fileId: z.string(),
  createdAt: z.string(),
  current: z.boolean(),
})
export type CustomsDocument = z.infer<typeof documentSchema>

const declarationSchema = z.object({
  id: z.string(),
  status: z.enum(DECLARATION_STATUSES),
  filedBy: z.enum(['BROKER', 'CARRIER']),
  broker: z.object({ id: z.string(), name: z.string() }).nullable(),
  mrn: z.string().nullable(),
  invoice: z.object({ id: z.string(), number: z.string(), date: z.string().nullable() }).nullable(),
  exitConfirmedAt: z.string().nullable(),
  exitFile: z.object({ id: z.string(), name: z.string() }).nullable(),
  alertAfterDays: z.number(),
  exitDueAt: z.string().nullable(),
  daysLeft: z.number().nullable(),
  overdue: z.boolean(),
  /** The broker links: to whom (an address the person typed, or null when passed on), until, withdrawn, answered, opened. */
  links: z.array(z.object({ id: z.string(), email: z.string().nullable(), expiresAt: z.string(), revoked: z.boolean(), answered: z.boolean(), lastOpenedAt: z.string().nullable(), createdAt: z.string() })),
  version: z.number(),
  createdAt: z.string(),
})
export type Declaration = z.infer<typeof declarationSchema>

export const exportSchema = z.object({
  shipment: z.object({ id: z.string(), number: z.string(), status: z.string(), shippedAt: z.string().nullable(), siteId: z.string(), companyId: z.string() }),
  destination: z.object({ country: z.string().nullable(), class: z.enum(DESTINATION_CLASSES).nullable() }),
  needed: z.boolean(),
  eori: z.string().nullable(),
  /** The Incoterm and its place as the order says them (its own words). */
  deliveryTerms: z.string().nullable(),
  papers: z.object({
    held: z.enum(CUSTOMS_REFUSALS).nullable(),
    commercialInvoice: z.array(documentSchema),
    postalForm: z.object({
      suggested: z.enum(POSTAL_FORMS).nullable(),
      because: z.array(z.enum(CN23_BECAUSE)),
      held: z.enum(CUSTOMS_REFUSALS).nullable(),
      versions: z.array(documentSchema),
    }),
  }),
  declaration: declarationSchema.nullable(),
  declarationHeld: z.enum(CUSTOMS_REFUSALS).nullable(),
  brokerPackOn: z.boolean(),
  invoices: z.array(z.object({ id: z.string(), number: z.string(), docType: z.string(), status: z.string(), date: z.string().nullable(), ofShipment: z.boolean() })),
  alertDays: z.object({ default: z.number(), min: z.number(), max: z.number() }),
  mayManage: z.boolean(),
  seesValues: z.boolean(),
})
export type ExportRead = z.infer<typeof exportSchema>

export const readExport = (api: ApiClient, shipmentId: string, signal?: AbortSignal): Promise<ExportRead> => api.get(base(shipmentId), { schema: exportSchema, signal })

const paperSchema = z.object({ document: documentSchema.extend({ made: z.boolean() }) })

export interface PaperBody {
  language?: 'it' | 'en'
  reason?: string
  reasonText?: string
  notes?: string
  comments?: string
  form?: 'CN22' | 'CN23'
}

/** POST …/export/commercial-invoice (shipping.customs.manage + money.price): 201 a new version, 200 the same contents. */
export const makeCommercialInvoice = (api: ApiClient, shipmentId: string, body: PaperBody, idempotencyKey: string) =>
  api.post(`${base(shipmentId)}/commercial-invoice`, { body, schema: paperSchema, idempotencyKey }).then((answer) => answer.document)

/** POST …/export/postal-form: CN 22 / CN 23, one page per parcel. */
export const makePostalForm = (api: ApiClient, shipmentId: string, body: PaperBody, idempotencyKey: string) =>
  api.post(`${base(shipmentId)}/postal-form`, { body, schema: paperSchema, idempotencyKey }).then((answer) => answer.document)

/** GET …/export/documents/:documentId/pdf (+ money.price): the paper's bytes (the Commercial invoice PDF window). */
export const customsPaperPdf = (api: ApiClient, shipmentId: string, documentId: string, signal?: AbortSignal): Promise<Uint8Array> =>
  api.bytes(`${base(shipmentId)}/documents/${encodeURIComponent(documentId)}/pdf`, signal ? { signal } : {})

const changed = z.object({ changed: z.boolean(), declarationId: z.string() })

export const openDeclaration = (api: ApiClient, shipmentId: string, body: { brokerPartyId: string | null; alertAfterDays?: number }, idempotencyKey: string) =>
  api.post(`${base(shipmentId)}/declaration`, { body, schema: z.object({ declarationId: z.string() }), idempotencyKey })

export const recordMrn = (api: ApiClient, shipmentId: string, body: { mrn: string; version: number }, idempotencyKey: string) =>
  api.post(`${base(shipmentId)}/declaration/mrn`, { body, schema: changed, idempotencyKey })

export const nameInvoice = (api: ApiClient, shipmentId: string, body: { invoiceId: string; version: number }, idempotencyKey: string) =>
  api.post(`${base(shipmentId)}/declaration/invoice`, { body, schema: changed, idempotencyKey })

export const confirmExit = (api: ApiClient, shipmentId: string, body: { exitConfirmedAt: string; fileId: string; version: number }, idempotencyKey: string) =>
  api.post(`${base(shipmentId)}/declaration/exit`, { body, schema: changed, idempotencyKey })

export const removeDeclaration = (api: ApiClient, shipmentId: string, query: { version: number; reason: string }, idempotencyKey: string) =>
  api.request('DELETE', `${base(shipmentId)}/declaration`, { query, schema: z.object({ removed: z.boolean(), linksRevoked: z.number() }), idempotencyKey })

const fileSchema = z.object({ fileId: z.string(), name: z.string(), sizeBytes: z.number() })

export const packSchema = z.object({
  shipment: z.object({ id: z.string(), number: z.string() }),
  parts: z.array(z.object({ part: z.enum(PACK_PARTS), state: z.enum(PACK_PART_STATES), files: z.array(fileSchema) })),
  originCandidates: z.array(fileSchema.extend({ createdAt: z.string() })),
  downloadHeld: z.enum(BROKER_PACK_REFUSALS).nullable(),
  linkHeld: z.enum(BROKER_PACK_REFUSALS).nullable(),
  brokerPackOn: z.boolean(),
})
export type BrokerPack = z.infer<typeof packSchema>

const origin = (ids: readonly string[]) => (ids.length > 0 ? ids.join(',') : undefined)

export const readPack = (api: ApiClient, shipmentId: string, originFileIds: readonly string[], signal?: AbortSignal): Promise<BrokerPack> =>
  api.get(`${base(shipmentId)}/pack`, { query: { originFileIds: origin(originFileIds) }, schema: packSchema, signal })

/** The pack's parts merged into ONE PDF (+ money.price for the priced parts). */
export const packPdf = (api: ApiClient, shipmentId: string, originFileIds: readonly string[], signal?: AbortSignal): Promise<Uint8Array> =>
  api.bytes(`${base(shipmentId)}/pack/pdf`, { query: { originFileIds: origin(originFileIds) }, signal })

/** A BROKER_PACK link: mailed to the broker's active contacts (the FAKE mail locally), or one link to pass on (`url`, once). */
export const packLink = (api: ApiClient, shipmentId: string, body: { originFileIds: string[]; send: boolean }, idempotencyKey: string) =>
  api.post(`${base(shipmentId)}/pack/link`, { body, schema: z.object({ url: z.string().nullable(), linkId: z.string() }), idempotencyKey })

const partySchema = z.object({ id: z.string(), code: z.string(), legalName: z.string(), roles: z.array(z.string()) })
export type BrokerParty = z.infer<typeof partySchema>

/** The parties that may file a declaration: the company's ACTIVE carriers and suppliers (parties.view). */
export const listBrokers = (api: ApiClient, companyId: string, signal?: AbortSignal): Promise<BrokerParty[]> =>
  api.get('/parties', { query: { role: 'CARRIER,SUPPLIER', status: 'ACTIVE', companyId, limit: 200 }, schema: z.object({ parties: z.array(partySchema) }), signal }).then((answer) => answer.parties)

/** The proof of exit: uploaded as a file of the declaration (office only), then named by the exit. */
export async function uploadExitProof(api: ApiClient, declaration: { id: string; companyId: string }, file: File): Promise<string> {
  const bytes = await file.arrayBuffer()
  const announced = await requestUpload(api, {
    companyId: declaration.companyId,
    record: { type: 'CustomsDeclaration', id: declaration.id },
    kind: 'DOCUMENT',
    name: file.name || 'proof-of-exit',
    contentType: file.type || 'application/octet-stream',
    sizeBytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    visibility: ['OFFICE'],
    floorSiteId: null,
    partyId: null,
  })
  await putToStore(announced.upload, bytes)
  const done = await completeUpload(api, announced.file.id)
  return done.file.id
}
