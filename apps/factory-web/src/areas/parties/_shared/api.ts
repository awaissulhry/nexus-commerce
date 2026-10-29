import { z } from 'zod'
import { ADDRESS_KINDS, MASTER_STATUSES } from '@nexus/factory-domain/parties/addresses'
import { CONTACT_ROLES } from '@nexus/factory-domain/parties/contacts'
import { PARTY_KINDS, PARTY_ROLES, PARTY_STATUSES } from '@nexus/factory-domain/parties/rules'
import { PARTY_TAX_MODES } from '@nexus/factory-domain/parties/tax'
import { VIES_RESULTS, VIES_STATES } from '@nexus/factory-domain/parties/vies'
import { PARTY_WARNINGS } from '@nexus/factory-domain/parties/warnings'
import { PURCHASE_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/orders'
import { SALES_ORDER_STATUSES } from '@nexus/factory-domain/sales/orders/orders'
import { QUOTE_STATUSES } from '@nexus/factory-domain/sales/quotes/quotes'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * The customers' and suppliers' calls (B-W1-07 part 2; apps/factory-api modules/parties, contracts in factory-domain
 * parties/contracts.ts): ONE party record for both sides, so one set of calls. Plus the reads the records show beside
 * it: the party's quotes and orders (modules/sales) and its purchase orders (modules/purchasing). Each answer is
 * checked against its shape (an answer that does not match is a `contract` error, never half-read). Only containers
 * call these; the views draw what the containers map. Every write sends the version it read (COL-078) and an
 * Idempotency-Key, so a retry never writes twice.
 */

export type PartyKind = (typeof PARTY_KINDS)[number]
export type PartyRole = (typeof PARTY_ROLES)[number]
export type PartyStatus = (typeof PARTY_STATUSES)[number]
export type TaxMode = (typeof PARTY_TAX_MODES)[number]
export type AddressKind = (typeof ADDRESS_KINDS)[number]
export type ContactRole = (typeof CONTACT_ROLES)[number]
export type ViesState = (typeof VIES_STATES)[number]
export type ViesResult = (typeof VIES_RESULTS)[number]
export type WarningCode = (typeof PARTY_WARNINGS)[number]
export type MasterStatus = (typeof MASTER_STATUSES)[number]
export type QuoteStatus = (typeof QUOTE_STATUSES)[number]
export type SalesOrderStatus = (typeof SALES_ORDER_STATUSES)[number]
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number]
export {
  ADDRESS_KINDS,
  CONTACT_ROLES,
  PARTY_KINDS,
  PARTY_ROLES,
  PARTY_STATUSES,
  PARTY_TAX_MODES,
  PARTY_WARNINGS,
  PURCHASE_ORDER_STATUSES,
  QUOTE_STATUSES,
  SALES_ORDER_STATUSES,
  VIES_RESULTS,
  VIES_STATES,
}

// ---- factory-domain parties/contracts.ts (answers) --------------------------------------------------------------------

const viesStanding = z.object({
  state: z.enum(VIES_STATES),
  message: z.string(),
  proofCheckId: z.string().nullable(),
  checkedAt: z.string().nullable(),
  validUntil: z.string().nullable(),
  maxAgeDays: z.number(),
})
export type ViesStanding = z.infer<typeof viesStanding>

const partyRowShape = {
  id: z.string(),
  companyId: z.string().nullable(),
  code: z.string(),
  kind: z.enum(PARTY_KINDS),
  legalName: z.string(),
  tradeName: z.string().nullable(),
  roles: z.array(z.enum(PARTY_ROLES)),
  status: z.enum(PARTY_STATUSES),
  country: z.string(),
  currency: z.string(),
  language: z.string(),
  taxMode: z.enum(PARTY_TAX_MODES).nullable(),
  vatNumber: z.string().nullable(),
  fiscalCode: z.string().nullable(),
  city: z.string().nullable(),
  vies: viesStanding,
  attention: z.array(z.enum(PARTY_WARNINGS)),
  invoiceBlocked: z.boolean(),
  version: z.number(),
  updatedAt: z.string(),
}
export const partyRowSchema = z.object(partyRowShape)
export type PartyRow = z.infer<typeof partyRowSchema>

