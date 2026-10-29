import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import {
  announceDocumentContract,
  announceReportContract,
  attachDocumentContract,
  blockContract,
  clearHoldContract,
  getLotContract,
  getSettingsContract,
  listLotsContract,
  listDocumentsContract,
  listResultsContract,
  recordResultContract,
  rejectContract,
  releaseCheckContract,
  releaseContract,
  saveSettingsContract,
  unblockContract,
} from './contract'
import { blockLot, clearHold, rejectLot, releaseLot, unblockLot } from './decisions'
import { announceDocument, attachDocument } from './documents'
import { manifest } from './manifest'
import { listLots } from './lots'
import { getLot, listDocuments, listResults, releaseCheck } from './read'
import { announceReport, recordResult } from './results'
import { getQualitySettings, saveQualitySettings } from './settings'

/**
 * The lab step for incoming lots (B-W1-34; Owner question Q14, design answer W3): a lot's chromium VI results with their
 * reports (./results.ts), its supplier documents (./documents.ts), the release checklist and the decisions — release
 * with the typed lot code, reject, block, unblock, clear the receiver's hold (./decisions.ts) — and the Cr VI evidence
 * rule (./settings.ts), and the lots list with its on-hold filter (./lots.ts, B-W1-45). Results, documents and settings
 * are kept through their seams (*-store.ts).
 */
export default defineRoutes('quality.lab', manifest, async (app) => {
  app.get('/quality/lots', { schema: listLotsContract }, async (request) => listLots(request, { ...request.query, onHold: request.query.onHold === 'true' }))

  app.get('/quality/lots/:lotId', { schema: getLotContract }, async (request) => getLot(request, request.params.lotId))

  app.get('/quality/lots/:lotId/release-check', { schema: releaseCheckContract }, async (request) => releaseCheck(request, request.params.lotId))

  app.get('/quality/lots/:lotId/results', { schema: listResultsContract }, async (request) => listResults(request, request.params.lotId))

  app.post('/quality/lots/:lotId/results/report', { schema: announceReportContract }, async (request, reply) =>
    reply.code(201).send(await announceReport(request, request.params.lotId, request.body, idempotencyKeyFrom(request))),
  )

  app.post('/quality/lots/:lotId/results', { schema: recordResultContract }, async (request, reply) =>
    reply.code(201).send(await recordResult(request, request.params.lotId, request.body, idempotencyKeyFrom(request))),
  )

  app.get('/quality/lots/:lotId/documents', { schema: listDocumentsContract }, async (request) => listDocuments(request, request.params.lotId))

  app.post('/quality/lots/:lotId/documents/upload', { schema: announceDocumentContract }, async (request, reply) =>
    reply.code(201).send(await announceDocument(request, request.params.lotId, request.body, idempotencyKeyFrom(request))),
  )

  app.post('/quality/lots/:lotId/documents', { schema: attachDocumentContract }, async (request, reply) =>
    reply.code(201).send(await attachDocument(request, request.params.lotId, request.body, idempotencyKeyFrom(request))),
  )

  app.post('/quality/lots/:lotId/release', { schema: releaseContract }, async (request) => releaseLot(request, request.params.lotId, request.body, idempotencyKeyFrom(request)))

  app.post('/quality/lots/:lotId/unblock', { schema: unblockContract }, async (request) => unblockLot(request, request.params.lotId, request.body, idempotencyKeyFrom(request)))

  app.post('/quality/lots/:lotId/hold/clear', { schema: clearHoldContract }, async (request) => clearHold(request, request.params.lotId, request.body, idempotencyKeyFrom(request)))

  app.post('/quality/lots/:lotId/reject', { schema: rejectContract }, async (request) => rejectLot(request, request.params.lotId, request.body, idempotencyKeyFrom(request)))

  app.post('/quality/lots/:lotId/block', { schema: blockContract }, async (request) => blockLot(request, request.params.lotId, request.body, idempotencyKeyFrom(request)))

  app.get('/quality/settings', { schema: getSettingsContract }, async (request) => getQualitySettings(request, request.query))

  app.put('/quality/settings', { schema: saveSettingsContract }, async (request) =>
    saveQualitySettings(request, request.body, { stepUp: () => requireStepUp(officeAuthOf(app), request), idempotencyKey: idempotencyKeyFrom(request) }),
  )
})
