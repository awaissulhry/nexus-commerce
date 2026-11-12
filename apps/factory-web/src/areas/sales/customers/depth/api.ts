import { z } from 'zod'
import { LAWFUL_BASES } from '@nexus/factory-domain/parties/contact-privacy/privacy'
import { HOLD_REASONS } from '@nexus/factory-domain/parties/holds/holds'
import { REQUIREMENT_KINDS, REQUIREMENT_STAGES } from '@nexus/factory-domain/parties/requirements/requirements'
import { GLANCE_PARTS } from '@nexus/factory-domain/sales/customer-360/glance'
import { REPAIR_KINDS, REPAIR_STAGES } from '@nexus/factory-domain/sales/repairs/rules'
import { SAMPLE_KINDS, SAMPLE_STAGES } from '@nexus/factory-domain/sales/samples/rules'
import type { ApiClient } from '../../../../lib/api/client'
import { listFiles } from '../../../../record-panels/api'

/**
 * Customer 360 and customers in depth (B-W2b-324), the calls: the customer at a glance (`GET /sales/customer-360/:id`, this
 * step's API) and B-W2b-290's customer routes — holds, requirements, terms per company (the PO number), the contacts' lawful
 * basis, objection, access copy and erasure. Answers are checked (zod; unknown fields dropped). The API's English
 * (`reasonWords`, `shownOn`, `basisWords`, `why`) is never drawn: the screen says each code in its own words. Every write
 * names the version it read and carries one Idempotency-Key per attempt.
 */

const enc = encodeURIComponent
const party = (partyId: string) => `/parties/${enc(partyId)}`
const signalOf = (signal?: AbortSignal) => (signal ? { signal } : {})
const write = (idempotencyKey: string) => ({ idempotencyKey })

export type HoldReason = (typeof HOLD_REASONS)[number]
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number]
export type RequirementStage = (typeof REQUIREMENT_STAGES)[number]
export type LawfulBasis = (typeof LAWFUL_BASES)[number]
export type SampleStage = (typeof SAMPLE_STAGES)[number]
export type SampleKind = (typeof SAMPLE_KINDS)[number]
export type RepairStage = (typeof REPAIR_STAGES)[number]
export type RepairKind = (typeof REPAIR_KINDS)[number]

// ---- the customer at a glance ---------------------------------------------------------------------------------------------

const part = <Row extends z.ZodType>(row: Row) => z.object({ count: z.number(), rows: z.array(row) }).nullable()
const amount = z.number().nullable().optional()

const glanceSchema = z.object({
  party: z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.enum(['ORGANISATION', 'PERSON']), status: z.string() }),
  company: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  hold: z.object({
    onHold: z.boolean(),
    holds: z.array(z.object({ id: z.string(), reason: z.enum(HOLD_REASONS), words: z.string(), everyCompany: z.boolean(), placedAt: z.string(), placedBy: z.string().nullable() })),
  }),
  team: z.object({ id: z.string(), code: z.string(), name: z.string(), status: z.string() }).nullable(),
  requirements: z.object({
    count: z.number(),
    rows: z.array(z.object({ id: z.string(), kind: z.enum(REQUIREMENT_KINDS), words: z.string(), appliesAt: z.array(z.enum(REQUIREMENT_STAGES)), everyStyle: z.boolean(), everyCompany: z.boolean() })),
  }),
  promises: z.object({ open: z.number(), late: z.number(), noPromise: z.number(), next: z.string().nullable() }).nullable(),
  credit: z
    .object({
      state: z.enum(['NONE', 'WITHIN', 'OVER']),
      currency: z.string().nullable(),
      // Price grain: absent without money.price.
      limit: amount,
      used: amount,
      available: amount,
      overLimitBy: amount,
      overdue: amount,
      usedPct: z.number().nullable().optional(),
      onHold: z.boolean(),
    })
    .nullable(),
  samples: part(
    z.object({
      id: z.string(),
      number: z.string(),
      kind: z.enum(SAMPLE_KINDS),
      roundNo: z.number(),
      stage: z.enum(SAMPLE_STAGES),
      style: z.object({ id: z.string(), code: z.string(), name: z.string() }),
      dueDate: z.string().nullable(),
      daysLate: z.number().nullable(),
    }),
  ),
  profiles: part(z.object({ id: z.string(), riderName: z.string(), garmentType: z.string(), revision: z.number(), baseSize: z.string().nullable(), takenAt: z.string() })),
  riders: part(z.object({ id: z.string(), code: z.string(), name: z.string(), status: z.string(), profiles: z.number() })),
  repairs: part(z.object({ id: z.string(), number: z.string(), kind: z.enum(REPAIR_KINDS), stage: z.enum(REPAIR_STAGES), createdAt: z.string() })),
  withheld: z.array(z.enum(GLANCE_PARTS)),
  readAt: z.string(),
})
export type Glance = z.infer<typeof glanceSchema>

