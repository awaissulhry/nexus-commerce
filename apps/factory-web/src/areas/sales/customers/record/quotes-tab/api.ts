import { beforeOrderCountsAnswer, type BeforeOrderCountsAnswer } from '@nexus/factory-domain/sales/before-order/contracts'
import type { ApiClient } from '../../../../../lib/api/client'

/**
 * F-CQ-101 (customer page › Quotes & incoming, 13-backend ★(1), B-CQ-002): the ONE count read of the tab —
 * GET /sales/before-order/counts?partyId=&companyId= (office, parties.view over the customer; each kind under its own view right
 * and wall on the server: a group the reader holds no right of is null, a customer out of reach is "Customer not found."). The
 * company is the session's (the sample rounds then match Overview's). Counts only: no amount, no person. Read only while this tab
 * is shown (W3 lifts it to the page, once, for the tab's badge).
 */
export function readBeforeOrderCounts(api: ApiClient, partyId: string, companyId: string | null, signal?: AbortSignal): Promise<BeforeOrderCountsAnswer> {
  return api.get('/sales/before-order/counts', { query: { partyId, companyId: companyId ?? undefined }, schema: beforeOrderCountsAnswer, signal })
}
