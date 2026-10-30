import { z } from 'zod'
import { materialRow, materialView, type MaterialRow, type MaterialView } from '@nexus/factory-domain/product/materials/contracts'
import type { ItemKind } from '@nexus/factory-domain/product/materials/rules'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { lotSchema, type Lot } from '../../quality/_shared/lots'

/**
 * Every call Materials & trims makes (SCR-047 list, SCR-048 record), each answer checked against the API's own contract
 * (factory-domain product/materials): the list and its counts, one material, its writes (fields, the standard cost on its
 * own route with the cost grain, archive/reactivate, colours), and what the record shows beside it — the supplier
 * picker (parties), the colour library, the certificates that cover it, its lots' test results and its stock. The
 * standard cost is optional in the contract: the API drops it for a person without the cost grain, and the screens say
 * "not in your role", never 0. Every write sends the version it was made on (COL-078) and an idempotency key.
 */

export type { MaterialRow, MaterialView }
export type MaterialColour = MaterialView['colours'][number]

const enc = encodeURIComponent
const path = (materialId: string) => `/product/materials/${enc(materialId)}`
const key = () => ({ idempotencyKey: newIdempotencyKey() })

export interface MaterialQuery {
  q?: string
  kind?: readonly ItemKind[]
  status?: 'ACTIVE' | 'ARCHIVED' | 'ALL'
  requiresCrViTest?: boolean
  ppeComponent?: boolean
  missingCost?: boolean
  supplierId?: string
  limit?: number
  cursor?: string | null
}

const page = z.object({ materials: z.array(materialRow), nextCursor: z.string().nullable(), count: z.number().int() })
export type MaterialPage = z.infer<typeof page>

export function listMaterials(api: ApiClient, query: MaterialQuery): Promise<MaterialPage> {
  return api.get('/product/materials', {
    query: {
      q: query.q?.trim() || undefined,
      kind: query.kind && query.kind.length > 0 ? query.kind.join(',') : undefined,
      status: query.status ?? 'ACTIVE',
      requiresCrViTest: query.requiresCrViTest === undefined ? undefined : String(query.requiresCrViTest),
      ppeComponent: query.ppeComponent === undefined ? undefined : String(query.ppeComponent),
      missingCost: query.missingCost === undefined ? undefined : String(query.missingCost),
      supplierId: query.supplierId,
      limit: query.limit ?? 50,
      cursor: query.cursor ?? undefined,
    },
    schema: page,
  })
}

/** How many materials a saved filter holds (a tile's number is the list's total under that filter). */
export async function countMaterials(api: ApiClient, query: MaterialQuery): Promise<number> {
  return (await listMaterials(api, { ...query, limit: 1, cursor: null })).count
}

const one = z.object({ material: materialView })

export function getMaterial(api: ApiClient, materialId: string): Promise<MaterialView> {
  return api.get(path(materialId), { schema: one }).then((answer) => answer.material)
}

/** A new material as the dialog sends it (the API fills what the kind defaults). */
export interface NewMaterialBody {
  companyId: string | null
  code: string
  name: string
  kind: ItemKind
  baseUom: string
  purchaseUom: string
  purchaseFactor: string | null
  consumptionUom: string
  consumptionFactor: string | null
  sourcing: string
  tracking: string
  defaultSupplierId: string | null
  supplierArticleCode: string | null
  animalSpecies: string | null
  tannage: string | null
  grade: string | null
  thicknessMinMm: string | null
  thicknessMaxMm: string | null
  animalOrigin: boolean
  isPpeComponent: boolean
  requiresCrViTest: boolean
  crViLimitMgKg: string | null
  /** Only for a person with product.materials.cost and the cost grain; left out otherwise. */
  standardCost?: string | null
}

export function createMaterial(api: ApiClient, body: NewMaterialBody): Promise<MaterialView> {
  return api.post('/product/materials', { body, schema: one, ...key() }).then((answer) => answer.material)
}

/** A change: only the fields sent (null clears an optional one). */
export type MaterialPatch = Record<string, unknown>

export function updateMaterial(api: ApiClient, material: Pick<MaterialView, 'id' | 'version'>, patch: MaterialPatch): Promise<MaterialView> {
  return api.request('PATCH', path(material.id), { body: { ...patch, version: material.version }, schema: one, ...key() }).then((answer) => answer.material)
}

/** The standard purchase price per base unit (null removes it), with the reason kept in the audit row. */
export function setStandardCost(api: ApiClient, material: Pick<MaterialRow, 'id' | 'version'>, standardCost: string | null, reason?: string): Promise<MaterialView> {
  return api
    .request('PUT', `${path(material.id)}/standard-cost`, { body: { version: material.version, standardCost, ...(reason ? { reason } : {}) }, schema: one, ...key() })
    .then((answer) => answer.material)
}

export function archiveMaterial(api: ApiClient, material: Pick<MaterialRow, 'id' | 'version'>, reason?: string): Promise<MaterialView> {
  return api.post(`${path(material.id)}/archive`, { body: { version: material.version, ...(reason ? { reason } : {}) }, schema: one, ...key() }).then((answer) => answer.material)
}

