import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  createStandardContract,
  discardStandardContract,
  freezeStandardContract,
  listStandardsContract,
  prepareStandardsContract,
  standardContract,
  updateStandardContract,
} from './contract'
import { manifest } from './manifest'
import { createStandard, discardStandard, freezeStandard, listStandards, prepareStandards, standardRecord, updateStandard } from './standards'

/**
 * Standard cost per item (B-W2a-21; FIN-024; design finance.costing "Standard cost per item"): the list and one standard
 * with how it was built; prepare DRAFTs for a period (a garment from its cost sheet, a material from its standard
 * purchase price), type one, correct or discard a DRAFT, freeze it (the one before it ends; receipts that waited for a
 * standard are valued and their work orders' completions posted). A repeated Idempotency-Key answers from its receipt.
 */
export default defineRoutes('costing.standards', manifest, async (app) => {
  app.get('/costing/standards', { schema: listStandardsContract }, async (request) => listStandards(request, request.query))

  app.get('/costing/standards/:standardId', { schema: standardContract }, async (request) => ({ standard: await standardRecord(request, request.params.standardId) }))

  app.post('/costing/standards', { schema: createStandardContract }, async (request, reply) =>
    reply.code(201).send({ standard: await createStandard(request, request.body, idempotencyKeyFrom(request)) }),
  )

  app.post('/costing/standards/prepare', { schema: prepareStandardsContract }, async (request) => prepareStandards(request, request.body, idempotencyKeyFrom(request)))

  app.patch('/costing/standards/:standardId', { schema: updateStandardContract }, async (request) => ({
    standard: await updateStandard(request, request.params.standardId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/costing/standards/:standardId/discard', { schema: discardStandardContract }, async (request) =>
    discardStandard(request, request.params.standardId, request.body.version, idempotencyKeyFrom(request)),
  )

  app.post('/costing/standards/:standardId/freeze', { schema: freezeStandardContract }, async (request) =>
    freezeStandard(request, request.params.standardId, request.body.version, idempotencyKeyFrom(request)),
  )
})
