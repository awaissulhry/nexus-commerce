/**
 * Delete rows from the product sheet (Owner, 2026-10-06) — the doors of `sheet-delete-rows.service.ts`.
 *
 *   POST /api/products/:id/sheet-rows/delete/preview  { rows: [{ productId, aliasId }] }
 *        → what the delete does: products to the recycle bin, extra listings archived, rows refused and why   products.view
 *   POST /api/products/:id/sheet-rows/delete/run      { rows, expected: { products, aliases } }
 *        → the same plan read again in one transaction; refused when it no longer matches `expected`         products.delete
 *   POST /api/products/:id/sheet-rows/restore         { products, aliases }  → the Undo                         products.delete
 *
 * Nothing here reaches a channel. No database access here — the service owns it.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import {
  SheetDeleteError, deleteSheetRows, parseSheetDeleteExpected, parseSheetDeleteRows, previewSheetDelete, restoreSheetRows,
} from '../services/pim/sheet-delete-rows.service.js'
import { ProductRelationshipError } from '../services/pim/product-relationship.service.js'

function sendError(reply: FastifyReply, request: FastifyRequest, err: unknown) {
  if (err instanceof SheetDeleteError) return reply.code(err.statusCode).send({ error: err.code, message: err.message })
  // A Serializable conflict: the family changed while the delete ran.
  if (err instanceof ProductRelationshipError) return reply.code(err.statusCode ?? 409).send({ error: 'conflict', message: err.message })
  request.log.error({ err }, 'sheet row delete failed')
  return reply.code(500).send({ error: 'sheet_delete_failed', message: 'The delete could not be read or written. Nothing was assumed; reload the page to see what the sheet holds.' })
}

const userOf = (request: FastifyRequest) => request.authUser?.id ?? null

const sheetDeleteRowsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Params: { id: string } }>('/products/:id/sheet-rows/delete/preview', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'no-store')
      return await previewSheetDelete(request.params.id, parseSheetDeleteRows(request.body))
    } catch (err) { return sendError(reply, request, err) }
  })

  fastify.post<{ Params: { id: string } }>('/products/:id/sheet-rows/delete/run', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'no-store')
      const rows = parseSheetDeleteRows(request.body)
      const expected = parseSheetDeleteExpected((request.body as { expected?: unknown } | null)?.expected)
      return await deleteSheetRows(request.params.id, rows, expected, userOf(request))
    } catch (err) { return sendError(reply, request, err) }
  })

  fastify.post<{ Params: { id: string } }>('/products/:id/sheet-rows/restore', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'no-store')
      return await restoreSheetRows(request.params.id, parseSheetDeleteExpected(request.body), userOf(request))
    } catch (err) { return sendError(reply, request, err) }
  })
}

export default sheetDeleteRowsRoutes
