import { ValidationError } from '@nexus/factory-domain/core/errors'
import { idempotencyKeyFrom, IDEMPOTENCY_KEY_HEADER } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { stateContract, tickContract, workOrderChecklistsContract } from './contract'
import { manifest } from './manifest'
import { tickStep } from './tick'
import { checklistState, workOrderChecklists } from './views'

/**
 * Steps in an operation (B-W2b-47; MES-102): what stands on a bundle at an operation, a tick (its Idempotency-Key, when
 * sent, is the clientEventId; 201 recorded, 200 a resend or the same outcome again), one bundle's ticks in the office.
 * Finish is held by the scans' report (scans/hooks/checklist.ts). Offline a tick queues as production.checklist.tick.
 */
export default defineRoutes('production.checklists', manifest, async (app) => {
  app.get('/production/checklists/state', { schema: stateContract }, async (request) => checklistState(request, request.query))

  app.post('/production/checklists/tick', { schema: tickContract }, async (request, reply) => {
    const header = idempotencyKeyFrom(request)
    if (header !== undefined && header !== request.body.clientEventId) {
      throw new ValidationError('The Idempotency-Key is the tick’s clientEventId: send the same value, or no header.', [{ path: `headers/${IDEMPOTENCY_KEY_HEADER}`, message: 'Must equal body.clientEventId.' }])
    }
    const { replayed, ...answer } = await tickStep(request, request.body)
    return reply.code(replayed ? 200 : 201).send(answer)
  })

  app.get('/production/checklists/work-orders/:workOrderId', { schema: workOrderChecklistsContract }, async (request) => workOrderChecklists(request, request.params.workOrderId, request.query.bundleId))
})
