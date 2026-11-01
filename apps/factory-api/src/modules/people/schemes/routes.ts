import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { activateContract, createSchemeContract, deleteContract, endContract, exampleContract, schemeContract, schemesContract, updateSchemeContract } from './contract'
import { example } from './example'
import { manifest } from './manifest'
import { scheme, schemes } from './store'
import { activateScheme, createScheme, deleteScheme, endScheme, updateScheme } from './writes'

/**
 * Incentive schemes (B-W2b-38; W2b plan §3 GATE-PIECE-PAY; MES-253, MES-257, MES-258, MES-259; c.c. arts. 2100-2101 and
 * the CCNL minimum): how pay is computed for a company or a line — make-up to the guaranteed hourly pay, what rework and
 * scrap pay, how a team's pay splits, how waiting is paid — drafted, started (the scheme before it ends the day before),
 * ended, and tried on made-up figures. The legal switch of piece pay (B-W2b-34) names one as its SCHEME precondition;
 * the period run (B-W2b-43) computes with factory-domain people/schemes/pay. The screens are B-W2b-62's.
 */
export default defineRoutes('people.schemes', manifest, async (app) => {
  app.get('/people/incentive-schemes', { schema: schemesContract }, async (request) => schemes(request, request.query))
  app.post('/people/incentive-schemes', { schema: createSchemeContract }, async (request, reply) => {
    const { replayed, ...answer } = await createScheme(request, request.body, idempotencyKeyFrom(request))
    return reply.code(replayed ? 200 : 201).send(answer)
  })
  app.get('/people/incentive-schemes/:schemeId', { schema: schemeContract }, async (request) => scheme(request, request.params.schemeId))
  app.patch('/people/incentive-schemes/:schemeId', { schema: updateSchemeContract }, async (request) => updateScheme(request, request.params.schemeId, request.body, idempotencyKeyFrom(request)))
  app.delete('/people/incentive-schemes/:schemeId', { schema: deleteContract }, async (request) => deleteScheme(request, request.params.schemeId, request.query, idempotencyKeyFrom(request)))
  app.post('/people/incentive-schemes/:schemeId/activate', { schema: activateContract }, async (request) => activateScheme(request, request.params.schemeId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/incentive-schemes/:schemeId/end', { schema: endContract }, async (request) => endScheme(request, request.params.schemeId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/incentive-schemes/:schemeId/example', { schema: exampleContract }, async (request) => example(request, request.params.schemeId, request.body))
})
