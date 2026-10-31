import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { completeKitContract, getKitContract, reopenKitContract, stageKitContract } from './contract'
import { completeKit, getKit, reopenKit, stageKit } from './kits'
import { manifest } from './manifest'

/**
 * Kit staging (B-W2b-15; SCM-213; design warehouse.picking): a work order's kit — where the picked material waits and
 * whether a person checked it complete (./kits.ts). Picking & kits shows it on every row and in the pick list.
 */
export default defineRoutes('inventory.kits', manifest, async (app) => {
  app.get('/inventory/kits/:workOrderId', { schema: getKitContract }, async (request) => getKit(request, request.params.workOrderId))
  app.post('/inventory/kits/:workOrderId/stage', { schema: stageKitContract }, async (request) => stageKit(request, request.params.workOrderId, request.body, idempotencyKeyFrom(request)))
  app.post('/inventory/kits/:workOrderId/complete', { schema: completeKitContract }, async (request) => completeKit(request, request.params.workOrderId, request.body, idempotencyKeyFrom(request)))
  app.post('/inventory/kits/:workOrderId/reopen', { schema: reopenKitContract }, async (request) => reopenKit(request, request.params.workOrderId, request.body, idempotencyKeyFrom(request)))
})
