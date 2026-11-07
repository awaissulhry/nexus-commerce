import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { processFiles } from '../../../platform/files/service'
import { AUTH_RATE_LIMITS } from '../../../platform/auth/sessions/office-auth'
import { inlineDisposition } from '../quotes/preview'
import {
  announceProofContract,
  announceProofVersionContract,
  carryProofsContract,
  completeProofContract,
  linkProofContract,
  listProofsContract,
  orderProofsContract,
  removeProofContract,
  workOrderProofsContract,
} from './contract'
import { linkProofBytes } from './link'
import { manifest } from './manifest'
import { announceProof, announceProofVersion, carryProofs, completeProof, listProofs, removeProof } from './office'
import { orderProofs, workOrderProofs } from './orders'

/**
 * Proofs signed with the quote (B-W2b-165; SAL-199): the office attaches proofs to the quote's unsent version (office.ts),
 * the send freezes them with it (freeze.ts, called by quotes/send.ts), the accept link lists them and the acceptance names
 * each one (link.ts, called by quotes/accept.ts), and the order and its work orders read what was accepted (orders.ts).
 */
export default defineRoutes('sales.quote-proofs', manifest, async (app) => {
  app.get('/sales/quotes/:quoteId/proofs', { schema: listProofsContract }, async (request) => listProofs(request, request.params.quoteId))

  app.post('/sales/quotes/:quoteId/proofs', { schema: announceProofContract }, async (request, reply) =>
    reply.code(201).send(await announceProof(processFiles(), request, request.params.quoteId, request.body, idempotencyKeyFrom(request))),
  )

  app.post('/sales/quotes/:quoteId/proofs/carry', { schema: carryProofsContract }, async (request) => carryProofs(processFiles(), request, request.params.quoteId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/quotes/:quoteId/proofs/:fileId/versions', { schema: announceProofVersionContract }, async (request, reply) =>
    reply.code(201).send(await announceProofVersion(processFiles(), request, request.params.quoteId, request.params.fileId, request.body, idempotencyKeyFrom(request))),
  )

  app.post('/sales/quotes/:quoteId/proofs/:fileId/complete', { schema: completeProofContract }, async (request) => completeProof(processFiles(), request, request.params.quoteId, request.params.fileId, idempotencyKeyFrom(request)))

  app.delete('/sales/quotes/:quoteId/proofs/:fileId', { schema: removeProofContract }, async (request) => removeProof(processFiles(), request, request.params.quoteId, request.params.fileId, idempotencyKeyFrom(request)))

  app.get('/sales/orders/:orderId/proofs', { schema: orderProofsContract }, async (request) => orderProofs(request, request.params.orderId))

  app.get('/production/work-orders/:workOrderId/proofs', { schema: workOrderProofsContract }, async (request) => workOrderProofs(request, request.params.workOrderId))

  const linkUse = app.officeAuth?.rateLimits.linkUse ?? AUTH_RATE_LIMITS.linkUse
  app.get('/link/quote/proofs/:fileId', { schema: linkProofContract, config: { rateLimit: { max: linkUse.max, timeWindow: linkUse.timeWindowMs } } }, async (request, reply) => {
    const { bytes, contentType, fileName } = await linkProofBytes(request, request.params.fileId)
    return reply.type(contentType).header('content-disposition', inlineDisposition(fileName)).header('cache-control', 'no-store').send(bytes)
  })
})
