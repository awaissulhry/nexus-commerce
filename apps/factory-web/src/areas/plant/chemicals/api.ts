import { z } from 'zod'
import { CHEMICAL_STATUSES, CHEMICAL_USES, GHS_PICTOGRAMS, QUANTITY_UNITS, SHEET_STATUSES, SIGNAL_WORDS, type ChemicalUse, type QuantityUnit, type SignalWord } from '@nexus/factory-domain/safety/chemicals/rules'
import type { ApiClient } from '../../../lib/api/client'
import { presignedSchema, type Presigned } from '../../../record-panels/api'
import { putToStore, readFromStore, sha256Hex } from '../../../record-panels/store'

/**
 * Every call of Plant › Health & safety › Chemicals & waste (SCR-213; B-W2b-143 on the API of the same step, apps/factory-api
 * modules/safety/chemicals): the register and its tiles, one chemical with every sheet, the SDS library, the cabinets and one
 * cabinet's wall sheet, the dialog's choices, and the writes (add, change, archive, put back, a sheet's PDF and the sheet
 * itself). Each answer's shape is checked (zod mirrors of the API's contracts; unknown fields are dropped). Reading is
 * safety.view; every write safety.chemicals.manage, with the version read and its own Idempotency-Key. The API's English is
 * never shown: the screens say their own words from the codes. No person, no money.
 */

const codeName = z.object({ code: z.string(), name: z.string() })
const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })
const seg = (value: string) => encodeURIComponent(value)

export const sheetSchema = z.object({
  id: z.string(),
  versionLabel: z.string(),
  revisedOn: z.string(),
  language: z.string(),
  status: z.enum(SHEET_STATUSES),
  fileId: z.string(),
  fileName: z.string(),
  sizeBytes: z.number(),
  sha256: z.string(),
  supersededAt: z.string().nullable(),
  supersededBy: z.string().nullable(),
  addedAt: z.string(),
  addedBy: z.string().nullable(),
})
export type Sheet = z.infer<typeof sheetSchema>

export const chemicalSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  company: codeName,
  siteId: z.string(),
  site: codeName,
  name: z.string(),
  supplier: z.object({ partyId: z.string().nullable(), name: z.string().nullable() }),
  use: z.enum(CHEMICAL_USES),
  ghsPictograms: z.array(z.enum(GHS_PICTOGRAMS)),
  signalWord: z.enum(SIGNAL_WORDS).nullable(),
  hazardStatements: z.array(z.string()),
  precautionStatements: z.array(z.string()),
  storagePlace: z.string(),
  cabinetCode: z.string().nullable(),
  maxQuantity: z.string().nullable(),
  maxQuantityUnit: z.enum(QUANTITY_UNITS).nullable(),
  roles: z.array(ref),
  ppe: z.array(ref),
  status: z.enum(CHEMICAL_STATUSES),
  note: z.string().nullable(),
  current: z.array(sheetSchema),
  superseded: z.number(),
  sheetState: z.enum(['MISSING', 'OTHER_LANGUAGE', 'OK']),
  language: z.string(),
  version: z.number(),
  canManage: z.boolean(),
})
export type Chemical = z.infer<typeof chemicalSchema>

const placeSchema = z.object({ id: z.string(), code: z.string(), name: z.string(), language: z.string(), sites: z.array(ref) })
export type Place = z.infer<typeof placeSchema>
const lawSchema = z.object({ register: z.string(), sds: z.string() })

const listAnswer = z.object({ chemicals: z.array(chemicalSchema), complete: z.boolean(), companies: z.array(placeSchema), canManage: z.boolean(), law: lawSchema, today: z.string() })
export type ListAnswer = z.infer<typeof listAnswer>

const countsAnswer = z.object({ active: z.number(), withoutSds: z.number(), toRequest: z.number(), cabinets: z.number() })
export type CountsAnswer = z.infer<typeof countsAnswer>

const recordAnswer = z.object({ chemical: chemicalSchema, sheets: z.array(sheetSchema), today: z.string() })
export type ChemicalRecord = z.infer<typeof recordAnswer>

const libraryRow = z.object({
  id: z.string(),
  chemicalId: z.string(),
  chemical: z.string(),
  site: codeName,
  siteId: z.string(),
  versionLabel: z.string(),
  revisedOn: z.string(),
  language: z.string(),
  fileId: z.string(),
  fileName: z.string(),
  addedAt: z.string(),
  superseded: z.array(z.object({ id: z.string(), versionLabel: z.string(), revisedOn: z.string(), supersededAt: z.string().nullable() })),
  canManage: z.boolean(),
})
export type LibraryRow = z.infer<typeof libraryRow>
const libraryAnswer = z.object({ sheets: z.array(libraryRow), missing: z.array(z.object({ chemicalId: z.string(), chemical: z.string(), site: codeName, canManage: z.boolean() })) })
export type LibraryAnswer = z.infer<typeof libraryAnswer>

