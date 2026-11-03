import { z } from 'zod'
import { TRACE_NODE_KINDS, TRACE_REACHES } from '@nexus/factory-domain/inventory/trace/rules'
import { GENEALOGY_START_TYPES, HOLD_NEXT_STEPS, NODE_HOLD_STATES, type GenealogyStartType, type HoldNextStep } from '@nexus/factory-domain/quality/holds/depth'
import { HOLD_STATUSES, HOLD_SUBJECT_TYPES } from '@nexus/factory-domain/quality/holds/rules'
import type { ApiClient } from '../../../../lib/api/client'
import { holdSchema } from '../api'

/**
 * Every call of holds in depth (B-W2b-114; the API's modules/quality/holds depth-contract.ts): the tree a hold by genealogy
 * ticks, placing it, what a hold touches (Affected), the board's lane, the quarantine move asked and confirmed. Each answer
 * checked against the contract's shape (unknown fields dropped). Writes carry the version read and an Idempotency-Key.
 */

const count = z.number().int().min(0)
const holdKind = z.enum(HOLD_SUBJECT_TYPES)

export const impactNodeSchema = z.object({
  key: z.string(),
  kind: z.enum(TRACE_NODE_KINDS),
  id: z.string(),
  code: z.string().nullable(),
  reach: z.enum(TRACE_REACHES),
  companyId: z.string().nullable(),
  siteId: z.string().nullable(),
  hidden: z.boolean(),
  state: z.string().nullable(),
  holdKind: holdKind.nullable(),
  hold: z.enum(NODE_HOLD_STATES),
  problem: z.string().nullable(),
  holds: z.array(z.object({ id: z.string(), reasonCode: z.string() })),
  workOrderId: z.string().nullable(),
  cell: z.object({ colourwayCode: z.string(), size: z.string(), quantity: count, released: count, packed: count, shipped: count, returned: count }).nullable().optional(),
  lot: z.object({ itemCode: z.string(), itemName: z.string(), uom: z.string(), onHand: z.string(), colourCode: z.string().nullable() }).nullable().optional(),
  hideOnHand: z.string().nullable().optional(),
  workOrder: z.object({ styleCode: z.string(), batchNumber: z.string().nullable(), status: z.string() }).nullable().optional(),
  bundle: z.object({ quantity: count, part: z.string().nullable() }).nullable().optional(),
  shipment: z.object({ ddtNumbers: z.array(z.string()), left: z.boolean() }).nullable().optional(),
  partyName: z.string().nullable().optional(),
  received: z.boolean().optional(),
})
export type ImpactNodeView = z.infer<typeof impactNodeSchema>

const impactShape = {
  starts: z.array(z.object({ key: z.string(), kind: z.string(), id: z.string(), code: z.string() })),
  asOf: z.string(),
  nodes: z.array(impactNodeSchema),
  edges: z.array(z.object({ from: z.string(), to: z.string(), link: z.string(), exact: z.boolean(), quantity: z.string().nullable(), uom: z.string().nullable() })),
  levels: z.array(z.object({ kind: z.enum(TRACE_NODE_KINDS), exact: count, possible: count })),
  gaps: z.array(z.object({ code: z.string(), severity: z.string(), at: z.string(), count })),
  states: z.object({
    material: z.array(z.object({ uom: z.string(), onHand: z.string() })),
    hidesInStock: count,
    garments: z.object({ inWork: count, inStock: count, packed: count, shipped: count, returned: count }),
    customers: count,
  }),
  restricted: z.array(z.object({ permission: z.string(), nodes: count })),
}
export const impactSchema = z.object(impactShape)
export type Impact = z.infer<typeof impactSchema>

export const groupSchema = z.object({
  id: z.string(),
  sourceType: z.string(),
  sourceId: z.string(),
  sourceCode: z.string().nullable(),
  reasonCode: z.string(),
  reasonNote: z.string().nullable(),
  counts: z.record(z.string(), count),
  placedAt: z.string(),
  placedBy: z.enum(['USER', 'SYSTEM']),
  version: z.number(),
  holds: z.array(z.object({ id: z.string(), number: z.string().nullable(), subjectType: holdKind, count, status: z.enum(HOLD_STATUSES), siteCode: z.string().nullable() })),
})
export type HoldGroup = z.infer<typeof groupSchema>

const startType = z.enum(GENEALOGY_START_TYPES)
const placeSchema = z.object({ id: z.string(), code: z.string(), name: z.string() })

