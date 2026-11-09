import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  effectivityContract,
  floorSettingsContract,
  getDepthContract,
  getLibrarySettingsContract,
  setLibrarySettingsContract,
  stepCheckpointContract,
  stepSettingsContract,
  stepVariantsContract,
  workOrderRoutingContract,
} from './contract'
import { getRoutingDepth, setStepCheckpoint, setStepSettings, setStepVariants } from './depth'
import { getEffectivity } from './effectivity'
import { getLibrarySettings, setLibrarySettings } from './library'
import { manifest } from './manifest'
import { getFloorSettings, getWorkOrderRouting } from './work-order'

/**
 * A routing in depth (product module, B-W2b-225; features PRD-118 machine and stitch settings, PRD-119 quality checkpoints,
 * PRD-124 routing versions with effectivity, PRD-128 operations per variant): a draft step's cells, checkpoint and
 * settings; a library operation's default settings; a style's revisions with their effective days and the work orders that
 * keep each one's frozen routing; a work order's routing copy in depth; the tablet's settings beside the instruction. The
 * revision copies carry the depth (./copy.ts, called by W1's copies), the release closes the old revision's days
 * (./effectivity.ts, called by W1's release), the worker opens a checkpoint's check (./checkpoints.ts).
 */
export default defineRoutes('product.routingDepth', manifest, async (app) => {
  app.get('/product/styles/:styleId/revisions/:revisionId/routing/depth', { schema: getDepthContract }, async (request) => ({
    routing: await getRoutingDepth(request, request.params.styleId, request.params.revisionId),
  }))

  app.put('/product/styles/:styleId/revisions/:revisionId/routing/steps/:stepId/variants', { schema: stepVariantsContract }, async (request) => ({
    routing: await setStepVariants(request, request.params.styleId, request.params.revisionId, request.params.stepId, request.body, idempotencyKeyFrom(request)),
  }))

  app.put('/product/styles/:styleId/revisions/:revisionId/routing/steps/:stepId/checkpoint', { schema: stepCheckpointContract }, async (request) => ({
    routing: await setStepCheckpoint(request, request.params.styleId, request.params.revisionId, request.params.stepId, request.body, idempotencyKeyFrom(request)),
  }))

  app.put('/product/styles/:styleId/revisions/:revisionId/routing/steps/:stepId/settings', { schema: stepSettingsContract }, async (request) => ({
    routing: await setStepSettings(request, request.params.styleId, request.params.revisionId, request.params.stepId, request.body, idempotencyKeyFrom(request)),
  }))

  app.get('/product/styles/:styleId/routing/effectivity', { schema: effectivityContract }, async (request) => ({
    effectivity: await getEffectivity(request, request.params.styleId, request.query),
  }))

  app.get('/product/operations/:operationId/settings', { schema: getLibrarySettingsContract }, async (request) => ({ operation: await getLibrarySettings(request, request.params.operationId) }))

  app.put('/product/operations/:operationId/settings', { schema: setLibrarySettingsContract }, async (request) => ({
    operation: await setLibrarySettings(request, request.params.operationId, request.body, idempotencyKeyFrom(request)),
  }))

  app.get('/production/work-orders/:workOrderId/routing', { schema: workOrderRoutingContract }, async (request) => ({ routing: await getWorkOrderRouting(request, request.params.workOrderId) }))

  app.get('/production/work-orders/:workOrderId/operations/:operationId/settings', { schema: floorSettingsContract }, async (request) => ({
    settings: await getFloorSettings(request, request.params.workOrderId, request.params.operationId),
  }))
})