const cabinetRow = z.object({ siteId: z.string(), site: codeName, code: z.string(), places: z.array(z.string()), products: z.number(), withoutSheet: z.number() })
export type Cabinet = z.infer<typeof cabinetRow>

export const cabinetChemicalSchema = z.object({
  id: z.string(),
  name: z.string(),
  supplier: z.string().nullable(),
  use: z.enum(CHEMICAL_USES),
  ghsPictograms: z.array(z.enum(GHS_PICTOGRAMS)),
  signalWord: z.enum(SIGNAL_WORDS).nullable(),
  hazardStatements: z.array(z.string()),
  precautionStatements: z.array(z.string()),
  storagePlace: z.string(),
  maxQuantity: z.string().nullable(),
  maxQuantityUnit: z.enum(QUANTITY_UNITS).nullable(),
  ppe: z.array(z.string()),
  current: z.array(z.object({ id: z.string(), versionLabel: z.string(), revisedOn: z.string(), language: z.string() })),
})
export type CabinetChemical = z.infer<typeof cabinetChemicalSchema>
const cabinetAnswer = z.object({ siteId: z.string(), site: codeName, company: codeName, code: z.string(), places: z.array(z.string()), chemicals: z.array(cabinetChemicalSchema), law: lawSchema, today: z.string() })
export type CabinetSheet = z.infer<typeof cabinetAnswer>

const choicesAnswer = z.object({ roles: z.array(ref), ppe: z.array(ref), suppliers: z.array(ref), cabinets: z.array(z.string()), places: z.array(z.string()) })
export type Choices = z.infer<typeof choicesAnswer>

// ---- reads ------------------------------------------------------------------------------------------------------------------

export interface ListQuery {
  readonly siteId: string | null
  readonly status?: 'ACTIVE' | 'ARCHIVED' | 'all' | undefined
  readonly tile?: 'withoutSds' | 'toRequest' | null | undefined
  readonly use?: ChemicalUse | null | undefined
  readonly cabinet?: string | null | undefined
  readonly q?: string | null | undefined
}

/** GET /safety/chemicals (safety.view): the register as the list's address asks. */
export const listChemicals = (api: ApiClient, query: ListQuery, signal?: AbortSignal) =>
  api.get('/safety/chemicals', {
    query: { ...(query.siteId ? { siteId: query.siteId } : {}), ...(query.status ? { status: query.status } : {}), ...(query.tile ? { tile: query.tile } : {}), ...(query.use ? { use: query.use } : {}), ...(query.cabinet ? { cabinet: query.cabinet } : {}), ...(query.q ? { q: query.q } : {}) },
    schema: listAnswer,
    signal,
  })

/** GET /safety/chemicals/counts (safety.view): the tiles. */
export const readCounts = (api: ApiClient, siteId: string | null, signal?: AbortSignal) => api.get('/safety/chemicals/counts', { query: siteId ? { siteId } : {}, schema: countsAnswer, signal })

/** GET /safety/chemicals/:id (safety.view): one chemical with every sheet. */
export const readChemical = (api: ApiClient, id: string, signal?: AbortSignal) => api.get(`/safety/chemicals/${seg(id)}`, { schema: recordAnswer, signal })

/** GET /safety/chemicals/data-sheets (safety.view): the library. */
export const readLibrary = (api: ApiClient, siteId: string | null, signal?: AbortSignal) => api.get('/safety/chemicals/data-sheets', { query: siteId ? { siteId } : {}, schema: libraryAnswer, signal })

/** GET /safety/chemicals/cabinets (safety.view): the cabinets the QR dialog offers. */
export const readCabinets = async (api: ApiClient, siteId: string | null, signal?: AbortSignal) => (await api.get('/safety/chemicals/cabinets', { query: siteId ? { siteId } : {}, schema: z.object({ cabinets: z.array(cabinetRow) }), signal })).cabinets

/** GET /safety/chemicals/cabinets/:siteId/:code (safety.view): one cabinet's wall sheet. */
export const readCabinet = (api: ApiClient, siteId: string, code: string, signal?: AbortSignal) => api.get(`/safety/chemicals/cabinets/${seg(siteId)}/${seg(code)}`, { schema: cabinetAnswer, signal })