/** GET /sales/customer-360/:partyId?companyId= (parties.view; each part its own permission). */
export function readGlance(api: ApiClient, partyId: string, companyId: string | null, signal?: AbortSignal): Promise<Glance> {
  return api.get(`/sales/customer-360/${enc(partyId)}`, { query: companyId ? { companyId } : {}, schema: glanceSchema, ...signalOf(signal) })
}

// ---- holds (Tax & terms › Hold) -------------------------------------------------------------------------------------------

const holdSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  company: z.object({ code: z.string(), name: z.string() }).nullable(),
  reason: z.enum(HOLD_REASONS),
  words: z.string(),
  inForce: z.boolean(),
  placedAt: z.string(),
  placedBy: z.string().nullable(),
  releasedAt: z.string().nullable(),
  releasedBy: z.string().nullable(),
  releaseWords: z.string().nullable(),
  version: z.number(),
})
export type Hold = z.infer<typeof holdSchema>
const holdsSchema = z.object({
  holds: z.object({
    onHold: z.boolean(),
    holds: z.array(holdSchema),
    ordersWaiting: z.array(z.object({ quoteId: z.string(), number: z.string(), revision: z.number(), quoteVersionId: z.string(), companyId: z.string(), customerRef: z.string().nullable() })),
    mayPlace: z.boolean(),
  }),
})
export type Holds = z.infer<typeof holdsSchema>['holds']

export async function readHolds(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<Holds> {
  return (await api.get(`${party(partyId)}/holds`, { schema: holdsSchema, ...signalOf(signal) })).holds
}
export async function placeHold(api: ApiClient, partyId: string, body: { companyId: string | null; reason: HoldReason; words: string }, key: string): Promise<Holds> {
  return (await api.post(`${party(partyId)}/holds`, { body, schema: holdsSchema, ...write(key) })).holds
}
export async function releaseHold(api: ApiClient, partyId: string, holdId: string, body: { version: number; words: string }, key: string): Promise<Holds> {
  return (await api.post(`${party(partyId)}/holds/${enc(holdId)}/release`, { body, schema: holdsSchema, ...write(key) })).holds
}

// ---- requirements (the Requirements tab) ----------------------------------------------------------------------------------

const requirementSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  companyCode: z.string().nullable(),
  kind: z.enum(REQUIREMENT_KINDS),
  words: z.string(),
  appliesAt: z.array(z.enum(REQUIREMENT_STAGES)),
  styles: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })),
  everyStyle: z.boolean(),
  file: z.object({ id: z.string(), fileName: z.string() }).nullable(),
  supersedesId: z.string().nullable(),
  active: z.boolean(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  endedAt: z.string().nullable(),
  endedBy: z.string().nullable(),
  endReason: z.string().nullable(),
  version: z.number(),
})
export type Requirement = z.infer<typeof requirementSchema>
const requirementsView = z.object({ inForce: z.array(requirementSchema), ended: z.array(requirementSchema) })
export type Requirements = z.infer<typeof requirementsView>

