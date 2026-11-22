import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { acceptAskContract, answerAskContract, askAgainContract, cancelAskContract, changeAskContract, chaseAskContract, makeAskContract, reassignAskContract } from './contract'
import { acceptAsk, answerAsk, askAgain, cancelAsk, changeAsk, chaseAsk, makeAsk, reassignAsk } from './file-asks'
import { manifest } from './manifest'
import { askChoices, askChoicesContract } from './choices' // B-OF-035

/**
 * Ask for a file on a sales order (order files tab B-OF-031): make one, change its words or due day, ask someone else, cancel it with
 * a reason; send the files for it, accept them or ask again, ask for an update. Loaded by its folder (core/autoload.ts: a module part one level under modules/sales).
 */
export default defineRoutes('sales.file-asks', manifest, async (app) => {
  app.post('/sales/orders/:orderId/file-asks', { schema: makeAskContract }, async (request, reply) => reply.code(201).send(await makeAsk(request, request.params.orderId, request.body, idempotencyKeyFrom(request))))

  app.patch('/sales/orders/:orderId/file-asks/:askId', { schema: changeAskContract }, async (request) => changeAsk(request, request.params.orderId, request.params.askId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/orders/:orderId/file-asks/:askId/reassign', { schema: reassignAskContract }, async (request) => reassignAsk(request, request.params.orderId, request.params.askId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/orders/:orderId/file-asks/:askId/cancel', { schema: cancelAskContract }, async (request) => cancelAsk(request, request.params.orderId, request.params.askId, request.body, idempotencyKeyFrom(request)))

  // S2.2: send the files for this ask, accept them or ask again (why), ask for an update.
  app.post('/sales/orders/:orderId/file-asks/:askId/answer', { schema: answerAskContract }, async (request) => answerAsk(request, request.params.orderId, request.params.askId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/orders/:orderId/file-asks/:askId/accept', { schema: acceptAskContract }, async (request) => acceptAsk(request, request.params.orderId, request.params.askId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/orders/:orderId/file-asks/:askId/ask-again', { schema: askAgainContract }, async (request) => askAgain(request, request.params.orderId, request.params.askId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/orders/:orderId/file-asks/:askId/chase', { schema: chaseAskContract }, async (request) => chaseAsk(request, request.params.orderId, request.params.askId, request.body, idempotencyKeyFrom(request)))

  // B-OF-035 (S3): the people, office roles, floor roles, teams, lines, work orders and steps the "Ask for a file…" window may pick.
  app.get('/sales/orders/:orderId/file-asks/choices', { schema: askChoicesContract }, async (request) => askChoices(request, request.params.orderId))
})
