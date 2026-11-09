import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { createTypeContract, getTypeContract, listTypesContract, readStyleTypeContract, setStyleTypeContract, typeStatusContract, updateTypeContract } from './contract'
import { manifest } from './manifest'
import { createType, getType, listTypes, moveType, readStyleType, setStyleType, updateType } from './types'

/**
 * Product types (B-W2b-221; PRD-008 product types with inherited attributes): the types with what they inherit, their writes,
 * and a style's type (./types.ts). A new style takes its type's defaults in W1's create (styles/styles.ts).
 */
export default defineRoutes('product.types', manifest, async (app) => {
  app.get('/product/types', { schema: listTypesContract }, async (request) => ({ types: await listTypes(request, request.query) }))
  app.get('/product/types/:typeId', { schema: getTypeContract }, async (request) => ({ type: await getType(request, request.params.typeId) }))
  app.post('/product/types', { schema: createTypeContract }, async (request, reply) => reply.code(201).send({ type: await createType(request, request.body, idempotencyKeyFrom(request)) }))
  app.patch('/product/types/:typeId', { schema: updateTypeContract }, async (request) => ({ type: await updateType(request, request.params.typeId, request.body, idempotencyKeyFrom(request)) }))
  app.post('/product/types/:typeId/archive', { schema: typeStatusContract }, async (request) => ({ type: await moveType(request, request.params.typeId, 'archive', request.body, idempotencyKeyFrom(request)) }))
  app.post('/product/types/:typeId/restore', { schema: typeStatusContract }, async (request) => ({ type: await moveType(request, request.params.typeId, 'restore', request.body, idempotencyKeyFrom(request)) }))
  app.get('/product/styles/:styleId/type', { schema: readStyleTypeContract }, async (request) => ({ styleType: await readStyleType(request, request.params.styleId) }))
  app.put('/product/styles/:styleId/type', { schema: setStyleTypeContract }, async (request) => ({ styleType: await setStyleType(request, request.params.styleId, request.body, idempotencyKeyFrom(request)) }))
})
