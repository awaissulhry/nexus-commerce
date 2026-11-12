import { z } from 'zod'
import { DEFAULT_PURPOSES, HELD_ITEM_KINDS } from '@nexus/factory-domain/inventory/locations-depth/kinds'
import { SEPARATION_RULES } from '@nexus/factory-domain/inventory/counts-depth/separation'
import { LOCATION_KINDS, LOCATION_STATUSES } from '@nexus/factory-domain/inventory/locations/rules'
import { EVIDENCE_RULES, SETTING_SOURCES } from '@nexus/factory-domain/quality/lab/rules'
import type { ApiClient } from '../../../lib/api/client'

/**
 * Warehouse › Settings › Warehouse rules (SCR-258, B-W2b-355): every call of the page, each answer checked with zod (unknown
 * fields dropped). The API's English sentences (`words`, `held`) are never drawn: the page says its own words from the
 * codes and figures; the approval rules' sentences come in Italian and English from the engine and are drawn as sent.
 *
 *   GET  /inventory/rules?companyId                     inventory.stock.view: posting dates, the adjustment value (cost grain),
 *                                                       the low-stock alerts, the row's version and who changed it (B-W2b-314)
 *   PUT  /inventory/rules/posting-dates | adjustment-approval | low-stock-alerts      inventory.rules.manage (a looser value:
 *                                                       the reason and a fresh code, 403 stepUp)
 *   GET  /inventory/rules/separation-of-duties?companyId   inventory.stock.view: the two switches (B-W2b-299)
 *   PUT  /inventory/rules/separation-of-duties          inventory.rules.manage (a switch off: the reason and a fresh code)
 *   GET  /inventory/locations                           inventory.locations.view: the sites and their places (W1)
 *   GET  /inventory/locations/defaults?siteId           inventory.locations.view: a site's default places (B-W2b-289)
 *   PUT  /inventory/locations/defaults                  inventory.locations.manage: set, change or clear one
 *   GET  /approvals/rules                               approvals.view: the STOCK_ADJUSTMENT rules (B-W2b-282), written in Admin
 *   GET  /quality/settings?companyId                    quality.lots.view: the Cr VI evidence rule in force (W1, B-W1-34)
 *   GET  /audit?recordType&recordId|siteId              audit.read ("Changed by" per card)
 *
 * The posting-date and separation cards share ONE InventorySettings row (the company's, else every company's): one version.
 */

export { fetchRules, type ApprovalRule, type RulesAnswer } from '../../admin/automation/approval-rules/api'

const source = z.enum(SETTING_SOURCES)
const words = z.object({ en: z.string(), it: z.string() })
const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })

// ---- posting dates, the adjustment value, low-stock alerts (B-W2b-314) -------------------------------------------------------

export const rulesSchema = z.object({
  companyId: z.string().nullable(),
  company: ref.nullable(),
  version: z.number().int(),
  updatedAt: z.string().nullable(),
  changedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  mayChange: z.boolean(),
  postingDates: z.object({
    own: z.number().int().nullable(),
    inForce: z.object({ days: z.number().int().nullable(), source }),
    today: z.string(),
    earliest: z.string().nullable(),
    limits: z.object({ min: z.number().int(), max: z.number().int() }),
  }),
  adjustmentApproval: z.object({
    /** Absent without the cost grain. */
    own: z.number().int().nullable().optional(),
    inForce: z.object({ amount: z.number().int().nullable().optional(), source, set: z.boolean() }),
    currency: z.string().nullable(),
    approvalRules: z.object({ active: z.number().int(), words }),
    /** Not null: the reader's roles show no costs (the value is not sent). */
    held: z.string().nullable(),
  }),
  lowStockAlerts: z.object({ own: z.boolean().nullable(), inForce: z.object({ on: z.boolean(), source }) }),
})
export type RulesView = z.infer<typeof rulesSchema>

const savedRules = z.object({ rules: rulesSchema, loosened: z.boolean() })
type Scope = { readonly companyId: string | null; readonly version: number }

