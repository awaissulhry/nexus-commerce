import { defineRoutes } from '../../../core/manifest'
import { chainContract, chainReportContract, chainsContract } from './contract'
import { chainOf, chains, reportOnChain } from './chains'
import { manifest } from './manifest'

/** Chains (owb- order workflow, S5 fl4 step 3): the lines, one line's WIP per size × step, and "+12" (./chains.ts). */
export default defineRoutes('production.chains', manifest, async (app) => {
  app.get('/production/chains', { schema: chainsContract }, async (request) => chains(request))

  app.get('/production/chains/:lineId', { schema: chainContract }, async (request) => chainOf(request, request.params.lineId, request.query))

  app.post('/production/chains/report', { schema: chainReportContract }, async (request, reply) => {
    const answer = await reportOnChain(request, request.body)
    return reply.code(answer.replayed ? 200 : 201).send(answer)
  })
})
