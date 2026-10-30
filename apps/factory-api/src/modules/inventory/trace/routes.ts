import { defineRoutes } from '../../../core/manifest'
import { traceContract, traceFindContract } from './contract'
import { findTraceStart } from './find'
import { manifest } from './manifest'
import { traceFrom } from './trace'

/**
 * The trace both ways (B-W2a-27; SCM-240 backward, SCM-241 forward): the Trace dialog's lookup (one field, any code:
 * the kind is recognised) and the trace tree of a lot, a hide, a bundle, a work order (its batch), a garment serial or a
 * shipment. Read only.
 */
export default defineRoutes('inventory.trace', manifest, async (app) => {
  app.get('/inventory/trace/find', { schema: traceFindContract }, async (request) => findTraceStart(request, request.query.code))
  app.get('/inventory/trace', { schema: traceContract }, async (request) => traceFrom(request, request.query))
})
