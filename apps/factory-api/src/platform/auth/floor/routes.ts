import type { FastifyRequest } from 'fastify'
import { defineRoutes } from '../../../core/manifest'
import { AUTH_RATE_LIMITS, officeAuthOf, type AuthRateLimit } from '../sessions/office-auth'
import {
  changePinContract,
  createDeviceContract,
  createWorkerContract,
  deviceContract,
  editDeviceContract,
  editWorkerContract,
  enrolDeviceContract,
  floorMeContract,
  getSettingsContract,
  issueBadgeContract,
  listDevicesContract,
  listWorkersContract,
  putSettingsContract,
  renewEnrolmentContract,
  resetPinContract,
  revokeBadgeContract,
  revokeDeviceContract,
  setWorkerRolesContract,
  signInContract,
  signOutContract,
  switchContract,
  workerStatusContract,
} from './contract'
import { deviceCookieOf } from './cookies'
import { deviceInfo, enrolDevice } from './device'
import { manifest } from './manifest'
import { createDevice, editDevice, getSettings, listDevices, putSettings, renewEnrolment, revokeDevice } from './registry'
import { changePin, floorMe, floorSignIn, floorSignOut, switchOperator } from './sign-in'
import { parseSiteToken } from './tokens'
import { createWorker, editWorker, issueBadge, listWorkers, resetPin, revokeBadge, setWorkerRoles, setWorkerStatus } from './workers'

/**
 * The floor (an enrolled device):
 *   POST /floor/device/enrol    the one-time code of the Office's QR code → the device token (HttpOnly cookie)
 *   GET  /floor/device          the device, its site and station, the language, whether someone is signed in, the roster
 *   POST /floor/sign-in         badge code (or worker id) + PIN → the floor session cookie (409 if another operator is on)
 *   POST /floor/switch          from a signed-in device: the next worker's badge (or name) + PIN; the current one ends
 *   POST /floor/sign-out        ends the floor session, clears its cookie (the device stays enrolled)
 *   GET  /floor/me              the operator, device, site, session times, language and permissions
 *   POST /floor/pin             the operator changes their PIN (required after an administrator's reset)
 * The Office:
 *   GET   /auth/floor/devices                        the device registry (in use or not, never by whom)
 *   POST  /auth/floor/devices                        enrol a device: a PENDING device + a one-time QR code (15 minutes)
 *   POST  /auth/floor/devices/:deviceId/enrolment    a new code for a PENDING device (the older ones retire)
 *   PATCH /auth/floor/devices/:deviceId              rename, move to a station (version)
 *   POST  /auth/floor/devices/:deviceId/revoke       revoke: its sign-ins end at once
 *   GET|PUT /auth/floor/sites/:siteId/settings       a site's idle minutes and shift ends
 *   GET   /auth/floor/workers                        the floor workers (name, language, badge hint, roles, PIN state)
 *   POST  /auth/floor/workers                        add a worker (no PIN until a reset gives one)
 *   PATCH /auth/floor/workers/:workerId              name, language, employee number, office link (version)
 *   POST  /auth/floor/workers/:workerId/deactivate|reactivate
 *   PUT   /auth/floor/workers/:workerId/roles        the worker's floor roles
 *   POST  /auth/floor/workers/:workerId/badges       a new badge (its code once, for printing); older ones revoked
 *   POST  /auth/floor/badges/:badgeId/revoke         a lost or revoked badge: its sign-ins end
 *   POST  /auth/floor/workers/:workerId/pin-reset    a new PIN once; the worker chooses their own next
 *
 * The routes that take a secret have their own rate limit: the sign-in ones per enrolled device (a plant's tablets
 * may share one address), the enrolment per client address.
 */
