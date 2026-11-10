import { z } from 'zod'
import { labourRateView, settingsListView, type LabourRateView, type SettingsListView } from '@nexus/factory-domain/costing/contracts'
import { settingsView, type SettingsView, type UpdateSettingsBody } from '@nexus/factory-domain/product/settings/contracts'
import { typeView, type CreateTypeBody, type TypeView, type UpdateTypeBody } from '@nexus/factory-domain/product/types/contracts'
import type { ApiClient } from '../../../lib/api/client'

/**
 * Products › Settings › Product settings (SCR-251, B-W2b-239): every call of the page, each answer checked against
 * factory-domain's own contracts (apps/factory-api modules/product/settings and types, B-W2b-221; costing's rates and
 * settings, B-W2a-21). The API's English sentences are never drawn: the page says its own words from the codes.
 *
 *   GET  /product/settings[?companyId]     product.styles.view: the scope's row (edit rules, tolerance) and `mayChange`
 *   PUT  /product/settings                 product.settings.manage over the company (the tenant row: every company)
 *   GET  /product/types?status=ALL[&companyId]   product.styles.view: the types with what they inherit
 *   POST /product/types, PATCH /product/types/:id, POST …/archive | restore   product.settings.manage
 *   GET  /product/size-scales              product.styles.view (the type's default size scale)
 *   GET  /compliance/labels                compliance.certificates.view (the type's default label template)
 *   GET  /audit?recordType&recordId        audit.read ("Changed by" per card)
 *   GET  /costing/rates, /costing/settings costing.view (the costing defaults, read only; the cost per minute is money.cost)
 */

export type ProductSettings = SettingsView
export type ProductType = TypeView
export type LabourRate = LabourRateView
export type CostingSettings = SettingsListView

const enc = encodeURIComponent
const oneSettings = z.object({ settings: settingsView })
const oneType = z.object({ type: typeView })

/** The scope's settings: a company's (`companyId`) or every company's (null). */
export const readSettings = (api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<ProductSettings> =>
  api.get('/product/settings', { query: { companyId: companyId ?? undefined }, schema: oneSettings, signal }).then((answer) => answer.settings)

export const saveSettings = (api: ApiClient, body: UpdateSettingsBody, idempotencyKey: string): Promise<ProductSettings> =>
  api.request('PUT', '/product/settings', { body, schema: oneSettings, idempotencyKey }).then((answer) => answer.settings)

/** Every type a style of the company may take (its own and every company's), archived ones too; null: every type the caller sees. */
export const listTypes = (api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<ProductType[]> =>
  api.get('/product/types', { query: { status: 'ALL', companyId: companyId ?? undefined }, schema: z.object({ types: z.array(typeView) }), signal }).then((answer) => answer.types)

export const createType = (api: ApiClient, body: CreateTypeBody, idempotencyKey: string): Promise<ProductType> =>
  api.post('/product/types', { body, schema: oneType, idempotencyKey }).then((answer) => answer.type)

export const updateType = (api: ApiClient, typeId: string, body: UpdateTypeBody, idempotencyKey: string): Promise<ProductType> =>
  api.request('PATCH', `/product/types/${enc(typeId)}`, { body, schema: oneType, idempotencyKey }).then((answer) => answer.type)

export const moveType = (api: ApiClient, type: Pick<ProductType, 'id' | 'version'>, to: 'archive' | 'restore', idempotencyKey: string): Promise<ProductType> =>
  api.post(`/product/types/${enc(type.id)}/${to}`, { body: { version: type.version }, schema: oneType, idempotencyKey }).then((answer) => answer.type)

// ---- what a type's defaults pick from -----------------------------------------------------------------------------------

const scaleRef = z.object({ id: z.string(), code: z.string(), name: z.string(), companyId: z.string().nullable() })
export type ScaleRef = z.infer<typeof scaleRef>

/** The active size scales (one page of 200: a factory keeps a handful). */
export const listScales = (api: ApiClient, signal?: AbortSignal): Promise<ScaleRef[]> =>
  api.get('/product/size-scales', { query: { status: 'ACTIVE', limit: 200 }, schema: z.object({ scales: z.array(scaleRef) }), signal }).then((answer) => answer.scales)

const labelRef = z.object({ id: z.string(), code: z.string(), name: z.string(), revision: z.number(), status: z.string(), companyId: z.string().nullable() })
export type LabelRef = z.infer<typeof labelRef>

/** The garment label templates not retired (compliance.certificates.view). */
export const listLabelTemplates = (api: ApiClient, signal?: AbortSignal): Promise<LabelRef[]> =>
  api.get('/compliance/labels', { schema: z.object({ templates: z.array(labelRef) }), signal }).then((answer) => answer.templates.filter((template) => template.status !== 'RETIRED'))

// ---- "Changed by" -------------------------------------------------------------------------------------------------------

const auditEntry = z.object({ id: z.string(), at: z.string(), action: z.string(), recordId: z.string(), after: z.unknown(), actorName: z.string().nullable() })
export type AuditEntry = z.infer<typeof auditEntry>

/** The newest audited writes of a record (or of every record of a type), newest first (audit.read). */
export const readChanges = (api: ApiClient, recordType: string, recordId: string | null, limit: number, signal?: AbortSignal): Promise<AuditEntry[]> =>
  api.get('/audit', { query: { recordType, recordId: recordId ?? undefined, limit }, schema: z.object({ entries: z.array(auditEntry) }), signal }).then((answer) => answer.entries)

// ---- the costing defaults (Finance's, read only) ------------------------------------------------------------------------

export interface CostingDefaults {
  readonly rates: LabourRate[]
  readonly settings: CostingSettings
}

/** The labour rates in force and the overhead for the company (costing.view; the cost per minute only with money.cost). */
export async function readCosting(api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<CostingDefaults> {
  const query = { companyId: companyId ?? undefined }
  const [rates, settings] = await Promise.all([
    api.get('/costing/rates', { query, schema: z.object({ rates: z.array(labourRateView) }), signal }).then((answer) => answer.rates),
    api.get('/costing/settings', { query, schema: z.object({ settings: settingsListView }), signal }).then((answer) => answer.settings),
  ])
  return { rates, settings }
}