/** The rules of a company (what it keeps and what it follows), or — `null` — of every company. */
export const readRules = (api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<RulesView> =>
  api.get('/inventory/rules', { query: { companyId: companyId ?? undefined }, schema: rulesSchema, signal })

export const savePostingDates = (api: ApiClient, body: Scope & { readonly backDatingDays: number | null; readonly reason?: string }, idempotencyKey: string) =>
  api.request('PUT', '/inventory/rules/posting-dates', { body, schema: savedRules, idempotencyKey })

export const saveAdjustmentApproval = (api: ApiClient, body: Scope & { readonly amount: number | null; readonly reason?: string }, idempotencyKey: string) =>
  api.request('PUT', '/inventory/rules/adjustment-approval', { body, schema: savedRules, idempotencyKey })

export const saveLowStockAlerts = (api: ApiClient, body: Scope & { readonly on: boolean | null }, idempotencyKey: string) =>
  api.request('PUT', '/inventory/rules/low-stock-alerts', { body, schema: savedRules, idempotencyKey })

// ---- separation of duties (B-W2b-299) ----------------------------------------------------------------------------------------

export const separationSchema = z.object({
  companyId: z.string().nullable(),
  version: z.number().int(),
  updatedAt: z.string().nullable(),
  changedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  mayChange: z.boolean(),
  switches: z.array(z.object({ rule: z.enum(SEPARATION_RULES), own: z.boolean().nullable(), inForce: z.object({ on: z.boolean(), source }) })),
  offReason: z.string().nullable(),
})
export type SeparationView = z.infer<typeof separationSchema>

export const readSeparation = (api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<SeparationView> =>
  api.get('/inventory/rules/separation-of-duties', { query: { companyId: companyId ?? undefined }, schema: separationSchema, signal })

export interface SeparationBody extends Scope {
  readonly counterNotApprover?: boolean | null
  readonly receiverNotMatcher?: boolean | null
  readonly reason?: string
}

export const saveSeparation = (api: ApiClient, body: SeparationBody, idempotencyKey: string) =>
  api.request('PUT', '/inventory/rules/separation-of-duties', { body, schema: z.object({ rules: separationSchema, loosened: z.array(z.enum(SEPARATION_RULES)) }), idempotencyKey })

// ---- the sites, their places and their default places (W1, B-W2b-289) -----------------------------------------------------------

const placeSchema = z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.enum(LOCATION_KINDS), status: z.enum(LOCATION_STATUSES), path: z.array(z.string()) })
export type Place = z.infer<typeof placeSchema>
const siteSchema = z.object({ id: z.string(), companyId: z.string(), code: z.string(), name: z.string(), locations: z.array(placeSchema) })
export type SitePlaces = z.infer<typeof siteSchema>

/** The sites the reader reaches with their places (active ones only), by code. */
export const readSites = (api: ApiClient, signal?: AbortSignal): Promise<SitePlaces[]> =>
  api.get('/inventory/locations', { schema: z.object({ sites: z.array(siteSchema) }), signal }).then((answer) => [...answer.sites].sort((a, b) => a.code.localeCompare(b.code)))

const defaultSchema = z.object({
  id: z.string(),
  itemKind: z.enum(HELD_ITEM_KINDS).nullable(),
  purpose: z.enum(DEFAULT_PURPOSES),
  location: z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.enum(LOCATION_KINDS), status: z.enum(LOCATION_STATUSES) }),
  version: z.number().int(),
  updatedAt: z.string(),
  updatedById: z.string().nullable(),
})
export type DefaultRow = z.infer<typeof defaultSchema>

export const readDefaults = (api: ApiClient, siteId: string, signal?: AbortSignal): Promise<DefaultRow[]> =>
  api.get('/inventory/locations/defaults', { query: { siteId }, schema: z.object({ siteId: z.string(), defaults: z.array(defaultSchema) }), signal }).then((answer) => answer.defaults)

export interface SetDefaultBody {
  readonly siteId: string
  readonly itemKind: (typeof HELD_ITEM_KINDS)[number] | null
  readonly purpose: (typeof DEFAULT_PURPOSES)[number]
  /** null clears it. */
  readonly locationId: string | null
  /** The version of the active default read; left out while there is none. */
  readonly version?: number
}

export const setDefault = (api: ApiClient, body: SetDefaultBody, idempotencyKey: string): Promise<DefaultRow | null> =>
  api.request('PUT', '/inventory/locations/defaults', { body, schema: z.object({ default: defaultSchema.nullable() }), idempotencyKey }).then((answer) => answer.default)

// ---- the Cr VI evidence rule (W1; Compliance › Rules & markets keeps it) --------------------------------------------------------

const crViSchema = z.object({ companyId: z.string().nullable(), crViEvidenceRule: z.enum(EVIDENCE_RULES), source, default: z.enum(EVIDENCE_RULES), version: z.number(), updatedAt: z.string().nullable() })
export type CrViRule = z.infer<typeof crViSchema>

export const readCrVi = (api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<CrViRule> =>
  api.get('/quality/settings', { query: { companyId: companyId ?? undefined }, schema: z.object({ settings: crViSchema }), signal }).then((answer) => answer.settings)

// ---- "Changed by" ---------------------------------------------------------------------------------------------------------------

const auditEntry = z.object({ id: z.string(), at: z.string(), action: z.string(), recordId: z.string(), actorName: z.string().nullable(), after: z.unknown().optional() })
export type AuditEntry = z.infer<typeof auditEntry>

/** The newest audited writes of a record type (one record, or one site's), newest first (audit.read). */
export const readChanges = (api: ApiClient, query: { readonly recordType: string; readonly recordId?: string; readonly siteId?: string; readonly action?: string; readonly limit: number }, signal?: AbortSignal): Promise<AuditEntry[]> =>
  api
    .get('/audit', { query: { recordType: query.recordType, recordId: query.recordId, siteId: query.siteId, action: query.action, limit: query.limit }, schema: z.object({ entries: z.array(auditEntry) }), signal })
    .then((answer) => answer.entries)
