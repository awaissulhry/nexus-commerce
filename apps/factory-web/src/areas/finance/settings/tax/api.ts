import { z } from 'zod'
import { TAX_CODE_STATES, TAX_CODE_STATUSES, TAX_CODE_VERIFICATIONS } from '@nexus/factory-domain/invoicing/tax-codes/tax-codes'
import { TAX_SWITCHES } from '@nexus/factory-domain/invoicing/tax-codes/switches'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * The company's tax set-up (B-W2b-392's API; FIN-107; GATE-ACCOUNTANT): its three tax switches, its tax codes as data — a
 * rate or a Natura with its law, an account key, the rule it follows, the days it is in force, versions, the accountant's
 * confirmation — and the rules they follow. No money. The API's English `words` are dropped: the screen says its own.
 */

export { TAX_CODE_STATES, TAX_SWITCHES }
export type TaxSwitch = (typeof TAX_SWITCHES)[number]
export type TaxCodeState = (typeof TAX_CODE_STATES)[number]
export type Verification = (typeof TAX_CODE_VERIFICATIONS)[number]

const switchesSchema = z.object({ taxCodesOn: z.boolean(), stampDutyOn: z.boolean(), declarationsOfIntentOn: z.boolean() })
export type Switches = z.infer<typeof switchesSchema>

export const companyTaxSchema = z.object({ companyId: z.string(), code: z.string(), legalName: z.string(), version: z.number().nullable(), switches: switchesSchema, selfInvoicesOn: z.boolean() })
export type CompanyTax = z.infer<typeof companyTaxSchema>

/** The switches of each company the person sees (invoices.view). */
export async function getTaxSettings(api: ApiClient, signal?: AbortSignal): Promise<CompanyTax[]> {
  return (await api.get('/invoicing/tax/settings', { schema: z.object({ companies: z.array(companyTaxSchema) }), signal })).companies
}

/** One switch on or off (invoices.tax.switch + a fresh code); ONE command. */
export async function putTaxSwitch(api: ApiClient, companyId: string, body: { version?: number } & Partial<Switches>, idempotencyKey: string): Promise<CompanyTax> {
  return (await api.request('PUT', `/invoicing/tax/settings/${encodeURIComponent(companyId)}`, { body, schema: z.object({ company: companyTaxSchema }), idempotencyKey })).company
}

export const taxCodeSchema = z.object({
  id: z.string(),
  version: z.number(),
  companyId: z.string(),
  country: z.string(),
  code: z.string(),
  label: z.string(),
  ratePct: z.string(),
  natura: z.string().nullable(),
  legalRef: z.string().nullable(),
  accountCodeKey: z.string().nullable(),
  ruleId: z.string().nullable(),
  verification: z.enum(TAX_CODE_VERIFICATIONS),
  confirmedAt: z.string().nullable(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  status: z.enum(TAX_CODE_STATUSES),
  state: z.enum(TAX_CODE_STATES),
  can: z.object({ edit: z.boolean(), relabel: z.boolean(), end: z.boolean(), newVersion: z.boolean(), archive: z.boolean(), delete: z.boolean(), confirm: z.boolean() }),
})
export type TaxCode = z.infer<typeof taxCodeSchema>

const ruleSchema = z.object({ id: z.string(), law: z.string(), catalogueStatus: z.enum(TAX_CODE_VERIFICATIONS), status: z.enum(TAX_CODE_VERIFICATIONS), taxCodeIds: z.array(z.string()) })
export type TaxRuleRow = z.infer<typeof ruleSchema>

const codesSchema = z.object({ companyId: z.string(), today: z.string(), switches: switchesSchema, codes: z.array(taxCodeSchema), rules: z.array(ruleSchema) })
export type TaxCodes = z.infer<typeof codesSchema>

/** The company's codes, every version, with what each may do today, and the rules (invoices.view). */
export function getTaxCodes(api: ApiClient, companyId: string, signal?: AbortSignal): Promise<TaxCodes> {
  return api.get('/invoicing/tax-codes', { query: { companyId }, schema: codesSchema, signal })
}

export interface CodeFields {
  label?: string
  ratePct?: string
  natura?: string | null
  legalRef?: string | null
  accountCodeKey?: string | null
  ruleId?: string | null
  validFrom?: string
  validTo?: string | null
}

const one = z.object({ taxCode: taxCodeSchema })
const codePath = (id: string) => `/invoicing/tax-codes/${encodeURIComponent(id)}`

/** A new code (UNVERIFIED until the accountant confirms) (invoices.tax.manage). */
export async function createTaxCode(api: ApiClient, body: { companyId: string; country: string; code: string; label: string; ratePct: string; validFrom: string } & CodeFields, idempotencyKey: string): Promise<TaxCode> {
  return (await api.post('/invoicing/tax-codes', { body, schema: one, idempotencyKey })).taxCode
}

/** A version not in force yet: anything; in force: its label and end; ended or archived: its label (invoices.tax.manage). */
export async function updateTaxCode(api: ApiClient, code: Pick<TaxCode, 'id' | 'version'>, fields: CodeFields, idempotencyKey: string): Promise<TaxCode> {
  return (await api.request('PATCH', codePath(code.id), { body: { version: code.version, ...fields }, schema: one, idempotencyKey })).taxCode
}

/** The next version from a later day: the current one ends the day before (invoices.tax.manage). */
export async function newTaxCodeVersion(api: ApiClient, code: Pick<TaxCode, 'id' | 'version'>, fields: CodeFields & { validFrom: string }, idempotencyKey: string): Promise<TaxCode> {
  return (await api.post(`${codePath(code.id)}/versions`, { body: { version: code.version, ...fields }, schema: z.object({ taxCode: taxCodeSchema }), idempotencyKey })).taxCode
}

export async function archiveTaxCode(api: ApiClient, code: Pick<TaxCode, 'id' | 'version'>, idempotencyKey: string): Promise<TaxCode> {
  return (await api.post(`${codePath(code.id)}/archive`, { body: { version: code.version }, schema: one, idempotencyKey })).taxCode
}

/** Only a version not yet in force. */
export async function deleteTaxCode(api: ApiClient, code: Pick<TaxCode, 'id' | 'version'>, idempotencyKey: string): Promise<void> {
  await api.request('DELETE', codePath(code.id), { query: { version: code.version }, schema: z.object({ deleted: z.literal(true) }), idempotencyKey })
}

/** The accountant's confirmation of a version (invoices.tax.switch + a fresh code); once. */
export async function confirmTaxCode(api: ApiClient, code: Pick<TaxCode, 'id' | 'version'>, idempotencyKey: string): Promise<TaxCode> {
  return (await api.post(`${codePath(code.id)}/confirm`, { body: { version: code.version }, schema: one, idempotencyKey })).taxCode
}

/** A live event that changes the tax set-up (a code, the switches, the accountant's switch). */
export const taxTouched = (change: { type: string }): boolean => change.type === 'tax_code.changed' || change.type === 'tax_settings.changed' || change.type === 'e_invoicing.settings_changed'