export interface RequirementBody {
  readonly companyId: string | null
  readonly kind: RequirementKind
  readonly words: string
  readonly appliesAt: readonly RequirementStage[]
  readonly styleIds: readonly string[]
  readonly fileId: string | null
}

export async function readRequirements(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<Requirements> {
  return (await api.get(`${party(partyId)}/requirements`, { schema: z.object({ requirements: requirementsView }), ...signalOf(signal) })).requirements
}
export async function addRequirement(api: ApiClient, partyId: string, body: RequirementBody, key: string): Promise<Requirements> {
  return (await api.post(`${party(partyId)}/requirements`, { body, schema: z.object({ requirements: requirementsView }), ...write(key) })).requirements
}
export async function replaceRequirement(api: ApiClient, partyId: string, requirementId: string, body: RequirementBody & { version: number; reason: string | null }, key: string): Promise<Requirements> {
  return (await api.post(`${party(partyId)}/requirements/${enc(requirementId)}/replace`, { body, schema: z.object({ requirements: requirementsView }), ...write(key) })).requirements
}
export async function endRequirement(api: ApiClient, partyId: string, requirementId: string, body: { version: number; reason: string }, key: string): Promise<Requirements> {
  return (await api.post(`${party(partyId)}/requirements/${enc(requirementId)}/end`, { body, schema: z.object({ requirements: requirementsView }), ...write(key) })).requirements
}

/** The styles a requirement may name (Products › Styles; products.styles.view). */
const styleSchema = z.object({ id: z.string(), code: z.string(), name: z.string() })
export type StyleOption = z.infer<typeof styleSchema>
export async function searchStyles(api: ApiClient, q: string, signal?: AbortSignal): Promise<StyleOption[]> {
  return (await api.get('/product/styles', { query: { q: q.trim() || undefined, status: 'OPEN', limit: 50 }, schema: z.object({ styles: z.array(styleSchema) }), ...signalOf(signal) })).styles
}

/** The record's files (a routing guide is one of the customer's files: B-W2b-290), through the record panels' call. */
export type PartyFile = { readonly id: string; readonly name: string }
export async function readPartyFiles(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<PartyFile[]> {
  return (await listFiles(api, { type: 'Party', id: partyId }, signal)).files.map((file) => ({ id: file.id, name: file.originalName }))
}

// ---- terms per company: Customer PO number required ----------------------------------------------------------------------

const termsRow = z.object({ id: z.string(), companyId: z.string(), poNumberRequired: z.boolean(), setBy: z.string().nullable(), setAt: z.string(), version: z.number() })
const companyTermsSchema = z.object({
  terms: z.object({
    tenantWide: z.boolean(),
    companies: z.array(
      z.object({
        company: z.object({ id: z.string(), code: z.string(), name: z.string() }),
        terms: termsRow.nullable(),
        inForce: z.object({ poNumberRequired: z.boolean() }),
        mayChange: z.boolean(),
      }),
    ),
  }),
})
export type CompanyTerms = z.infer<typeof companyTermsSchema>['terms']

export async function readCompanyTerms(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<CompanyTerms> {
  return (await api.get(`${party(partyId)}/company-terms`, { schema: companyTermsSchema, ...signalOf(signal) })).terms
}
/** PUT …/company-terms/:companyId {version?, poNumberRequired}: makes the company's row (no version) or changes it. */
export async function setPoNumberRequired(api: ApiClient, partyId: string, companyId: string, body: { version?: number; poNumberRequired: boolean }, key: string): Promise<CompanyTerms> {
  return (await api.request('PUT', `${party(partyId)}/company-terms/${enc(companyId)}`, { body, schema: companyTermsSchema, ...write(key) })).terms
}

// ---- contacts: lawful basis, consent, objection, access copy, erasure -----------------------------------------------------

const privacyContact = z.object({
  id: z.string(),
  name: z.string(),
  erased: z.boolean(),
  status: z.string(),
  lawfulBasis: z.enum(LAWFUL_BASES).nullable(),
  consentAt: z.string().nullable(),
  consentSource: z.string().nullable(),
  objectedAt: z.string().nullable(),
  erasedAt: z.string().nullable(),
  erasedBy: z.string().nullable(),
  version: z.number(),
})
export type PrivacyContact = z.infer<typeof privacyContact>
const privacySchema = z.object({ privacy: z.object({ contacts: z.array(privacyContact), notRecorded: z.number() }) })
export type Privacy = z.infer<typeof privacySchema>['privacy']

export async function readPrivacy(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<Privacy> {
  return (await api.get(`${party(partyId)}/contacts/privacy`, { schema: privacySchema, ...signalOf(signal) })).privacy
}
export async function setLawfulBasis(api: ApiClient, partyId: string, contactId: string, body: { version: number; lawfulBasis: LawfulBasis; consentAt: string | null; consentSource: string | null }, key: string): Promise<Privacy> {
  return (await api.request('PUT', `${party(partyId)}/contacts/${enc(contactId)}/lawful-basis`, { body, schema: privacySchema, ...write(key) })).privacy
}
export async function recordObjection(api: ApiClient, partyId: string, contactId: string, body: { version: number; words: string }, key: string): Promise<Privacy> {
  return (await api.post(`${party(partyId)}/contacts/${enc(contactId)}/objection`, { body, schema: privacySchema, ...write(key) })).privacy
}

const record = z.object({ id: z.string(), number: z.string(), status: z.string(), at: z.string() })
const copySchema = z.object({
  madeAt: z.string(),
  copy: z.object({
    person: z.object({ name: z.string(), email: z.string().nullable(), phone: z.string().nullable(), roles: z.array(z.string()), language: z.string().nullable(), status: z.string() }),
    processing: z.object({ organisation: z.object({ code: z.string(), legalName: z.string() }), lawfulBasis: z.enum(LAWFUL_BASES).nullable(), consentAt: z.string().nullable(), consentSource: z.string().nullable(), objectedAt: z.string().nullable() }),
    records: z.object({ quotes: z.array(record), inquiries: z.array(record), returns: z.array(record), complaints: z.array(record) }),
    mailsReceived: z.array(z.object({ id: z.string() })),
    mailsSent: z.array(z.object({ id: z.string() })),
    messages: z.array(z.object({ id: z.string() })),
    links: z.array(z.object({ id: z.string() })),
    measurementProfiles: z.array(z.object({ id: z.string() })),
    portalUsers: z.array(z.object({ id: z.string() })),
    changes: z.array(z.object({ at: z.string() })),
    truncated: z.boolean(),
  }),
})
export type AccessCopy = z.infer<typeof copySchema>

/**
 * POST …/access-copy {words}: what we hold about the person (GDPR art. 15), made for the reason given. The screen shows
 * how much of each kind it holds and the person's own details; the whole copy is the answer the office passes on (Download).
 */
export function accessCopy(api: ApiClient, partyId: string, contactId: string, body: { words: string }, key: string): Promise<AccessCopy & { raw: unknown }> {
  return api.post(`${party(partyId)}/contacts/${enc(contactId)}/access-copy`, { body, ...write(key) }).then((raw) => ({ ...copySchema.parse(raw), raw }))
}

const eraseSchema = z.object({ privacy: privacySchema.shape.privacy, kept: z.array(z.object({ kind: z.string(), count: z.number() })) })
export type Erased = z.infer<typeof eraseSchema>

/** POST …/erase {version, words} (parties.erase; a fresh code: a 403 `stepUp` asks for it). */
export function eraseContact(api: ApiClient, partyId: string, contactId: string, body: { version: number; words: string }, key: string): Promise<Erased> {
  return api.post(`${party(partyId)}/contacts/${enc(contactId)}/erase`, { body, schema: eraseSchema, ...write(key) })
}
