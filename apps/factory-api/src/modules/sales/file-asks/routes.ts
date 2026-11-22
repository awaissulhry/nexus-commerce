import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { cancelAskContract, changeAskContract, makeAskContract, reassignAskContract } from './contract'
import { cancelAsk, changeAsk, makeAsk, reassignAsk } from './file-asks'
import { manifest } from './manifest'

/**
 * Ask for a file on a sales order (order files tab B-OF-031): make one, change its words or due day, ask someone else, cancel it with
 * a reason. Loaded by its folder (core/autoload.ts: a module part one level under modules/sales).
 */
export default defineRoutes('sales.file-asks', manifest, async (app) => {
  app.post('/sales/orders/:orderId/file-asks', { schema: makeAskContract }, async (request, reply) => reply.code(201).send(await makeAsk(request, request.params.orderId, request.body, idempotencyKeyFrom(request))))

  app.patch('/sales/orders/:orderId/file-asks/:askId', { schema: changeAskContract }, async (request) => changeAsk(request, request.params.orderId, request.params.askId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/orders/:orderId/file-asks/:askId/reassign', { schema: reassignAskContract }, async (request) => reassignAsk(request, request.params.orderId, request.params.askId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/orders/:orderId/file-asks/:askId/cancel', { schema: cancelAskContract }, async (request) => cancelAsk(request, request.params.orderId, request.params.askId, request.body, idempotencyKeyFrom(request)))
})
