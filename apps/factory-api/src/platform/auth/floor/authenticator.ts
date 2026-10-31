import type { FastifyRequest } from 'fastify'
import { FLOOR_SESSION, idleEndAt } from '@nexus/factory-domain/auth/floor/session'
import { UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import type { Authenticator, SessionContext } from '../../../core/context'
import { assertCsrf, isUnsafeMethod } from '../sessions/cookies'
import { deviceCookieOf, floorCookieOf } from './cookies'
import { slideCrew } from './crew-store'
import { floorGrantsOf, isLiveSession, liveDevice, SESSION_SELECT, siteScope, siteTiming, type FloorCore, type FloorDevice } from './store'
import { floorHash, parseSessionToken, parseSiteToken } from './tokens'

/**
 * The Authenticator for floor sessions (plan A1 §3.2 step 1, §3.10 "Floor"). A request is a floor request when it
 * carries the floor session cookie (sessions/office-auth.ts sends it here, never to the office authenticator). Then,
 * in the FLOOR scope of the device token's tenant and site (factory_floor_runtime), every request:
 *
 *   1. the device token (its own cookie) names a live device: ACTIVE, its token's hash matches, its site and tenant
 *      active. A floor session is valid only with its device's token;
 *   2. the session cookie names a session of THAT device, which is the device's current one (one operator per device),
 *      not ended, before its idle end and its shift end;
 *   3. its worker is ACTIVE, and the badge it started with (if any) is still ACTIVE;
 *   4. an unsafe method passes the CSRF double submit (403 otherwise);
 *   5. the idle end slides forward (at most once a minute, never past the shift end) and the device's last contact is
 *      recorded: bookkeeping, not audited;
 *   6. the context: floor, the device's tenant and site, the worker, the device, and the grants of the worker's live
 *      floor roles over the device's company and site (none while the worker's PIN must change).
 * B-W2b-52 (MES-181, MES-186, PLT-059): a line board holds no session (nobody signs in on it), a personal phone only its
 * person's (a mode changed in the office stops any other at its next request), and on a crew tablet the slide of the
 * active member's idle end moves the other members' with it (the crew stays signed in while the tablet is used).
 * Anything else: no session (401). A revoked device, badge or worker therefore stops at the next request, even if the
 * command that revoked it had not ended the session.
 */

/** What the floor routes need to know about the request's floor session, beyond the context. */
export interface FloorSession {
  readonly id: string
  readonly device: FloorDevice
  readonly workerId: string
  readonly badgeId: string | null
  readonly startedAt: Date
  readonly idleExpiresAt: Date
  readonly endsAt: Date
  /** When the worker last proved their PIN in this session (null: a badge alone, not proved since). */
  readonly pinVerifiedAt: Date | null
  readonly worker: { readonly displayName: string; readonly locale: string; readonly pinMustChange: boolean; readonly employeeCode: string | null }
}

const sessions = new WeakMap<FastifyRequest, FloorSession>()

/** The floor session the authenticator found for this request (routes with a floor audience). */
export function floorSessionOf(request: FastifyRequest): FloorSession {
  const session = sessions.get(request)
  if (!session) throw new UnauthenticatedError()
  return session
}

/** True when the request carries a floor session cookie: it is the floor authenticator's to answer. */
export const isFloorRequest = (request: FastifyRequest): boolean => floorCookieOf(request) !== null

export function floorAuthenticator(core: FloorCore): Authenticator {
  return async (request): Promise<SessionContext | null> => {
    const deviceToken = parseSiteToken(deviceCookieOf(request))
    const sessionToken = parseSessionToken(floorCookieOf(request))
    if (!deviceToken || !sessionToken) return null
    const now = core.clock.now()
    return core.database.withScope(siteScope(deviceToken), async (client) => {
      const device = await liveDevice(client, deviceToken)
      if (!device || device.currentSessionId === null) return null
      const row = await client.floorSession.findUnique({
        where: { tokenHash: floorHash(sessionToken) },
        select: {
          ...SESSION_SELECT,
          worker: { select: { status: true, displayName: true, locale: true, pinMustChange: true, employeeCode: true } },
          badge: { select: { status: true } },
        },
      })
      if (!row || row.deviceId !== device.id || row.id !== device.currentSessionId || !isLiveSession(row, now)) return null
      if (row.worker.status !== 'ACTIVE' || (row.badge !== null && row.badge.status !== 'ACTIVE')) return null
      if (device.mode === 'DISPLAY' || (device.mode === 'PHONE' && row.workerId !== device.personalWorkerId)) return null
      if (isUnsafeMethod(request.method)) assertCsrf(request)

      const grants = await floorGrantsOf(client, { id: row.workerId, pinMustChange: row.worker.pinMustChange }, device)

      let idleExpiresAt = row.idleExpiresAt
      if (now.getTime() - row.lastSeenAt.getTime() >= FLOOR_SESSION.slideEveryMs) {
        const timing = await siteTiming(client, device.siteId)
        idleExpiresAt = idleEndAt(now, timing.idleMinutes, row.endsAt)
        await client.floorSession.updateMany({ where: { id: row.id, endedAt: null }, data: { lastSeenAt: now, idleExpiresAt } })
        if (device.mode === 'STATION') await slideCrew(client, device.id, row.id, idleExpiresAt, now)
      }
      if (device.lastSeenAt === null || now.getTime() - device.lastSeenAt.getTime() >= FLOOR_SESSION.slideEveryMs) {
        await client.device.updateMany({ where: { id: device.id, status: 'ACTIVE' }, data: { lastSeenAt: now } })
      }

      sessions.set(request, {
        id: row.id,
        device,
        workerId: row.workerId,
        badgeId: row.badgeId,
        startedAt: row.startedAt,
        idleExpiresAt,
        endsAt: row.endsAt,
        pinVerifiedAt: row.pinVerifiedAt,
        worker: { displayName: row.worker.displayName, locale: row.worker.locale, pinMustChange: row.worker.pinMustChange, employeeCode: row.worker.employeeCode },
      })
      return { audience: 'floor', tenantId: device.tenantId, siteId: device.siteId, deviceId: device.id, actorId: row.workerId, grants }
    })
  }
}

/**
 * The app's authenticator: a request with the floor session cookie is answered by the floor authenticator (no office
 * fallback, so a tablet's request never runs as an office person), any other by the office one.
 */
export function sessionAuthenticator(office: Authenticator, floor: Authenticator): Authenticator {
  return (request) => (isFloorRequest(request) ? floor(request) : office(request))
}
