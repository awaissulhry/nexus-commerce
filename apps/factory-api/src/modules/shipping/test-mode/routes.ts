import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { processCarrier } from '../labels/carrier'
import { getTestModesContract, switchTestModeContract } from './contract'
import { manifest } from './manifest'
import { getTestModes, switchTestMode } from './test-mode'

/**
 * Test carrier mode per site (B-W2b-390; LOG-035): read every reachable site's mode (the shell's TEST MODE banner), switch a
 * site to live labels (a fresh step-up; labels are bought and charged from then on) or back to test mode.
 */
export default defineRoutes('shipping.test-mode', manifest, async (app) => {
  app.get('/shipping/test-mode', { schema: getTestModesContract }, async (request) => getTestModes(request, request.query, processCarrier().environment))

  app.put('/shipping/sites/:siteId/test-mode', { schema: switchTestModeContract }, async (request) =>
    switchTestMode(request, request.params.siteId, request.body, () => requireStepUp(officeAuthOf(app), request), processCarrier().environment, idempotencyKeyFrom(request)),
  )
})
