/**
 * `POST /api/products` — create one DRAFT product from the Products page's "New product" dialog.
 *
 * Body `{ sku, name, kind: 'single' | 'parent', familyId? }`; answers 201 `{ id, sku }`. A refusal answers 400 or 409
 * with `{ error, code, field }` (and `productId` when the SKU belongs to a live product the person can open), so the
 * dialog shows the sentence under the field it is about. The rules live in `product-create.service.ts`.
 */
import type { FastifyPluginAsync } from 'fastify'
import { createDraftProduct, ProductCreateError } from '../services/products/product-create.service.js'

const productCreateRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/products', async (request, reply) => {
    try {
      const created = await createDraftProduct(request.body, { userId: request.authUser?.id ?? null, ip: request.ip ?? null })
      return reply.code(201).send(created)
    } catch (err) {
      if (err instanceof ProductCreateError) {
        return reply.code(err.statusCode).send({
          error: err.message,
          code: err.statusCode === 409 ? 'DUPLICATE_SKU' : 'INVALID_REQUEST',
          ...(err.field ? { field: err.field } : {}),
          ...(err.productId ? { productId: err.productId } : {}),
        })
      }
      fastify.log.error({ err }, '[products/create] failed')
      return reply.code(500).send({ error: 'The product could not be created. Try again.', code: 'CREATE_FAILED' })
    }
  })
}

export default productCreateRoutes