export default defineRoutes('auth-floor', manifest, async (app) => {
  const auth = () => officeAuthOf(app)
  const limits = app.officeAuth?.rateLimits ?? AUTH_RATE_LIMITS
  const perAddress = (rate: AuthRateLimit) => ({ rateLimit: { max: rate.max, timeWindow: rate.timeWindowMs } })
  const perDevice = (rate: AuthRateLimit) => ({
    rateLimit: { max: rate.max, timeWindow: rate.timeWindowMs, keyGenerator: (request: FastifyRequest) => `floor-device:${parseSiteToken(deviceCookieOf(request))?.id ?? request.ip}` },
  })

  app.post('/floor/device/enrol', { schema: enrolDeviceContract, config: perAddress(limits.tokenUse) }, (request, reply) => enrolDevice(auth(), request, reply, request.body))
  app.get('/floor/device', { schema: deviceContract }, (request) => deviceInfo(auth(), request))
  app.post('/floor/sign-in', { schema: signInContract, config: perDevice(limits.floorSignIn) }, (request, reply) => floorSignIn(auth(), request, reply, request.body))
  app.post('/floor/switch', { schema: switchContract, config: perDevice(limits.floorSignIn) }, (request, reply) => switchOperator(auth(), request, reply, request.body))
  app.post('/floor/sign-out', { schema: signOutContract }, (request, reply) => floorSignOut(auth(), request, reply))
  app.get('/floor/me', { schema: floorMeContract }, (request) => floorMe(request))
  app.post('/floor/pin', { schema: changePinContract, config: perDevice(limits.floorSignIn) }, (request) => changePin(auth(), request, request.body))

  app.get('/auth/floor/devices', { schema: listDevicesContract }, (request) => listDevices(auth(), request, request.query))
  app.post('/auth/floor/devices', { schema: createDeviceContract }, (request) => createDevice(auth(), request, request.body))
  app.post('/auth/floor/devices/:deviceId/enrolment', { schema: renewEnrolmentContract }, (request) => renewEnrolment(auth(), request, request.params.deviceId))
  app.patch('/auth/floor/devices/:deviceId', { schema: editDeviceContract }, (request) => editDevice(auth(), request, request.params.deviceId, request.body))
  app.post('/auth/floor/devices/:deviceId/revoke', { schema: revokeDeviceContract }, (request) => revokeDevice(auth(), request, request.params.deviceId, request.body))
  app.get('/auth/floor/sites/:siteId/settings', { schema: getSettingsContract }, (request) => getSettings(request, request.params.siteId))
  app.put('/auth/floor/sites/:siteId/settings', { schema: putSettingsContract }, (request) => putSettings(auth(), request, request.params.siteId, request.body))

  app.get('/auth/floor/workers', { schema: listWorkersContract }, (request) => listWorkers(auth(), request, request.query))
  app.post('/auth/floor/workers', { schema: createWorkerContract }, (request) => createWorker(auth(), request, request.body))
  app.patch('/auth/floor/workers/:workerId', { schema: editWorkerContract }, (request) => editWorker(auth(), request, request.params.workerId, request.body))
  app.post('/auth/floor/workers/:workerId/deactivate', { schema: workerStatusContract }, (request) =>
    setWorkerStatus(auth(), request, request.params.workerId, 'INACTIVE', request.body),
  )
  app.post('/auth/floor/workers/:workerId/reactivate', { schema: workerStatusContract }, (request) =>
    setWorkerStatus(auth(), request, request.params.workerId, 'ACTIVE', request.body),
  )
  app.put('/auth/floor/workers/:workerId/roles', { schema: setWorkerRolesContract }, (request) => setWorkerRoles(auth(), request, request.params.workerId, request.body.roleIds))
  app.post('/auth/floor/workers/:workerId/badges', { schema: issueBadgeContract }, (request) => issueBadge(auth(), request, request.params.workerId))
  app.post('/auth/floor/badges/:badgeId/revoke', { schema: revokeBadgeContract }, (request) => revokeBadge(auth(), request, request.params.badgeId, request.body))
  app.post('/auth/floor/workers/:workerId/pin-reset', { schema: resetPinContract }, (request) => resetPin(auth(), request, request.params.workerId))
})
