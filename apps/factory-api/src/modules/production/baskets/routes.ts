import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { manifest } from './manifest'
// ---- server A (owb-fl1/fl2) imports ----
import { basketContract, homeContract, moveContract, photoAnnounceContract, photoCompleteContract, routeContract, routeNormalContract, sessionDepartmentContract, undoMovesContract } from './contract'
import { basketHome } from './home'
import { moveBaskets, undoMoves } from './moves'
import { changeRoute, normalRoute } from './route-edits'
import { announcePhoto, completePhoto } from './photo'
import { readBasket } from './read'
import { pickDepartment } from './session'
// ---- end server A imports ----
// ---- server B (owb-fl3/fl4) imports ----
import { setFlags } from './flags'
import { sayLate } from './late'
import { flagsContract, lateContract } from './signals-contract'
import { basketsBoard } from './board'
import { boardContract, fromTheFloorContract, lateAnswerContract, teamContract } from './board-contract'
import { answerLate, fromTheFloor } from './from-the-floor'
import { teamHome } from './team'
// ---- end server B imports ----

/**
 * Baskets on the floor (owb- order workflow, S5): server A's block (fl1/fl2) and server B's block (fl3/fl4) — see ./manifest.ts.
 * Each write is one command with an Idempotency-Key (a floor act keyed `<device>.<clientEventId>` when none is sent).
 */
export default defineRoutes('production.baskets', manifest, async (app) => {
  // ---- server A (owb-fl1/fl2): the basket read, the home, the department pick, the quality photo ----
  // The home first: a static path, never read as a basket's code.
  app.get('/production/baskets/home', { schema: homeContract }, async (request) => basketHome(request))

  app.get('/production/baskets/:bundleId', { schema: basketContract }, async (request) => readBasket(request, request.params.bundleId, request.query))

  app.post('/floor/session/department', { schema: sessionDepartmentContract }, async (request) => pickDepartment(request, request.body, idempotencyKeyFrom(request)))

  app.post('/production/baskets/:bundleId/checklist/:stepCode/photo', { schema: photoAnnounceContract }, async (request, reply) =>
    reply.code(201).send(await announcePhoto(request, request.params, request.body, idempotencyKeyFrom(request))),
  )

  app.post('/production/baskets/:bundleId/checklist/:stepCode/photo/:fileId/complete', { schema: photoCompleteContract }, async (request) => completePhoto(request, request.params, request.body))

  // owb-fl2: moves by hand, their undo, route edits (201 a new act; 200 a resend of its key).
  app.post('/production/baskets/move', { schema: moveContract }, async (request, reply) => {
    const { replayed, ...answer } = await moveBaskets(request, request.body, idempotencyKeyFrom(request))
    return reply.code(replayed ? 200 : 201).send({ ...answer, stayWords: [...answer.stayWords], baskets: [...answer.baskets] })
  })

  app.post('/production/baskets/moves/:groupId/undo', { schema: undoMovesContract }, async (request, reply) => {
    const { replayed, ...answer } = await undoMoves(request, request.params.groupId, request.body, idempotencyKeyFrom(request))
    return reply.code(replayed ? 200 : 201).send({ ...answer, stayWords: [...answer.stayWords] })
  })

  app.post('/production/baskets/route', { schema: routeContract }, async (request) => {
    const { replayed: _replayed, ...answer } = await changeRoute(request, request.body, idempotencyKeyFrom(request))
    return answer
  })

  app.post('/production/baskets/route/normal', { schema: routeNormalContract }, async (request) => {
    const { replayed: _replayed, ...answer } = await normalRoute(request, request.body, idempotencyKeyFrom(request))
    return answer
  })
  // ---- end server A ----

  // ---- server B (owb-fl3/fl4): flags, late, team, board, from the floor ----
  app.post('/production/baskets/flags', { schema: flagsContract }, async (request) => setFlags(request, request.body, idempotencyKeyFrom(request)))

  app.post('/production/baskets/late', { schema: lateContract }, async (request, reply) => {
    const answer = await sayLate(request, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send(answer)
  })

  app.get('/production/baskets/board', { schema: boardContract }, async (request) => basketsBoard(request, request.query))

  app.get('/production/baskets/team', { schema: teamContract }, async (request) => teamHome(request))

  app.get('/production/baskets/from-the-floor', { schema: fromTheFloorContract }, async (request) => fromTheFloor(request, request.query))

  app.post('/production/baskets/late/:id/answer', { schema: lateAnswerContract }, async (request) => answerLate(request, request.params.id, request.body, idempotencyKeyFrom(request)))
  // ---- end server B ----
})
