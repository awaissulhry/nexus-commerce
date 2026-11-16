import { z } from 'zod'
import { DECLARATION_STATES } from '@nexus/factory-domain/invoicing/intent/intent'
import type { ApiClient } from '../../../../lib/api/client'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { completeUpload, requestUpload } from '../../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../../record-panels/store'
import { invoiceSchema, type Invoice } from '../../_shared/api'

/**
 * Declarations of intent (B-W2b-GB02, G152; B-W2b-392's API; FIN-100): the customers' declarations of a company with what
 * they declared, used and have left (the price grain; absent without it), their state, the check on the tax agency's site
 * with the receipt it printed (a file uploaded on the declaration first), a revocation with why, a new declaration, and the
 * one a draft rests on (GET …/tax names it and the customer's live ones; PUT …/declaration-of-intent names it or lets it
 * go). The API's English `waits` is dropped: the screens say their own words from the switch.
 */

export { DECLARATION_STATES }
export type DeclarationState = (typeof DECLARATION_STATES)[number]

export const declarationSchema = z.object({
  id: z.string(),
  version: z.number(),
  companyId: z.string(),
  partyId: z.string(),
  party: z.object({ code: z.string(), legalName: z.string() }),
  protocolNumber: z.string(),
  protocolDate: z.string(),
  year: z.number(),
  amount: z.number().optional(),
  usedAmount: z.number().optional(),
  leftAmount: z.number().optional(),
  state: z.enum(DECLARATION_STATES),
  checkedAt: z.string().nullable(),
  checkedById: z.string().nullable(),
  receiptFileId: z.string().nullable(),
  revokedAt: z.string().nullable(),
  revokeReason: z.string().nullable(),
  invoices: z.array(z.object({ id: z.string(), docType: z.string(), number: z.string().nullable(), issueDate: z.string().nullable(), intentAmount: z.number().optional() })),
})
export type Declaration = z.infer<typeof declarationSchema>

const one = z.object({ declaration: declarationSchema })

export interface DeclarationQuery {
  readonly companyId: string
  readonly year?: number | null
  readonly state?: DeclarationState | null
  readonly partyId?: string | null
}

/** The declarations of a company the person sees, newest first (invoices.view). */
export async function listDeclarations(api: ApiClient, query: DeclarationQuery, signal?: AbortSignal): Promise<Declaration[]> {
  const answer = await api.get('/invoicing/declarations-of-intent', {
    query: { companyId: query.companyId, year: query.year ?? undefined, state: query.state ?? undefined, partyId: query.partyId ?? undefined },
    schema: z.object({ declarations: z.array(declarationSchema) }),
    signal,
  })
  return answer.declarations
}

/** One declaration (invoices.view). */
export async function getDeclaration(api: ApiClient, declarationId: string, signal?: AbortSignal): Promise<Declaration> {
  return (await api.get(`/invoicing/declarations-of-intent/${encodeURIComponent(declarationId)}`, { schema: one, signal })).declaration
}

export interface NewDeclaration {
  readonly companyId: string
  readonly partyId: string
  readonly protocolNumber: string
  readonly protocolDate: string
  readonly year: number
  /** Minor units (the price grain's). */
  readonly amount: number
}

/** Records a customer's declaration, not checked yet (invoices.tax.manage). */
export async function createDeclaration(api: ApiClient, input: NewDeclaration, idempotencyKey: string): Promise<Declaration> {
  return (await api.post('/invoicing/declarations-of-intent', { body: input, schema: one, idempotencyKey })).declaration
}

/**
 * The receipt the tax agency's site printed, onto the declaration (files.upload): announce, send the bytes, confirm. Its id
 * and whether the store holds it ready (a file held by the virus check is not).
 */
