import { z } from 'zod'
import { ORDER_PHASES } from '@nexus/factory-domain/production-brand/stages'
import type { ApiClient } from '../../../../lib/api/client'
import { listParties, type PartyQuery, type PartyWorkBand } from '../../../parties/_shared/api'

/**
 * F-CL-201 (customers list 13-backend §4, B-CL-003 / B-CL-009): where each customer's work stands, for a page of the list —
 * `GET /sales/orders/customers/work?partyIds=` (1–50 ids; orders.view; counts only, never an amount) — and the band, ONE read of
 * the list's own route (`GET /parties?…&limit=1&band=true`: one place builds the filters). Every field past the first answer's is
 * optional here: the web never waits for a server field (15-steps). An id the reader does not reach is absent (no 0, no name).
 */

export type OrderPhase = (typeof ORDER_PHASES)[number]
export { ORDER_PHASES }

/** At most this many customers in one read (the route's own cap). */
export const CUSTOMERS_WORK_MAX = 50

const customerWorkSchema = z.object({
  partyId: z.string(),
  orders: z.number(),
  phases: z.array(z.object({ phase: z.enum(ORDER_PHASES), count: z.number() })),
  late: z.number(),
  waitsForYes: z.number(),
  depositOpen: z.number(),
  requests: z.object({ open: z.number(), firstId: z.string().nullable() }),
  /** null: withheld (no threads.read). */
  replies: z.number().nullable(),
  customerUrgent: z.object({ count: z.number(), byCompany: z.array(z.object({ companyId: z.string(), count: z.number() })) }),
  /** OUR levels: URGENT ("Top") and HIGH, among the open orders. Office only. */
  priority: z.object({ top: z.number(), high: z.number() }),
  nextPromise: z.string().nullable(),
  lastOrderDate: z.string().nullable().optional(),
  newestOrder: z.object({ id: z.string(), number: z.string() }).nullable().optional(),
  /** The Quotes & incoming lane's rule (B-CL-009); a part without its right is absent, never 0. */
  beforeOrder: z.object({ toAnswer: z.number().optional(), openQuotes: z.number().optional() }).optional(),
})
export type CustomerWork = z.infer<typeof customerWorkSchema>

const customersWorkSchema = z.object({
  customers: z.array(customerWorkSchema),
  repliesComplete: z.boolean().optional(),
  withheld: z.array(z.string()).optional(),
  limited: z.boolean().optional(),
  asOf: z.string().optional(),
})
export type CustomersWork = z.infer<typeof customersWorkSchema>

/** One read for up to 50 customers (the page's ids, in its order). */
export function readCustomersWork(api: ApiClient, partyIds: readonly string[], signal?: AbortSignal): Promise<CustomersWork> {
  return api.get('/sales/orders/customers/work', { query: { partyIds: partyIds.slice(0, CUSTOMERS_WORK_MAX).join(',') }, schema: customersWorkSchema, ...(signal ? { signal } : {}) })
}

/** The band over the list's own terms (its door, order and page aside): null when the answer has none. */
export async function readWorkBand(api: ApiClient, terms: PartyQuery, signal?: AbortSignal): Promise<PartyWorkBand | null> {
  const page = await listParties(api, { ...terms, limit: 1, cursor: null, band: true }, signal)
  return page.band ?? null
}
