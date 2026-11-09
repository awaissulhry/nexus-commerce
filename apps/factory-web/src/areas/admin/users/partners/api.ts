import { z } from 'zod'
import { CAPABILITIES, PARTNER_KINDS } from '@nexus/factory-domain/auth/partners/kinds'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * The partner organisations' calls (B-W2b-180 on B-W2b-162's API, platform/auth/partners; B-W2b-167's office requests,
 * platform/portal/tasks): one place for the customer's and the supplier's Portal access tab, Admin › Users "Partners" and
 * the user record's Partner organisation. Each answer is checked against its shape; no money anywhere (a role says only
 * whether it sees prices). Only containers call these.
 */

export const PARTNER_STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const
export type PartnerStatus = (typeof PARTNER_STATUSES)[number]
export type PartnerKind = (typeof PARTNER_KINDS)[number]
export type Capability = (typeof CAPABILITIES)[number]

const capability = z.enum(CAPABILITIES)
const kind = z.enum(PARTNER_KINDS)

const partnerRole = z.object({
  key: z.string(),
  kind,
  name: z.string(),
  description: z.string(),
  seesPrices: z.boolean(),
  admin: z.boolean(),
  capabilities: z.object({ allowed: z.array(capability), byDefault: z.array(capability) }),
  offered: z.boolean(),
})
export type PartnerRole = z.infer<typeof partnerRole>

const partnerPerson = z.object({
  id: z.string(),
  displayName: z.string(),
  email: z.string(),
  kind: kind.nullable(),
  status: z.enum(PARTNER_STATUSES),
  roleKey: z.string().nullable(),
  roleName: z.string().nullable(),
  seesPrices: z.boolean(),
  admin: z.boolean(),
  capabilities: z.array(capability),
  accessUntil: z.string().nullable(),
  accessEndsSoon: z.boolean(),
  lastSignInAt: z.string().nullable(),
  invitation: z.object({ id: z.string(), expiresAt: z.string() }).nullable(),
  version: z.number(),
})
export type PartnerPerson = z.infer<typeof partnerPerson>

const settings = z.object({ portalOn: z.boolean(), progressShared: z.boolean(), maxUsers: z.number().nullable(), allowedRoleKeys: z.array(z.string()), version: z.number() })
export type PortalSettings = z.infer<typeof settings>
const seats = z.object({ taken: z.number(), max: z.number().nullable() })
export type Seats = z.infer<typeof seats>

const partnerParty = z.object({ id: z.string(), code: z.string(), name: z.string(), roles: z.array(z.string()), status: z.string(), companyId: z.string().nullable() })
export type PartnerParty = z.infer<typeof partnerParty>

export const portalAccessSchema = z.object({
  party: partnerParty,
  kinds: z.array(kind),
  settings,
  seats,
  roles: z.array(partnerRole),
  people: z.array(partnerPerson),
  termsInForce: z.boolean().nullable(),
})
export type PortalAccess = z.infer<typeof portalAccessSchema>

const organisation = z.object({
  party: partnerParty,
  kinds: z.array(kind),
  portalOn: z.boolean(),
  progressShared: z.boolean(),
  maxUsers: z.number().nullable(),
  people: z.object({ active: z.number(), invited: z.number(), suspended: z.number() }),
  accessEndingSoon: z.number(),
})
export type Organisation = z.infer<typeof organisation>
export const organisationsSchema = z.object({
  organisations: z.array(organisation),
  counts: z.object({ organisations: z.number(), people: z.number(), accessEndingSoon: z.number() }),
})
export type Organisations = z.infer<typeof organisationsSchema>

const enc = encodeURIComponent
const party = (partyId: string) => `/partners/${enc(partyId)}`
const person = (partyId: string, userId: string) => `${party(partyId)}/people/${enc(userId)}`

/** GET /partners — the partner organisations, with the counts of Admin › Users ("Partners (n)", "Access ends soon"). */
export const listOrganisations = (api: ApiClient) => api.get('/partners', { schema: organisationsSchema })

/** GET /partners/:partyId — a party's Portal access: its switch and limits, the roles of its portals, its people. */
export const getPortalAccess = (api: ApiClient, partyId: string) => api.get(party(partyId), { schema: portalAccessSchema })

export interface SettingsBody {
  portalOn?: boolean
  progressShared?: boolean
  maxUsers?: number | null
  allowedRoleKeys?: string[]
  /** The version read (0: no settings row yet). */
  version: number
}
export const changeSettings = (api: ApiClient, partyId: string, body: SettingsBody, idempotencyKey: string) =>
  api.post(`${party(partyId)}/settings`, { body, idempotencyKey, schema: z.object({ settings, seats }) })