/** GET /safety/chemicals/choices?siteId (safety.chemicals.manage): the dialog's role sheets, PPE items, suppliers. */
export const readChoices = (api: ApiClient, siteId: string, signal?: AbortSignal) => api.get('/safety/chemicals/choices', { query: { siteId }, schema: choicesAnswer, signal })

/** GET …/data-sheets/:sheetId/download (safety.view): a sheet's PDF bytes for the viewer (read once: the address lives 60 s). */
export async function sheetBytes(api: ApiClient, chemicalId: string, sheetId: string): Promise<{ bytes: Uint8Array; fileName: string }> {
  const answer = await api.get(`/safety/chemicals/${seg(chemicalId)}/data-sheets/${seg(sheetId)}/download`, { schema: z.object({ download: presignedSchema, fileName: z.string() }) })
  return { bytes: await readFromStore(answer.download), fileName: answer.fileName }
}

// ---- writes -----------------------------------------------------------------------------------------------------------------

export interface ChemicalBody {
  name: string
  supplierPartyId: string | null
  supplierName: string | null
  use: ChemicalUse
  ghsPictograms: string[]
  signalWord: SignalWord | null
  hazardStatements: string[]
  precautionStatements: string[]
  storagePlace: string
  cabinetCode: string | null
  maxQuantity: string | null
  maxQuantityUnit: QuantityUnit | null
  roleSheetIds: string[]
  ppeItemIds: string[]
  note: string | null
}

const chemicalAnswer = z.object({ chemical: chemicalSchema })

/** POST /safety/chemicals. */
export const addChemical = async (api: ApiClient, body: ChemicalBody & { companyId: string; siteId: string }, idempotencyKey: string) =>
  (await api.post('/safety/chemicals', { body, schema: chemicalAnswer, idempotencyKey })).chemical

/** PATCH /safety/chemicals/:id. */
export const editChemical = async (api: ApiClient, id: string, body: ChemicalBody & { version: number }, idempotencyKey: string) =>
  (await api.request('PATCH', `/safety/chemicals/${seg(id)}`, { body, schema: chemicalAnswer, idempotencyKey })).chemical

/** POST /safety/chemicals/:id/archive. */
export const archiveChemical = async (api: ApiClient, id: string, body: { version: number; reason: string }, idempotencyKey: string) =>
  (await api.post(`/safety/chemicals/${seg(id)}/archive`, { body, schema: chemicalAnswer, idempotencyKey })).chemical

/** POST /safety/chemicals/:id/restore. */
export const restoreChemical = async (api: ApiClient, id: string, body: { version: number }, idempotencyKey: string) =>
  (await api.post(`/safety/chemicals/${seg(id)}/restore`, { body, schema: chemicalAnswer, idempotencyKey })).chemical

export interface SheetFacts {
  versionLabel: string
  revisedOn: string
  language: string
}

const addedSheet = z.object({ sheet: sheetSchema, superseded: sheetSchema.nullable(), chemical: chemicalSchema })
export type AddedSheet = z.infer<typeof addedSheet>

/**
 * Replace SDS (and the first sheet of Add chemical): the PDF announced to the chemical (shared with its site's tablets by the
 * API), its bytes sent to the store, confirmed, then the sheet recorded (the current one of its language superseded, kept).
 */
export async function uploadSheet(api: ApiClient, chemicalId: string, file: File, facts: SheetFacts, key: string): Promise<AddedSheet> {
  const bytes = await file.arrayBuffer()
  const announced = await api.post(`/safety/chemicals/${seg(chemicalId)}/data-sheets/upload`, {
    body: { originalName: file.name || 'sds.pdf', contentType: file.type || 'application/pdf', sizeBytes: bytes.byteLength, sha256: await sha256Hex(bytes) },
    schema: z.object({ file: z.object({ id: z.string() }), upload: presignedSchema }),
    idempotencyKey: `${key}:announce`,
  })
  await putToStore(announced.upload as Presigned, bytes)
  await api.post(`/safety/chemicals/${seg(chemicalId)}/data-sheets/upload/${seg(announced.file.id)}/complete`, { schema: z.object({ file: z.object({ id: z.string(), status: z.string() }) }), idempotencyKey: `${key}:complete` })
  return api.post(`/safety/chemicals/${seg(chemicalId)}/data-sheets`, { body: { fileId: announced.file.id, ...facts }, schema: addedSheet, idempotencyKey: `${key}:sheet` })
}
