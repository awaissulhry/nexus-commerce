import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireFloorStepUp } from '../../../platform/auth/floor/step-up'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import {
  archiveTableContract,
  cancelVersionContract,
  confirmContract,
  confirmManyContract,
  confirmPreviewContract,
  createTableContract,
  createVersionContract,
  floorMineContract,
  floorReadContract,
  overviewContract,
  paperReceiptsContract,
  preconditionsContract,
  publishContract,
  publishPreviewContract,
  putInForceContract,
  ratesContract,
  setRatesContract,
  startContract,
  stopContract,
  switchContract,
  tableContract,
  tablesContract,
  updateTableContract,
  updateVersionContract,
  versionContract,
  withdrawContract,
} from './contract'
import { floorMine, floorRead } from './floor'
import { manifest } from './manifest'
import { overview, publishPreview, rates, table, tables, version } from './store'
import { recordPreconditions, startPiecePay, stopPiecePay, switchView } from './switch'
import {
  archiveTable,
  cancelVersion,
  confirm,
  confirmMany,
  confirmPreview,
  createTable,
  createVersion,
  paperReceipts,
  publish,
  putInForce,
  setRates,
  updateTable,
  updateVersion,
  withdraw,
} from './writes'

/**
 * Piece rates and the legal switch of piece pay (B-W2b-34; W2b plan §3 GATE-PIECE-PAY; MES-254, MES-255, MES-262; c.c.
 * arts. 2100-2101): rate tables in versions with their first days and why they changed, provisional rates with a trial,
 * publishing a version to the workers with a receipt per worker, and "Start piece pay" only when every precondition is
 * on record (OFF by default). The screens are B-W2b-62's.
 */
export default defineRoutes('people.piecerates', manifest, async (app) => {
  const stepUpOf = (request: Parameters<typeof requireStepUp>[1]) => () => requireStepUp(officeAuthOf(app), request)

  app.get('/people/piece-rates', { schema: overviewContract }, async (request) => overview(request, request.query))
  app.get('/people/piece-rates/rates', { schema: ratesContract }, async (request) => rates(request, request.query))
  app.get('/people/piece-rates/tables', { schema: tablesContract }, async (request) => tables(request, request.query))

  app.post('/people/piece-rates/tables', { schema: createTableContract }, async (request, reply) => {
    const { replayed, ...answer } = await createTable(request, request.body, idempotencyKeyFrom(request))
    return reply.code(replayed ? 200 : 201).send(answer)
  })
  app.get('/people/piece-rates/tables/:tableId', { schema: tableContract }, async (request) => table(request, request.params.tableId))
  app.patch('/people/piece-rates/tables/:tableId', { schema: updateTableContract }, async (request) => updateTable(request, request.params.tableId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/piece-rates/tables/:tableId/archive', { schema: archiveTableContract }, async (request) => archiveTable(request, request.params.tableId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/piece-rates/tables/:tableId/versions', { schema: createVersionContract }, async (request, reply) => {
    const { replayed, ...answer } = await createVersion(request, request.params.tableId, request.body, idempotencyKeyFrom(request))
    return reply.code(replayed ? 200 : 201).send(answer)
  })

  app.post('/people/piece-rates/versions/confirm', { schema: confirmManyContract }, async (request) => confirmMany(request, request.body, idempotencyKeyFrom(request)))
  app.post('/people/piece-rates/versions/confirm/preview', { schema: confirmPreviewContract }, async (request) => confirmPreview(request, request.body))
  app.get('/people/piece-rates/versions/:versionId', { schema: versionContract }, async (request) => version(request, request.params.versionId))
  app.patch('/people/piece-rates/versions/:versionId', { schema: updateVersionContract }, async (request) => updateVersion(request, request.params.versionId, request.body, idempotencyKeyFrom(request)))
  app.put('/people/piece-rates/versions/:versionId/rates', { schema: setRatesContract }, async (request) => setRates(request, request.params.versionId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/piece-rates/versions/:versionId/cancel', { schema: cancelVersionContract }, async (request) => cancelVersion(request, request.params.versionId, request.body, idempotencyKeyFrom(request)))
  app.get('/people/piece-rates/versions/:versionId/publish/preview', { schema: publishPreviewContract }, async (request) => publishPreview(request, request.params.versionId, request.query))
  app.post('/people/piece-rates/versions/:versionId/publish', { schema: publishContract }, async (request, reply) => {
    const { replayed, ...answer } = await publish(request, request.params.versionId, request.body, idempotencyKeyFrom(request))
    return reply.code(replayed ? 200 : 201).send(answer)
  })
  app.post('/people/piece-rates/versions/:versionId/put-in-force', { schema: putInForceContract }, async (request) => putInForce(request, request.params.versionId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/piece-rates/versions/:versionId/confirm', { schema: confirmContract }, async (request) => confirm(request, request.params.versionId, request.body, idempotencyKeyFrom(request)))

  app.post('/people/piece-rates/publications/:publicationId/withdraw', { schema: withdrawContract }, async (request) => withdraw(request, request.params.publicationId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/piece-rates/publications/:publicationId/paper-receipts', { schema: paperReceiptsContract }, async (request) =>
    paperReceipts(request, request.params.publicationId, request.body, idempotencyKeyFrom(request)),
  )

  app.get('/people/piece-rates/sites/:siteId/switch', { schema: switchContract }, async (request) => switchView(request, request.params.siteId, request.query))
  app.put('/people/piece-rates/sites/:siteId/switch/preconditions', { schema: preconditionsContract }, async (request) => recordPreconditions(request, request.params.siteId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/piece-rates/sites/:siteId/switch/start', { schema: startContract }, async (request) =>
    startPiecePay(request, request.params.siteId, request.body, { stepUp: stepUpOf(request), idempotencyKey: idempotencyKeyFrom(request) }),
  )
  app.post('/people/piece-rates/sites/:siteId/switch/stop', { schema: stopContract }, async (request) => stopPiecePay(request, request.params.siteId, request.body, idempotencyKeyFrom(request)))

  app.get('/people/piece-rates/floor/mine', { schema: floorMineContract }, async (request) => floorMine(request))
  app.post('/people/piece-rates/floor/publications/:publicationId/read', { schema: floorReadContract }, async (request) => {
    requireFloorStepUp(officeAuthOf(app), request)
    return floorRead(request, request.params.publicationId, request.body, idempotencyKeyFrom(request))
  })
})
