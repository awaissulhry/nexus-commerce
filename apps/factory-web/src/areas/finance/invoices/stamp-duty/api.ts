import { z } from 'zod'
import { QUARTER_STATES, STAMP_DUTY_REASONS } from '@nexus/factory-domain/invoicing/stamp-duty/stamp-duty'
import type { ApiClient } from '../../../../lib/api/client'
import { invoiceSchema, type Invoice } from '../../_shared/api'

/**
 * Stamp duty (B-W2b-392's API; FIN-101): an invoice's decision before the issue (GET …/tax — the pre-check's "stamp duty
 * decided"), deciding it again by saving the draft unchanged, and a company's quarters of a year with the day each is due
 * and its F24 code, recounting one and recording its payment. Totals are the price grain (absent without it). The API's
 * English `words` are dropped: the screens say their own from the reason and the figures.
 */

export { QUARTER_STATES, STAMP_DUTY_REASONS }
export type QuarterState = (typeof QUARTER_STATES)[number]
export type StampDutyReason = (typeof STAMP_DUTY_REASONS)[number]

const problemSchema = z.object({ code: z.string(), path: z.string() })

export const invoiceTaxSchema = z.object({
  invoiceId: z.string(),
  status: z.string(),
  switches: z.object({ taxCodesOn: z.boolean(), stampDutyOn: z.boolean(), declarationsOfIntentOn: z.boolean() }),
  stampDuty: z.object({ amount: z.number().nullable().optional(), charge: z.boolean(), reason: z.enum(STAMP_DUTY_REASONS), chargedAmount: z.number().nullable().optional() }),
  problems: z.array(problemSchema),
})
export type InvoiceTax = z.infer<typeof invoiceTaxSchema>

/** What the invoice's tax rules say before the issue (invoices.view). */
export function getInvoiceTax(api: ApiClient, invoiceId: string, signal?: AbortSignal): Promise<InvoiceTax> {
  return api.get(`/invoicing/invoices/${encodeURIComponent(invoiceId)}/tax`, { schema: invoiceTaxSchema, signal })
}

/** Decides the stamp duty again: the draft saved with no change (its lines, totals and stamp line follow the rule) (invoices.manage). */
export async function decideAgain(api: ApiClient, invoice: Pick<Invoice, 'id' | 'version'>, idempotencyKey: string): Promise<Invoice> {
  return (await api.request('PATCH', `/invoicing/invoices/${encodeURIComponent(invoice.id)}`, { body: { version: invoice.version }, schema: z.object({ invoice: invoiceSchema }), idempotencyKey })).invoice
}

export const quarterSchema = z.object({
  id: z.string().nullable(),
  version: z.number().nullable(),
  companyId: z.string(),
  quarterStart: z.string(),
  quarterEnd: z.string(),
  invoiceCount: z.number(),
  total: z.number().optional(),
  liveCount: z.number(),
  liveTotal: z.number().optional(),
  stale: z.boolean(),
  dueOn: z.string(),
  f24Code: z.string(),
  deferred: z.boolean(),
  state: z.enum(QUARTER_STATES),
  paidAt: z.string().nullable(),
})
export type Quarter = z.infer<typeof quarterSchema>

const quartersSchema = z.object({ companyId: z.string(), year: z.number(), today: z.string(), stampDutyOn: z.boolean(), quarters: z.array(quarterSchema) })
export type Quarters = z.infer<typeof quartersSchema>

/** The company's four quarters of a year (invoices.view). */
export function getQuarters(api: ApiClient, companyId: string, year: number | null, signal?: AbortSignal): Promise<Quarters> {
  return api.get('/invoicing/stamp-duty/quarters', { query: { companyId, year: year ?? undefined }, schema: quartersSchema, signal })
}

const oneQuarter = z.object({ quarter: quarterSchema })

/** Counts a quarter again from its issued invoices (invoices.tax.manage; the switch on). */
export async function recountQuarter(api: ApiClient, companyId: string, quarterStart: string, idempotencyKey: string): Promise<Quarter> {
  return (await api.post('/invoicing/stamp-duty/quarters/recount', { body: { companyId, quarterStart }, schema: oneQuarter, idempotencyKey })).quarter
}

/** Records a quarter's payment (F24) on a day after it ended, not in the future (invoices.tax.manage). */
export async function payQuarter(api: ApiClient, quarter: { id: string; version: number }, paidOn: string, idempotencyKey: string): Promise<Quarter> {
  return (await api.post(`/invoicing/stamp-duty/quarters/${encodeURIComponent(quarter.id)}/paid`, { body: { version: quarter.version, paidOn }, schema: oneQuarter, idempotencyKey })).quarter
}

/** A live event that changes the quarters or an invoice's stamp duty. */
export const stampDutyTouched = (change: { type: string }): boolean => change.type === 'stamp_duty_quarter.changed' || change.type === 'tax_settings.changed' || change.type === 'invoice.issued'
