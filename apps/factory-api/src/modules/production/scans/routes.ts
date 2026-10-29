import { ValidationError } from '@nexus/factory-domain/core/errors'
import type { FastifyRequest } from 'fastify'
import { idempotencyKeyFrom, IDEMPOTENCY_KEY_HEADER } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  approveContract,
  askContract,
  batchContract,
  cardContract,
  correctionContract,
  correctionsContract,
  discardContract,
  mineContract,
  reasonsContract,
  refusalContract,
  refusalsContract,
  refuseContract,
  reportContract,
  siteWipContract,
  undoContract,
  workOrderScansContract,
  workOrderWipContract,
} from './contract'
import { approveCorrection, correctionOf, listCorrections, refuseCorrection } from './corrections'
import { manifest } from './manifest'
import { siteWip, workOrderWip } from './progress'
import { askCorrection, reportScan, sendBatch, undoScan } from './scans'
import { bundleCard, discard, listRefusals, mine, reasons, refusalOf, workOrderScans } from './views'

/**
 * Operation scans on the floor, offline, with undo and corrections; WIP (B-W1-42; MES-069, MES-090, MES-095, MES-096,
 * MES-167, MES-308; A2 SCR-090, SCR-072, SCR-073, SCR-023). The floor's writes are one command each (./scans.ts); the
 * device's clientScanId is the action's Idempotency-Key (an Idempotency-Key header, when sent, must be the same), so a
 * resend answers 200 with the scan recorded first. The batch answers every queued action in the order sent.
 */

/** The floor's action key: the body's clientScanId; a header sent beside it must say the same. */
function sameKey(request: FastifyRequest, clientScanId: string): void {
  const header = idempotencyKeyFrom(request)
  if (header !== undefined && header !== clientScanId) {
    throw new ValidationError('The Idempotency-Key is the scan’s clientScanId: send the same value, or no header.', [{ path: `headers/${IDEMPOTENCY_KEY_HEADER}`, message: 'Must equal body.clientScanId.' }])
  }
}

export default defineRoutes('production.scans', manifest, async (app) => {
  app.get('/production/scans/reasons', { schema: reasonsContract }, async (request) => reasons(request))

  app.get('/production/scans/card', { schema: cardContract }, async (request) => bundleCard(request, request.query))

  app.get('/production/scans/mine', { schema: mineContract }, async (request) => mine(request))

  app.post('/production/scans', { schema: reportContract }, async (request, reply) => {
    sameKey(request, request.body.clientScanId)
    const result = await reportScan(request, request.body)
    return reply.code(result.replayed ? 200 : 201).send(result)
  })

  app.post('/production/scans/:scanId/undo', { schema: undoContract }, async (request, reply) => {
    sameKey(request, request.body.clientScanId)
    const result = await undoScan(request, { ...request.body, scanId: request.params.scanId })
    return reply.code(result.replayed ? 200 : 201).send(result)
  })

  app.post('/production/scans/:scanId/corrections', { schema: askContract }, async (request, reply) => {
    sameKey(request, request.body.clientScanId)
    const result = await askCorrection(request, { ...request.body, scanId: request.params.scanId })
    return reply.code(result.replayed ? 200 : 201).send(result)
  })

  app.post('/production/scans/batch', { schema: batchContract }, async (request) => sendBatch(request, request.body))

  app.post('/production/scans/mine/refusals/:refusalId/discard', { schema: discardContract }, async (request) => discard(request, request.params.refusalId, idempotencyKeyFrom(request)))

  app.get('/production/scans/corrections', { schema: correctionsContract }, async (request) => listCorrections(request, request.query))

  app.get('/production/scans/corrections/:requestId', { schema: correctionContract }, async (request) => correctionOf(request, request.params.requestId))

  app.post('/production/scans/corrections/:requestId/approve', { schema: approveContract }, async (request, reply) =>
    reply.code(201).send(await approveCorrection(request, request.params.requestId, request.body, idempotencyKeyFrom(request))),
  )

  app.post('/production/scans/corrections/:requestId/refuse', { schema: refuseContract }, async (request, reply) =>
    reply.code(201).send(await refuseCorrection(request, request.params.requestId, request.body, idempotencyKeyFrom(request))),
  )

  app.get('/production/scans/refusals', { schema: refusalsContract }, async (request) => listRefusals(request, request.query))

  app.get('/production/scans/refusals/:refusalId', { schema: refusalContract }, async (request) => refusalOf(request, request.params.refusalId))

  app.post('/production/scans/refusals/:refusalId/discard', { schema: discardContract }, async (request) => discard(request, request.params.refusalId, idempotencyKeyFrom(request)))

  app.get('/production/scans/wip', { schema: siteWipContract }, async (request) => siteWip(request, request.query))

  app.get('/production/scans/work-orders/:workOrderId/wip', { schema: workOrderWipContract }, async (request) => workOrderWip(request, request.params.workOrderId))

  app.get('/production/scans/work-orders/:workOrderId/scans', { schema: workOrderScansContract }, async (request) => workOrderScans(request, request.params.workOrderId, request.query))
})
