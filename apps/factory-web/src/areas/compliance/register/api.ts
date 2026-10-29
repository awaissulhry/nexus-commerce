import { z } from 'zod'
import { REGISTER_KINDS, REGISTER_RISKS, REGISTER_SOURCE_TYPES, REGISTER_STATUSES } from '@nexus/factory-domain/compliance/register/rules'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * Every call of the PPE register screens (SCR-113; apps/factory-api modules/compliance/register, B-W1-43), each answer
 * checked with a zod shape that mirrors the API's contract (contract.ts lives in the API source, which the web never
 * imports): unknown fields are ignored, so a new field on the API never breaks a page. Beside the register: the styles and
 * parties the New entry dialog picks from, and the reversed releases an entry opened by a reversal links to.
 */

export { REGISTER_KINDS, REGISTER_RISKS, REGISTER_SOURCE_TYPES, REGISTER_STATUSES }
export type RegisterKind = (typeof REGISTER_KINDS)[number]
export type RegisterRisk = (typeof REGISTER_RISKS)[number]
export type RegisterStatus = (typeof REGISTER_STATUSES)[number]
export type RegisterSourceType = (typeof REGISTER_SOURCE_TYPES)[number]

const named = z.object({ id: z.string(), code: z.string(), name: z.string() })

export const entrySchema = z.object({
  id: z.string(),
  companyId: z.string(),
  reference: z.string(),
  kind: z.enum(REGISTER_KINDS),
  status: z.enum(REGISTER_STATUSES),
  styleId: z.string(),
  style: named,
  styleRevisionId: z.string().nullable(),
  batchNumbers: z.array(z.string()),
  serials: z.array(z.string()),
  lotIds: z.array(z.string()),
  workOrderIds: z.array(z.string()),
  shipmentIds: z.array(z.string()),
  partyId: z.string().nullable(),
  party: named.nullable(),
  ownerId: z.string().nullable(),
  source: z.object({ type: z.enum(REGISTER_SOURCE_TYPES), id: z.string() }).nullable(),
  reportedAt: z.string(),
  description: z.string(),
  investigation: z.string().nullable(),
  risk: z.enum(REGISTER_RISKS),
  actionTaken: z.string().nullable(),
  actionCompletedAt: z.string().nullable(),
  distributorsInformedAt: z.string().nullable(),
  authorityNotifiedAt: z.string().nullable(),
  authorityReference: z.string().nullable(),
  closedAt: z.string().nullable(),
  closedById: z.string().nullable(),
  closeReason: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Entry = z.infer<typeof entrySchema>

const VIA = ['BATCH', 'SERIAL', 'LOT', 'WORK_ORDER', 'SHIPMENT'] as const
export type TraceVia = (typeof VIA)[number]

const cellSchema = z.object({
  workOrderSizeId: z.string(),
  colourwayCode: z.string(),
  size: z.string(),
  pieces: z.number(),
  concerned: z.number(),
  released: z.number(),
  packed: z.number(),
  shipped: z.number(),
  returned: z.number(),
  serials: z.array(z.object({ serial: z.string(), status: z.string(), shipmentId: z.string().nullable(), shipmentNumber: z.string().nullable() })),
})

export const traceSchema = z.object({
  workOrders: z.array(
    z.object({
      id: z.string(),
      number: z.string(),
      batchNumber: z.string().nullable(),
      styleId: z.string(),
      styleCode: z.string(),
      revision: z.number().nullable(),
      status: z.string(),
      reach: z.enum(['WHOLE', 'PART']),
      via: z.array(z.enum(VIA)),
      cells: z.array(cellSchema),
    }),
  ),
  lots: z.array(z.object({ id: z.string(), code: z.string(), workOrderNumbers: z.array(z.string()) })),
  shipments: z.array(
    z.object({
      id: z.string(),
      number: z.string(),
      status: z.string(),
      left: z.boolean(),
      shippedAt: z.string().nullable(),
      deliveredAt: z.string().nullable(),
      partyId: z.string(),
      partyCode: z.string(),
      partyName: z.string(),
      ddtNumbers: z.array(z.string()),
      garments: z.number(),
      workOrderNumbers: z.array(z.string()),
    }),
  ),
  customers: z.array(z.object({ partyId: z.string(), code: z.string(), name: z.string(), garments: z.number(), shipmentNumbers: z.array(z.string()), ddtNumbers: z.array(z.string()) })),
  counts: z.object({ workOrders: z.number(), concerned: z.number(), released: z.number(), packed: z.number(), shipped: z.number(), returned: z.number(), customers: z.number() }),
  shippedGoods: z.boolean(),
  problems: z.array(z.object({ path: z.string(), code: z.string(), message: z.string() })),
})
export type Trace = z.infer<typeof traceSchema>

export const DUTY_CODES = ['RISK_ASSESSMENT', 'CORRECTIVE_ACTION', 'DISTRIBUTORS', 'AUTHORITY'] as const
export type DutyCode = (typeof DUTY_CODES)[number]

export const entryDetailSchema = entrySchema.extend({
  trace: traceSchema,
  duties: z.array(z.object({ code: z.enum(DUTY_CODES), required: z.boolean(), done: z.boolean(), law: z.string() })),
  toClose: z.array(z.object({ code: z.string(), message: z.string() })),
})
export type EntryDetail = z.infer<typeof entryDetailSchema>

const oneEntry = z.object({ entry: entryDetailSchema })

/** The list's filters as the API reads them. */
export interface EntryQuery {
  readonly status?: RegisterStatus | null
  readonly kind?: RegisterKind | null
  readonly risk?: RegisterRisk | null
  readonly q?: string | null
  readonly limit: number
}

/** `GET /compliance/register`: newest first, at most `limit` (500 at most; the list has no cursor). */
export async function listEntries(api: ApiClient, query: EntryQuery, signal?: AbortSignal): Promise<Entry[]> {
  const answer = await api.get('/compliance/register', {
    query: {
      ...(query.status ? { status: query.status } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.risk ? { risk: query.risk } : {}),
      ...(query.q?.trim() ? { q: query.q.trim() } : {}),
      limit: query.limit,
    },
    schema: z.object({ entries: z.array(entrySchema) }),
    signal,
  })
  return answer.entries
}

export function getEntry(api: ApiClient, entryId: string, signal?: AbortSignal): Promise<EntryDetail> {
  return api.get(`/compliance/register/${encodeURIComponent(entryId)}`, { schema: oneEntry, signal }).then((answer) => answer.entry)
}

/** What a new entry concerns (the trace preview and the create). */
export interface Concern {
  readonly companyId: string
  readonly styleId: string
  readonly batchNumbers: readonly string[]
  readonly serials: readonly string[]
}

export function previewTrace(api: ApiClient, concern: Concern, signal?: AbortSignal): Promise<Trace> {
  return api
    .post('/compliance/register/trace', {
      body: { companyId: concern.companyId, styleId: concern.styleId, batchNumbers: [...concern.batchNumbers], serials: [...concern.serials] },
      schema: z.object({ trace: traceSchema }),
      signal,
    })
    .then((answer) => answer.trace)
}

export interface NewEntryBody extends Concern {
  readonly kind: RegisterKind
  readonly partyId: string | null
  readonly reportedAt: string | null
  readonly description: string
  readonly risk: RegisterRisk
  readonly actionTaken: string | null
}

export function createEntry(api: ApiClient, body: NewEntryBody, idempotencyKey: string): Promise<EntryDetail> {
  return api
    .post('/compliance/register', {
      body: {
        companyId: body.companyId,
        kind: body.kind,
        styleId: body.styleId,
        batchNumbers: [...body.batchNumbers],
        serials: [...body.serials],
        ...(body.partyId ? { partyId: body.partyId } : {}),
        ...(body.reportedAt ? { reportedAt: body.reportedAt } : {}),
        description: body.description,
        risk: body.risk,
        ...(body.actionTaken ? { actionTaken: body.actionTaken } : {}),
      },
      schema: oneEntry,
      idempotencyKey,
    })
    .then((answer) => answer.entry)
}

/** The fields an entry's dialogs change (`PATCH`, while OPEN, with the version read). */
export interface EntryPatch {
  readonly description?: string
  readonly investigation?: string | null
  readonly risk?: RegisterRisk
  readonly actionTaken?: string | null
  readonly partyId?: string | null
}

export function updateEntry(api: ApiClient, entryId: string, version: number, patch: EntryPatch): Promise<EntryDetail> {
  return api
    .request('PATCH', `/compliance/register/${encodeURIComponent(entryId)}`, { body: { version, ...patch }, schema: oneEntry, idempotencyKey: newIdempotencyKey() })
    .then((answer) => answer.entry)
}

export function completeAction(api: ApiClient, entryId: string, version: number, body: { actionTaken?: string; completedAt?: string }): Promise<EntryDetail> {
  return api
    .post(`/compliance/register/${encodeURIComponent(entryId)}/corrective-action/complete`, { body: { version, ...body }, schema: oneEntry, idempotencyKey: newIdempotencyKey() })
    .then((answer) => answer.entry)
}

export function informDistributors(api: ApiClient, entryId: string, version: number, body: { informedAt?: string; note: string }): Promise<EntryDetail> {
  return api
    .post(`/compliance/register/${encodeURIComponent(entryId)}/distributors-informed`, { body: { version, ...body }, schema: oneEntry, idempotencyKey: newIdempotencyKey() })
    .then((answer) => answer.entry)
}

export function notifyAuthority(api: ApiClient, entryId: string, version: number, body: { notifiedAt?: string; reference: string; note: string }): Promise<EntryDetail> {
  return api
    .post(`/compliance/register/${encodeURIComponent(entryId)}/authority-notified`, { body: { version, ...body }, schema: oneEntry, idempotencyKey: newIdempotencyKey() })
    .then((answer) => answer.entry)
}

export function closeEntry(api: ApiClient, entryId: string, version: number, reason: string): Promise<EntryDetail> {
  return api
    .post(`/compliance/register/${encodeURIComponent(entryId)}/close`, { body: { version, reason }, schema: oneEntry, idempotencyKey: newIdempotencyKey() })
    .then((answer) => answer.entry)
}

// ---- beside the register --------------------------------------------------------------------------------------------------

export const styleOptionSchema = z.object({ id: z.string(), companyId: z.string().nullable(), code: z.string(), name: z.string(), status: z.string() })
export type StyleOption = z.infer<typeof styleOptionSchema>

/** The styles an entry may name (`GET /product/styles`, every status: a complaint may be about an archived style). */
export async function listStyles(api: ApiClient, signal?: AbortSignal): Promise<StyleOption[]> {
  const answer = await api.get('/product/styles', { query: { status: 'ALL', limit: 200 }, schema: z.object({ styles: z.array(styleOptionSchema) }), signal })
  return answer.styles
}

export const partyOptionSchema = z.object({ id: z.string(), code: z.string(), legalName: z.string(), tradeName: z.string().nullable() })
export type PartyOption = z.infer<typeof partyOptionSchema>

/** The customers and brands that may report a problem (`GET /parties`). */
export async function listReporters(api: ApiClient, signal?: AbortSignal): Promise<PartyOption[]> {
  const answer = await api.get('/parties', { query: { role: 'CUSTOMER,BRAND', limit: 200 }, schema: z.object({ parties: z.array(partyOptionSchema) }), signal })
  return answer.parties
}

export const reversedReleaseSchema = z.object({
  id: z.string(),
  releaseNumber: z.string().nullable(),
  /** The work order's number. */
  number: z.string(),
  reversals: z.array(z.object({ id: z.string() })),
})
export type ReversedRelease = z.infer<typeof reversedReleaseSchema>

/** The releases with garments taken back (`GET /quality/releases?reversed=true`): an entry opened by a reversal links to its release. */
export async function listReversedReleases(api: ApiClient, signal?: AbortSignal): Promise<ReversedRelease[]> {
  const answer = await api.get('/quality/releases', { query: { reversed: 'true', limit: 200 }, schema: z.object({ releases: z.array(reversedReleaseSchema) }), signal })
  return answer.releases
}
