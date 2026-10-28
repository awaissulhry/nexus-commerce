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