export async function uploadReceipt(api: ApiClient, declaration: Pick<Declaration, 'id' | 'companyId'>, file: File): Promise<{ id: string; available: boolean }> {
  const bytes = await file.arrayBuffer()
  const { file: stored, upload } = await requestUpload(api, {
    companyId: declaration.companyId,
    record: { type: 'DeclarationOfIntent', id: declaration.id },
    kind: 'DOCUMENT',
    name: file.name || 'ricevuta-dichiarazione.pdf',
    contentType: file.type || 'application/pdf',
    sizeBytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    visibility: ['OFFICE'],
    floorSiteId: null,
    partyId: null,
  })
  await putToStore(upload, bytes)
  const done = await completeUpload(api, stored.id)
  return { id: stored.id, available: done.file.status === 'AVAILABLE' }
}

/** Records the check on the tax agency's site with its receipt, once (invoices.tax.manage). */
export async function checkDeclaration(api: ApiClient, declaration: Pick<Declaration, 'id' | 'version'>, receiptFileId: string, idempotencyKey: string = newIdempotencyKey()): Promise<Declaration> {
  return (await api.post(`/invoicing/declarations-of-intent/${encodeURIComponent(declaration.id)}/check`, { body: { version: declaration.version, receiptFileId }, schema: one, idempotencyKey })).declaration
}

/** Revokes a declaration with why; then it changes no more (invoices.tax.manage). */
export async function revokeDeclaration(api: ApiClient, declaration: Pick<Declaration, 'id' | 'version'>, reason: string, idempotencyKey: string = newIdempotencyKey()): Promise<Declaration> {
  return (await api.post(`/invoicing/declarations-of-intent/${encodeURIComponent(declaration.id)}/revoke`, { body: { version: declaration.version, reason: reason.trim() }, schema: one, idempotencyKey })).declaration
}

const customerSchema = z.object({ id: z.string(), code: z.string(), legalName: z.string(), companyId: z.string().nullable() })
export type CustomerOption = z.infer<typeof customerSchema>

/** The company's customers a declaration may be recorded for (parties.view; the first 200, the picker filters them). */
export async function getCustomers(api: ApiClient, companyId: string, signal?: AbortSignal): Promise<CustomerOption[]> {
  return (await api.get('/parties', { query: { role: 'CUSTOMER', limit: '200', companyId }, schema: z.object({ parties: z.array(customerSchema) }), signal })).parties
}

// ---- the declaration a draft rests on -----------------------------------------------------------------------------------------

const namedSchema = z.object({
  id: z.string(),
  protocolNumber: z.string(),
  protocolDate: z.string(),
  year: z.number(),
  state: z.enum(DECLARATION_STATES),
  amount: z.number().optional(),
  usedAmount: z.number().optional(),
  thisAmount: z.number().optional(),
})

export const invoiceIntentSchema = z.object({
  invoiceId: z.string(),
  status: z.string(),
  switches: z.object({ declarationsOfIntentOn: z.boolean() }),
  declarationOfIntent: namedSchema.nullable(),
  declarationCandidates: z.array(z.object({ id: z.string(), protocolNumber: z.string(), year: z.number(), state: z.enum(DECLARATION_STATES) })),
})
export type InvoiceIntent = z.infer<typeof invoiceIntentSchema>

/** The declaration a draft names and the customer's live ones it could name (GET …/tax; invoices.view). */
export function getInvoiceIntent(api: ApiClient, invoiceId: string, signal?: AbortSignal): Promise<InvoiceIntent> {
  return api.get(`/invoicing/invoices/${encodeURIComponent(invoiceId)}/tax`, { schema: invoiceIntentSchema, signal })
}

/** Names a declaration on a draft (its taxable lines become N3.5), or lets it go (null) (invoices.manage). */
export async function nameDeclaration(api: ApiClient, invoice: Pick<Invoice, 'id' | 'version'>, declarationOfIntentId: string | null, idempotencyKey: string = newIdempotencyKey()): Promise<Invoice> {
  return (await api.request('PUT', `/invoicing/invoices/${encodeURIComponent(invoice.id)}/declaration-of-intent`, { body: { version: invoice.version, declarationOfIntentId }, schema: z.object({ invoice: invoiceSchema }), idempotencyKey })).invoice
}

/** A live event that changes the declarations, their use or the switch. */
export const intentTouched = (change: { type: string }): boolean => change.type === 'declaration_of_intent.changed' || change.type === 'tax_settings.changed' || change.type === 'invoice.issued'
