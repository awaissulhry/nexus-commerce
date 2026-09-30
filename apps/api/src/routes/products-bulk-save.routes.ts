/**
 * POST /api/products/bulk-save — the product sheet's save for one OPERATION (a fill, a paste, an undo).
 *
 *   Body:   { operationId?, units: [{ key, changes, marketplaceContexts?, expectedVersion? }, …] }
 *           Each unit is exactly one `PATCH /api/products/bulk` body plus the client's `key` for it.
 *   Answer: 200 { operationId, saved, failed, elapsedMs, units: [{ key, status, body }] }
 *           — whenever the transaction committed, even if some units were refused. A unit's `status`/`body` are what
 *           its own PATCH would have answered. A whole-operation failure (the database unreachable, a race lost three
 *           times) answers 5xx with `nothingSaved: true` — the transaction rolled back, so the client can say "not saved"
 *           rather than "unknown". A 5xx WITHOUT that flag (a proxy, a crash before the handler) proves nothing.
 *
 * One request per operation, so the rate limit counts operations, not cells. RBAC: a POST under `/api/products` maps to
 * `products:edit` (permissions-manifest.ts, the `/api/products` prefix rule). The business profile comes from the same
 * request hook as every other route, so every read and write inside is row-level secured.
 *
 * `Idempotency-Key` (the client sends its `operationId`) is honoured by `command-idempotency.ts`: a resent operation
 * after a lost connection is answered from the stored result, never applied twice.
 *
 * Why it exists and what it guarantees: `services/products/bulk-save.service.ts`.
 */
import type { FastifyPluginAsync } from 'fastify'

import { applyProductBulkSave, BulkSaveError, parseBulkSaveInput, writeRaceLost } from '../services/products/bulk-save.service.js'
import { WRITE_BUSY } from '../lib/product-bulk-error.js'

const productsBulkSaveRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/products/bulk-save', {
    // A 2,000-row paste with long descriptions is a few MB; the row route's 5 MB was sized for one row's typing burst.
    bodyLimit: 16 * 1024 * 1024,
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    let input
    try {
      input = parseBulkSaveInput(request.body)
    } catch (error) {
      if (error instanceof BulkSaveError) return reply.code(error.statusCode).send(error.details)
      throw error
    }
    let result
    try {
      result = await applyProductBulkSave(input, {
        formulaCascade: false,
        userId: (request as { authUser?: { id?: string } }).authUser?.id,
        ip: request.ip,
        logger: request.log,
      })
    } catch (error) {
      // Nothing of the operation is stored. Say whether sending it again can work: a lost race or a busy pool can.
      request.log.error({ err: error, operationId: input.operationId, units: input.units.length }, '[products/bulk-save] operation failed')
      if (writeRaceLost(error)) return reply.code(503).header('retry-after', '2').send(WRITE_BUSY)
      // A17 — the cause is in the log under this request id; it is never sent.
      return reply.code(500).send({ error: 'Nothing of this change was saved. Try again; if it keeps failing, reload the page.', nothingSaved: true, requestId: request.id })
    }
    request.log.info({ operationId: result.operationId, units: result.units.length, saved: result.saved, failed: result.failed, elapsedMs: result.elapsedMs },
      '[products/bulk-save] operation saved')
    return result
  })
}

export default productsBulkSaveRoutes
