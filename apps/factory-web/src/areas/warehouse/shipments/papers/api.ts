import { z } from 'zod'
import { DOCUMENT_LANGUAGES, PROFORMA_PURPOSES } from '@nexus/factory-domain/documents/model'
import type { ApiClient } from '../../../../lib/api/client'
import { downloadLink } from '../../../../record-panels/api'

/**
 * The shipment's papers in depth (apps/factory-api modules/shipping shipment-pack, proforma; compliance public-doc): the
 * driver's pack as ONE merged PDF (B-W2b-391, LOG-031: labels, packing list, DDT, commercial invoice, proforma — a priced
 * part only named), the proforma (LOG-058: a PF number taken once, versions; the PDF behind the price grain), and the
 * public DoC page of each style (B-W2b-166, links.doc). The pack's parts are named by code (the API's English words are
 * not drawn); shipment-pack/rules.ts reads node's crypto, so its two code lists are repeated here.
 */

export const PACK_PARTS = ['LABELS', 'PACKING_LIST', 'DDT', 'COMMERCIAL_INVOICE', 'PROFORMA'] as const
export const PART_STATES = ['READY', 'MISSING', 'NONE', 'NOT_SHOWN'] as const

const partSchema = z.object({ kind: z.enum(PACK_PARTS), state: z.enum(PART_STATES), number: z.string().nullable(), files: z.number(), test: z.boolean() })
const versionSchema = z.object({ documentId: z.string(), version: z.number(), pages: z.number().nullable(), createdAt: z.string(), current: z.boolean() })

export const packSchema = z.object({
  shipmentId: z.string(),
  number: z.string(),
  status: z.string(),
  parts: z.array(partSchema),
  test: z.boolean(),
  latest: versionSchema.nullable(),
  printer: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
})
export type Pack = z.infer<typeof packSchema>
export type PackPart = Pack['parts'][number]

const base = (shipmentId: string) => `/shipping/shipments/${encodeURIComponent(shipmentId)}`

export const readPack = (api: ApiClient, shipmentId: string): Promise<Pack> => api.get(`${base(shipmentId)}/pack`, { schema: packSchema })

const madeSchema = z.object({
  pack: z.object({ documentId: z.string(), version: z.number(), pages: z.number().nullable(), made: z.boolean(), createdAt: z.string() }),
  parts: z.array(partSchema),
  test: z.boolean(),
  job: z.object({ jobId: z.string(), printerId: z.string() }).nullable(),
  problem: z.object({ code: z.enum(['NO_PRINTER', 'PRINTER']) }).nullable(),
})
export type PackMade = z.infer<typeof madeSchema>

/** Make the pack (or take the newest that holds the same papers) and, unless `print` is false, ONE job on the A4 printer. */
export function makePack(api: ApiClient, shipmentId: string, print: boolean, idempotencyKey: string): Promise<PackMade> {
  return api.post(`${base(shipmentId)}/pack`, { body: { print }, schema: madeSchema, idempotencyKey })
}

/** The pack's bytes (a version, else the newest). */
export const packPdf = (api: ApiClient, shipmentId: string, version: number | null): Promise<Uint8Array> => api.bytes(`${base(shipmentId)}/pack/pdf${version ? `?version=${version}` : ''}`)

// ---- the proforma -------------------------------------------------------------------------------------------------------------

const proformaVersion = z.object({ documentId: z.string(), version: z.number(), number: z.string(), language: z.enum(DOCUMENT_LANGUAGES), fileId: z.string(), createdAt: z.string(), createdBy: z.string().nullable(), current: z.boolean() })

export const proformasSchema = z.object({
  label: z.string(),
  purpose: z.enum(PROFORMA_PURPOSES),
  number: z.string().nullable(),
  versions: z.array(proformaVersion),
  problems: z.array(z.string()),
})
export type Proformas = z.infer<typeof proformasSchema>
export type DocumentLanguage = (typeof DOCUMENT_LANGUAGES)[number]
export { DOCUMENT_LANGUAGES }

export const readProformas = (api: ApiClient, shipmentId: string): Promise<Proformas> => api.get('/shipping/proformas', { query: { recordType: 'Shipment', recordId: shipmentId }, schema: proformasSchema })

export function makeProforma(api: ApiClient, shipmentId: string, body: { language?: DocumentLanguage; notes?: string }, idempotencyKey: string): Promise<{ made: boolean; number: string; version: number }> {
  return api
    .post('/shipping/proformas', { body: { recordType: 'Shipment', recordId: shipmentId, ...body }, schema: z.object({ proforma: proformaVersion.extend({ made: z.boolean() }) }), idempotencyKey })
    .then((answer) => ({ made: answer.proforma.made, number: answer.proforma.number, version: answer.proforma.version }))
}

/** A stored file's presigned GET (the proforma's PDF; files.read). */
export const fileDownload = (api: ApiClient, fileId: string) => downloadLink(api, fileId).then((answer) => answer.download)

// ---- the public DoC page of a style -------------------------------------------------------------------------------------------

/** The office's address of a style's public DoC page and whether it shows a declaration today (compliance.certificates.view). */
export const readPublicDoc = (api: ApiClient, styleId: string): Promise<{ address: string; live: boolean }> =>
  api.get('/compliance/public-doc/address', { query: { styleId }, schema: z.object({ address: z.object({ address: z.string(), live: z.boolean() }) }) }).then((answer) => answer.address)
