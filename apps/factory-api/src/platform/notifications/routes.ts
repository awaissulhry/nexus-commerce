import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { readDigest, saveDigest } from '../email-out/digest/digest'
import { countsContract, digestContract, doneContract, listNotificationsContract, readContract, saveDigestContract, snoozeContract, wakeContract } from './contract'
import { manifest } from './manifest'
import { listNotifications, markDone, markRead, notificationCounts, officeOf, snooze, wake } from './notifications'

/**
 * The notification centre (B-W2a-20; PLT-138 in-app notification centre, PLT-142 quiet defaults): my notifications by
 * tab, the bell's counts, read / done / snooze / wake, and my daily digest (off until I turn it on). The fan-out that
 * makes them is the worker's (fan-out.ts); the digest is the scheduler's (platform/email-out/digest).
 */
export default defineRoutes('notifications', manifest, async (app) => {
  app.get('/notifications', { schema: listNotificationsContract }, async (request) => listNotifications(request, request.query))

  app.get('/notifications/counts', { schema: countsContract }, async (request) => notificationCounts(request))

  app.post('/notifications/read', { schema: readContract }, async (request) => markRead(request, request.body, idempotencyKeyFrom(request)))

  app.post('/notifications/done', { schema: doneContract }, async (request) => markDone(request, request.body, idempotencyKeyFrom(request)))

  app.post('/notifications/snooze', { schema: snoozeContract }, async (request) => snooze(request, request.body, idempotencyKeyFrom(request)))

  app.post('/notifications/wake', { schema: wakeContract }, async (request) => wake(request, request.body, idempotencyKeyFrom(request)))

  app.get('/notifications/digest', { schema: digestContract }, async (request) => readDigest(request, officeOf(request)))

  app.put('/notifications/digest', { schema: saveDigestContract }, async (request) => saveDigest(request, officeOf(request), request.body, idempotencyKeyFrom(request)))
})
