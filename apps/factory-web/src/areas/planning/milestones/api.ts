import { z } from 'zod'
import { GATE_KINDS, GATE_REFUSALS, GATE_STATES, LEATHER_STATES, MILESTONE_KINDS, MILESTONE_STATES, PASS_VIAS, WAITING_TILES } from '@nexus/factory-domain/planning/milestones/rules'
import type { ApiClient } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'

/**
 * Every call of Planning › Time & action (SCR-253), the answers checked with zod (unknown fields dropped, so a new API field
 * never breaks the page). The shapes mirror apps/factory-api modules/planning/milestones/contract.ts (B-W2b-263); the enum
 * lists are factory-domain's own (planning/milestones/rules). One read gives the page everything (tiles, orders, their gates
 * and milestones); each write answers the gate as it is now (or the ids passed), then the page reads again.
 */

const person = z.object({ id: z.string(), name: z.string() })
const refusal = z.object({ code: z.enum(GATE_REFUSALS), message: z.string() })
const action = z.object({ allowed: z.boolean(), refusal: refusal.nullable(), needs: z.string().nullable() })

export const gateSchema = z.object({
  id: z.string(),
  salesOrderId: z.string(),
  kind: z.enum(GATE_KINDS),
  label: z.string().nullable(),
  targetDate: z.string().nullable(),
  sampleRound: z.object({ id: z.string(), number: z.string(), kind: z.string(), decision: z.string().nullable() }).nullable(),
  owner: person.nullable(),
  ownerId: z.string().nullable(),
  makerId: z.string().nullable(),
  state: z.enum(GATE_STATES),
  passedOn: z.string().nullable(),
  passedAt: z.string().nullable(),
  passedBy: person.nullable(),
  via: z.enum(PASS_VIAS).nullable(),
  startedBefore: z.object({ at: z.string(), by: person.nullable(), reason: z.string() }).nullable(),
  leather: z.enum(LEATHER_STATES).nullable(),
  holds: z.number(),
  version: z.number(),
  actions: z.object({ pass: action, startBefore: action, edit: action, remove: action }),
})
export type Gate = z.infer<typeof gateSchema>
export type GateAction = z.infer<typeof action>

export const milestoneSchema = z.object({
  id: z.string(),
  kind: z.enum(MILESTONE_KINDS),
  gateId: z.string().nullable(),
  gateKind: z.enum(GATE_KINDS).nullable(),
  label: z.string().nullable(),
  salesOrderId: z.string(),
  target: z.string().nullable(),
  actual: z.string().nullable(),
  state: z.enum(MILESTONE_STATES),
  late: z.number().nullable(),
  owner: person.nullable(),
})
export type Milestone = z.infer<typeof milestoneSchema>

export const orderSchema = z.object({
  id: z.string(),
  number: z.string(),
  companyId: z.string(),
  customer: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  status: z.string(),
  promiseDate: z.string().nullable(),
  customerRef: z.string().nullable(),
  workOrders: z.object({ count: z.number(), notStarted: z.number() }),
  gates: z.array(gateSchema),
  milestones: z.array(milestoneSchema),
  waiting: z.array(z.enum(GATE_KINDS)),
  late: z.number(),
  next: z.string().nullable(),
  mayAddGate: z.object({ allowed: z.boolean(), needs: z.string().nullable(), refusal: refusal.nullable() }),
})
export type Order = z.infer<typeof orderSchema>

const tilesSchema = z.object(Object.fromEntries(WAITING_TILES.map((tile) => [tile, z.number()])) as Record<(typeof WAITING_TILES)[number], z.ZodNumber>)

export const milestonesSchema = z.object({ today: z.string(), timeZone: z.string(), tiles: tilesSchema, orders: z.array(orderSchema), truncated: z.boolean() })
export type Milestones = z.infer<typeof milestonesSchema>

const choicesSchema = z.object({
  order: z.object({ id: z.string(), number: z.string(), kinds: z.array(z.enum(GATE_KINDS)) }),
  rounds: z.array(z.object({ id: z.string(), number: z.string(), kind: z.string(), roundNo: z.number(), decision: z.string().nullable(), stage: z.string(), style: z.object({ id: z.string(), code: z.string() }) })),
  owners: z.array(z.object({ id: z.string(), name: z.string(), me: z.boolean() })),
})
export type GateChoices = z.infer<typeof choicesSchema>

const gateAnswer = z.object({ gate: gateSchema })

export const getMilestones = (api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<Milestones> =>
  api.get('/planning/milestones', { query: companyId ? { companyId } : {}, schema: milestonesSchema, signal })

export const getChoices = (api: ApiClient, salesOrderId: string, signal?: AbortSignal): Promise<GateChoices> =>
  api.get(`/planning/milestones/orders/${encodeURIComponent(salesOrderId)}/choices`, { schema: choicesSchema, signal })

export interface GateBody {
  readonly kind?: (typeof GATE_KINDS)[number]
  readonly label?: string | null
  readonly targetDate?: string | null
  readonly sampleRoundId?: string | null
  readonly ownerId?: string | null
}

export function addGate(api: ApiClient, salesOrderId: string, body: GateBody & { kind: (typeof GATE_KINDS)[number] }): Promise<Gate> {
  return api.post('/planning/milestones/gates', { body: { salesOrderId, ...body }, schema: gateAnswer, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.gate)
}

export function editGate(api: ApiClient, gateId: string, version: number, body: GateBody): Promise<Gate> {
  const { kind: _kind, ...rest } = body
  return api.request('PATCH', `/planning/milestones/gates/${encodeURIComponent(gateId)}`, { body: { version, ...rest }, schema: gateAnswer, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.gate)
}

export function removeGate(api: ApiClient, gateId: string, version: number): Promise<unknown> {
  return api.post(`/planning/milestones/gates/${encodeURIComponent(gateId)}/remove`, { body: { version }, idempotencyKey: newIdempotencyKey() })
}

export function passGates(api: ApiClient, gates: readonly { id: string; version: number }[], on?: string): Promise<{ passed: { id: string; version: number }[] }> {
  return api.post('/planning/milestones/gates/pass', { body: { gates, ...(on ? { on } : {}) }, schema: z.object({ passed: z.array(z.object({ id: z.string(), version: z.number() })) }), idempotencyKey: newIdempotencyKey() })
}

export function startBefore(api: ApiClient, gateId: string, version: number, reason: string): Promise<Gate> {
  return api.post(`/planning/milestones/gates/${encodeURIComponent(gateId)}/start-before`, { body: { version, reason }, schema: gateAnswer, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.gate)
}