export function reactivateMaterial(api: ApiClient, material: Pick<MaterialRow, 'id' | 'version'>): Promise<MaterialView> {
  return api.post(`${path(material.id)}/reactivate`, { body: { version: material.version }, schema: one, ...key() }).then((answer) => answer.material)
}

export interface ColourInput {
  code: string
  name: string
  supplierColourCode: string | null
  colourId: string | null
}

export function addColour(api: ApiClient, materialId: string, colour: ColourInput): Promise<MaterialView> {
  return api.post(`${path(materialId)}/colours`, { body: colour, schema: one, ...key() }).then((answer) => answer.material)
}

export function updateColour(api: ApiClient, materialId: string, colour: Pick<MaterialColour, 'id' | 'version'>, patch: Partial<ColourInput> & { status?: 'ACTIVE' | 'ARCHIVED' }): Promise<MaterialView> {
  return api.request('PATCH', `${path(materialId)}/colours/${enc(colour.id)}`, { body: { ...patch, version: colour.version }, schema: one, ...key() }).then((answer) => answer.material)
}

// ---- beside the material ----------------------------------------------------------------------------------------------

/** A supplier (a party with the SUPPLIER role), for the default supplier picker. */
const supplierRow = z.object({ id: z.string(), code: z.string(), legalName: z.string(), tradeName: z.string().nullable(), status: z.string() })
export type SupplierRow = z.infer<typeof supplierRow>

export function findSuppliers(api: ApiClient, q: string): Promise<SupplierRow[]> {
  return api.get('/parties', { query: { role: 'SUPPLIER', q: q.trim() || undefined, limit: 20 }, schema: z.object({ parties: z.array(supplierRow) }) }).then((answer) => answer.parties)
}

/** A colour of the library (a material colour may name the one it matches). */
const libraryColour = z.object({ id: z.string(), code: z.string(), name: z.string(), hex: z.string().nullable(), status: z.string() })
export type LibraryColour = z.infer<typeof libraryColour>

export function listLibraryColours(api: ApiClient): Promise<LibraryColour[]> {
  return api.get('/product/colours', { query: { limit: 500 }, schema: z.object({ colours: z.array(libraryColour) }) }).then((answer) => answer.colours)
}

/** A certificate that covers the material (an EN 1621 protector's). Unknown fields are ignored. */
const certificateRow = z.object({ id: z.string(), number: z.string(), standard: z.string(), ppeClass: z.string().nullable(), validTo: z.string(), status: z.string(), daysToExpiry: z.number().int() })
export type CoveringCertificate = z.infer<typeof certificateRow>

export function certificatesFor(api: ApiClient, materialId: string): Promise<CoveringCertificate[]> {
  return api.get('/compliance/certificates', { query: { itemId: materialId }, schema: z.object({ certificates: z.array(certificateRow) }) }).then((answer) => answer.certificates)
}

/** How many of the newest lots are read to find this material's (the lot list has no material filter: an API gap). */
export const LOTS_READ = 200

/** The material's lots among the newest LOTS_READ (Compliance › Tests & substances). */
export async function lotsOf(api: ApiClient, materialId: string): Promise<{ lots: Lot[]; capped: boolean }> {
  const answer = await api.get('/quality/lots', { query: { limit: LOTS_READ }, schema: z.object({ lots: z.array(lotSchema) }) })
  return { lots: answer.lots.filter((lot) => lot.item.id === materialId), capped: answer.lots.length >= LOTS_READ }
}

/** The material's stock by location, lot and hide (Warehouse; inventory.stock.view). Unknown fields are ignored. */
const named = z.object({ id: z.string(), code: z.string(), name: z.string() })
const stockRow = z.object({
  siteId: z.string(),
  siteCode: z.string(),
  location: named,
  colour: named.nullable(),
  lot: z.object({ id: z.string(), code: z.string(), qualityStatus: z.string() }).nullable(),
  hide: z.object({ id: z.string(), code: z.string() }).nullable(),
  onHand: z.string(),
  held: z.string(),
  available: z.string(),
})
export type StockRow = z.infer<typeof stockRow>
const stockTotal = z.object({ itemColourId: z.string().nullable(), onHand: z.string(), held: z.string(), available: z.string(), hides: z.number().int(), heldHides: z.number().int(), locations: z.number().int() })
export type StockTotal = z.infer<typeof stockTotal>
export interface MaterialStock {
  rows: StockRow[]
  totals: StockTotal[]
  truncated: boolean
}

export function stockOf(api: ApiClient, materialId: string): Promise<MaterialStock> {
  return api
    .get('/inventory/stock', { query: { itemId: materialId }, schema: z.object({ rows: z.array(stockRow), items: z.array(stockTotal), truncated: z.boolean() }) })
    .then((answer) => ({ rows: answer.rows, totals: answer.items, truncated: answer.truncated }))
}
