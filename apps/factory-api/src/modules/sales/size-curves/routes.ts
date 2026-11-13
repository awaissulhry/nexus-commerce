import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { createCurveContract, curveStatusContract, getCurveContract, listCurvesContract, updateCurveContract } from './contract'
import { createCurve, getCurve, listCurves, setCurveStatus, updateCurve } from './curves'
import { manifest } from './manifest'

/** Size curves (B-W2b-302; SAL-269): the saved percent curves a quote line is filled from (POST …/lines/fill). */
export default defineRoutes('sales.sizeCurves', manifest, async (app) => {
  app.get('/sales/size-curves', { schema: listCurvesContract }, async (request) => listCurves(request, request.query))

  app.get('/sales/size-curves/:curveId', { schema: getCurveContract }, async (request) => getCurve(request, request.params.curveId))

  app.post('/sales/size-curves', { schema: createCurveContract }, async (request, reply) => reply.code(201).send(await createCurve(request, request.body, idempotencyKeyFrom(request))))

  app.patch('/sales/size-curves/:curveId', { schema: updateCurveContract }, async (request) => updateCurve(request, request.params.curveId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/size-curves/status', { schema: curveStatusContract }, async (request) => setCurveStatus(request, request.body, idempotencyKeyFrom(request)))
})
