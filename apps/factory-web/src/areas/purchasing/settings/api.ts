import { z } from 'zod'
import { ITEM_KINDS } from '@nexus/factory-domain/product/materials/rules'
import { MAX_TOLERANCE_NOTE, TOLERANCE_ACTIONS, TOLERANCE_STATUSES } from '@nexus/factory-domain/purchasing/po-depth/tolerances'
import type { ApiClient } from '../../../lib/api/client'

/**
 * Purchasing › Settings › Purchasing settings (SCR-256, B-W2b-354): every call of the page, each answer checked with zod
 * (unknown fields dropped). The API's English sentences (`scope`, `words`) are never drawn: the page says its own words from
 * the codes; the rule sentences the approval engine and the alert rules send in Italian and English are drawn as sent.
 *
 *   GET  /approvals/rules, /approvals/kinds          approvals.view: the PURCHASE_ORDER rules (B-W2b-282/-305) and what a
 *                                                    rule may check; written and switched in Admin › Automation only
 *   GET  /purchasing/tolerances?companyId            purchasing.view: the delivery tolerances (B-W2b-296)
 *   POST /purchasing/tolerances, PATCH …/:id, POST …/:id/archive | reactivate     purchasing.tolerances.manage
 *   GET  /purchasing/reminders/settings?companyId    purchasing.view: the Owner's reminder switch (B-W2b-14)
 *   PUT  /purchasing/reminders/settings/switch       purchasing.reminders.switch (ON asks a fresh step-up)
 *   GET  /alerts/rules?ruleKind=PO_NOT_CONFIRMED     alerts.view: the buyer's alert (B-W2a-78)
 *   GET  /audit?recordType&recordId                  audit.read ("Changed by" per card)
 *   GET  /parties?role=SUPPLIER,SUBCONTRACTOR, GET /product/materials   parties.view, product.materials.view (the pickers)
 */

export { fetchKinds, fetchRules, type ApprovalRule, type KindsAnswer, type RulesAnswer } from '../../admin/automation/approval-rules/api'

const enc = encodeURIComponent

// ---- delivery tolerances --------------------------------------------------------------------------------------------------

const toleranceSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  company: z.object({ code: z.string(), name: z.string() }).nullable(),
  supplierId: z.string().nullable(),
  supplier: z.object({ code: z.string(), name: z.string() }).nullable(),
  itemId: z.string().nullable(),
  item: z.object({ code: z.string(), name: z.string() }).nullable(),
  itemKind: z.enum(ITEM_KINDS).nullable(),
  overPct: z.string(),
  underPct: z.string(),
  whenBeyond: z.enum(TOLERANCE_ACTIONS),
  status: z.enum(TOLERANCE_STATUSES),
  note: z.string().nullable(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  updatedById: z.string().nullable(),
  mayChange: z.boolean(),
})
export type Tolerance = z.infer<typeof toleranceSchema>
const oneTolerance = z.object({ tolerance: toleranceSchema })

