import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * The security events (B-W2b-399; PLT-075; design admin.security "Security events": time, the event in words, who or
 * "unknown", the address's country, the result; row → one event; saved filters "Failed sign-ins", "Exports"), for
 * administrators and the Owner only (security.events.view over every company). Codes only: the screens say kind, surface,
 * result and the details' codes in words. A floor worker is never named here (Owner answer W1): `actor.kind` WORKER with the
 * worker's id, the site beside it. Rows, never a count per person.
 *
 *   GET /audit/security-events                   newest first; filters kind (one or a comma list), view, surface, actorId, ip
 *                                                (the address typed, matched by its keyed hash), recordType + recordId, from, to
 *   GET /audit/security-events/:eventId          one event
 */

export const SECURITY_EVENT_KINDS = ['SIGN_IN', 'SIGN_IN_FAILED', 'LOCKOUT', 'MFA_CHANGED', 'PERMISSION_DENIED', 'ROLE_CHANGED', 'API_KEY_USED', 'EXPORT', 'STEP_UP_LOCKED'] as const
export const SECURITY_SURFACES = ['OFFICE', 'PORTAL', 'FLOOR', 'LINK', 'API', 'SYSTEM'] as const
/** The design's saved filters. */
export const SECURITY_EVENT_VIEWS = ['failed-sign-ins', 'exports'] as const
/** What came of it, for the "result" column. */
export const SECURITY_RESULTS = ['SUCCEEDED', 'REFUSED', 'LOCKED', 'DONE'] as const
/** Who: an office or portal person, a floor worker (never by name), a link, the system, or nobody known. */
export const SECURITY_ACTOR_KINDS = ['PERSON', 'WORKER', 'LINK', 'SYSTEM', 'NOBODY'] as const

export type SecurityEventKindCode = (typeof SECURITY_EVENT_KINDS)[number]

export const securityEventView = output({
  id: id(),
  at: instant(),
  kind: z.enum(SECURITY_EVENT_KINDS),
  surface: z.enum(SECURITY_SURFACES),
  result: z.enum(SECURITY_RESULTS),
  actor: output({ kind: z.enum(SECURITY_ACTOR_KINDS), id: id().nullable(), name: z.string().nullable() }),
  /** The address's country (ISO 3166-1 alpha-2) when known; never the address. */
  ipCountry: z.string().nullable(),
  siteId: id().nullable(),
  partyId: id().nullable(),
  record: output({ type: z.string(), id: id() }).nullable(),
  /** Codes: `{ reason: 'WRONG_PASSWORD' }`, `{ permission: 'costing.view', route: 'GET /…' }`. */
  details: z.record(z.string(), z.unknown()),
})
export type SecurityEventView = z.infer<typeof securityEventView>

const kindList = z
  .string()
  .max(200)
  .transform((value, context) => {
    const kinds = [...new Set(value.split(',').map((kind) => kind.trim()).filter((kind) => kind !== ''))]
    const unknown = kinds.filter((kind) => !(SECURITY_EVENT_KINDS as readonly string[]).includes(kind))
    if (unknown.length > 0) context.addIssue({ code: 'custom', message: `Expected ${SECURITY_EVENT_KINDS.join(', ')}.` })
    return kinds as SecurityEventKindCode[]
  })

export const securityEventsQuery = {
  kind: kindList.optional(),
  view: z.enum(SECURITY_EVENT_VIEWS).optional(),
  surface: z.enum(SECURITY_SURFACES).optional(),
  actorId: id().optional(),
  /** An IPv4 or IPv6 address, matched by its keyed hash. */
  ip: z.string().trim().min(2).max(45).optional(),
  recordType: z.string().regex(/^[A-Z][A-Za-z0-9]{0,63}$/).optional(),
  recordId: id().optional(),
  from: instant().optional(),
  to: instant().optional(),
}

export const listSecurityEventsContract = defineContract({
  querystring: input({ ...securityEventsQuery, before: id().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: { 200: output({ events: z.array(securityEventView), nextBefore: id().nullable() }) },
})

export const oneSecurityEventContract = defineContract({
  params: input({ eventId: id() }),
  response: { 200: output({ event: securityEventView }) },
})
