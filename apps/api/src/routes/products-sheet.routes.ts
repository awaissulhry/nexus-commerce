/**
 * MS.1 + MS.2 — the MASTER SHEET's read endpoints, one market at a time.
 *
 * `docs/2026-08-29-master-sheet-design.md`. The sheet is the SOURCE: one row per product or
 * variation, one column per master attribute, and beside them what each channel in the market would
 * do with the row right now. Writes do NOT live here — the sheet autosaves through the existing
 * `PATCH /api/products/bulk`, which is already the cell path (rate-limited for typing, per-cell
 * structured errors, `attr_*` into `categoryAttributes`, 409 on a version conflict).
 *
 * Routes (mounted under /api, so the `/api/products` RBAC prefix rule already maps them to
 * products:view on a GET — a new route is invisible until it is mapped):
 *
 *   GET  /products/sheet/columns?market=IT&productTypes=COAT,GLOVES
 *   GET  /products/sheet?market=IT&page=1&limit=25&search=&status=&productTypes=&parentIds=
 *   POST /products/sheet/publish-preview  { ids[], channel, marketplace }
 *
 * The column set is cached in-process for five minutes: it is derived from the 24 h-cached Amazon
 * schema plus the eBay aspect table, and rebuilding it per page load would put the manifest
 * derivation on every keystroke of the sheet's search box.
 */
import type { FastifyPluginAsync } from 'fastify'

import { getSheetColumns, UnknownMarketError } from '../services/pim/sheet-columns.service.js'
import { getSheetRows } from '../services/pim/sheet-rows.service.js'
import { previewPublish } from '../services/pim/sheet-publish.service.js'
import { TtlCache } from '../utils/ttl-cache.js'

const columnCache = new TtlCache<Awaited<ReturnType<typeof getSheetColumns>>>({ ttlMs: 5 * 60_000, maxEntries: 64 })

/** `?productTypes=A,B` or repeated `?productTypes=A&productTypes=B`, both normalised. */
function csv(v: unknown): string[] {
  if (v === undefined || v === null) return []
  const parts = Array.isArray(v) ? v : [v]
  return [...new Set(parts.flatMap((p) => String(p).split(',')).map((s) => s.trim()).filter(Boolean))]
}

const productsSheetRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * The sheet's columns for a market. `productTypes` narrows the Amazon union manifest; with none,
   * the schema-derived attributes are absent and only the master's own shape comes back — honest,
   * and the caller can say so, rather than us inventing a column set.
   */
  fastify.get('/products/sheet/columns', async (request, reply) => {
    const q = request.query as Record<string, unknown>
    const market = String(q.market ?? '').trim().toUpperCase()
    if (!market) return reply.code(400).send({ error: 'market is required', hint: 'e.g. ?market=IT' })

    const productTypes = csv(q.productTypes)
    const key = `${market}:${productTypes.slice().sort().join(',')}`
    const force = q.force === '1' || q.force === 'true'

    const hit = force ? undefined : columnCache.get(key)
    if (hit) {
      reply.header('X-Sheet-Columns-Cache', 'hit')
      return hit
    }

    try {
      const set = await getSheetColumns({ market, productTypes })
      columnCache.set(key, set)
      reply.header('X-Sheet-Columns-Cache', 'miss')
      reply.header('Cache-Control', 'private, max-age=300')
      return set
    } catch (err) {
      if (err instanceof UnknownMarketError) return reply.code(400).send({ error: err.code, message: err.message, knownMarkets: err.known })
      request.log.error({ err, market, productTypes }, '[sheet] column build failed')
      return reply.code(500).send({ error: 'sheet_columns_failed', message: err instanceof Error ? err.message : String(err) })
    }
  })

  /**
   * One page of FAMILIES — a parent followed by its variations, never split across a page boundary,
   * because a colour × size grid that is half on the next page makes the fill handle lie.
   */
  fastify.get('/products/sheet', async (request, reply) => {
    const q = request.query as Record<string, unknown>
    const market = String(q.market ?? '').trim().toUpperCase()
    if (!market) return reply.code(400).send({ error: 'market is required', hint: 'e.g. ?market=IT' })

    const page = Number(q.page ?? 1)
    const limit = Number(q.limit ?? 25)
    if (!Number.isFinite(page) || page < 1) return reply.code(400).send({ error: 'page must be a positive integer' })
    if (!Number.isFinite(limit) || limit < 1 || limit > 200) return reply.code(400).send({ error: 'limit must be between 1 and 200' })

    try {
      const t0 = Date.now()
      const result = await getSheetRows({
        market,
        page,
        limit,
        search: q.search ? String(q.search) : undefined,
        status: q.status ? String(q.status) : undefined,
        productTypes: csv(q.productTypes),
        parentIds: csv(q.parentIds),
      })
      // The sheet's own honesty: it reports how long its read took, so a slow market is visible
      // rather than being felt as "the grid is laggy".
      reply.header('Server-Timing', `sheet;dur=${Date.now() - t0}`)
      return result
    } catch (err) {
      if (err instanceof UnknownMarketError) return reply.code(400).send({ error: err.code, message: err.message, knownMarkets: err.known })
      request.log.error({ err, market }, '[sheet] row read failed')
      return reply.code(500).send({ error: 'sheet_rows_failed', message: err instanceof Error ? err.message : String(err) })
    }
  })

  /**
   * MS.5 — what a publish WOULD do, per row. Makes no channel call: a row whose readiness has errors
   * is refused here with its fields named, rather than spending an API call to be told the same
   * thing. The real send stays on `POST /api/products/:id/publish-amazon`, which the sheet calls only
   * after an operator has read this and confirmed. A POST, so RBAC maps it to products:edit.
   */
  fastify.post('/products/sheet/publish-preview', async (request, reply) => {
    const body = (request.body ?? {}) as { ids?: unknown; channel?: unknown; marketplace?: unknown }
    const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : []
    const channel = String(body.channel ?? '').trim().toUpperCase()
    const marketplace = String(body.marketplace ?? '').trim().toUpperCase()

    if (ids.length === 0) return reply.code(400).send({ error: 'ids[] is required' })
    if (ids.length > 200) return reply.code(400).send({ error: `max 200 rows per preview (got ${ids.length})` })
    if (!channel || !marketplace) return reply.code(400).send({ error: 'channel and marketplace are required', hint: 'e.g. { channel: "AMAZON", marketplace: "IT" }' })

    try {
      return await previewPublish({ ids, channel, marketplace })
    } catch (err) {
      if (err instanceof UnknownMarketError) return reply.code(400).send({ error: err.code, message: err.message, knownMarkets: err.known })
      request.log.error({ err, channel, marketplace }, '[sheet] publish preview failed')
      return reply.code(500).send({ error: 'publish_preview_failed', message: err instanceof Error ? err.message : String(err) })
    }
  })
}

export default productsSheetRoutes
