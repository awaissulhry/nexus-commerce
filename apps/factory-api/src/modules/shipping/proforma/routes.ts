import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { processFiles } from '../../../platform/files/service'
import { listProformasContract, makeProformaContract } from './contract'
import { manifest } from './manifest'
import { listProformas, makeProforma } from './proforma'

/**
 * The proforma invoice (B-W2b-391; LOG-058): a shipment's (customs), a sample shipment's or a deposit request's (prepayment),
 * with its own PF number; read its versions, make one.
 */
export default defineRoutes('shipping.proforma', manifest, async (app) => {
  app.get('/shipping/proformas', { schema: listProformasContract }, async (request) => listProformas(request, request.query))

  app.post('/shipping/proformas', { schema: makeProformaContract }, async (request, reply) => {
    const { status, proforma } = await makeProforma(processFiles(), request, request.body, idempotencyKeyFrom(request))
    return reply.code(status).send({ proforma })
  })
})
