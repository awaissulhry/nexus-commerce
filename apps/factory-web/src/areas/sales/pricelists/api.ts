import { z } from 'zod'
import { ENTRY_CHANGES, PRICE_LIST_KINDS, PRICE_LIST_STATES, PRICE_VERSION_STATUSES } from '@nexus/factory-domain/sales/pricelists/pricelists'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * Every call of Sales › Price lists & contracts (SCR-106; B-W2a-49 on the API of B-W2a-19, apps/factory-api
 * modules/sales/pricelists/contract.ts), with the answer's shape checked (zod; unknown fields are dropped). Prices are the
 * price grain, a price row's standard cost the cost grain, its margin the margin grain: each is ABSENT (never null) when
 * the person's grains do not reach it, so a screen draws no such column then. A list's `version` guards its own edits, a
 * version's `version` its days, prices and activation: every write sends the one read (a moved record is a 409, never
 * overwritten) with its own Idempotency-Key. The API's English is never drawn: the screens say their own words.
 */

export type PriceListKind = (typeof PRICE_LIST_KINDS)[number]
export type PriceListState = (typeof PRICE_LIST_STATES)[number]
export type PriceVersionStatus = (typeof PRICE_VERSION_STATUSES)[number]
export type EntryChange = (typeof ENTRY_CHANGES)[number]
export { PRICE_LIST_KINDS, PRICE_LIST_STATES }

const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })
const shownVersionSchema = z.object({ id: z.string(), revision: z.number(), status: z.enum(PRICE_VERSION_STATUSES), validFrom: z.string().nullable(), validTo: z.string().nullable() })

export const listRowSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  code: z.string(),
  name: z.string(),
  kind: z.enum(PRICE_LIST_KINDS),
  currency: z.string(),
  baseList: ref.nullable(),
  state: z.enum(PRICE_LIST_STATES),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  shownVersion: shownVersionSchema.nullable(),
  draftVersionId: z.string().nullable(),
  stylesPriced: z.number(),
  customers: z.number(),
  startsSoon: z.boolean(),
  endsSoon: z.boolean(),
  version: z.number(),
  updatedAt: z.string(),
})
export type PriceListRow = z.infer<typeof listRowSchema>

export const versionSchema = z.object({
  id: z.string(),
  revision: z.number(),
  status: z.enum(PRICE_VERSION_STATUSES),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
  activatedAt: z.string().nullable(),
  activatedById: z.string().nullable(),
  note: z.string().nullable(),
  entries: z.number(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type PriceVersion = z.infer<typeof versionSchema>

const listCustomerSchema = z.object({ id: z.string(), code: z.string(), legalName: z.string(), status: z.string(), companyId: z.string().nullable(), version: z.number() })
export type ListCustomer = z.infer<typeof listCustomerSchema>

export const listDetailSchema = listRowSchema.omit({ customers: true }).extend({
  note: z.string().nullable(),
  createdAt: z.string(),
  createdById: z.string().nullable(),
  versions: z.array(versionSchema),
  customers: z.array(listCustomerSchema),
  fallbackOf: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.enum(PRICE_LIST_KINDS), status: z.string() })),
})
export type PriceListDetail = z.infer<typeof listDetailSchema>

export const entrySchema = z.object({
  id: z.string(),
  styleId: z.string(),
  style: z.object({ code: z.string(), name: z.string(), status: z.string() }),
  colourwayId: z.string().nullable(),
  colourway: z.object({ code: z.string(), name: z.string() }).nullable(),
  unitPrice: z.string().optional(),
  standardCost: z.string().nullable().optional(),
  marginPct: z.string().nullable().optional(),
  belowFloor: z.boolean().optional(),
  version: z.number(),
})
export type PriceEntry = z.infer<typeof entrySchema>

const versionAnswerSchema = z.object({ version: versionSchema, entries: z.array(entrySchema) })
export type VersionAnswer = z.infer<typeof versionAnswerSchema>
const oneList = z.object({ list: listDetailSchema })

export const compareSchema = z.object({
  before: z.object({ id: z.string(), revision: z.number() }),
  after: z.object({ id: z.string(), revision: z.number() }),
  changed: z.number(),
  rows: z.array(
    z.object({
      styleId: z.string(),
      style: z.object({ id: z.string(), code: z.string(), name: z.string() }),
      colourwayId: z.string().nullable(),
      colourway: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
      before: z.string().nullable().optional(),
      after: z.string().nullable().optional(),
      change: z.enum(ENTRY_CHANGES),
      changePct: z.string().nullable().optional(),
    }),
  ),
})
export type CompareAnswer = z.infer<typeof compareSchema>

