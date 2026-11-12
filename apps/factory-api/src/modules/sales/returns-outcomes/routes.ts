import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { processFiles } from '../../../platform/files/service'
import { askRemakeContract, finishContract, linkRemakeContract, outcomesContract, portalRemakeContract, sendBackContract, splitContract } from './contract'
import { finishReturn } from './finish'
import { manifest } from './manifest'
import { getOutcomes } from './outcomes'
import { askRemake, linkAskRemake, portalAskRemake } from './remake'
import { sendBack } from './send-back'
import { splitLine } from './split'

/**
 * Remakes, exchanges and closing a return (B-W2b-346): the outcomes read (./outcomes.ts), a line split on a partial receipt
 * (./split.ts), goods sent back unchanged with the return DDT (./send-back.ts), the close with a finish reason
 * (./finish.ts), a remake asked with photos from the office, the portal and a claim link (./remake.ts). The size exchange
 * is W2a's decision and replacement order (returns/decide.ts and replacement.ts take SIZE_EXCHANGE, ./exchange.ts checks
 * the size).
 */
export default defineRoutes('sales.returns-outcomes', manifest, async (app) => {
  app.get('/sales/returns/:returnId/outcomes', { schema: outcomesContract }, async (request) => getOutcomes(request, request.params.returnId))
  app.post('/sales/returns/:returnId/lines/:lineId/split', { schema: splitContract }, async (request) => splitLine(request, request.params.returnId, request.params.lineId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/returns/:returnId/send-back', { schema: sendBackContract }, async (request) =>
    sendBack(processFiles(), request, request.params.returnId, request.body, idempotencyKeyFrom(request), (error) => request.log.error({ err: error }, 'returns-outcomes: the return DDT PDF was not stored')),
  )
  app.post('/sales/returns/:returnId/finish', { schema: finishContract }, async (request) => finishReturn(request, request.params.returnId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/returns/:returnId/remake', { schema: askRemakeContract }, async (request) => askRemake(request, request.params.returnId, request.body, idempotencyKeyFrom(request)))
  app.post('/portal/returns/remake', { schema: portalRemakeContract }, async (request, reply) => reply.code(201).send(await portalAskRemake(app, request, request.body, idempotencyKeyFrom(request))))
  app.post('/link/claim/remake', { schema: linkRemakeContract }, async (request, reply) => reply.code(201).send(await linkAskRemake(app, request, request.body, request.query.language)))
})
