import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * The customer's own calls of the Account page (B-W2b-196, SCR-188), each answer checked against what the API's contracts
 * say: delivery addresses with our check (B-W2b-190, F13b, F15: modules/sales/portal-ordering/addresses.ts) and the page's
 * own (B-W2b-196: platform/auth/portal/self.ts — the person's name and language, the company data). Colleagues, the
 * hand-over, the step-up and the sessions are the shared account calls (../../shared/account/api.ts, lifted by B-W2b-193);
 * e-mail settings are the frame's (portal/shell/api.ts). The web reads only what it uses; the API's English never reaches
 * the screen.
 */

const words = z.object({ it: z.string(), en: z.string() })

// ── delivery addresses (B-W2b-190, F13b, F15) ────────────────────────────────────────────────────────────────────────────
export const APPROVALS = ['WAITING', 'APPROVED', 'REFUSED'] as const
export type Approval = (typeof APPROVALS)[number]
const address = z.object({
  id: z.string(),
  name: z.string().nullable(),
  line1: z.string(),
  line2: z.string().nullable(),
  postalCode: z.string(),
  city: z.string(),
  province: z.string().nullable(),
  country: z.string(),
  contactName: z.string().nullable(),
  phone: z.string().nullable(),
  deliveryNotes: z.string().nullable(),
  isDefault: z.boolean(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  approval: z.object({ status: z.enum(APPROVALS), words, refuseReason: z.string().nullable() }).nullable(),
  version: z.number(),
  createdAt: z.string(),
  addedBy: z.object({ kind: z.enum(['COLLEAGUE', 'FACTORY']), name: z.string().nullable(), you: z.boolean() }),
  requestedAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
})
export type DeliveryAddress = z.infer<typeof address>
export const addressesSchema = z.object({ addresses: z.array(address), canManage: z.boolean() })
export type DeliveryAddresses = z.infer<typeof addressesSchema>

export const fetchAddresses = (api: ApiClient, signal?: AbortSignal) => api.get('/portal/addresses', { schema: addressesSchema, signal })

export interface AddressBody {
  name: string | null
  line1: string
  line2: string | null
  postalCode: string
  city: string
  province: string | null
  country: string
  contactName: string | null
  phone: string | null
  deliveryNotes: string | null
}
export const addAddress = (api: ApiClient, body: AddressBody, idempotencyKey: string) => api.post('/portal/addresses', { body, schema: z.object({ address }), idempotencyKey })
export const archiveAddress = (api: ApiClient, row: { id: string; version: number }) =>
  api.post(`/portal/addresses/${encodeURIComponent(row.id)}/archive`, { body: { version: row.version }, schema: addressesSchema, idempotencyKey: newIdempotencyKey() })
export const defaultAddress = (api: ApiClient, row: { id: string; version: number }) =>
  api.post(`/portal/addresses/${encodeURIComponent(row.id)}/default`, { body: { version: row.version }, schema: addressesSchema, idempotencyKey: newIdempotencyKey() })

// ── the page's own (B-W2b-196: platform/auth/portal/self.ts) ─────────────────────────────────────────────────────────────
export const saveProfile = (api: ApiClient, body: { displayName?: string; locale?: 'it' | 'en' }) =>
  api.post('/portal/me/profile', { body, schema: z.object({ displayName: z.string(), locale: z.string(), changed: z.boolean() }), idempotencyKey: newIdempotencyKey() })

const partyAddress = z.object({ name: z.string().nullable(), line1: z.string(), line2: z.string().nullable(), postalCode: z.string(), city: z.string(), province: z.string().nullable(), country: z.string() })
export type PartyAddressLines = z.infer<typeof partyAddress>
export const companySchema = z.object({
  company: z.object({
    legalName: z.string(),
    tradeName: z.string().nullable(),
    kind: z.string(),
    country: z.string(),
    currency: z.string(),
    language: z.string(),
    taxIdentity: z.object({ country: z.string(), taxMode: z.string(), vatNumber: z.string().nullable(), fiscalCode: z.string().nullable(), sdiRecipientCode: z.string().nullable(), pec: z.string().nullable(), validFrom: z.string() }).nullable(),
    invoiceAddress: partyAddress.nullable(),
    registeredOffice: partyAddress.nullable(),
    paymentTerms: words.nullable(),
  }),
})
export type CompanyData = z.infer<typeof companySchema>['company']
export const fetchCompany = (api: ApiClient, signal?: AbortSignal) => api.get('/portal/company', { schema: companySchema, signal })
