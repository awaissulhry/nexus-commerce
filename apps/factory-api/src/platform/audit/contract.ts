import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { grainedJson } from '@nexus/factory-domain/money/marked'

/**
 * `GET /audit/:recordType/:recordId`: the audit history of one record, newest first (features PLT-072, PLT-077 in
 * part). `before` and `after` are what the command recorded, shaped for the caller's money grains: a value the
 * command marked with `markMoney` is shown only with its grain (factory-domain money; the app's grain filter).
 */

export const AUDIT_AUDIENCES = ['OFFICE', 'FLOOR', 'PARTNER', 'LINK', 'SYSTEM'] as const

/** A model name, as command() records it. */
export const RECORD_TYPE = /^[A-Z][A-Za-z0-9]{0,63}$/

export const auditEntry = output({
  id: id(),
  at: instant(),
  audience: z.enum(AUDIT_AUDIENCES),
  actorId: id(),
  deviceId: id().nullable(),
  deviceTime: instant().nullable(),
  companyId: id().nullable(),
  siteId: id().nullable(),
  partyId: id().nullable(),
  action: z.string(),
  recordType: z.string(),
  recordId: id(),
  before: grainedJson(),
  after: grainedJson(),
  reason: z.string().nullable(),
  requestId: z.string(),
})
export type AuditEntryView = z.infer<typeof auditEntry>

export const auditHistoryContract = defineContract({
  params: input({ recordType: z.string().regex(RECORD_TYPE), recordId: id() }),
  querystring: input({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
  response: { 200: output({ entries: z.array(auditEntry) }) },
})

/**
 * `GET /audit` (B-W0-28, design 02 admin.audit, SCR-018; PLT-072, PLT-073, PLT-077): every audited write the caller's
 * audit.read grants reach, newest first, 50 a page (Owner L3), with filters (who, record, action, surface, company and
 * site, a time window, one request) and four saved views (`view`). Each entry adds the words the log shows: the office
 * person's name, the floor device's name (a floor worker is never named in an office list: Owner answer W1), the
 * Idempotency-Key. `counts` (asked with `withCounts`): how many entries of each saved view fall in the same time window
 * and scope, so the tiles and the list agree.
 */
export const AUDIT_VIEWS = ['roles', 'access', 'deletes', 'settings'] as const
export type AuditViewName = (typeof AUDIT_VIEWS)[number]

export const auditListEntry = auditEntry.extend({
  idempotencyKey: z.string().nullable(),
  /** The office person who acted (null for the floor, a partner, a link and the system). */
  actorName: z.string().nullable(),
  /** The floor device it was done on. */
  deviceName: z.string().nullable(),
})
export type AuditListEntryView = z.infer<typeof auditListEntry>

export const auditListContract = defineContract({
  querystring: input({
    actorId: id().optional(),
    audience: z.enum(AUDIT_AUDIENCES).optional(),
    recordType: z.string().regex(RECORD_TYPE).optional(),
    recordId: id().optional(),
    /** An action, or the start of one (`numbering.` for every numbering write). */
    action: z.string().regex(/^[a-z][A-Za-z0-9.]{0,99}$/).optional(),
    companyId: id().optional(),
    siteId: id().optional(),
    requestId: z.string().min(1).max(100).optional(),
    view: z.enum(AUDIT_VIEWS).optional(),
    from: instant().optional(),
    to: instant().optional(),
    /** Entries older than this one (paging, newest first). */
    before: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    withCounts: z.enum(['true', 'false']).optional(),
  }),
  response: {
    200: output({
      entries: z.array(auditListEntry),
      /** The id to ask `before` for the next page; null on the last page. */
      nextBefore: id().nullable(),
      counts: output({ roles: z.number().int(), access: z.number().int(), deletes: z.number().int(), settings: z.number().int() }).nullable(),
    }),
  },
})
