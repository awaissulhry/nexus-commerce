import { incomingList, type IncomingList } from '@nexus/factory-domain/sales/incoming/contracts'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * B-TH-239: Today's Incoming lines read Sales › Incoming's own read — GET /sales/incoming (B-TH-039) with no filter and the New tile,
 * one row (the lines need only the counts: every tile's count and the New tile's rows per kind), checked against the API's own
 * contract (factory-domain sales/incoming/contracts).
 */
export function fetchIncomingCounts(api: ApiClient, signal?: AbortSignal): Promise<IncomingList> {
  return api.get('/sales/incoming', { query: { tile: 'NEW', limit: 1 }, schema: incomingList, signal })
}
