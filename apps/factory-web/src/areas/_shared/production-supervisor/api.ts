import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'

/**
 * F-PR-21 — the production supervisor's routes the office screens use (B-PR-42a, `modules/production/supervisor`; production.brand.manage):
 * - `GET /production/supervisors?partyId&companyId?` — the people who may supervise this customer's production there, by name (`me`
 *   marks the reader), at most 500 (`complete` false: some may be missing); nobody is counted.
 * - `POST /production/orders/supervisor {orderIds 1–100, supervisorId|null}` — each order's own supervisor (null: back to its customer's
 *   default); one result per order: changed, unchanged, skipped with why (only orders the caller sees), the rest counted (`unknown`).
 * The API's `why` is English: the screen says it from its code (model `skipKeyOf`), never the API's words.
 */

const pickListSchema = z.object({ people: z.array(z.object({ id: z.string(), name: z.string(), me: z.boolean() })), complete: z.boolean(), ordersOnDefault: z.number() })
export type SupervisorPickList = z.infer<typeof pickListSchema>

const orderRef = z.object({ orderId: z.string(), number: z.string() })
const assignSchema = z.object({
  supervisor: z.object({ id: z.string(), name: z.string(), active: z.boolean() }).nullable(),
  changed: z.array(orderRef),
  unchanged: z.array(orderRef),
  skipped: z.array(z.object({ orderId: z.string(), number: z.string(), why: z.string() })),
  unknown: z.number(),
})
export type OrderSupervisorsAnswer = z.infer<typeof assignSchema>

export function readPickList(api: ApiClient, scope: { readonly partyId: string; readonly companyId?: string | null }, signal?: AbortSignal): Promise<SupervisorPickList> {
  return api.get('/production/supervisors', { query: { partyId: scope.partyId, companyId: scope.companyId ?? undefined }, schema: pickListSchema, ...(signal ? { signal } : {}) })
}

export function assignOrderSupervisors(api: ApiClient, body: { readonly orderIds: readonly string[]; readonly supervisorId: string | null }, idempotencyKey: string): Promise<OrderSupervisorsAnswer> {
  return api.post('/production/orders/supervisor', { body: { orderIds: [...body.orderIds], supervisorId: body.supervisorId }, schema: assignSchema, idempotencyKey })
}