export interface InviteBody {
  email: string
  displayName: string
  locale?: 'it' | 'en'
  kind?: PartnerKind
  roleKey: string
  capabilities?: Capability[]
  accessUntil?: string | null
}
const invited = z.object({
  invitation: z.object({ id: z.string(), userId: z.string(), email: z.string(), expiresAt: z.string(), roleKeys: z.array(z.string()), accessUntil: z.string().nullable() }),
  delivery: z.enum(['sent', 'already_sent']),
})
export type Invited = z.infer<typeof invited>
export const invitePartner = (api: ApiClient, partyId: string, body: InviteBody, idempotencyKey: string) => api.post(`${party(partyId)}/people`, { body, idempotencyKey, schema: invited })
export const resendInvitation = (api: ApiClient, partyId: string, userId: string) => api.post(`${person(partyId, userId)}/invitation`, { body: {}, schema: invited })
const changed = z.object({ id: z.string(), status: z.enum(PARTNER_STATUSES), version: z.number() })
export const revokeInvitation = (api: ApiClient, partyId: string, userId: string, version: number) => api.post(`${person(partyId, userId)}/invitation/revoke`, { body: { version }, schema: changed })

export interface ChangeBody {
  roleKey?: string
  capabilities?: Capability[]
  accessUntil?: string | null
  version: number
}
export const changePartnerPerson = (api: ApiClient, partyId: string, userId: string, body: ChangeBody, idempotencyKey: string) =>
  api.request('PATCH', person(partyId, userId), { body, idempotencyKey, schema: z.object({ id: z.string(), roleKeys: z.array(z.string()), accessUntil: z.string().nullable() }) })

export const PERSON_ACTIONS = ['suspend', 'reactivate', 'deactivate'] as const
export type PersonAction = (typeof PERSON_ACTIONS)[number]
export const changePartnerStatus = (api: ApiClient, partyId: string, userId: string, action: PersonAction, body: { version: number; reason?: string }) =>
  api.post(`${person(partyId, userId)}/${action}`, { body, schema: changed.extend({ sessionsEnded: z.number() }) })

/** POST /partners/:partyId/preview — the party's portal, read-only, in this browser (the portal cookie; at most an hour). */
export const startPreview = (api: ApiClient, partyId: string) =>
  api.post(`${party(partyId)}/preview`, {
    body: {},
    schema: z.object({ csrfToken: z.string(), party: z.object({ id: z.string(), name: z.string() }), company: z.object({ id: z.string(), code: z.string(), name: z.string() }), expiresAt: z.string() }),
  })

// ---- the party's requests (B-W2b-167, office side) ----------------------------------------------------------------------

const words = z.object({ it: z.string(), en: z.string() })
const request = z.object({
  id: z.string(),
  kind: z.string(),
  verb: words,
  words,
  record: z.object({ type: z.string(), id: z.string(), label: z.string() }),
  companyId: z.string(),
  dueAt: z.string().nullable(),
  due: z.enum(['OVERDUE', 'TODAY', 'SOON', 'LATER', 'NONE']),
  askedBy: z.string().nullable(),
  status: z.enum(['OPEN', 'DONE', 'CANCELLED']),
  closedAt: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
})
export type PartnerRequest = z.infer<typeof request>

/** GET /partners/:partyId/tasks — what we asked of the party and still waits (status OPEN). */
export const listRequests = (api: ApiClient, partyId: string) =>
  api.get(`${party(partyId)}/tasks`, { query: { status: 'OPEN' }, schema: z.object({ asOf: z.string(), items: z.array(request), complete: z.boolean() }) })

/** The kinds the office asks by hand (factory-domain portal/tasks ASKABLE_KINDS). */
export const ASKABLE = ['UPLOAD_DOCUMENT', 'ANSWER_MESSAGE', 'SEND_MEASUREMENTS', 'REPORT_PROGRESS'] as const
export type Askable = (typeof ASKABLE)[number]
export const askPartner = (api: ApiClient, partyId: string, body: { kind: Askable; recordType: string; recordId: string; dueAt: string | null; companyId?: string }, idempotencyKey: string) =>
  api.post(`${party(partyId)}/tasks`, { body, idempotencyKey, schema: z.object({ task: request, made: z.boolean() }) })
export const cancelRequest = (api: ApiClient, taskId: string, version: number, idempotencyKey: string) =>
  api.post(`/partner-tasks/${enc(taskId)}/cancel`, { body: { version }, idempotencyKey, schema: z.object({ task: request }) })
