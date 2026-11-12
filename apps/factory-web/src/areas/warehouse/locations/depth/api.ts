import { z } from 'zod'
import { BLOCK_REASONS } from '@nexus/factory-domain/inventory/locations-depth/blocks'
import { DEFAULT_PURPOSES, HELD_ITEM_KINDS } from '@nexus/factory-domain/inventory/locations-depth/kinds'
import { LOCATION_KINDS, LOCATION_STATUSES } from '@nexus/factory-domain/inventory/locations/rules'
import type { ApiClient } from '../../../../lib/api/client'
import type { LocationView, SiteLocations } from '../../../_shared/stock/api'

/**
 * Locations in depth (B-W2b-327 on B-W2b-289's API; SCM-177, SCM-178, SCM-179, SCM-181): the calls of the W2b parts of
 * Locations, Stock and Movements that read or change a place — the places with their bin label code and block (the W1
 * list answers them; the shared stock client drops them), Block / Unblock, the label code, the label and its print
 * history, Print labels, the bin labels PDF, the default locations and the parties a workshop's or customer's place
 * names. Shapes mirror apps/factory-api modules/inventory/locations-depth/contract.ts; unknown fields are dropped. The
 * API's English is never drawn: the screens say their own words from codes.
 */

type Query = Readonly<Record<string, string | number | boolean | null | undefined>>
const clean = (query: Query): Query => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ''))
const seg = (value: string) => encodeURIComponent(value)

export const BLOCK_REASON_LIST = BLOCK_REASONS
export type BlockReason = (typeof BLOCK_REASONS)[number]
export const PURPOSE_LIST = DEFAULT_PURPOSES
export type Purpose = (typeof DEFAULT_PURPOSES)[number]
export type HeldItemKind = (typeof HELD_ITEM_KINDS)[number]

const blockSchema = z.object({
  reason: z.enum(BLOCK_REASONS),
  note: z.string().nullable(),
  /** The last day it holds (Rome); null: until unblocked. */
  until: z.string().nullable(),
  at: z.string(),
  byId: z.string().nullable(),
  /** False once its until-day passed (moves go through again). */
  holds: z.boolean(),
  /** The count whose counting holds it, or null. */
  countNumber: z.string().nullable(),
})
export type BlockView = z.infer<typeof blockSchema>

/** A place as the W1 list answers it since B-W2b-289 (its label code, its block, a workshop's or customer's party). */
export type PlaceView = LocationView & { partyId?: string | null; labelCode?: string | null; block?: BlockView | null }
export type PlaceSite = Omit<SiteLocations, 'locations'> & { locations: PlaceView[] }

const placeSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  parentId: z.string().nullable(),
  code: z.string(),
  name: z.string(),
  kind: z.enum(LOCATION_KINDS),
  partyId: z.string().nullable().optional(),
  status: z.enum(LOCATION_STATUSES),
  depth: z.number(),
  path: z.array(z.string()),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  labelCode: z.string().nullable().optional(),
  block: blockSchema.nullable().optional(),
})
const placeSitesSchema = z.object({ sites: z.array(z.object({ id: z.string(), companyId: z.string(), code: z.string(), name: z.string(), locations: z.array(placeSchema) })) })

/** The location trees of the sites the person may see, each place with its label code and block. */
export const listPlaces = (api: ApiClient, query: { siteId?: string | null; includeArchived?: boolean }, signal?: AbortSignal): Promise<{ sites: PlaceSite[] }> =>
  api.get('/inventory/locations', { query: clean({ siteId: query.siteId, includeArchived: query.includeArchived ? 'true' : undefined }), schema: placeSitesSchema, signal })

/** A workshop's or a customer's place names its party (SUBCONTRACTOR; CUSTOMER or BRAND): created with W1's route. */
export const createPlace = (api: ApiClient, body: { siteId: string; parentId: string | null; code: string; name: string; kind: LocationView['kind']; partyId?: string | null }) =>
  api.post('/inventory/locations', { body: Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)), schema: z.object({ location: placeSchema }) })

// ---- SCM-181 blocks ----------------------------------------------------------------------------------------------------------

const shortPlace = z.object({ location: z.object({ id: z.string(), code: z.string(), version: z.number(), block: blockSchema.nullable() }).loose() })
export interface BlockInput {
  version: number
  reason: BlockReason
  note?: string | null
  until?: string | null
}
/** inventory.locations.manage: blocks a place (or changes its block, keeping its start). */
export const blockPlace = (api: ApiClient, locationId: string, body: BlockInput, idempotencyKey: string) =>
  api.post(`/inventory/locations/${seg(locationId)}/block`, { body: Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined && value !== '')), schema: shortPlace, idempotencyKey })
export const unblockPlace = (api: ApiClient, locationId: string, version: number, idempotencyKey: string) =>
  api.post(`/inventory/locations/${seg(locationId)}/unblock`, { body: { version }, schema: shortPlace, idempotencyKey })

