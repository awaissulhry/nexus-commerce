import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { processLiveFeed, serveLiveStream } from '../../../core/sse'
import { appClock } from '../tasks/clock'
import { portalSessionOf } from '../../auth/portal/authenticator'
import { portalCountsContract, portalNotificationsContract, portalReadContract, readSettingsContract, saveSettingsContract, unsubscribeContract, unsubscribePreviewContract } from './contract'
import { counts, listMine, markRead } from './inbox'
import { manifest } from './manifest'
import { readSettings, saveSettings, unsubscribe, unsubscribePreview } from './settings'

/**
 * Notifications to partners (B-W2b-167; PLT-148, COL-063; design portal.frame Notifications, E-mail settings, live): the
 * bell, the e-mail settings with the transactional topics locked on, the unsubscribe link of every mail, and the portal
 * session's one live channel. The fan-out is the worker's (./fan-out.ts), the summaries the scheduler's (./digest.ts).
 */
export default defineRoutes('portal-notifications', manifest, async (app) => {
  const open = new Set<() => void>()
  app.addHook('preClose', async () => {
    for (const close of [...open]) close()
  })

  app.get('/portal/notifications', { schema: portalNotificationsContract }, async (request) => listMine(request, request.query, appClock(app).now()))

  app.get('/portal/notifications/counts', { schema: portalCountsContract }, async (request) => counts(request, appClock(app).now()))

  app.post('/portal/notifications/read', { schema: portalReadContract }, async (request) => markRead(app, request, request.body, idempotencyKeyFrom(request)))

  app.get('/portal/live', async (request, reply) =>
    serveLiveStream(request, reply, {
      feed: processLiveFeed(),
      session: portalSessionOf(request).id,
      track: (close) => {
        open.add(close)
        return () => open.delete(close)
      },
    }),
  )

  app.get('/portal/email-settings', { schema: readSettingsContract }, async (request) => readSettings(request))

  app.put('/portal/email-settings', { schema: saveSettingsContract }, async (request) => saveSettings(app, request, request.body, idempotencyKeyFrom(request)))

  app.post('/portal/unsubscribe/preview', { schema: unsubscribePreviewContract }, async (request) => unsubscribePreview(app, request.body.token))

  app.post('/portal/unsubscribe', { schema: unsubscribeContract }, async (request) => unsubscribe(app, request, request.body.token))
})
