import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { addAction, cancelAction, doneAction, editAction } from './containment'
import {
  addActionContract,
  addDecisionContract,
  assignContract,
  getSettingsContract,
  saveSettingsContract,
  approveDecisionContract,
  boardContract,
  cancelActionContract,
  cancelContract,
  carryOutContract,
  closeContract,
  closeHoldContract,
  countsContract,
  doneActionContract,
  editActionContract,
  editContract,
  editDecisionContract,
  getContract,
  linkContract,
  listContract,
  prefillContract,
  raiseContract,
  registerContract,
  removeDecisionContract,
  reworkContract,
  stageContract,
  unlinkContract,
} from './contract'
import { addDecision, approveDecision, carryOut, editDecision, removeDecision, reworkFromDecision } from './decisions'
import { manifest } from './manifest'
import { cancelNcr, closeNcr, closeNcrHold, editNcr, linkRecord, moveNcr, raiseNcr, registerNcr, unlinkRecord } from './ncr'
import { listNcrs, ncrBoard, ncrCounts, ncrPrefill, ncrRecord } from './reads'
import { assignNcrs } from './assign'
import { getNcrSettings, saveNcrSettings } from './settings'

const flag = (value: 'true' | 'false' | undefined): boolean | undefined => (value === undefined ? undefined : value === 'true')

/**
 * Nonconformances of B-W2a-47 (QHS-080 … QHS-091): the reads (./reads.ts), raise / change / stages / close / cancel /
 * links (./ncr.ts; a close is an e-signature: the office's step-up first), containment (./containment.ts) and the
 * decisions by quantity with their stock moves and follow-ups (./decisions.ts).
 */
export default defineRoutes('quality.ncr', manifest, async (app) => {
  app.get('/quality/ncr', { schema: listContract }, async (request) =>
    listNcrs(request, { ...request.query, open: flag(request.query.open), overdue: flag(request.query.overdue), waiting: flag(request.query.waiting) }),
  )
  app.get('/quality/ncr/counts', { schema: countsContract }, async (request) => ncrCounts(request, request.query))
  app.get('/quality/ncr/board', { schema: boardContract }, async (request) => ncrBoard(request, { ...request.query, overdue: flag(request.query.overdue), waiting: flag(request.query.waiting) }))
  app.get('/quality/ncr/prefill', { schema: prefillContract }, async (request) => ncrPrefill(request, request.query))
  // B-W2b-17: one owner for the selected NCRs (one command), and the default containment time as a setting.
  app.post('/quality/ncr/assign', { schema: assignContract }, async (request) => assignNcrs(request, request.body, idempotencyKeyFrom(request)))
  app.get('/quality/ncr/settings', { schema: getSettingsContract }, async (request) => getNcrSettings(request, request.query))
  app.put('/quality/ncr/settings', { schema: saveSettingsContract }, async (request) => saveNcrSettings(request, request.body, idempotencyKeyFrom(request)))
  app.post('/quality/ncr', { schema: raiseContract }, async (request, reply) => reply.code(201).send(await raiseNcr(request, request.body, idempotencyKeyFrom(request))))
  app.get('/quality/ncr/:ncrId', { schema: getContract }, async (request) => ncrRecord(request, request.params.ncrId))
  app.patch('/quality/ncr/:ncrId', { schema: editContract }, async (request) => editNcr(request, request.params.ncrId, request.body, idempotencyKeyFrom(request)))
  app.post('/quality/ncr/:ncrId/stage', { schema: stageContract }, async (request) => moveNcr(request, request.params.ncrId, request.body, idempotencyKeyFrom(request)))
  app.post('/quality/ncr/:ncrId/close', { schema: closeContract }, async (request) => {
    await requireStepUp(officeAuthOf(app), request)
    return closeNcr(request, request.params.ncrId, request.body, idempotencyKeyFrom(request))
  })
  app.post('/quality/ncr/:ncrId/cancel', { schema: cancelContract }, async (request) => cancelNcr(request, request.params.ncrId, request.body, idempotencyKeyFrom(request)))
  app.post('/quality/ncr/:ncrId/links', { schema: linkContract }, async (request, reply) => reply.code(201).send(await linkRecord(request, request.params.ncrId, request.body, idempotencyKeyFrom(request))))
  app.delete('/quality/ncr/:ncrId/links/:linkId', { schema: unlinkContract }, async (request) => unlinkRecord(request, request.params.ncrId, request.params.linkId, request.query, idempotencyKeyFrom(request)))
  app.post('/quality/ncr/:ncrId/register', { schema: registerContract }, async (request) => registerNcr(request, request.params.ncrId, request.body, idempotencyKeyFrom(request)))
  app.post('/quality/ncr/:ncrId/holds/:holdId/close', { schema: closeHoldContract }, async (request) => closeNcrHold(request, request.params.ncrId, request.params.holdId, request.body, idempotencyKeyFrom(request)))

  app.post('/quality/ncr/:ncrId/containment', { schema: addActionContract }, async (request, reply) => reply.code(201).send(await addAction(request, request.params.ncrId, request.body, idempotencyKeyFrom(request))))
  app.patch('/quality/ncr/:ncrId/containment/:actionId', { schema: editActionContract }, async (request) => editAction(request, request.params.ncrId, request.params.actionId, request.body, idempotencyKeyFrom(request)))
  app.post('/quality/ncr/:ncrId/containment/:actionId/done', { schema: doneActionContract }, async (request) => doneAction(request, request.params.ncrId, request.params.actionId, request.body, idempotencyKeyFrom(request)))
  app.post('/quality/ncr/:ncrId/containment/:actionId/cancel', { schema: cancelActionContract }, async (request) => cancelAction(request, request.params.ncrId, request.params.actionId, request.body, idempotencyKeyFrom(request)))

  app.post('/quality/ncr/:ncrId/decisions', { schema: addDecisionContract }, async (request, reply) => reply.code(201).send(await addDecision(request, request.params.ncrId, request.body, idempotencyKeyFrom(request))))
  app.patch('/quality/ncr/:ncrId/decisions/:decisionId', { schema: editDecisionContract }, async (request) => editDecision(request, request.params.ncrId, request.params.decisionId, request.body, idempotencyKeyFrom(request)))
  app.delete('/quality/ncr/:ncrId/decisions/:decisionId', { schema: removeDecisionContract }, async (request) => removeDecision(request, request.params.ncrId, request.params.decisionId, request.query, idempotencyKeyFrom(request)))
  app.post('/quality/ncr/:ncrId/decisions/:decisionId/approve', { schema: approveDecisionContract }, async (request) => approveDecision(request, request.params.ncrId, request.params.decisionId, request.body, idempotencyKeyFrom(request)))
  app.post('/quality/ncr/:ncrId/decisions/:decisionId/carry-out', { schema: carryOutContract }, async (request) => carryOut(request, request.params.ncrId, request.params.decisionId, request.body, idempotencyKeyFrom(request)))
  app.post('/quality/ncr/:ncrId/decisions/:decisionId/rework', { schema: reworkContract }, async (request) => reworkFromDecision(request, request.params.ncrId, request.params.decisionId, request.body, idempotencyKeyFrom(request)))
})
