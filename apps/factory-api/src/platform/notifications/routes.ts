import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { readDigest, saveDigest } from '../email-out/digest/digest'
import { countsContract, digestContract, doneContract, listNotificationsContract, readContract, saveDigestContract, snoozeContract, wakeContract } from './contract'
import { manifest } from './manifest'
import { listNotifications, markDone, markRead, notificationCounts, officeOf, snooze, wake } from './notifications'
// B-W2b-385 (PLT-140, PLT-141, PLT-151): my matrix and the role defaults, push on my devices, the saved views I follow.
import { addDeviceContract, followedViewsContract, followViewContract, preferencesContract, pushContract, removeDeviceContract, resetPreferencesContract, roleDefaultsContract, savePreferenceContract, saveRoleDefaultContract, testPushContract } from './preferences/contract'
import { readPreferences, readRoleDefaults, resetPreferences, savePreference, saveRoleDefault } from './preferences/preferences'
import { addDevice, readPush, removeDevice, testPush } from './push/subscriptions'
import { followView, listFollowedViews, unfollowView } from './view-follow/follow'

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

  // B-W2b-385: the preferences matrix (each cell saves at once; DELETE = reset to my roles' defaults) and the role defaults.
  app.get('/notifications/preferences', { schema: preferencesContract }, async (request) => readPreferences(request))
  app.put('/notifications/preferences', { schema: savePreferenceContract }, async (request) => savePreference(request, request.body, idempotencyKeyFrom(request)))
  app.delete('/notifications/preferences', { schema: resetPreferencesContract }, async (request) => resetPreferences(request, idempotencyKeyFrom(request)))
  app.get('/notifications/role-defaults', { schema: roleDefaultsContract }, async (request) => readRoleDefaults(request, request.query.roleId))
  app.put('/notifications/role-defaults', { schema: saveRoleDefaultContract }, async (request) => saveRoleDefault(request, request.body, idempotencyKeyFrom(request)))

  // B-W2b-385: push on this device.
  app.get('/notifications/push', { schema: pushContract }, async (request) => readPush(request))
  app.post('/notifications/push/devices', { schema: addDeviceContract }, async (request) => addDevice(request, request.body, idempotencyKeyFrom(request)))
  app.delete('/notifications/push/devices/:deviceId', { schema: removeDeviceContract }, async (request) => removeDevice(request, request.params.deviceId, idempotencyKeyFrom(request)))
  app.post('/notifications/push/test', { schema: testPushContract }, async (request) => testPush(request, request.body))

  // B-W2b-385: the saved views I follow.
  app.get('/notifications/following/views', { schema: followedViewsContract }, async (request) => listFollowedViews(request))
  app.put('/notifications/following/views/:viewId', { schema: followViewContract }, async (request) => followView(request, request.params.viewId, idempotencyKeyFrom(request)))
  app.delete('/notifications/following/views/:viewId', { schema: followViewContract }, async (request) => unfollowView(request, request.params.viewId, idempotencyKeyFrom(request)))
})
