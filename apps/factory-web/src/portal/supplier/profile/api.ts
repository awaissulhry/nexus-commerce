import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'

/**
 * The supplier's own calls of the Profile page (B-W2b-193, SCR-191), each answer checked against the API's contract
 * (apps/factory-api modules/purchasing/portal-profile/contract.ts, B-W2b-189 / F13a): the company, its addresses and
 * contacts with what waits for our check, and the changes sent for our check (nothing changes on our side until a buyer
 * approves them) or withdrawn. Colleagues, the step-up, e-mail settings and sessions are the shared account calls
 * (../../shared/account/api.ts, portal/shell/api.ts). The API's sentences (`summary`, `sentence`) are English: the page
 * says its own words from the codes and the values.
 */

const addressFields = {
  kinds: z.array(z.string()),
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
}
const contactFields = { name: z.string(), email: z.string().nullable(), phone: z.string().nullable(), roles: z.array(z.string()), language: z.string().nullable() }

const address = z.object({ id: z.string(), version: z.number(), ...addressFields, isDefaultBillTo: z.boolean(), isDefaultShipTo: z.boolean(), waiting: z.boolean() })
export type ProfileAddress = z.infer<typeof address>
const contact = z.object({ id: z.string(), version: z.number(), ...contactFields, waiting: z.boolean() })
export type ProfileContact = z.infer<typeof contact>

export const REQUEST_STATES = ['OPEN', 'APPROVED', 'REFUSED', 'WITHDRAWN'] as const
export type RequestState = (typeof REQUEST_STATES)[number]

const plannedChange = z.object({
  target: z.enum(['ADDRESS', 'CONTACT', 'COMPANY']),
  op: z.enum(['ADD', 'CHANGE', 'REMOVE']),
  id: z.string().nullable(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  changed: z.array(z.string()),
})
export type PlannedChange = z.infer<typeof plannedChange>

const request = z.object({
  requestId: z.string(),
  state: z.enum(REQUEST_STATES),
  sentAt: z.string(),
  sentBy: z.string().nullable(),
  note: z.string().nullable(),
  changes: z.array(plannedChange),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  /** Our refusal's reason, as the buyer typed it to the supplier. */
  reason: z.string().nullable(),
})
export type ChangeRequest = z.infer<typeof request>

export const supplierProfileSchema = z.object({
  company: z.object({ code: z.string(), legalName: z.string(), tradeName: z.string().nullable(), country: z.string(), vatNumber: z.string().nullable(), fiscalCode: z.string().nullable(), website: z.string().nullable(), waiting: z.boolean() }),
  addresses: z.array(address),
  contacts: z.array(contact),
  pending: z.array(request),
  decided: z.array(request),
  mayChange: z.boolean(),
  limits: z.object({ changes: z.number(), addressKinds: z.array(z.string()), contactRoles: z.array(z.string()) }),
  live: z.object({ events: z.array(z.string()) }),
})
export type SupplierProfile = z.infer<typeof supplierProfileSchema>

export const fetchSupplierProfile = (api: ApiClient, signal?: AbortSignal) => api.get('/portal/supplier-profile', { schema: supplierProfileSchema, signal })

export interface AddressBody {
  name?: string | null
  line1?: string
  line2?: string | null
  postalCode?: string
  city?: string
  province?: string | null
  country?: string
  contactName?: string | null
  phone?: string | null
  deliveryNotes?: string | null
}
export interface ContactBody {
  name?: string
  email?: string | null
  phone?: string | null
  roles?: string[]
  language?: string | null
}
export type AddressChangeBody = { op: 'ADD'; address: Required<Pick<AddressBody, 'line1' | 'postalCode' | 'city' | 'country'>> & AddressBody & { kinds: string[] } } | { op: 'CHANGE'; addressId: string; version: number; address: AddressBody } | { op: 'REMOVE'; addressId: string; version: number }
export type ContactChangeBody = { op: 'ADD'; contact: ContactBody & { name: string } } | { op: 'CHANGE'; contactId: string; version: number; contact: ContactBody } | { op: 'REMOVE'; contactId: string; version: number }

export interface ChangesBody {
  addresses?: AddressChangeBody[]
  contacts?: ContactChangeBody[]
  company?: { website: string | null }
  note?: string | null
}

/** Sends the changes for our check (201: the request, OPEN; nothing changed on our side). One key per send. */
export const sendChanges = (api: ApiClient, body: ChangesBody, idempotencyKey: string) => api.post('/portal/supplier-profile/changes', { body, schema: z.object({ request }), idempotencyKey })

/** Takes a request back before our check (OPEN → WITHDRAWN). */
export const withdrawChanges = (api: ApiClient, requestId: string, idempotencyKey: string) => api.post(`/portal/supplier-profile/changes/${encodeURIComponent(requestId)}/withdraw`, { body: {}, schema: z.object({ request }), idempotencyKey })
