import { searchAnswer, type SearchAnswer } from '@nexus/factory-domain/search/contracts'
import type { ApiClient } from '../../lib/api/client'

/**
 * Global search's one call (B-W2a-32; apps/factory-api platform/search `GET /search`): the palette's Records group and
 * the All results page. The answer is checked against factory-domain's own contract (an answer that does not match is a
 * `contract` error, never half-read). Only containers call it.
 */
export function searchRecords(api: ApiClient, params: { q: string; type?: string | null; limit?: number; offset?: number }, signal?: AbortSignal): Promise<SearchAnswer> {
  return api.get('/search', {
    query: { q: params.q, type: params.type ?? undefined, limit: params.limit, offset: params.offset },
    schema: searchAnswer,
    signal,
  })
}

export type { SearchAnswer, SearchResult } from '@nexus/factory-domain/search/contracts'
