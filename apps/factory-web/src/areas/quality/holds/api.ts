import { z } from 'zod'
import { HOLD_QUARANTINE, HOLD_STATUSES, HOLD_SUBJECT_TYPES, RELEASE_CHECKS, type HoldQuarantine, type HoldSourceType, type HoldStatus, type HoldSubjectType } from '@nexus/factory-domain/quality/holds/rules'
import { WORK_ORDER_STATUSES } from '@nexus/factory-domain/production/work-orders/machine'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { pickerReasons, type PickerReason } from '../../_shared/reasons/api'

/**
 * Every call of Quality › Holds (SCR-078; the place dialog other lists open), each answer checked against the shape the
 * API's contract gives (apps/factory-api modules/quality/holds contract.ts; unknown fields are dropped, so a new field
 * never breaks the page). Writes carry the hold's version and an Idempotency-Key; a release answers 403 `stepUp` until
 * the session has a fresh code (the page's useStepUp asks for it, then sends the same key again).
 */

const kind = z.enum(HOLD_SUBJECT_TYPES)
const status = z.enum(HOLD_STATUSES)
const quarantine = z.enum(HOLD_QUARANTINE)
const woStatus = z.enum(WORK_ORDER_STATUSES)
const place = z.object({ id: z.string(), code: z.string(), name: z.string() })

export const holdSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  site: place.nullable().optional().default(null),
  status,
  subjectType: kind,
  subjects: z.array(z.object({ id: z.string(), label: z.string().nullable(), state: z.string().nullable() })),
  subjectWords: z.string(),
  quantity: z.string().nullable(),
  blocks: z.string(),
  reasonCode: z.string(),
  reason: z.string(),
  reasonNote: z.string().nullable(),
  sourceType: z.string().nullable(),
  sourceId: z.string().nullable(),
  placedAt: z.string(),
  placedBy: z.object({ kind: z.enum(['USER', 'WORKER', 'SYSTEM']), userId: z.string().nullable() }),
  ownerId: z.string().nullable(),
  owner: z.object({ id: z.string(), name: z.string() }).nullable().optional().default(null),
  expectedReleaseOn: z.string().nullable(),
  overdue: z.boolean(),
  ageDays: z.number(),
  quarantine,
  quarantineLocation: place.nullable(),
  quarantineMovedAt: z.string().nullable(),
  ncrId: z.string().nullable(),
  releasedAt: z.string().nullable(),
  releasedBy: z.object({ kind: z.enum(['USER', 'WORKER']), userId: z.string().nullable() }).nullable(),
  releaseNote: z.string().nullable(),
  closedAt: z.string().nullable(),
  closedById: z.string().nullable(),
  closeNote: z.string().nullable(),
  note: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Hold = z.infer<typeof holdSchema>

const check = z.object({ key: z.enum(RELEASE_CHECKS), ok: z.boolean(), words: z.string() })
export type HoldCheck = z.infer<typeof check>

export const holdDetailSchema = z.object({
  hold: holdSchema,
  workOrders: z.array(
    z.object({ id: z.string(), number: z.string(), status: woStatus, heldFromStatus: woStatus.nullable(), holdReason: z.string().nullable(), heldByThis: z.boolean(), batchNumber: z.string().nullable().optional().default(null) }),
  ),
  release: z.object({ checks: z.array(check), releasable: z.boolean(), mayRelease: z.boolean() }),
  canChange: z.boolean(),
})
export type HoldDetail = z.infer<typeof holdDetailSchema>

export const countsSchema = z.object({ open: z.number(), overdue: z.number(), system: z.number(), mine: z.number(), waitingQuarantine: z.number() })
export type HoldCounts = z.infer<typeof countsSchema>

const seg = (value: string) => encodeURIComponent(value)

// ---- reads ------------------------------------------------------------------------------------------------------------

export interface HoldsQuery {
  readonly status?: HoldStatus | 'ALL' | null
  readonly subjectType?: HoldSubjectType | null
  readonly subjectId?: string | null
  readonly ownerId?: string | null
  readonly overdue?: boolean
  readonly system?: boolean
  readonly quarantine?: HoldQuarantine | null
}