/** The tolerances a company follows (its own and every company's), or — `null` — every row the caller may read. */
export const listTolerances = (api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<Tolerance[]> =>
  api.get('/purchasing/tolerances', { query: { companyId: companyId ?? undefined }, schema: z.object({ tolerances: z.array(toleranceSchema) }), signal }).then((answer) => answer.tolerances)

export interface CreateToleranceBody {
  readonly companyId: string | null
  readonly supplierId: string | null
  readonly itemId: string | null
  readonly itemKind: (typeof ITEM_KINDS)[number] | null
  readonly overPct: string
  readonly underPct: string
  readonly whenBeyond: (typeof TOLERANCE_ACTIONS)[number]
  readonly note?: string | null
}

export interface UpdateToleranceBody {
  readonly version: number
  readonly overPct?: string
  readonly underPct?: string
  readonly whenBeyond?: (typeof TOLERANCE_ACTIONS)[number]
  readonly note?: string | null
}

export const createTolerance = (api: ApiClient, body: CreateToleranceBody, idempotencyKey: string): Promise<Tolerance> =>
  api.post('/purchasing/tolerances', { body, schema: oneTolerance, idempotencyKey }).then((answer) => answer.tolerance)

export const updateTolerance = (api: ApiClient, toleranceId: string, body: UpdateToleranceBody, idempotencyKey: string): Promise<Tolerance> =>
  api.request('PATCH', `/purchasing/tolerances/${enc(toleranceId)}`, { body, schema: oneTolerance, idempotencyKey }).then((answer) => answer.tolerance)

export const moveTolerance = (api: ApiClient, tolerance: Pick<Tolerance, 'id' | 'version'>, to: 'archive' | 'reactivate', idempotencyKey: string): Promise<Tolerance> =>
  api.post(`/purchasing/tolerances/${enc(tolerance.id)}/${to}`, { body: { version: tolerance.version }, schema: oneTolerance, idempotencyKey }).then((answer) => answer.tolerance)

export { MAX_TOLERANCE_NOTE }

// ---- the Owner's reminder switch ------------------------------------------------------------------------------------------

const settingsRow = z.object({ id: z.string(), companyId: z.string().nullable(), confirmationRemindersEnabled: z.boolean(), version: z.number().int(), updatedAt: z.string() }).nullable()
const reminderSchema = z.object({
  companyId: z.string().nullable(),
  source: z.enum(['COMPANY', 'TENANT', 'DEFAULT']),
  on: z.boolean(),
  mayChange: z.boolean(),
  company: settingsRow,
  tenant: settingsRow,
})
export type ReminderSettings = z.infer<typeof reminderSchema>

/** Where the switch stands for a company (its row, else every company's, else OFF), or — `null` — every company's row. */
export const readReminders = (api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<ReminderSettings> =>
  api.get('/purchasing/reminders/settings', { query: { companyId: companyId ?? undefined }, schema: reminderSchema, signal })

export const switchReminders = (api: ApiClient, body: { readonly companyId: string | null; readonly on: boolean; readonly version?: number }, idempotencyKey: string): Promise<ReminderSettings> =>
  api.request('PUT', '/purchasing/reminders/settings/switch', { body, schema: reminderSchema, idempotencyKey })

// ---- the buyer's alert ----------------------------------------------------------------------------------------------------

const words = z.object({ en: z.string(), it: z.string() })
const alertRuleSchema = z.object({
  id: z.string(),
  ruleKind: z.string(),
  name: z.string(),
  sentence: words,
  place: z.object({ companyId: z.string().nullable(), siteId: z.string().nullable(), label: z.string().nullable() }),
  recipient: z.object({ roleId: z.string(), name: z.string() }).nullable(),
  enabled: z.boolean(),
  builtIn: z.boolean(),
  fired7Days: z.number().int(),
  openAlerts: z.number().int(),
  canChange: z.boolean(),
})
export type AlertRule = z.infer<typeof alertRuleSchema>

/** The exception rules that tell the buyer an order is not confirmed in time (alerts.view). */
export const readBuyerAlerts = (api: ApiClient, signal?: AbortSignal): Promise<{ rules: AlertRule[]; canAdd: boolean }> =>
  api.get('/alerts/rules', { query: { ruleKind: 'PO_NOT_CONFIRMED' }, schema: z.object({ rules: z.array(alertRuleSchema), canAdd: z.boolean() }), signal }).then((answer) => ({ rules: answer.rules.filter((rule) => rule.ruleKind === 'PO_NOT_CONFIRMED'), canAdd: answer.canAdd }))

// ---- "Changed by" ---------------------------------------------------------------------------------------------------------

const auditEntry = z.object({ id: z.string(), at: z.string(), action: z.string(), recordId: z.string(), actorName: z.string().nullable() })
export type AuditEntry = z.infer<typeof auditEntry>

/** The newest audited writes of a record (or of every record of a type), newest first (audit.read). */
export const readChanges = (api: ApiClient, recordType: string, recordId: string | null, limit: number, signal?: AbortSignal): Promise<AuditEntry[]> =>
  api.get('/audit', { query: { recordType, recordId: recordId ?? undefined, limit }, schema: z.object({ entries: z.array(auditEntry) }), signal }).then((answer) => answer.entries)

// ---- what a tolerance names -----------------------------------------------------------------------------------------------

const supplierRef = z.object({ id: z.string(), code: z.string(), legalName: z.string(), status: z.string() })
export interface SupplierRef {
  readonly id: string
  readonly code: string
  readonly name: string
}

/** The active suppliers and workshops a tolerance may name (one page of 200: a factory buys from a few dozen). */
export const listSuppliers = (api: ApiClient, signal?: AbortSignal): Promise<SupplierRef[]> =>
  api
    .get('/parties', { query: { role: 'SUPPLIER,SUBCONTRACTOR', status: 'ACTIVE', limit: 200 }, schema: z.object({ parties: z.array(supplierRef) }), signal })
    .then((answer) => answer.parties.map((party) => ({ id: party.id, code: party.code, name: party.legalName })).sort((a, b) => a.name.localeCompare(b.name)))

const materialRef = z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string(), status: z.string() })
export interface MaterialRef {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly kind: string
}

/** The active materials a tolerance may name (never a finished garment; one page of 200). */
export const listMaterials = (api: ApiClient, signal?: AbortSignal): Promise<MaterialRef[]> =>
  api
    .get('/product/materials', { query: { status: 'ACTIVE', limit: 200 }, schema: z.object({ materials: z.array(materialRef) }), signal })
    .then((answer) => answer.materials.filter((material) => material.kind !== 'FINISHED').map(({ id, code, name, kind }) => ({ id, code, name, kind })).sort((a, b) => a.code.localeCompare(b.code)))
