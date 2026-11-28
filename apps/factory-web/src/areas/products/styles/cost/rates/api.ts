import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'

/**
 * owb-pd5b step 5.4 (S4; design plan § 5zh "The factory's rates"; brief owb-pd-server.md pd2 step 2.5, pd3 step 3.2) — the calls of the
 * rates window, with this web's own zod (Finance's pages keep their contracts; a new field never breaks this window):
 *   GET  /costing/rates            the labour rates (costing.view; the cost per minute only with the cost grain) — pd2 adds `departmentId`
 *   POST /costing/rates            a new rate (costing.rates.manage), with `departmentId` for one department (it wins over its kind's)
 *   PATCH /costing/rates/:rateId   a correction under its version
 *   GET/PUT /costing/settings      the overhead in force, and (pd3) the company switch `oneKeeperAllowed` ("one person may keep a cost"):
 *                                  on the company's OWN row only (owb-pd8b: the server refuses it on the whole factory's row, 400)
 *   GET  /costing/leather-bases    the leathers against the reference (yield and grades; kept in Finance › Costing)
 */

export const rateRow = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  workCentreKind: z.string(),
  /** pd2: the department the rate is for; null / absent: the kind's rate. */
  departmentId: z.string().nullable().optional(),
  /** Absent without the cost grain. */
  costPerMinute: z.string().optional(),
  currency: z.string(),
  plannedEfficiencyPct: z.string(),
  validFrom: z.string(),
  status: z.string(),
  inForce: z.boolean(),
  version: z.number().int(),
})
export type RateRow = z.infer<typeof rateRow>

/** The active rates of the company and the tenant-wide ones. */
export function readRates(api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<RateRow[]> {
  return api.get('/costing/rates', { query: { companyId: companyId ?? undefined, status: 'ACTIVE' }, schema: z.object({ rates: z.array(rateRow) }), signal }).then((answer) => answer.rates)
}

const settingsRow = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  overheadPct: z.string(),
  overheadFromTenant: z.boolean().optional(),
  /** pd3: "one person may keep a cost" (default false: four eyes) — a company's own row only. */
  oneKeeperAllowed: z.boolean().optional(),
  version: z.number().int(),
})
export type SettingsRow = z.infer<typeof settingsRow>

export const costingSettings = z.object({
  settings: z.object({ tenant: settingsRow.nullable(), company: settingsRow.nullable(), inForce: z.string().nullable() }),
})
export type CostingSettings = z.infer<typeof costingSettings>

/** The overhead rows (the company's own, the tenant-wide one) and which one is in force. */
export function readSettings(api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<CostingSettings> {
  return api.get('/costing/settings', { query: { companyId: companyId ?? undefined }, schema: costingSettings, signal })
}

const basis = z.object({ id: z.string(), item: z.object({ code: z.string(), name: z.string() }), expectedYieldPct: z.string(), inForce: z.boolean(), status: z.string(), styleId: z.string().nullable().optional() })
export type LeatherBasis = z.infer<typeof basis>

/** The leathers of the company (active), each with its expected yield against the reference. */
export function readLeatherBases(api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<LeatherBasis[]> {
  return api.get('/costing/leather-bases', { query: { companyId: companyId ?? undefined }, schema: z.object({ bases: z.array(basis) }), signal }).then((answer) => answer.bases)
}

export interface CreateRate {
  readonly companyId: string | null
  readonly workCentreKind: string
  readonly departmentId: string
  readonly costPerMinute: string
  readonly plannedEfficiencyPct: string
  readonly validFrom: string
}

export function createRate(api: ApiClient, body: CreateRate): Promise<unknown> {
  return api.post('/costing/rates', { body, idempotencyKey: newIdempotencyKey() })
}

export function updateRate(api: ApiClient, rate: Pick<RateRow, 'id' | 'version'>, body: { costPerMinute: string; plannedEfficiencyPct: string }): Promise<unknown> {
  return api.request('PATCH', `/costing/rates/${encodeURIComponent(rate.id)}`, { body: { version: rate.version, ...body }, idempotencyKey: newIdempotencyKey() })
}

export interface SaveSettings {
  readonly companyId: string | null
  readonly overheadPct: string
  readonly version?: number
  /** owb-pd8b: a company row that follows the whole factory's overhead keeps following it (with 0) when only the switch changes. */
  readonly overheadFromTenant?: boolean
  readonly oneKeeperAllowed?: boolean
  /** Why the switch changed (logged). */
  readonly reason?: string
}

export function saveSettings(api: ApiClient, body: SaveSettings): Promise<unknown> {
  return api.request('PUT', '/costing/settings', { body, idempotencyKey: newIdempotencyKey() })
}
