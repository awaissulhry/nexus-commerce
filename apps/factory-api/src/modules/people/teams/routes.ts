import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  applyMovesContract,
  archiveAreaContract,
  archiveTeamContract,
  createAreaContract,
  createLoanContract,
  createTeamContract,
  endLoanContract,
  listLoansContract,
  listTeamsContract,
  myTeamsContract,
  orgTreeContract,
  previewMovesContract,
  removeLoanContract,
  setLeadContract,
  setLineAreaContract,
  teamRecordContract,
  updateAreaContract,
  updateTeamContract,
} from './contract'
import { createLoan, endLoan, listLoans, removeLoan } from './loans'
import { manifest } from './manifest'
import { archiveArea, createArea, orgTree, setLineArea, updateArea } from './org'
import { applyMoves, archiveTeam, createTeam, listTeams, myTeams, previewMoves, setLead, teamRecord, updateTeam } from './teams'

/** Lines, teams and leads (./teams.ts), loans (./loans.ts), the org tree (./org.ts). Each write is one command with an Idempotency-Key. */
export default defineRoutes('people.teams', manifest, async (app) => {
  app.get('/people/teams', { schema: listTeamsContract }, async (request) => listTeams(request, request.query))
  app.get('/people/teams/mine', { schema: myTeamsContract }, async (request) => myTeams(request))
  app.get('/people/teams/:teamId', { schema: teamRecordContract }, async (request) => teamRecord(request, request.params.teamId))
  app.post('/people/teams', { schema: createTeamContract }, async (request, reply) => {
    const { replayed, ...answer } = await createTeam(request, request.body, idempotencyKeyFrom(request))
    return reply.code(replayed ? 200 : 201).send(answer)
  })
  app.patch('/people/teams/:teamId', { schema: updateTeamContract }, async (request) => updateTeam(request, request.params.teamId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/teams/:teamId/archive', { schema: archiveTeamContract }, async (request) => archiveTeam(request, request.params.teamId, request.body, idempotencyKeyFrom(request)))
  app.put('/people/teams/:teamId/lead', { schema: setLeadContract }, async (request) => setLead(request, request.params.teamId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/teams/moves/preview', { schema: previewMovesContract }, async (request) => previewMoves(request, request.body))
  app.post('/people/teams/moves', { schema: applyMovesContract }, async (request) => applyMoves(request, request.body, idempotencyKeyFrom(request)))

  app.get('/people/loans', { schema: listLoansContract }, async (request) => listLoans(request, request.query))
  app.post('/people/loans', { schema: createLoanContract }, async (request, reply) => {
    const { replayed, ...answer } = await createLoan(request, request.body, idempotencyKeyFrom(request))
    return reply.code(replayed ? 200 : 201).send(answer)
  })
  app.post('/people/loans/:loanId/end', { schema: endLoanContract }, async (request) => endLoan(request, request.params.loanId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/loans/:loanId/remove', { schema: removeLoanContract }, async (request) => removeLoan(request, request.params.loanId, request.body, idempotencyKeyFrom(request)))

  app.get('/org/tree', { schema: orgTreeContract }, async (request) => orgTree(request, request.query))
  app.post('/org/sites/:siteId/areas', { schema: createAreaContract }, async (request, reply) => {
    const { replayed, ...answer } = await createArea(request, request.params.siteId, request.body, idempotencyKeyFrom(request))
    return reply.code(replayed ? 200 : 201).send(answer)
  })
  app.patch('/org/areas/:areaId', { schema: updateAreaContract }, async (request) => updateArea(request, request.params.areaId, request.body, idempotencyKeyFrom(request)))
  app.post('/org/areas/:areaId/archive', { schema: archiveAreaContract }, async (request) => archiveArea(request, request.params.areaId, request.body, idempotencyKeyFrom(request)))
  app.put('/org/lines/:lineId/area', { schema: setLineAreaContract }, async (request) => setLineArea(request, request.params.lineId, request.body, idempotencyKeyFrom(request)))
})
