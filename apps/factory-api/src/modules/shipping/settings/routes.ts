import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { getSettingsContract, listSettingsContract, saveSettingsContract } from './contract'
import { manifest } from './manifest'
import { getSettings, listSettings, saveSettings } from './settings'

/**
 * A site's shipping settings (B-W1-46; LOG-117; A2 SCR-068): the sender and return addresses, the default carrier
 * account, carrier and service, who carries by default, the goods' appearance, the packing printers and the cut-off.
 */
export default defineRoutes('shipping.settings', manifest, async (app) => {
  app.get('/shipping/settings', { schema: listSettingsContract }, async (request) => listSettings(request, request.query))

  app.get('/shipping/settings/:siteId', { schema: getSettingsContract }, async (request) => getSettings(request, request.params.siteId))

  app.put('/shipping/settings/:siteId', { schema: saveSettingsContract }, async (request, reply) => {
    const { created, ...saved } = await saveSettings(request, request.params.siteId, request.body, idempotencyKeyFrom(request))
    return reply.code(created ? 201 : 200).send(saved)
  })
})
