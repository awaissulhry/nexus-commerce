import { z } from 'zod'
import { AREA_UOMS, type AreaUom } from '@nexus/factory-domain/inventory/hides/area'
import { SHADE_RULES, type ShadeRule } from '@nexus/factory-domain/inventory/reservations/shade'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * The calls of the Cutting card of Floor rules & codes (B-W2b-219), each answer checked by its schema (the API's English
 * words are never drawn):
 *  - the site's cutting rules: `GET|POST /production/settings/:siteId/cutting-rules` (production.settings.view / .manage) —
 *    the shade rule, the photo of the hide before cutting, the smallest remnant kept. The row's version is the site's floor
 *    rules version (one ProductionSettings row with the page's other parts).
 *  - the leather area tolerance where a purchase order line names none: `GET|PUT /purchasing/settings/leather-tolerance`
 *    (purchasing.view / .manage), for the site's company.
 */

const seg = (value: string) => encodeURIComponent(value)

export const cuttingRulesSchema = z.object({
  site: z.object({ id: z.string(), companyId: z.string(), code: z.string(), name: z.string() }),
  rules: z.object({ shadeRule: z.enum(SHADE_RULES), hidePhotoRequired: z.boolean(), minimumRemnant: z.object({ area: z.string(), uom: z.enum(AREA_UOMS) }) }),
  isDefault: z.boolean(),
  version: z.number().nullable(),
  updatedAt: z.string().nullable(),
  canManage: z.boolean(),
})
export type CuttingRules = z.infer<typeof cuttingRulesSchema>

export const getCuttingRules = (api: ApiClient, siteId: string, signal?: AbortSignal) => api.get(`/production/settings/${seg(siteId)}/cutting-rules`, { schema: cuttingRulesSchema, signal })

export interface CuttingRulesBody {
  shadeRule?: ShadeRule
  hidePhotoRequired?: boolean
  minimumRemnantArea?: string
  minimumRemnantUom?: AreaUom
  reason?: string
  version?: number
}

/** production.settings.manage: the site's cutting rules from now on (audited before → after with the reason). */
export const changeCuttingRules = (api: ApiClient, siteId: string, body: CuttingRulesBody, idempotencyKey: string) =>
  api.post(`/production/settings/${seg(siteId)}/cutting-rules`, { body, schema: cuttingRulesSchema.extend({ changed: z.boolean() }), idempotencyKey })

const rowSchema = z.object({ id: z.string(), percent: z.string().nullable(), version: z.number(), updatedAt: z.string() })
export const toleranceSchema = z.object({
  companyId: z.string().nullable(),
  percent: z.string(),
  from: z.enum(['COMPANY', 'TENANT', 'DEFAULT']),
  company: rowSchema.nullable(),
  tenant: rowSchema.nullable(),
  mayChange: z.boolean(),
})
export type LeatherTolerance = z.infer<typeof toleranceSchema>

export const getLeatherTolerance = (api: ApiClient, companyId: string, signal?: AbortSignal) => api.get('/purchasing/settings/leather-tolerance', { query: { companyId }, schema: toleranceSchema, signal })

/** purchasing.manage: the company's tolerance (null: follow every company's, else 2 %). */
export const putLeatherTolerance = (api: ApiClient, body: { companyId: string; percent: string | null; version?: number }, idempotencyKey: string) =>
  api.request('PUT', '/purchasing/settings/leather-tolerance', { body, schema: toleranceSchema.extend({ changed: z.boolean() }), idempotencyKey })
