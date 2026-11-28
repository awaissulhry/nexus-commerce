import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { orderTeamsContract, putOrderTeamsContract, teamAskContract, teamsBoardContract } from './contract'
import { manifest } from './manifest'
import { orderTeams, teamsBoard } from './read'
import { askForTeam, putOrderTeams } from './write'

/** An order's teams (./read.ts, ./write.ts) and a site's teams board (./read.ts). Each write is one command with an Idempotency-Key. */
export default defineRoutes('production.order-teams', manifest, async (app) => {
  app.get('/production/orders/:orderId/teams', { schema: orderTeamsContract }, async (request) => orderTeams(request, request.params.orderId))
  app.put('/production/orders/:orderId/teams', { schema: putOrderTeamsContract }, async (request) => putOrderTeams(request, request.params.orderId, request.body, idempotencyKeyFrom(request)))
  app.post('/production/orders/:orderId/team-asks', { schema: teamAskContract }, async (request, reply) => {
    const { replayed, ...answer } = await askForTeam(request, request.params.orderId, request.body, idempotencyKeyFrom(request))
    return reply.code(replayed ? 200 : 201).send(answer)
  })
  app.get('/production/teams/board', { schema: teamsBoardContract }, async (request) => teamsBoard(request, request.query.siteId))
})
