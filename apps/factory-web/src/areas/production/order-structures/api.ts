import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { pictureSchema } from '../../../lib/people-picture/schema'

/**
 * owb-ss8 (S3 web B; the server Shape of owb-ss6, FIXED) — Production › Order structures: the structures, the rules (one list read from
 * the top, the first that fits wins), "Try an order", one order by hand, and the rules that name one customer. Answers checked (zod).
 * The fixed last line "Everything else → the normal way" is the web's (never stored). A rule names a customer or any, a category
 * (`Style.productType`) or any. The customer never reads any of it (office routes only).
 */

const count = z.number().int().min(0)

export const structureRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  teams: z.array(z.object({ id: z.string(), name: z.string(), picture: pictureSchema })),
  people: z.array(z.object({ userId: z.string(), name: z.string() })),
  note: z.string().nullable(),
  closed: z.boolean(),
  usedByRules: count,
  version: z.number().int(),
})
export type StructureRow = z.infer<typeof structureRowSchema>

export const ruleRowSchema = z.object({
  id: z.string(),
  sortOrder: z.number().int(),
  party: z.object({ id: z.string(), name: z.string() }).nullable(),
  category: z.string().nullable(),
  structure: z.object({ id: z.string(), name: z.string(), closed: z.boolean() }),
  active: z.boolean(),
  note: z.string().nullable(),
  closed: z.boolean(),
  dead: z.boolean(),
  deadBecause: z.object({ ruleId: z.string() }).nullable(),
  fitsNow: z.object({ count, orders: z.array(z.object({ id: z.string(), number: z.string() })) }),
  version: z.number().int(),
})
export type RuleRow = z.infer<typeof ruleRowSchema>

const structuresSchema = z.object({ structures: z.array(structureRowSchema), may: z.object({ manage: z.boolean() }) })
const rulesSchema = z.object({ rules: z.array(ruleRowSchema), neverUsed: count, may: z.object({ write: z.boolean() }) })
export type StructuresRead = z.infer<typeof structuresSchema>
export type RulesRead = z.infer<typeof rulesSchema>

const seg = (value: string): string => encodeURIComponent(value)

export const getStructures = (api: ApiClient, signal?: AbortSignal) => api.get('/production/order-structures', { schema: structuresSchema, signal })
export const createStructure = (api: ApiClient, body: { name: string; teamIds: string[]; peopleUserIds: string[]; note?: string }) =>
  api.post('/production/order-structures', { body, schema: structureRowSchema, idempotencyKey: newIdempotencyKey() })
export const patchStructure = (api: ApiClient, id: string, body: { version: number; name?: string; teamIds?: string[]; peopleUserIds?: string[]; note?: string }) =>
  api.request('PATCH', `/production/order-structures/${seg(id)}`, { body, schema: structureRowSchema, idempotencyKey: newIdempotencyKey() })
export const closeStructure = (api: ApiClient, id: string, open: boolean) => api.post(`/production/order-structures/${seg(id)}/${open ? 'reopen' : 'close'}`, { body: {}, idempotencyKey: newIdempotencyKey() })

export const getRules = (api: ApiClient, signal?: AbortSignal) => api.get('/production/structure-rules', { schema: rulesSchema, signal })
export const createRule = (api: ApiClient, body: { partyId: string | null; category: string | null; structureId: string; note?: string; place?: number }) =>
  api.post('/production/structure-rules', { body, schema: ruleRowSchema, idempotencyKey: newIdempotencyKey() })
export const patchRule = (api: ApiClient, id: string, body: { version: number; partyId?: string | null; category?: string | null; structureId?: string; note?: string }) =>
  api.request('PATCH', `/production/structure-rules/${seg(id)}`, { body, schema: ruleRowSchema, idempotencyKey: newIdempotencyKey() })
export const orderRules = (api: ApiClient, ids: readonly string[]) =>
  api.request('PUT', '/production/structure-rules/order', { body: { ids }, schema: z.object({ rules: z.array(ruleRowSchema) }), idempotencyKey: newIdempotencyKey() })
export const closeRule = (api: ApiClient, id: string, open: boolean) => api.post(`/production/structure-rules/${seg(id)}/${open ? 'reopen' : 'close'}`, { body: {}, idempotencyKey: newIdempotencyKey() })

const trySchema = z.object({
  winner: z.object({ ruleId: z.string().nullable(), structureId: z.string().nullable(), words: z.string() }),
  others: z.array(z.object({ ruleId: z.string(), words: z.string() })),
})
export type TryAnswer = z.infer<typeof trySchema>
export const tryOrder = (api: ApiClient, body: { partyId: string | null; category: string | null }) => api.post('/production/structure-rules/try', { body, schema: trySchema })

export const STRUCTURE_FROM = ['RULE', 'ORDER', 'NORMAL'] as const
export type StructureFrom = (typeof STRUCTURE_FROM)[number]

const orderStructureSchema = z.object({
  orderId: z.string(),
  printed: z.boolean(),
  byHand: z.object({ structureId: z.string().nullable(), why: z.string(), by: z.string(), at: z.string() }).nullable(),
  lines: z.array(
    z.object({
      salesOrderLineId: z.string(),
      label: z.string(),
      structure: z.object({ id: z.string(), name: z.string() }).nullable(),
      rule: z.object({ id: z.string() }).nullable(),
      from: z.enum(STRUCTURE_FROM).catch('NORMAL'),
      why: z.string(),
      kept: z.boolean(),
    }),
  ),
  may: z.object({ change: z.boolean() }),
})
export type OrderStructure = z.infer<typeof orderStructureSchema>

export const getOrderStructure = (api: ApiClient, orderId: string, signal?: AbortSignal) => api.get(`/production/orders/${seg(orderId)}/structure`, { schema: orderStructureSchema, signal })
export const putOrderStructure = (api: ApiClient, orderId: string, body: { structureId: string | null; why: string }) =>
  api.request('PUT', `/production/orders/${seg(orderId)}/structure`, { body, schema: orderStructureSchema, idempotencyKey: newIdempotencyKey() })
export const backToRules = (api: ApiClient, orderId: string) => api.request('DELETE', `/production/orders/${seg(orderId)}/structure`, { schema: orderStructureSchema, idempotencyKey: newIdempotencyKey() })

const customerRulesSchema = z.object({ rules: z.array(ruleRowSchema), may: z.object({ write: z.boolean() }) })
export type CustomerRules = z.infer<typeof customerRulesSchema>
export const getCustomerRules = (api: ApiClient, partyId: string, signal?: AbortSignal) => api.get(`/production/customers/${seg(partyId)}/structure-rules`, { schema: customerRulesSchema, signal })

/** The office people a structure may name (today's task assignees: the company's office users). */
export const officePeople = (api: ApiClient, signal?: AbortSignal) =>
  api.get('/tasks/assignees', { schema: z.object({ people: z.array(z.object({ id: z.string(), name: z.string() })) }), signal }).then((answer) => answer.people)
