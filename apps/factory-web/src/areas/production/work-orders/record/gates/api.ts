import { milestonesSchema, type Milestones } from '../../../../planning/milestones/api'
import type { ApiClient } from '../../../../../lib/api/client'

/**
 * F-PR-05a — the gates of one of the work order's orders (Planning › Time & action, B-W2b-263's read with planning.view over the
 * order's company and customer): `GET /planning/milestones?orderId=` answers that one order with its gates and milestones. The
 * answer's shape is Time & action's own (one schema). Another customer's order is never asked: only the work order's own.
 */
export function getOrderGates(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<Milestones> {
  return api.get('/planning/milestones', { query: { orderId }, schema: milestonesSchema, signal })
}
