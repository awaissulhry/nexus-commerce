import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * Every call of the customer's Account page (B-W2b-196, SCR-188), each answer checked against what the API's contracts say:
 * colleagues and roles (B-W2b-162, apps/factory-api platform/auth/partners/colleagues.ts), their open requests and the
 * hand-over (B-W2b-167 / F14, platform/portal/tasks), the step-up by e-mail code (B-W2b-159), delivery addresses with our
 * check (B-W2b-190, F13b, F15: modules/sales/portal-ordering/addresses.ts), and the page's own (B-W2b-196:
 * platform/auth/portal/self.ts — the person's name and language, their sessions, the company data). E-mail settings are
 * the frame's calls (portal/shell/api.ts). The web reads only what it uses; the API's English never reaches the screen.
 */

const words = z.object({ it: z.string(), en: z.string() })
const STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const
export type ColleagueStatus = (typeof STATUSES)[number]
export const CAPABILITIES = ['comment', 'upload', 'approve'] as const
export type Capability = (typeof CAPABILITIES)[number]

// ── colleagues (B-W2b-162) ───────────────────────────────────────────────────────────────────────────────────────────────
const colleague = z.object({
  id: z.string(),
  displayName: z.string(),
  /** Only for the organisation's admins. */
  email: z.string().nullable(),
  status: z.enum(STATUSES),
  roleKey: z.string().nullable(),
  roleName: z.string().nullable(),
  seesPrices: z.boolean(),
  admin: z.boolean(),
  capabilities: z.array(z.enum(CAPABILITIES)),
  lastSignInAt: z.string().nullable(),
  invitationExpiresAt: z.string().nullable(),
  version: z.number(),
})
export type Colleague = z.infer<typeof colleague>

const role = z.object({
  key: z.string(),
  kind: z.string(),
  name: z.string(),
  description: z.string(),
  seesPrices: z.boolean(),
  admin: z.boolean(),
  capabilities: z.object({ allowed: z.array(z.enum(CAPABILITIES)), byDefault: z.array(z.enum(CAPABILITIES)) }),
  offered: z.boolean(),
})
export type OfferedRole = z.infer<typeof role>

export const colleaguesSchema = z.object({
  me: z.string(),
  canManage: z.boolean(),
  admins: z.array(z.object({ id: z.string(), displayName: z.string(), email: z.string() })),
  people: z.array(colleague),
  roles: z.array(role),
  seats: z.object({ taken: z.number(), max: z.number().nullable() }).nullable(),
})
export type Colleagues = z.infer<typeof colleaguesSchema>

export const fetchColleagues = (api: ApiClient, signal?: AbortSignal) => api.get('/portal/colleagues', { schema: colleaguesSchema, signal })

export interface InviteBody {
  email: string
  displayName: string
  locale: 'it' | 'en'
  roleKey: string
  capabilities?: Capability[]
}
const invited = z.object({ invitation: z.object({ id: z.string(), userId: z.string(), email: z.string(), expiresAt: z.string() }), delivery: z.enum(['sent', 'already_sent']) })
/** One key per dialog: a retry of the same invite is the same invitation (no second mail). */
export const inviteColleague = (api: ApiClient, body: InviteBody, idempotencyKey: string) => api.post('/portal/colleagues', { body, schema: invited, idempotencyKey })
export const changeColleague = (api: ApiClient, userId: string, body: { roleKey?: string; capabilities?: Capability[]; version: number }) =>
  api.request('PATCH', `/portal/colleagues/${encodeURIComponent(userId)}`, { body, schema: z.object({ id: z.string() }), idempotencyKey: newIdempotencyKey() })
export const deactivateColleague = (api: ApiClient, userId: string, version: number) =>
  api.post(`/portal/colleagues/${encodeURIComponent(userId)}/deactivate`, { body: { version }, schema: z.object({ id: z.string(), status: z.string(), sessionsEnded: z.number() }), idempotencyKey: newIdempotencyKey() })

// ── a colleague's open requests (B-W2b-167, F14) ─────────────────────────────────────────────────────────────────────────
export const handoverSchema = z.object({
  open: z.number(),
  kept: z.number(),
  assigned: z.number(),
  alone: z.array(z.object({ id: z.string(), kind: z.string(), words, record: z.object({ type: z.string(), id: z.string(), label: z.string() }), dueAt: z.string().nullable() })),
  colleagues: z.array(z.object({ id: z.string(), displayName: z.string(), count: z.number() })),
})
export type Handover = z.infer<typeof handoverSchema>
export const fetchHandover = (api: ApiClient, userId: string, signal?: AbortSignal) => api.get(`/portal/tasks/handover/${encodeURIComponent(userId)}`, { schema: handoverSchema, signal })

const handedTask = z.object({ id: z.string(), version: z.number(), assignee: z.object({ id: z.string(), displayName: z.string() }).nullable().optional() })
const openTasks = z.object({ items: z.array(handedTask) })
/** The open requests the person sees, with whom each is handed to (F14). */
export const fetchOpenTasks = (api: ApiClient, signal?: AbortSignal) => api.get('/portal/tasks', { query: { state: 'OPEN' }, schema: openTasks, signal })
export const assignTask = (api: ApiClient, task: { id: string; version: number }, assigneeId: string | null) =>
  api.post(`/portal/tasks/${encodeURIComponent(task.id)}/assign`, { body: { version: task.version, assigneeId }, idempotencyKey: newIdempotencyKey() })

// ── step-up by e-mail code (B-W2b-159) ───────────────────────────────────────────────────────────────────────────────────
export const startStepUp = (api: ApiClient) => api.post('/portal/step-up/start', { body: {}, schema: z.object({ status: z.literal('sent'), to: z.string(), expiresInSeconds: z.number(), resendAfterSeconds: z.number() }) })
export const proveStepUp = (api: ApiClient, code: string) => api.post('/portal/step-up', { body: { code }, schema: z.object({ stepUpUntil: z.string() }) })

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

const session = z.object({ id: z.string(), current: z.boolean(), createdAt: z.string(), lastSeenAt: z.string(), idleExpiresAt: z.string(), absoluteExpiresAt: z.string(), userAgent: z.string().nullable() })
export type PortalSessionRow = z.infer<typeof session>
export const sessionsSchema = z.object({ sessions: z.array(session) })
export const fetchSessions = (api: ApiClient, signal?: AbortSignal) => api.get('/portal/sessions', { schema: sessionsSchema, signal })
export const endOtherSessions = (api: ApiClient) => api.post('/portal/sessions/end-others', { body: {}, schema: z.object({ ended: z.number() }), idempotencyKey: newIdempotencyKey() })

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
