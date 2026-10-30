import { defineContract, output } from '@nexus/factory-domain/core/contracts'
import { chooseMethodBody, costingMethodView, methodQuery } from '@nexus/factory-domain/costing/standards/contracts'
import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { manifest } from './manifest'
import { chooseMethod, methodOf } from './method'

/**
 * The costing method (B-W2a-21; FIN-025; c.c. art. 2426): the method in force for a company (or tenant-wide) in words,
 * held once locked, and the accountant's choice (step-up). Nothing here picks a method by itself: UNDECIDED stays until
 * a person chooses, and every cost posted meanwhile is provisional.
 */
const getMethodContract = defineContract({ querystring: methodQuery, response: { 200: output({ method: costingMethodView }) } })
const chooseMethodContract = defineContract({ body: chooseMethodBody, response: { 200: output({ method: costingMethodView }) } })

export default defineRoutes('costing.method', manifest, async (app) => {
  app.get('/costing/method', { schema: getMethodContract }, async (request) => ({ method: await methodOf(request, request.query) }))

  app.put('/costing/method', { schema: chooseMethodContract }, async (request) => {
    requireStepUp(officeAuthOf(app), request)
    return { method: await chooseMethod(request, request.body, idempotencyKeyFrom(request)) }
  })
})
