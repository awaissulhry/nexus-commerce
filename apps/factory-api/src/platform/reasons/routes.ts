import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { activeContract, createContract, editContract, editorContract, orderContract, pickerContract, standardContract } from './contract'
import { manifest } from './manifest'
import { addStandard, createReason, editorLists, editReason, pickerReasons, reorder, setActive } from './reasons'

/**
 * The reason lists (B-W2a-18; PLT-116; design production.settings "Reason codes" + "New reason code", floor.reasons,
 * sales.settings return reasons): one route family for every list (ReasonCode's eleven, ScrapReason's SCRAP and REWORK).
 *   GET   /reasons?list=A,B                 the active reasons a picker offers (office and floor), in tile order
 *   GET   /reasons/lists?list=A,B           the editor: every reason with how often it is used, the standard codes
 *                                           missing, the tenant's other floor languages, whether the caller may keep them
 *   POST  /reasons/:list                    a new reason at the list's end
 *   PATCH /reasons/:list/:reasonId          words (per language), icon, colour, needs a note, active — one cell at a time
 *   POST  /reasons/:list/active             many set inactive (or active again) at once
 *   POST  /reasons/:list/order              the list's tile order
 *   POST  /reasons/:list/standard           the standard reasons the list is missing
 */
export default defineRoutes('reasons', manifest, async (app) => {
  app.get('/reasons', { schema: pickerContract }, async (request) => pickerReasons(request, request.query))
  app.get('/reasons/lists', { schema: editorContract }, async (request) => editorLists(request, request.query))
  app.post('/reasons/:list', { schema: createContract }, async (request, reply) =>
    reply.code(201).send({ reason: await createReason(request, request.params.list, request.body, idempotencyKeyFrom(request)) }),
  )
  app.patch('/reasons/:list/:reasonId', { schema: editContract }, async (request) => ({
    reason: await editReason(request, request.params.list, request.params.reasonId, request.body, idempotencyKeyFrom(request)),
  }))
  app.post('/reasons/:list/active', { schema: activeContract }, async (request) => setActive(request, request.params.list, request.body, idempotencyKeyFrom(request)))
  app.post('/reasons/:list/order', { schema: orderContract }, async (request) => reorder(request, request.params.list, request.body, idempotencyKeyFrom(request)))
  app.post('/reasons/:list/standard', { schema: standardContract }, async (request) => addStandard(request, request.params.list, idempotencyKeyFrom(request)))
})