export const listsAnswerSchema = z.object({
  asOf: z.string(),
  lists: z.array(listRowSchema),
  tiles: z.object({ inForce: z.number(), startingIn30Days: z.number(), endingIn30Days: z.number() }),
})
export type ListsAnswer = z.infer<typeof listsAnswerSchema>

// ---- reads ------------------------------------------------------------------------------------------------------------

const enc = encodeURIComponent
const listPath = (id: string) => `/sales/price-lists/${enc(id)}`
const versionPath = (listId: string, versionId: string) => `${listPath(listId)}/versions/${enc(versionId)}`

export interface ListQuery {
  companyId?: string | null
  kind?: PriceListKind | null
  state?: PriceListState | null
  q?: string
}

export function listPriceLists(api: ApiClient, query: ListQuery, signal?: AbortSignal): Promise<ListsAnswer> {
  return api.get('/sales/price-lists', {
    query: { companyId: query.companyId ?? undefined, kind: query.kind ?? undefined, state: query.state ?? undefined, q: query.q?.trim() || undefined },
    schema: listsAnswerSchema,
    signal,
  })
}

export async function getPriceList(api: ApiClient, id: string, signal?: AbortSignal): Promise<PriceListDetail> {
  return (await api.get(listPath(id), { schema: oneList, signal })).list
}

export function getVersion(api: ApiClient, listId: string, versionId: string, signal?: AbortSignal): Promise<VersionAnswer> {
  return api.get(versionPath(listId, versionId), { schema: versionAnswerSchema, signal })
}

export function compareVersions(api: ApiClient, listId: string, versionId: string, withId: string, signal?: AbortSignal): Promise<CompareAnswer> {
  return api.get(`${versionPath(listId, versionId)}/compare`, { query: { with: withId }, schema: compareSchema, signal })
}

// ---- writes -----------------------------------------------------------------------------------------------------------

export interface NewListBody {
  companyId: string | null
  code: string
  name: string
  kind: PriceListKind
  currency: string
  baseListId: string | null
  note: string | null
  validFrom: string | null
  validTo: string | null
}

export async function createPriceList(api: ApiClient, body: NewListBody): Promise<PriceListDetail> {
  return (await api.post('/sales/price-lists', { body, schema: oneList, idempotencyKey: newIdempotencyKey() })).list
}

export async function moveList(api: ApiClient, list: Pick<PriceListDetail, 'id' | 'version'>, move: 'archive' | 'reactivate'): Promise<PriceListDetail> {
  return (await api.post(`${listPath(list.id)}/${move}`, { body: { version: list.version }, schema: oneList, idempotencyKey: newIdempotencyKey() })).list
}

export async function setCustomers(api: ApiClient, listId: string, partyIds: readonly string[], action: 'add' | 'remove'): Promise<PriceListDetail> {
  return (await api.post(`${listPath(listId)}/customers${action === 'remove' ? '/remove' : ''}`, { body: { partyIds }, schema: oneList, idempotencyKey: newIdempotencyKey() })).list
}

export function nextVersion(api: ApiClient, listId: string, fromVersionId: string | null): Promise<VersionAnswer> {
  return api.post(`${listPath(listId)}/versions`, { body: { fromVersionId }, schema: versionAnswerSchema, idempotencyKey: newIdempotencyKey() })
}

export interface PriceRow {
  styleId: string
  colourwayId: string | null
  /** Net, per piece; null removes the row. */
  unitPrice: string | null
}

export function setPrices(api: ApiClient, listId: string, version: Pick<PriceVersion, 'id' | 'version'>, entries: readonly PriceRow[]): Promise<VersionAnswer> {
  return api.request('PUT', `${versionPath(listId, version.id)}/entries`, { body: { version: version.version, entries }, schema: versionAnswerSchema, idempotencyKey: newIdempotencyKey() })
}

const activateSchema = versionAnswerSchema.extend({ ended: z.object({ id: z.string(), revision: z.number(), validTo: z.string() }).nullable() })
export type ActivateAnswer = z.infer<typeof activateSchema>

export function activateVersion(api: ApiClient, listId: string, version: Pick<PriceVersion, 'id' | 'version'>, days: { validFrom: string; validTo: string | null }): Promise<ActivateAnswer> {
  return api.post(`${versionPath(listId, version.id)}/activate`, { body: { version: version.version, validFrom: days.validFrom, validTo: days.validTo }, schema: activateSchema, idempotencyKey: newIdempotencyKey() })
}
