import { z } from 'zod'
import { EXCEPTION_KINDS } from '@nexus/factory-domain/planning/exceptions/detect'
import { EXCEPTION_RESOLUTIONS, EXCEPTION_STATUSES } from '@nexus/factory-domain/planning/exceptions/lifecycle'
import type { ApiClient } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'

/**
 * Every call of Planning › Exceptions (SCR-125), the answer's shape checked with zod (unknown fields dropped, so a new
 * API field never breaks the page). The shapes mirror apps/factory-api modules/planning/exceptions/contract.ts (B-W2a-22);
 * the enum lists are factory-domain's own. The API's English (`label`, `sentence`) is never drawn: the screen says each
 * exception from its kind and facts. No money, no figure per person (an exception's owner is an office person, named).
 */

export const KINDS = EXCEPTION_KINDS
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number]
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number]

const person = z.object({ id: z.string(), name: z.string() })
const named = z.object({ id: z.string(), code: z.string(), name: z.string() })

export const exceptionSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  kind: z.enum(EXCEPTION_KINDS),
  occurrence: z.number(),
  status: z.enum(EXCEPTION_STATUSES),
  item: named.nullable(),
  colour: named.nullable(),
  record: z.object({ type: z.string(), id: z.string(), label: z.string().nullable() }).nullable(),
  requirementId: z.string().nullable(),
  facts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  ordersAffected: z.number(),
  daysLate: z.number().nullable(),
  firstRunId: z.string(),
  lastRunId: z.string(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  ageDays: z.number(),
  owner: person.nullable(),
  mine: z.boolean(),
  acknowledgedAt: z.string().nullable(),
  acknowledgedBy: person.nullable(),
  snoozed: z.boolean(),
  snoozedAt: z.string().nullable(),
  snoozedUntil: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  resolution: z.enum(EXCEPTION_RESOLUTIONS).nullable(),
  resolvedBy: person.nullable(),
  resolveNote: z.string().nullable(),
  version: z.number(),
})
export type PlanningException = z.infer<typeof exceptionSchema>

const listSchema = z.object({
  siteId: z.string(),
  tiles: z.object({ open: z.number(), new: z.number(), mine: z.number(), snoozedUntilToday: z.number() }),
  latestRun: z.object({ id: z.string(), finishedAt: z.string().nullable() }).nullable(),
  exceptions: z.array(exceptionSchema),
  nextCursor: z.string().nullable(),
})
export type ExceptionList = z.infer<typeof listSchema>

/** The API's own filters (`status` comma-separated, `snoozed` now or not). */
export interface ExceptionQuery {
  status?: readonly ExceptionStatus[]
  kind?: ExceptionKind | null
  mine?: boolean
  snoozed?: boolean | null
  cursor?: string | null
  limit?: number
}

export function listExceptions(api: ApiClient, siteId: string, query: ExceptionQuery = {}, signal?: AbortSignal): Promise<ExceptionList> {
  return api.get('/planning/exceptions', {
    query: {
      siteId,
      status: query.status && query.status.length > 0 ? query.status.join(',') : undefined,
      kind: query.kind ?? undefined,
      mine: query.mine ? 'true' : undefined,
      snoozed: query.snoozed === true ? 'true' : query.snoozed === false ? 'false' : undefined,
      cursor: query.cursor ?? undefined,
      limit: query.limit ?? 50,
    },
    schema: listSchema,
    signal,
  })
}

export async function getException(api: ApiClient, id: string, signal?: AbortSignal): Promise<PlanningException> {
  return (await api.get(`/planning/exceptions/${encodeURIComponent(id)}`, { schema: z.object({ exception: exceptionSchema }), signal })).exception
}

/** NEW → ACKNOWLEDGED for each (one site, at most 200, each with its version); the person owns the ones with no owner. */
export async function acknowledgeExceptions(api: ApiClient, refs: readonly { id: string; version: number }[]): Promise<PlanningException[]> {
  return (await api.post('/planning/exceptions/acknowledge', { body: { exceptions: refs }, schema: z.object({ exceptions: z.array(exceptionSchema), replayed: z.boolean() }), idempotencyKey: newIdempotencyKey() })).exceptions
}

/** Until a later instant, or until the next run (`until` null). */
export async function snoozeException(api: ApiClient, id: string, version: number, until: string | null): Promise<PlanningException> {
  return (await api.post(`/planning/exceptions/${encodeURIComponent(id)}/snooze`, { body: { version, until }, schema: z.object({ exception: exceptionSchema, replayed: z.boolean() }), idempotencyKey: newIdempotencyKey() })).exception
}

/** Resolved by the person (HANDLED), with a note of 3 to 1000 characters. */
export async function resolveException(api: ApiClient, id: string, version: number, note: string): Promise<PlanningException> {
  return (await api.post(`/planning/exceptions/${encodeURIComponent(id)}/resolve`, { body: { version, note: note.trim() }, schema: z.object({ exception: exceptionSchema, replayed: z.boolean() }), idempotencyKey: newIdempotencyKey() })).exception
}