/** `GET /quality/holds`: newest first, at most 200 (`truncated` beyond; the API has no cursor). */
export async function listHolds(api: ApiClient, query: HoldsQuery, signal?: AbortSignal): Promise<{ holds: Hold[]; truncated: boolean }> {
  return api.get('/quality/holds', {
    query: {
      ...(query.status ? { status: query.status } : {}),
      ...(query.subjectType ? { subjectType: query.subjectType } : {}),
      ...(query.subjectId ? { subjectId: query.subjectId } : {}),
      ...(query.ownerId ? { ownerId: query.ownerId } : {}),
      ...(query.overdue ? { overdue: 'true' } : {}),
      ...(query.system ? { system: 'true' } : {}),
      ...(query.quarantine ? { quarantine: query.quarantine } : {}),
    },
    schema: z.object({ holds: z.array(holdSchema), truncated: z.boolean() }),
    signal,
  })
}

export const holdCounts = async (api: ApiClient, signal?: AbortSignal): Promise<HoldCounts> => (await api.get('/quality/holds/counts', { schema: z.object({ counts: countsSchema }), signal })).counts

export const getHold = (api: ApiClient, holdId: string, signal?: AbortSignal): Promise<HoldDetail> => api.get(`/quality/holds/${seg(holdId)}`, { schema: holdDetailSchema, signal })

/** Who may own a hold of the site (the owner picker; quality.holds.place). */
export const holdPeople = async (api: ApiClient, siteId: string): Promise<Person[]> =>
  (await api.get('/quality/holds/people', { query: { siteId }, schema: z.object({ people: z.array(z.object({ id: z.string(), name: z.string(), me: z.boolean() })) }) })).people
export interface Person {
  readonly id: string
  readonly name: string
  readonly me: boolean
}

/** The HOLD reasons in tile order (the place dialog's list; the list's words by language). */
export const holdReasons = (api: ApiClient, signal?: AbortSignal): Promise<PickerReason[]> => pickerReasons(api, ['HOLD'], signal)

// ---- the place dialog --------------------------------------------------------------------------------------------------

export const previewSchema = z.object({
  siteId: z.string().nullable(),
  subjects: z.array(z.object({ id: z.string().nullable(), code: z.string().nullable(), label: z.string().nullable(), state: z.string().nullable(), quantity: z.string().nullable(), problem: z.string().nullable() })),
  words: z.string().nullable(),
  quantity: z.string().nullable(),
  workOrders: z.array(z.object({ id: z.string(), number: z.string(), status: woStatus, move: z.enum(['HOLD', 'ALREADY', 'KEEP', 'REFUSED']) })),
  quarantinePlaces: z.array(place),
})
export type HoldPreview = z.infer<typeof previewSchema>

export const previewHold = (api: ApiClient, body: { subjectType: HoldSubjectType; subjectIds?: readonly string[]; codes?: readonly string[] }, signal?: AbortSignal): Promise<HoldPreview> =>
  api.post('/quality/holds/preview', { body, schema: previewSchema, signal })

export interface PlaceBody {
  readonly subjectType: HoldSubjectType
  readonly subjectIds: readonly string[]
  readonly reasonCode: string
  readonly reasonNote?: string | null
  readonly sourceType?: HoldSourceType | null
  readonly sourceId?: string | null
  readonly ownerId?: string | null
  readonly expectedReleaseOn?: string | null
  readonly askQuarantine?: boolean
  readonly quarantineLocationId?: string | null
  readonly note?: string | null
}

const moved = z.object({ id: z.string(), number: z.string() })

export const placeHold = (api: ApiClient, body: PlaceBody, idempotencyKey: string) =>
  api.post('/quality/holds', { body, schema: z.object({ hold: holdSchema, workOrdersHeld: z.array(moved.extend({ from: woStatus })) }), idempotencyKey })

// ---- changes and the release -------------------------------------------------------------------------------------------

export interface EditBody {
  readonly version: number
  readonly ownerId?: string | null
  readonly expectedReleaseOn?: string | null
  readonly note?: string | null
  readonly reasonNote?: string | null
}

export const editHold = (api: ApiClient, holdId: string, body: EditBody, idempotencyKey: string = newIdempotencyKey()) =>
  api.request('PATCH', `/quality/holds/${seg(holdId)}`, { body, schema: z.object({ hold: holdSchema }), idempotencyKey })

export const releaseHold = (api: ApiClient, holdId: string, body: { version: number; note?: string | null; notMakerStatement?: boolean }, idempotencyKey: string) =>
  api.post(`/quality/holds/${seg(holdId)}/release`, { body, schema: z.object({ hold: holdSchema, workOrdersLifted: z.array(moved.extend({ to: woStatus })), checks: z.array(check) }), idempotencyKey })
