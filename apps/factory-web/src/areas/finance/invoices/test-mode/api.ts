import { z } from 'zod'
import { GO_LIVE_PROBLEMS, SIMULATED_OUTCOMES } from '@nexus/factory-domain/invoicing/test-mode/test-mode'
import { COPY_STATES } from '@nexus/factory-domain/invoicing/archive-copy/archive-copy'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * A company's e-invoicing settings and our own copies of its sends (B-W2b-401's API; FIN-096, FIN-097): test mode with the
 * banner every invoice page shows while it is on, who answers the sends, what holds going live, the simulated answer, the
 * accountant's switch (self-invoices, debit notes, the VAT time limit), and the swap readiness. Codes only are drawn: the
 * API's English `words` are dropped here (the screens say their own).
 */

export { GO_LIVE_PROBLEMS, SIMULATED_OUTCOMES, COPY_STATES }
export type SimulatedOutcome = (typeof SIMULATED_OUTCOMES)[number]
export type GoLiveProblem = (typeof GO_LIVE_PROBLEMS)[number]
export type CopyState = (typeof COPY_STATES)[number]

export const companyEInvoicingSchema = z.object({
  companyId: z.string(),
  code: z.string(),
  legalName: z.string(),
  version: z.number().nullable(),
  testMode: z.boolean(),
  liveSince: z.string().nullable(),
  simulateOutcome: z.enum(SIMULATED_OUTCOMES),
  state: z.object({ code: z.enum(['TEST', 'LIVE']), banner: z.string().nullable(), simulated: z.boolean() }),
  connection: z.object({ state: z.enum(['NONE', 'SEVERAL', 'PAUSED', 'ACTIVE']), accounts: z.array(z.object({ id: z.string(), label: z.string(), mode: z.string(), status: z.string() })) }),
  goLive: z.object({ allowed: z.boolean(), problems: z.array(z.object({ code: z.enum(GO_LIVE_PROBLEMS) })) }),
  testSent: z.number(),
  simulateOptions: z.array(z.object({ outcome: z.enum(SIMULATED_OUTCOMES) })),
  rules: z.object({ selfInvoicesOn: z.boolean() }),
  can: z.object({ manage: z.boolean(), switchRules: z.boolean() }),
})
export type CompanyEInvoicing = z.infer<typeof companyEInvoicingSchema>

/** Per company the person sees (invoices.view). */
export async function getEInvoicing(api: ApiClient, signal?: AbortSignal): Promise<CompanyEInvoicing[]> {
  return (await api.get('/invoicing/e-invoicing/settings', { schema: z.object({ companies: z.array(companyEInvoicingSchema) }), signal })).companies
}

const settingsPath = (companyId: string) => `/invoicing/e-invoicing/settings/${encodeURIComponent(companyId)}`
const oneCompany = z.object({ company: companyEInvoicingSchema })

/** Go live, back to test mode, or the simulated answer (invoices.testMode.manage + a fresh code). */
export async function putTestMode(api: ApiClient, companyId: string, body: { version?: number; testMode?: boolean; simulateOutcome?: SimulatedOutcome }, idempotencyKey: string): Promise<CompanyEInvoicing> {
  return (await api.request('PUT', settingsPath(companyId), { body, schema: oneCompany, idempotencyKey })).company
}

/** The accountant's switch for self-invoices, debit notes and the VAT time limit (invoices.tax.switch + a fresh code). */
export async function putDepthRules(api: ApiClient, companyId: string, body: { version?: number; selfInvoicesOn: boolean }, idempotencyKey: string): Promise<CompanyEInvoicing> {
  return (await api.request('PUT', `${settingsPath(companyId)}/rules`, { body, schema: oneCompany, idempotencyKey })).company
}

export const readinessSchema = z.object({ ready: z.boolean(), open: z.number(), missing: z.number(), copied: z.number(), providers: z.array(z.string()) })
export type Readiness = z.infer<typeof readinessSchema>

const sendCopySchema = z.object({
  submissionId: z.string(),
  invoiceId: z.string(),
  attempt: z.number(),
  fileName: z.string(),
  status: z.string(),
  copy: z.object({ state: z.enum(COPY_STATES) }),
  providerName: z.string().nullable(),
  receipts: z.array(z.object({ fileId: z.string(), type: z.string() })),
  copiedAt: z.string().nullable(),
})
export type SendCopy = z.infer<typeof sendCopySchema>

/** The swap readiness over every send and the newest 200 sends' copies (invoices.view). */
export async function getCopies(api: ApiClient, companyId: string, signal?: AbortSignal): Promise<{ readiness: Readiness; sends: SendCopy[] }> {
  return api.get('/invoicing/e-invoicing/copies', { query: { companyId }, schema: z.object({ readiness: readinessSchema, sends: z.array(sendCopySchema) }), signal })
}

/** Makes or completes up to 100 missing copies, oldest first (invoices.issue). */
export async function makeCopies(api: ApiClient, companyId: string, idempotencyKey: string): Promise<{ made: number; completed: number; remaining: number; readiness: Readiness }> {
  return api.post(`/invoicing/e-invoicing/copies/${encodeURIComponent(companyId)}/make`, { schema: z.object({ made: z.number(), completed: z.number(), remaining: z.number(), readiness: readinessSchema }), idempotencyKey })
}

/** A live event that changes a company's e-invoicing settings or its copies. */
export const eInvoicingTouched = (change: { type: string }): boolean => change.type === 'e_invoicing.settings_changed' || change.type === 'sdi_archive_copy.changed'