// ---- SCM-178 bin labels ---------------------------------------------------------------------------------------------------

/** Gives a place its label code: the suggested one (`labelCode` left out), a typed one, or none (null). */
export const setLabelCode = (api: ApiClient, locationId: string, body: { version: number; labelCode?: string | null }, idempotencyKey: string) =>
  api.request('PUT', `/inventory/locations/${seg(locationId)}/label-code`, { body, schema: z.object({ location: z.object({ id: z.string(), labelCode: z.string().nullable(), version: z.number() }).loose(), printed: z.number() }), idempotencyKey })

const jobSchema = z.object({ jobId: z.string(), printerId: z.string(), printerCode: z.string(), state: z.enum(['QUEUED', 'SENT', 'PRINTED', 'FAILED']), copies: z.number(), lastError: z.string().nullable(), at: z.string(), printedAt: z.string().nullable() })
export type LabelJob = z.infer<typeof jobSchema>
const labelSchema = z.object({
  location: z.object({ id: z.string(), code: z.string(), labelCode: z.string().nullable(), version: z.number() }).loose(),
  /** The code a label carries now: its own, or (none yet) the suggested one. */
  code: z.string(),
  suggested: z.boolean(),
  labelled: z.boolean(),
  label: z.object({ language: z.enum(['it', 'en']), heading: z.string(), title: z.string(), scanId: z.string(), fields: z.array(z.object({ label: z.string(), value: z.string() })) }),
  jobs: z.array(jobSchema),
})
export type PlaceLabel = z.infer<typeof labelSchema>
/** The bin label as it prints (in the label's language) and its print history (jobs with print.view only). */
export const placeLabel = (api: ApiClient, locationId: string, language: 'it' | 'en', signal?: AbortSignal) =>
  api.get(`/inventory/locations/${seg(locationId)}/label`, { query: { language }, schema: labelSchema, signal })

const printAnswer = z.object({
  jobs: z.array(z.object({ locationId: z.string(), labelCode: z.string(), jobId: z.string(), state: z.enum(['QUEUED', 'SENT', 'PRINTED', 'FAILED']) })),
  refused: z.array(z.object({ locationId: z.string(), code: z.string(), message: z.string() })),
})
export type PrintAnswer = z.infer<typeof printAnswer>
export interface PrintInput {
  printerId: string
  locationIds: readonly string[]
  copies: number
  language: 'it' | 'en'
}
/** print.labels: one print job per place on a label printer of their site (a place without a code gets its suggested one). */
export const printPlaceLabels = (api: ApiClient, body: PrintInput, idempotencyKey: string) => api.post('/inventory/locations/labels/print', { body, schema: printAnswer, idempotencyKey })

/** The bin labels PDF (one page of the stock's size per label and copy), stored nowhere: printed from the browser. */
export const placeLabelsPdf = (api: ApiClient, body: { locationIds: readonly string[]; copies: number; language: 'it' | 'en'; widthMm?: number; heightMm?: number }) =>
  api.bytes('/inventory/locations/labels/pdf', { method: 'POST', body })

// ---- SCM-179 default locations --------------------------------------------------------------------------------------------

const defaultSchema = z.object({
  id: z.string(),
  itemKind: z.enum(HELD_ITEM_KINDS).nullable(),
  purpose: z.enum(DEFAULT_PURPOSES),
  location: z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.enum(LOCATION_KINDS), status: z.enum(LOCATION_STATUSES) }),
  version: z.number(),
  updatedAt: z.string(),
  updatedById: z.string().nullable(),
})
export type DefaultView = z.infer<typeof defaultSchema>
/** The site's active defaults (what a command takes when no place is named). */
export const placeDefaults = (api: ApiClient, siteId: string, signal?: AbortSignal) => api.get('/inventory/locations/defaults', { query: { siteId }, schema: z.object({ siteId: z.string(), defaults: z.array(defaultSchema) }), signal })

// ---- the parties a workshop's or a customer's place names (parties.view) -----------------------------------------------------

const partySchema = z.object({ id: z.string(), code: z.string(), legalName: z.string(), tradeName: z.string().nullable() })
export interface PartyChoice {
  id: string
  code: string
  name: string
}
/** Active parties of these roles (SUBCONTRACTOR; CUSTOMER,BRAND), at most 100, by name. */
export const placeParties = async (api: ApiClient, roles: readonly string[], signal?: AbortSignal): Promise<PartyChoice[]> =>
  (await api.get('/parties', { query: { role: roles.join(','), status: 'ACTIVE', limit: 100 }, schema: z.object({ parties: z.array(partySchema) }), signal })).parties
    .map((party) => ({ id: party.id, code: party.code, name: party.tradeName || party.legalName }))
    .sort((a, b) => a.name.localeCompare(b.name))
