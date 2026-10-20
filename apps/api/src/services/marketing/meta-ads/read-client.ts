/**
 * Meta ads M1 — the read client: one Meta list or object, through the gateway (GET only), with paging and the
 * failure in words. Never throws for a Meta answer without a MetaReadError carrying the failure and the calls spent.
 *
 * Paging: `paging.cursors.after` with the same path and query, while Meta gives a `paging.next` (checked 2026-10-20:
 * developers.facebook.com/docs/graph-api/results — cursor-based pagination; the next link itself is never followed
 * because it carries the token). At most `maxPages` pages; a list cut there says so (`truncated`).
 */
import { metaCall, type MetaQueryValue } from '../../gateway/meta.js'
import type { GatewayResponse } from '../../gateway/gateway.js'
import { failureOfAnswer, failureOfThrow, localFailure, MetaReadError } from './errors.js'
import type { MetaAdsTarget } from './types.js'

export const DEFAULT_MAX_PAGES = 20

export interface MetaListRead { rows: number; calls: number; truncated: boolean }

/** One call; its JSON body, or a MetaReadError. */
export async function metaReadOne<T = Record<string, unknown>>(
  target: Pick<MetaAdsTarget, 'connectionId'>,
  input: { operation: string; path: string; query?: Record<string, MetaQueryValue>; triggeredBy?: 'cron' | 'manual' | 'api' },
): Promise<{ body: T; calls: number }> {
  let answer: GatewayResponse
  try {
    answer = await metaCall({ connectionId: target.connectionId, operation: input.operation, path: input.path, query: input.query, triggeredBy: input.triggeredBy })
  } catch (err) {
    const failure = failureOfThrow(err)
    if (failure) throw new MetaReadError(failure, input.operation, 0)
    throw err
  }
  if (!answer.ok) throw new MetaReadError(failureOfAnswer(answer), input.operation, 1)
  const body = answer.json<T>()
  if (body === null || typeof body !== 'object') throw new MetaReadError(localFailure('Meta answered with something that is not JSON.', 'NOT_JSON'), input.operation, 1)
  return { body, calls: 1 }
}

/** Every row of a list, page by page, handed to `onRows`. */
export async function metaReadAll(
  target: Pick<MetaAdsTarget, 'connectionId'>,
  input: { operation: string; path: string; query?: Record<string, MetaQueryValue>; maxPages?: number; triggeredBy?: 'cron' | 'manual' | 'api' },
  onRows: (rows: Record<string, unknown>[]) => void,
): Promise<MetaListRead> {
  const maxPages = input.maxPages ?? DEFAULT_MAX_PAGES
  let after: string | null = null
  let calls = 0
  let rows = 0
  for (let page = 0; page < maxPages; page++) {
    let read
    try {
      read = await metaReadOne<{ data?: unknown[]; paging?: { cursors?: { after?: unknown }; next?: unknown } }>(target, {
        operation: input.operation, path: input.path, query: { ...(input.query ?? {}), ...(after ? { after } : {}) }, triggeredBy: input.triggeredBy,
      })
    } catch (err) {
      if (err instanceof MetaReadError) throw new MetaReadError(err.failure, err.operation, calls + err.callsSpent)
      throw err
    }
    calls += read.calls
    const data = Array.isArray(read.body.data) ? read.body.data.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object') : []
    rows += data.length
    onRows(data)
    const next = typeof read.body.paging?.cursors?.after === 'string' ? read.body.paging.cursors.after : null
    if (!next || !read.body.paging?.next) return { rows, calls, truncated: false }
    after = next
  }
  return { rows, calls, truncated: true }
}
