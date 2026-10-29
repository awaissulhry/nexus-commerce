import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { archiveOperationContract, createOperationContract, getOperationContract, listOperationsContract, reactivateOperationContract, updateOperationContract } from './contract'
import { manifest } from './manifest'
import { createOperation, getOperation, listOperations, moveOperation, updateOperation } from './operations'

/**
 * The operation library (product module, B-W1-14; A2 SCR-049; features PRD-109, PRD-111): what is done, at which kind
 * of work centre, on which machine, with which skill and in how many standard minutes per garment; where each is used.
 * A routing step copies an operation (modules/product/routing); the library never changes a routing.
 */
export default defineRoutes('product.operations', manifest, async (app) => {
  app.get('/product/operations', { schema: listOperationsContract }, async (request) => listOperations(request, request.query))

  app.get('/product/operations/:operationId', { schema: getOperationContract }, async (request) => ({ operation: await getOperation(request, request.params.operationId) }))

  app.post('/product/operations', { schema: createOperationContract }, async (request, reply) =>
    reply.code(201).send({ operation: await createOperation(request, request.body, idempotencyKeyFrom(request)) }),
  )

  app.patch('/product/operations/:operationId', { schema: updateOperationContract }, async (request) => ({
    operation: await updateOperation(request, request.params.operationId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/product/operations/:operationId/archive', { schema: archiveOperationContract }, async (request) => ({
    operation: await moveOperation(request, request.params.operationId, 'ARCHIVED', request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/product/operations/:operationId/reactivate', { schema: reactivateOperationContract }, async (request) => ({
    operation: await moveOperation(request, request.params.operationId, 'ACTIVE', request.body, idempotencyKeyFrom(request)),
  }))
})
