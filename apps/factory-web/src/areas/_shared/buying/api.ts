import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'

/**
 * Reads every buying screen shares: the company's sites with their locations (`GET /inventory/locations`,
 * inventory.locations.view — the planning run, the delivery site of a new order and the goods-in dock are per site),
 * suppliers to buy from (`GET /parties?role=SUPPLIER,SUBCONTRACTOR`, parties.view) and materials (`GET /product/materials`,
 * product.materials.view). Answers are checked with zod; unknown fields are dropped.
 */

const locationSchema = z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string(), status: z.string() })
const siteSchema = z.object({ id: z.string(), companyId: z.string(), code: z.string(), name: z.string(), locations: z.array(locationSchema) })
export type SiteOption = z.infer<typeof siteSchema>

/** The sites of this company (the API's scope; another company's sites are dropped), by code. */
export async function listSites(api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<SiteOption[]> {
  const answer = await api.get('/inventory/locations', { schema: z.object({ sites: z.array(siteSchema) }), signal })
  return answer.sites.filter((site) => !companyId || site.companyId === companyId).sort((a, b) => a.code.localeCompare(b.code))
}

const partyRowSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  code: z.string(),
  legalName: z.string(),
  tradeName: z.string().nullable(),
  roles: z.array(z.string()),
  status: z.string(),
  country: z.string(),
  currency: z.string(),
})
export type SupplierOption = z.infer<typeof partyRowSchema>

/** Suppliers and subcontractors by name, code or VAT number (active and prospects; the API refuses a blocked one). */
export async function findSuppliers(api: ApiClient, q: string, signal?: AbortSignal): Promise<SupplierOption[]> {
  const answer = await api.get('/parties', { query: { q: q.trim() || undefined, role: 'SUPPLIER,SUBCONTRACTOR', status: 'ACTIVE,PROSPECT,BLOCKED', limit: 20 }, schema: z.object({ parties: z.array(partyRowSchema) }), signal })
  return answer.parties
}

const materialRowSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  kind: z.string(),
  tracking: z.string(),
  baseUom: z.string(),
  purchaseUom: z.string(),
  defaultSupplier: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  requiresCrViTest: z.boolean(),
  colourCount: z.number(),
  status: z.string(),
})
export type MaterialOption = z.infer<typeof materialRowSchema>

export async function findMaterials(api: ApiClient, q: string, signal?: AbortSignal): Promise<MaterialOption[]> {
  const answer = await api.get('/product/materials', { query: { q: q.trim() || undefined, limit: 20 }, schema: z.object({ materials: z.array(materialRowSchema) }), signal })
  return answer.materials.filter((material) => material.status === 'ACTIVE')
}

const colourSchema = z.object({ id: z.string(), code: z.string(), name: z.string(), supplierColourCode: z.string().nullable(), status: z.string() })
const unitSchema = z.object({ uom: z.string(), factor: z.string(), fixed: z.boolean() })
const materialSchema = materialRowSchema.extend({ colours: z.array(colourSchema), units: z.object({ base: unitSchema, purchase: unitSchema, consumption: unitSchema }) })
export type MaterialDetail = z.infer<typeof materialSchema>

export async function getMaterial(api: ApiClient, id: string, signal?: AbortSignal): Promise<MaterialDetail> {
  return (await api.get(`/product/materials/${encodeURIComponent(id)}`, { schema: z.object({ material: materialSchema }), signal })).material
}
