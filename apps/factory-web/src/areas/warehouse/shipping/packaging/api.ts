import { z } from 'zod'
import { PACKAGING_KINDS, PALLET_KINDS } from '@nexus/factory-domain/shipping/packaging/rules'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * Packaging (B-W2b-412 on B-W2b-384's API; LOG-008; apps/factory-api modules/shipping/packaging): the company's carton,
 * box and pallet types (inner size, own weight, the most it may weigh, the pallet's kind; the cost per unit only with the cost
 * grain — the API drops it otherwise and refuses it in a request) and the defaults per style or size run. Switched off, never
 * deleted. Sizes are centimetres and weights kilograms, as decimal strings.
 */

const typeSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  kind: z.enum(PACKAGING_KINDS),
  name: z.string(),
  innerLengthCm: z.string().nullable(),
  innerWidthCm: z.string().nullable(),
  innerHeightCm: z.string().nullable(),
  tareKg: z.string().nullable(),
  maxWeightKg: z.string().nullable(),
  palletKind: z.enum(PALLET_KINDS).nullable(),
  /** ABSENT without the cost grain. */
  cost: z.object({ perUnit: z.string(), currency: z.string() }).nullable().optional(),
  active: z.boolean(),
  version: z.number(),
  updatedAt: z.string(),
})
export type PackagingType = z.infer<typeof typeSchema>

const defaultSchema = z.object({
  id: z.string(),
  kind: z.enum(PACKAGING_KINDS),
  packagingTypeId: z.string(),
  packagingTypeName: z.string(),
  style: z.object({ code: z.string(), name: z.string() }).nullable(),
  sizeScale: z.object({ code: z.string(), name: z.string() }).nullable(),
  fromSize: z.string().nullable(),
  toSize: z.string().nullable(),
  active: z.boolean(),
  version: z.number(),
})
export type PackagingDefault = z.infer<typeof defaultSchema>

export const listTypes = (api: ApiClient, companyId: string, signal?: AbortSignal): Promise<PackagingType[]> =>
  api.get('/shipping/packaging/types', { query: { companyId }, schema: z.object({ types: z.array(typeSchema) }), signal }).then((answer) => answer.types)

export interface TypeBody {
  name?: string
  innerLengthCm?: string | null
  innerWidthCm?: string | null
  innerHeightCm?: string | null
  tareKg?: string | null
  maxWeightKg?: string | null
  palletKind?: (typeof PALLET_KINDS)[number] | null
  cost?: { perUnit: string; currency: string } | null
  active?: boolean
}

/** POST /shipping/packaging/types (shipping.packaging.manage): kind and company fixed; the name unique in the company. */
export const createType = (api: ApiClient, body: TypeBody & { companyId: string; kind: (typeof PACKAGING_KINDS)[number]; name: string }, idempotencyKey: string) =>
  api.post('/shipping/packaging/types', { body, schema: z.object({ type: typeSchema }), idempotencyKey }).then((answer) => answer.type)

/** PATCH /shipping/packaging/types/:id at its version: a field left out stays, null clears it. */
export const changeType = (api: ApiClient, typeId: string, body: TypeBody & { version: number }, idempotencyKey: string) =>
  api.request('PATCH', `/shipping/packaging/types/${encodeURIComponent(typeId)}`, { body, schema: z.object({ type: typeSchema }), idempotencyKey }).then((answer) => answer.type)

export const listDefaults = (api: ApiClient, companyId: string, signal?: AbortSignal): Promise<PackagingDefault[]> =>
  api.get('/shipping/packaging/defaults', { query: { companyId }, schema: z.object({ defaults: z.array(defaultSchema) }), signal }).then((answer) => answer.defaults)

/** POST /shipping/packaging/defaults: a style and / or a size scale with an optional run from … to. */
export const createDefault = (api: ApiClient, body: { companyId: string; packagingTypeId: string; styleId: string | null; sizeScaleId: string | null; fromSize: string | null; toSize: string | null }, idempotencyKey: string) =>
  api.post('/shipping/packaging/defaults', { body, schema: z.object({ default: defaultSchema }), idempotencyKey }).then((answer) => answer.default)

/** PATCH /shipping/packaging/defaults/:id: another type of the same kind, on / off. */
export const changeDefault = (api: ApiClient, defaultId: string, body: { version: number; packagingTypeId?: string; active?: boolean }, idempotencyKey: string) =>
  api.request('PATCH', `/shipping/packaging/defaults/${encodeURIComponent(defaultId)}`, { body, schema: z.object({ default: defaultSchema }), idempotencyKey }).then((answer) => answer.default)

const pick = z.object({ id: z.string(), code: z.string(), name: z.string() })
export type PickItem = z.infer<typeof pick>

/** The open styles a default may name (products' own list; the first 200). */
export const listStylesToPick = (api: ApiClient, signal?: AbortSignal): Promise<PickItem[]> =>
  api.get('/product/styles', { query: { status: 'OPEN', limit: 200 }, schema: z.object({ styles: z.array(pick) }), signal }).then((answer) => answer.styles)

/** The active size scales a default may name. */
export const listScalesToPick = (api: ApiClient, signal?: AbortSignal): Promise<PickItem[]> =>
  api.get('/product/size-scales', { query: { status: 'ACTIVE', limit: 200 }, schema: z.object({ scales: z.array(pick) }), signal }).then((answer) => answer.scales)