export const genealogySchema = z.object({
  start: z.object({ type: startType, id: z.string(), code: z.string(), companyId: z.string(), siteId: z.string() }),
  ...impactShape,
  sites: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), mayPlace: z.boolean(), quarantinePlaces: z.array(placeSchema) })),
  extending: z.object({ holdId: z.string(), number: z.string().nullable(), status: z.enum(HOLD_STATUSES), groupId: z.string().nullable() }).nullable(),
  group: groupSchema.nullable(),
})
export type Genealogy = z.infer<typeof genealogySchema>

export const affectedSchema = z.object({
  holdId: z.string(),
  traced: count,
  of: count,
  traceable: z.boolean(),
  ...impactShape,
  group: groupSchema.nullable(),
  extend: z.object({ start: z.object({ type: startType, id: z.string(), code: z.string() }).nullable(), held: z.enum(['NOT_ACTIVE', 'NO_RIGHT', 'KIND']).nullable() }),
})
export type Affected = z.infer<typeof affectedSchema>

export const heldStockSchema = z.object({
  places: z.array(placeSchema),
  lying: z.array(z.object({ locationId: z.string(), code: z.string(), name: z.string(), kind: z.string(), onHand: z.string(), uom: z.string(), moves: z.boolean() })),
})
export type HeldStock = z.infer<typeof heldStockSchema>

const seg = (value: string) => encodeURIComponent(value)

/** `GET /quality/holds/genealogy`: the forward tree of a suspect lot or hide (`holdId`: extending that hold). */
export const getGenealogy = (api: ApiClient, query: { type: GenealogyStartType; id: string; holdId?: string | null }, signal?: AbortSignal): Promise<Genealogy> =>
  api.get('/quality/holds/genealogy', { query: { type: query.type, id: query.id, ...(query.holdId ? { holdId: query.holdId } : {}) }, schema: genealogySchema, signal })

export interface GenealogyBody {
  readonly type: GenealogyStartType
  readonly id: string
  readonly picks: readonly string[]
  readonly reasonCode: string
  readonly reasonNote: string | null
  readonly ownerId: string | null
  readonly expectedReleaseOn: string | null
  readonly askQuarantine: boolean
  readonly note: string | null
  readonly holdId: string | null
}

export const placedGenealogySchema = z.object({
  group: groupSchema,
  holds: z.array(holdSchema),
  alreadyHeld: z.array(z.object({ key: z.string(), code: z.string().nullable() })),
  covered: count,
  quarantineNotAsked: z.array(z.object({ siteId: z.string(), places: count })),
})
export type PlacedGenealogy = z.infer<typeof placedGenealogySchema>

export const placeGenealogy = (api: ApiClient, body: GenealogyBody, idempotencyKey: string): Promise<PlacedGenealogy> =>
  api.post('/quality/holds/genealogy', { body, schema: placedGenealogySchema, idempotencyKey })

/** `GET /quality/holds/:holdId/affected`: what a hold touches (its records' forward trees, merged). */
export const getAffected = (api: ApiClient, holdId: string, signal?: AbortSignal): Promise<Affected> => api.get(`/quality/holds/${seg(holdId)}/affected`, { schema: affectedSchema, signal })

export const moveNextStep = (api: ApiClient, holdId: string, body: { version: number; nextStep: HoldNextStep }, idempotencyKey: string) =>
  api.post(`/quality/holds/${seg(holdId)}/next-step`, { body, schema: z.object({ hold: holdSchema }), idempotencyKey })

export const askQuarantine = (api: ApiClient, holdId: string, body: { version: number; locationId: string | null }, idempotencyKey: string) =>
  api.post(`/quality/holds/${seg(holdId)}/quarantine/ask`, { body, schema: z.object({ hold: holdSchema }), idempotencyKey })

export const confirmedSchema = z.object({
  hold: holdSchema,
  moved: z.array(z.object({ fromCode: z.string(), onHand: z.string(), uom: z.string() })),
  stays: z.array(z.object({ atCode: z.string(), onHand: z.string(), uom: z.string() })),
  stock: heldStockSchema.nullable(),
})
export type ConfirmedMove = z.infer<typeof confirmedSchema>

export const confirmQuarantine = (api: ApiClient, holdId: string, body: { version: number; placeCode: string }, idempotencyKey: string): Promise<ConfirmedMove> =>
  api.post(`/quality/holds/${seg(holdId)}/quarantine/confirm`, { body, schema: confirmedSchema, idempotencyKey })

export const NEXT_STEPS = HOLD_NEXT_STEPS
