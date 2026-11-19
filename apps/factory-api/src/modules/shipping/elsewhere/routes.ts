import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { elsewherePreviewContract, recordElsewhereContract } from './contract'
import { previewElsewhere, recordElsewhere } from './elsewhere'
import { manifest } from './manifest'

/**
 * B-OP-032 (order page N5; R-2, R-9, R-10, R-23): goods that left with a paper DDT written outside Nexus, recorded in one
 * command — the preview first (what it would say, nothing written), then the recording (a shipment made ELSEWHERE, SHIPPED at
 * the time it left; Nexus issues no DDT of it).
 */
export default defineRoutes('shipping.elsewhere', manifest, async (app) => {
  app.post('/shipping/shipments/elsewhere/preview', { schema: elsewherePreviewContract }, async (request) => previewElsewhere(request, request.body))

  app.post('/shipping/shipments/elsewhere', { schema: recordElsewhereContract }, async (request, reply) => reply.code(201).send(await recordElsewhere(request, request.body, idempotencyKeyFrom(request))))
})
