import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { addContract, choicesContract, listContract } from './contract'
import { addExtraOperation, extraChoices, listExtraOperations } from './extra'
import { manifest } from './manifest'

/** An unplanned operation (B-W2b-47; MES-086): what may be added, the add with its reason (201; 200 a resend), the record's list. */
export default defineRoutes('production.extraops', manifest, async (app) => {
  app.get('/production/extra-operations/work-orders/:workOrderId', { schema: listContract }, async (request) => listExtraOperations(request, request.params.workOrderId))

  app.get('/production/extra-operations/work-orders/:workOrderId/choices', { schema: choicesContract }, async (request) => extraChoices(request, request.params.workOrderId))

  app.post('/production/extra-operations/work-orders/:workOrderId', { schema: addContract }, async (request, reply) => {
    const { record, replayed } = await addExtraOperation(request, request.params.workOrderId, request.body, idempotencyKeyFrom(request))
    return reply.code(replayed ? 200 : 201).send(record)
  })
})