export const addressSchema = z.object({
  id: z.string(),
  kinds: z.array(z.enum(ADDRESS_KINDS)),
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
  isDefaultBillTo: z.boolean(),
  isDefaultShipTo: z.boolean(),
  status: z.enum(MASTER_STATUSES),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Address = z.infer<typeof addressSchema>

export const contactSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  roles: z.array(z.enum(CONTACT_ROLES)),
  language: z.string().nullable(),
  status: z.enum(MASTER_STATUSES),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Contact = z.infer<typeof contactSchema>

export const taxIdentitySchema = z.object({
  id: z.string(),
  country: z.string(),
  taxMode: z.enum(PARTY_TAX_MODES),
  vatNumber: z.string().nullable(),
  fiscalCode: z.string().nullable(),
  sdiRecipientCode: z.string().nullable(),
  pec: z.string().nullable(),
  validFrom: z.string(),
  current: z.boolean(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type TaxIdentity = z.infer<typeof taxIdentitySchema>

export const viesCheckSchema = z.object({
  id: z.string(),
  taxIdentityId: z.string(),
  companyId: z.string().nullable(),
  countryCode: z.string(),
  vatNumber: z.string(),
  requesterVatNumber: z.string().nullable(),
  requestedAt: z.string(),
  result: z.enum(VIES_RESULTS),
  consultationNumber: z.string().nullable(),
  traderName: z.string().nullable(),
  traderAddress: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMeaning: z.string().nullable(),
  requestId: z.string(),
  createdById: z.string().nullable(),
})
export type ViesCheck = z.infer<typeof viesCheckSchema>

export const partySchema = z.object({
  ...partyRowShape,
  paymentTerms: z.string().nullable(),
  internalNote: z.string().nullable(),
  blocked: z.object({ reason: z.string().nullable(), at: z.string() }).nullable(),
  addresses: z.array(addressSchema),
  contacts: z.array(contactSchema),
  taxIdentities: z.array(taxIdentitySchema),
  viesChecks: z.array(viesCheckSchema),
  warnings: z.array(z.object({ code: z.enum(PARTY_WARNINGS), message: z.string(), blocksInvoice: z.boolean() })),
  createdAt: z.string(),
  createdById: z.string().nullable(),
})
export type Party = z.infer<typeof partySchema>

const listAnswer = z.object({ parties: z.array(partyRowSchema), nextCursor: z.string().nullable(), count: z.number() })
export type PartyPage = z.infer<typeof listAnswer>
const oneAnswer = z.object({ party: partySchema })
const viesAnswer = z.object({ check: viesCheckSchema, vies: viesStanding, party: partySchema })
const historyAnswer = z.object({ checks: z.array(viesCheckSchema), nextCursor: z.string().nullable() })

// ---- the list ---------------------------------------------------------------------------------------------------------

export type Attention = 'VIES' | 'INVOICE'

/** The list's filters as the API reads them (factory-domain listPartiesQuery). */
export interface PartyQuery {
  roles: readonly PartyRole[]
  /** Left out: every status but ARCHIVED; `ALL`: every status. */
  statuses?: ReadonlyArray<PartyStatus | 'ALL'>
  q?: string
  kind?: PartyKind
  taxMode?: TaxMode
  attention?: Attention
  limit?: number
  cursor?: string | null
}

export function partyQueryParams(query: PartyQuery): Record<string, string | number | undefined> {
  return {
    role: query.roles.join(','),
    status: query.statuses?.length ? query.statuses.join(',') : undefined,
    q: query.q?.trim() ? query.q.trim() : undefined,
    kind: query.kind,
    taxMode: query.taxMode,
    attention: query.attention,
    limit: query.limit ?? 50,
    cursor: query.cursor ?? undefined,
  }
}

export const listParties = (api: ApiClient, query: PartyQuery, signal?: AbortSignal): Promise<PartyPage> => api.get('/parties', { query: partyQueryParams(query), schema: listAnswer, signal })

/** How many parties a filter holds (the tiles): one row asked, the API's count. */
export const countParties = async (api: ApiClient, query: PartyQuery): Promise<number> => (await listParties(api, { ...query, limit: 1, cursor: null })).count

/** Any party (any role, any status) a number or a name finds: the duplicate warning of New customer / supplier. */
export const findParties = async (api: ApiClient, q: string): Promise<PartyRow[]> => (await api.get('/parties', { query: { q, status: 'ALL', limit: 5 }, schema: listAnswer })).parties

// ---- one party --------------------------------------------------------------------------------------------------------

export const getParty = async (api: ApiClient, partyId: string): Promise<Party> => (await api.get(`/parties/${encodeURIComponent(partyId)}`, { schema: oneAnswer })).party

export interface NewPartyBody {
  code: string
  kind: PartyKind
  legalName: string
  tradeName?: string | null
  roles: PartyRole[]
  country: string
  currency: string
  language: string
  status: 'PROSPECT' | 'ACTIVE'
  taxIdentity?: { country: string; taxMode: TaxMode; vatNumber?: string | null; fiscalCode?: string | null; sdiRecipientCode?: string | null; pec?: string | null }
}

export const createParty = async (api: ApiClient, body: NewPartyBody, key: string = newIdempotencyKey()): Promise<Party> =>
  (await api.post('/parties', { body, schema: oneAnswer, idempotencyKey: key })).party

export type PartyPatch = Partial<{
  code: string
  kind: PartyKind
  legalName: string
  tradeName: string | null
  roles: PartyRole[]
  country: string
  currency: string
  language: string
  paymentTerms: string | null
  internalNote: string | null
}> & { version: number }

export const updateParty = async (api: ApiClient, partyId: string, body: PartyPatch): Promise<Party> =>
  (await api.request('PATCH', `/parties/${encodeURIComponent(partyId)}`, { body, schema: oneAnswer, idempotencyKey: newIdempotencyKey() })).party

export type PartyMove = 'activate' | 'block' | 'unblock' | 'archive' | 'reactivate'

export const moveParty = async (api: ApiClient, partyId: string, move: PartyMove, body: { version: number; reason?: string }): Promise<Party> =>
  (await api.post(`/parties/${encodeURIComponent(partyId)}/${move}`, { body, schema: oneAnswer, idempotencyKey: newIdempotencyKey() })).party

// ---- addresses, contacts, tax identities ------------------------------------------------------------------------------

export interface AddressBody {
  kinds: AddressKind[]
  name?: string | null
  line1: string
  line2?: string | null
  postalCode: string
  city: string
  province?: string | null
  country: string
  contactName?: string | null
  phone?: string | null
  deliveryNotes?: string | null
}

const party = (partyId: string) => `/parties/${encodeURIComponent(partyId)}`

export const addAddress = async (api: ApiClient, partyId: string, body: AddressBody & { isDefaultBillTo?: boolean; isDefaultShipTo?: boolean }): Promise<Party> =>
  (await api.post(`${party(partyId)}/addresses`, { body, schema: oneAnswer, idempotencyKey: newIdempotencyKey() })).party

export const updateAddress = async (api: ApiClient, partyId: string, addressId: string, body: Partial<AddressBody> & { version: number; status?: MasterStatus }): Promise<Party> =>
  (await api.request('PATCH', `${party(partyId)}/addresses/${encodeURIComponent(addressId)}`, { body, schema: oneAnswer, idempotencyKey: newIdempotencyKey() })).party

/** The defaults move on the party's version; null clears one. */
export const setDefaultAddresses = async (api: ApiClient, partyId: string, body: { version: number; billToAddressId?: string | null; shipToAddressId?: string | null }): Promise<Party> =>
  (await api.request('PUT', `${party(partyId)}/default-addresses`, { body, schema: oneAnswer, idempotencyKey: newIdempotencyKey() })).party

export interface ContactBody {
  name: string
  email?: string | null
  phone?: string | null
  roles: ContactRole[]
  language?: string | null
}

export const addContact = async (api: ApiClient, partyId: string, body: ContactBody): Promise<Party> =>
  (await api.post(`${party(partyId)}/contacts`, { body, schema: oneAnswer, idempotencyKey: newIdempotencyKey() })).party

export const updateContact = async (api: ApiClient, partyId: string, contactId: string, body: Partial<ContactBody> & { version: number; status?: MasterStatus }): Promise<Party> =>
  (await api.request('PATCH', `${party(partyId)}/contacts/${encodeURIComponent(contactId)}`, { body, schema: oneAnswer, idempotencyKey: newIdempotencyKey() })).party

export interface TaxIdentityBody {
  country: string
  taxMode: TaxMode
  vatNumber?: string | null
  fiscalCode?: string | null
  sdiRecipientCode?: string | null
  pec?: string | null
  validFrom?: string
}

export const addTaxIdentity = async (api: ApiClient, partyId: string, body: TaxIdentityBody): Promise<Party> =>
  (await api.post(`${party(partyId)}/tax-identities`, { body, schema: oneAnswer, idempotencyKey: newIdempotencyKey() })).party

export const updateTaxIdentity = async (api: ApiClient, partyId: string, identityId: string, body: Partial<TaxIdentityBody> & { version: number }): Promise<Party> =>
  (await api.request('PATCH', `${party(partyId)}/tax-identities/${encodeURIComponent(identityId)}`, { body, schema: oneAnswer, idempotencyKey: newIdempotencyKey() })).party

// ---- VIES -------------------------------------------------------------------------------------------------------------

/** One check of the identity in force (one gateway call, kept as the proof); a tenant-wide party names the company that asks. */
export const checkVies = (api: ApiClient, partyId: string, body: { companyId?: string } = {}, key: string = newIdempotencyKey()) =>
  api.post(`${party(partyId)}/vies-checks`, { body, schema: viesAnswer, idempotencyKey: key })

export const viesHistory = (api: ApiClient, partyId: string, cursor?: string | null) =>
  api.get(`${party(partyId)}/vies-checks`, { query: { limit: 50, cursor: cursor ?? undefined }, schema: historyAnswer })

// ---- beside the record: quotes, sales orders, purchase orders (money fields only with their grain) -----------------------

const quoteRow = z.object({
  id: z.string(),
  number: z.string(),
  status: z.enum(QUOTE_STATUSES),
  revision: z.number(),
  currency: z.string(),
  netAmount: z.number().optional(),
  validUntil: z.string().nullable(),
  promiseDate: z.string().nullable(),
  updatedAt: z.string(),
})
export type QuoteRow = z.infer<typeof quoteRow>

const salesOrderRow = z.object({
  id: z.string(),
  number: z.string(),
  status: z.enum(SALES_ORDER_STATUSES),
  orderDate: z.string(),
  promiseDate: z.string().nullable(),
  daysLate: z.number().nullable(),
  units: z.number(),
  shippedUnits: z.number(),
  currency: z.string(),
  netAmount: z.number().optional(),
  updatedAt: z.string(),
})
export type SalesOrderRow = z.infer<typeof salesOrderRow>

const purchaseOrderRow = z.object({
  id: z.string(),
  number: z.string(),
  status: z.enum(PURCHASE_ORDER_STATUSES),
  currency: z.string(),
  orderDate: z.string(),
  requestedDate: z.string().nullable(),
  latestConfirmedDate: z.string().nullable(),
  lineCount: z.number(),
  netAmount: z.number().optional(),
  sentAt: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  updatedAt: z.string(),
})
export type PurchaseOrderRow = z.infer<typeof purchaseOrderRow>

/** The party's quotes, newest first (one page of 200: a customer's quotes fit; `more` says when they do not). */
export async function listQuotesOf(api: ApiClient, partyId: string): Promise<{ rows: QuoteRow[]; more: boolean }> {
  const answer = await api.get('/sales/quotes', { query: { partyId, limit: 200 }, schema: z.object({ quotes: z.array(quoteRow), nextCursor: z.string().nullable() }) })
  return { rows: answer.quotes, more: answer.nextCursor !== null }
}

export async function listSalesOrdersOf(api: ApiClient, partyId: string): Promise<{ rows: SalesOrderRow[]; more: boolean }> {
  const answer = await api.get('/sales/orders', { query: { partyId, limit: 200 }, schema: z.object({ orders: z.array(salesOrderRow), nextCursor: z.string().nullable() }) })
  return { rows: answer.orders, more: answer.nextCursor !== null }
}

export async function listPurchaseOrdersOf(api: ApiClient, partyId: string): Promise<{ rows: PurchaseOrderRow[]; more: boolean }> {
  const answer = await api.get('/purchasing/orders', { query: { partyId, limit: 200 }, schema: z.object({ orders: z.array(purchaseOrderRow), nextCursor: z.string().nullable() }) })
  return { rows: answer.orders, more: answer.nextCursor !== null }
}
