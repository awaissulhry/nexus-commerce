import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { readSettingsContract, updateSettingsContract } from './contract'
import { manifest } from './manifest'
import { readSettings, updateSettings } from './settings'

/**
 * The product settings (B-W2b-221; PRD-182 the edit rule per lifecycle state, PRD-105 the consumption tolerance): one row per
 * company and one tenant-wide (./settings.ts). The cut consumption confirmation reads the tolerance through
 * modules/production/lays/consumption-tolerance.ts; every product write reads the edit rule through ../lifecycle/edit-rule.ts.
 */
export default defineRoutes('product.settings', manifest, async (app) => {
  app.get('/product/settings', { schema: readSettingsContract }, async (request) => ({ settings: await readSettings(request, request.query) }))
  app.put('/product/settings', { schema: updateSettingsContract }, async (request) => ({ settings: await updateSettings(request, request.body, idempotencyKeyFrom(request)) }))
})
