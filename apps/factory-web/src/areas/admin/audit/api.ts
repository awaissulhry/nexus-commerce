import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'

/**
 * The Audit log's call (B-W0-28, SCR-018): `GET /audit` (apps/factory-api platform/audit, audit.read), checked against
 * its shape. Mirrors the API's `auditListContract` (named per field); the web never imports the API's source.
 */

export const AUDIT_SURFACES = ['OFFICE', 'FLOOR', 'PARTNER', 'LINK', 'SYSTEM'] as const
export type AuditSurface = (typeof AUDIT_SURFACES)[number]
/** The saved views the API answers (platform/audit read.ts AUDIT_VIEW_ACTIONS). */
export const AUDIT_VIEWS = ['roles', 'access', 'deletes', 'settings'] as const
export type AuditViewName = (typeof AUDIT_VIEWS)[number]

export const auditEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  audience: z.enum(AUDIT_SURFACES),
  actorId: z.string(),
  deviceId: z.string().nullable(),
  deviceTime: z.string().nullable(),
  companyId: z.string().nullable(),
  siteId: z.string().nullable(),
  partyId: z.string().nullable(),
  action: z.string(),
  recordType: z.string(),
  recordId: z.string(),
  /** What the command recorded; money the reader may not see is left out by the API (grainedJson). */
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  reason: z.string().nullable(),
  requestId: z.string(),
  idempotencyKey: z.string().nullable(),
  actorName: z.string().nullable(),
  deviceName: z.string().nullable(),
})
export type AuditEntry = z.infer<typeof auditEntrySchema>

const countsSchema = z.object({ roles: z.number(), access: z.number(), deletes: z.number(), settings: z.number() })
export type AuditCounts = z.infer<typeof countsSchema>

const listSchema = z.object({ entries: z.array(auditEntrySchema), nextBefore: z.string().nullable(), counts: countsSchema.nullable() })
export type AuditPage = z.infer<typeof listSchema>

export interface AuditQuery {
  actorId?: string | null
  audience?: AuditSurface | null
  recordType?: string | null
  recordId?: string | null
  action?: string | null
  companyId?: string | null
  siteId?: string | null
  requestId?: string | null
  view?: AuditViewName | null
  from?: string | null
  to?: string | null
  before?: string | null
  limit?: number
  withCounts?: boolean
}

/** One page of the log, newest first (`nextBefore` asks for the next one). Empty filters are not sent. */
export function listAudit(api: ApiClient, query: AuditQuery = {}): Promise<AuditPage> {
  return api.get('/audit', {
    query: {
      actorId: query.actorId ?? undefined,
      audience: query.audience ?? undefined,
      recordType: query.recordType ?? undefined,
      recordId: query.recordId ?? undefined,
      action: query.action ?? undefined,
      companyId: query.companyId ?? undefined,
      siteId: query.siteId ?? undefined,
      requestId: query.requestId ?? undefined,
      view: query.view ?? undefined,
      from: query.from ?? undefined,
      to: query.to ?? undefined,
      before: query.before ?? undefined,
      limit: query.limit,
      withCounts: query.withCounts ? 'true' : undefined,
    },
    schema: listSchema,
  })
}
