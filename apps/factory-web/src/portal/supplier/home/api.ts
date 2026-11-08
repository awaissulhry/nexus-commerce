import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'

/**
 * What the supplier's Home reads besides the frame's one task list (B-W2b-179; design portal.supplier.home): the counts at a
 * glance (GET /portal/home, B-W2b-167's sources), the open lines of its confirmed orders (GET /portal/ship-notices/shippable,
 * B-W2b-182: "next deliveries"), and our latest messages (GET /portal/threads?from=company, B-W2b-168). No money anywhere.
 */

const words = z.object({ it: z.string(), en: z.string() })

export const homeSchema = z.object({
  asOf: z.string(),
  kind: z.string().nullable(),
  counts: z.array(z.object({ key: z.string(), area: z.string(), words, value: z.number().nullable() })),
  live: z.object({ events: z.array(z.string()) }),
})
export type HomeRead = z.infer<typeof homeSchema>
export const fetchHome = (api: ApiClient, signal?: AbortSignal): Promise<HomeRead> => api.get('/portal/home', { schema: homeSchema, signal })

export const shippableLineSchema = z.object({
  purchaseOrderLineId: z.string(),
  seq: z.number(),
  item: z.object({ code: z.string(), name: z.string(), leather: z.boolean() }),
  supplierArticleCode: z.string().nullable(),
  colour: z.string().nullable(),
  uom: z.string(),
  expected: z.string(),
  received: z.string(),
  inTransit: z.string(),
  open: z.string(),
  needDate: z.string(),
  confirmedDate: z.string().nullable(),
})
export type ShippableLine = z.infer<typeof shippableLineSchema>

export const shippableSchema = z.object({
  mayWrite: z.boolean(),
  orders: z.array(z.object({ id: z.string(), number: z.string(), documentNumber: z.string(), status: z.string(), lines: z.array(shippableLineSchema) })),
})
export type ShippableRead = z.infer<typeof shippableSchema>
export const fetchShippable = (api: ApiClient, signal?: AbortSignal): Promise<ShippableRead> => api.get('/portal/ship-notices/shippable', { schema: shippableSchema, signal })

export const conversationSchema = z.object({
  record: z.object({ type: z.string(), id: z.string(), theirRef: z.string().nullable(), ourRef: z.string().nullable(), subtitle: z.string().nullable(), status: z.string().nullable() }),
  thread: z.object({ id: z.string(), status: z.string() }),
  last: z.object({ id: z.string(), side: z.string(), channel: z.string(), authorName: z.string().nullable(), excerpt: z.string(), attachmentCount: z.number(), at: z.string() }),
})
export type Conversation = z.infer<typeof conversationSchema>
export const fetchRecentMessages = (api: ApiClient, signal?: AbortSignal): Promise<{ conversations: Conversation[] }> =>
  api.get('/portal/threads', { query: { from: 'company', limit: 3 }, schema: z.object({ conversations: z.array(conversationSchema) }), signal })
