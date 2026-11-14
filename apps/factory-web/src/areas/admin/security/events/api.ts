import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * The security events (B-W2b-413 on B-W2b-399's API; PLT-075), administrators and the Owner only (security.events.view over
 * every company): `GET /audit/security-events` and one event with the others from the same address around it
 * (`GET /audit/security-events/:id`). Mirrors apps/factory-api platform/audit/security-events/contract.ts. Codes only: the
 * screen says kind, surface, result and the details in words; a floor worker is never named (Owner answer W1).
 */

export const SECURITY_EVENT_KINDS = ['SIGN_IN', 'SIGN_IN_FAILED', 'LOCKOUT', 'MFA_CHANGED', 'PERMISSION_DENIED', 'ROLE_CHANGED', 'API_KEY_USED', 'EXPORT', 'STEP_UP_LOCKED'] as const
export const SECURITY_SURFACES = ['OFFICE', 'PORTAL', 'FLOOR', 'LINK', 'API', 'SYSTEM'] as const
export const SECURITY_EVENT_VIEWS = ['failed-sign-ins', 'exports'] as const
export const SECURITY_RESULTS = ['SUCCEEDED', 'REFUSED', 'LOCKED', 'DONE'] as const
export const SECURITY_ACTOR_KINDS = ['PERSON', 'WORKER', 'LINK', 'SYSTEM', 'NOBODY'] as const

export const securityEventSchema = z.object({
  id: z.string(),
  at: z.string(),
  kind: z.enum(SECURITY_EVENT_KINDS),
  surface: z.enum(SECURITY_SURFACES),
  result: z.enum(SECURITY_RESULTS),
  actor: z.object({ kind: z.enum(SECURITY_ACTOR_KINDS), id: z.string().nullable(), name: z.string().nullable() }),
  ipCountry: z.string().nullable(),
  siteId: z.string().nullable(),
  partyId: z.string().nullable(),
  record: z.object({ type: z.string(), id: z.string() }).nullable(),
  details: z.record(z.string(), z.unknown()),
})
export type SecurityEvent = z.infer<typeof securityEventSchema>
export type SecurityEventView = (typeof SECURITY_EVENT_VIEWS)[number]
export type SecuritySurface = (typeof SECURITY_SURFACES)[number]

const listAnswer = z.object({ events: z.array(securityEventSchema), nextBefore: z.string().nullable() })
const oneAnswer = z.object({ event: securityEventSchema, related: z.array(securityEventSchema) })

export interface SecurityEventsQuery {
  view?: SecurityEventView | null
  surface?: SecuritySurface | null
  ip?: string | null
  before?: string | null
  limit?: number
}

export const listSecurityEvents = (api: ApiClient, query: SecurityEventsQuery) =>
  api.get('/audit/security-events', {
    query: { view: query.view ?? undefined, surface: query.surface ?? undefined, ip: query.ip ?? undefined, before: query.before ?? undefined, limit: query.limit },
    schema: listAnswer,
  })

export const oneSecurityEvent = (api: ApiClient, eventId: string) => api.get(`/audit/security-events/${encodeURIComponent(eventId)}`, { schema: oneAnswer })
