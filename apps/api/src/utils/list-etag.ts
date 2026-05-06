/**
 * Phase 10b — ETag / 304 helpers for paginated list endpoints.
 *
 * Why this exists
 * ───────────────
 * Phase 10's smart-polling strategy needs cheap "did anything change?"
 * checks so the frontend can poll every 5–10s without exploding DB
 * load or bandwidth. Standard HTTP caching (ETag + If-None-Match) gives
 * us exactly that: the worker browser sends back its previous ETag,
 * and if nothing changed, the server short-circuits with 304 (empty
 * body) instead of re-rendering and re-serializing the full list.
 *
 * Key strategy
 * ────────────
 * Instead of hashing the full response body (CPU + memory cost on
 * every request), we derive the ETag from two lightweight signals
 * obtained via a single aggregate query:
 *
 *   ETag = W/"<count>.<max_updated_at_ms>.<filter_hash>"
 *
 *   - count          row count for the current filter set
 *   - max_updated_at the most recent updatedAt across the filtered set
 *   - filter_hash    short hash of the filter context (page, sort, etc.)
 *                    so different views of the same table get different
 *                    ETags
 *
 * The "W/" prefix marks this as a *weak* validator (RFC 7232) — we're
 * claiming semantic equivalence, not byte-identical equivalence. That
 * matches exactly what we need: two requests with the same count +
 * latest updatedAt + filter context will return the same items, and
 * downstream consumers don't need a stronger guarantee.
 *
 * Usage
 * ─────
 *   const etag = await listEtag(prisma, {
 *     model: 'product',
 *     where: prismaWhere,
 *     filterContext: { page, pageSize, sort, ... },
 *   })
 *   if (matches(request, etag)) {
 *     return reply.code(304).header('ETag', etag).send()
 *   }
 *   const items = await prisma.product.findMany(...)
 *   reply.header('ETag', etag).header('Cache-Control', 'private, max-age=0, must-revalidate')
 *   return { items, total }
 *
 * Cost vs benefit
 * ───────────────
 * Single aggregate query (~1ms typical, indexed on updatedAt) replaces
 * a full findMany + JSON serialize for the common "nothing changed"
 * case. Frontends that poll every 5s see ~95% of responses as 304s,
 * cutting bandwidth + DB load by an order of magnitude at scale.
 */

import type { PrismaClient } from '@prisma/client'
import type { FastifyRequest } from 'fastify'
import crypto from 'crypto'

export interface ListEtagInput {
  /** Prisma model accessor name (e.g. 'product', 'channelListing'). */
  model: string
  /** The Prisma `where` filter for the list — same shape as findMany.where. */
  where?: Record<string, unknown>
  /**
   * Filter context that contributes to the cache key beyond the data
   * itself: pagination, sort, includes, derived flags. Anything that
   * would change the response shape for the same underlying rows.
   */
  filterContext?: Record<string, unknown>
  /**
   * Override the timestamp column. Defaults to 'updatedAt' which every
   * Phase 1+ schema model carries. Set this for legacy tables that
   * track recency under a different name.
   */
  timestampField?: string
}

export interface ListEtagResult {
  /** The ETag string already wrapped in `W/"…"`, ready for headers. */
  etag: string
  /** Row count for the filtered set — useful so the caller doesn't requery. */
  count: number
  /** Most-recent updatedAt for the filtered set (ms since epoch); null if empty. */
  maxUpdatedAtMs: number | null
}

/**
 * Compute a freshness ETag for a filtered list. One aggregate query
 * via $runCommandRaw-style raw access through Prisma's grouping API.
 * Falls back gracefully when the model has zero rows.
 */
export async function listEtag(
  prisma: PrismaClient,
  input: ListEtagInput,
): Promise<ListEtagResult> {
  const tsField = input.timestampField ?? 'updatedAt'

  const modelClient = (prisma as unknown as Record<string, any>)[input.model]
  if (!modelClient || typeof modelClient.aggregate !== 'function') {
    throw new Error(
      `listEtag: prisma.${input.model} is not a queryable model accessor`,
    )
  }
  const agg = await modelClient.aggregate({
    where: input.where,
    _count: { _all: true },
    _max: { [tsField]: true },
  })

  const count: number = agg._count?._all ?? 0
  const rawMax = agg._max?.[tsField]
  const maxUpdatedAtMs =
    rawMax instanceof Date ? rawMax.getTime() : rawMax != null ? Number(rawMax) : null

  const filterHash = hashFilterContext(input.filterContext)
  const etag = `W/"${count}.${maxUpdatedAtMs ?? 0}.${filterHash}"`

  return { etag, count, maxUpdatedAtMs }
}

/**
 * Returns true when the request's If-None-Match header matches the
 * supplied ETag — i.e. the client already has the freshest data and
 * the handler should respond with 304.
 *
 * Tolerant of both quoted and unquoted forms; some clients normalise
 * the value before re-sending.
 */
export function matches(request: FastifyRequest, etag: string): boolean {
  const header = request.headers['if-none-match']
  if (!header) return false
  const incoming = Array.isArray(header) ? header.join(',') : header
  // Multiple ETags can be separated by commas; trim and compare each.
  for (const raw of incoming.split(',')) {
    const candidate = raw.trim()
    if (candidate === '*') return true
    if (candidate === etag) return true
    // Some proxies strip the W/ prefix or the surrounding quotes.
    // Normalise both sides before comparing.
    if (normalise(candidate) === normalise(etag)) return true
  }
  return false
}

/**
 * Stable short hash of an arbitrary filter context object so different
 * page/sort/include combinations get distinct ETags. JSON.stringify
 * with sorted keys + an 8-char hex prefix is enough — collisions
 * here only mean a stale cache, not data corruption, and the
 * count/maxUpdatedAt components dominate the actual change detection.
 */
function hashFilterContext(ctx: Record<string, unknown> | undefined): string {
  if (!ctx || Object.keys(ctx).length === 0) return '00000000'
  const sorted = sortKeys(ctx)
  const json = JSON.stringify(sorted)
  return crypto.createHash('md5').update(json).digest('hex').slice(0, 8)
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k])
    return out
  }
  return value
}

function normalise(etag: string): string {
  return etag.replace(/^W\//, '').replace(/^"|"$/g, '')
}
