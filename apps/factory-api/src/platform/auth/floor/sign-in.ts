import type { FastifyReply, FastifyRequest } from 'fastify'
import type { FloorSessionEndReason } from '@nexus/factory-db'
import { normalizeBadgeCode, badgeCodeHash } from '@nexus/factory-domain/auth/floor/badge'
import { hashPin, isPinLocked, pinLockUntil, pinProblems, verifyPin } from '@nexus/factory-domain/auth/floor/pin'
import { idleEndAt, sessionEndsAt, sessionState } from '@nexus/factory-domain/auth/floor/session'
import { ConflictError, UnauthenticatedError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandTx } from '../../../core/command'
import { requireContext } from '../../../core/context'
import { workerNoticeGate } from '../../privacy/read'
import { assertCsrf } from '../sessions/cookies'
import type { OfficeAuth } from '../sessions/office-auth'
import { floorSessionOf } from './authenticator'
import { clearFloorCookie, deviceCookieOf, floorCookieOf, setDeviceCookie, setFloorCookie } from './cookies'
import type { FloorCredentials } from './contract'
import { requireDevice, stationRef, type DeviceRequest } from './device'
import { endSessions, floorCommand, floorContext, liveDevice, SESSION_SELECT, siteScope, siteTiming, type FloorDevice } from './store'
import { floorHash, mintSessionToken, parseSessionToken, parseSiteToken } from './tokens'

/**
 * Signing in and out on an enrolled device (plan A1 §3.10 "Floor"; features PLT-057, PLT-058, PLT-060, PLT-062; MES-276):
 *
 *   sign-in   a scanned badge (or the worker picked by name) and the worker's 6-digit PIN, on a device whose token the
 *             request carries. The same answer for an unknown or revoked badge, an inactive worker, a worker without a
 *             PIN, a locked worker and a wrong PIN, after the same scrypt work (no oracle); the lock is checked before
 *             the PIN, so a locked worker confirms no guess. A wrong PIN is counted on the worker (5, then locked for
 *             minutes; the device stays usable for the next person). No biometric factor exists (GDPR art. 9).
 *   one operator per device: the device row names its current session. A live session of ANOTHER worker refuses a
 *             sign-in (409: switch operator instead); the same worker's is replaced; an expired one is closed first
 *             (idle, shift end). The device row is locked for the command, so two sign-ins on one device serialize.
 *   switch    from a signed-in device, the next worker's badge (or name) and PIN: the current session ends (SWITCHED)
 *             and theirs starts, in one command (crews sharing a station).
 *   sign-out  ends the cookie's session (whatever its state) and clears the floor cookie; the device stays enrolled.
 *   me        who is signed in, where, until when, in which language, with which permissions.
 *   notice    sign-in, switch and me also say what the tablet does next about the worker notice (B-W1-36; design
 *             floor.notice): `due` opens it after sign-in (once per version), `blocksScans` holds every scan-taking tile
 *             ("Read the notice first") at a site that names workers until the version in force is acknowledged
 *             (platform/privacy read.ts workerNoticeGate; the …_privacy_guards triggers hold the same).
 *   PIN       the signed-in worker changes their PIN (required after an administrator's reset: until then they hold
 *             nothing).
 * Every write is one floor command with its audit row (audience FLOOR, the device and its site on the row); a token,
 * a badge code and a PIN never reach a command's input, result, audit row or log.
 */

const wrongCredentials = () => new UnauthenticatedError('The badge or PIN is wrong, or this worker is locked for a few minutes after too many wrong PINs.')

const WORKER_SELECT = {
  id: true,
  status: true,
  displayName: true,
  locale: true,
  employeeCode: true,
  pinHash: true,
  pinMustChange: true,
  pinLockedUntil: true,
} as const

interface Candidate {
  readonly worker: { id: string; status: string; displayName: string; locale: string; employeeCode: string | null; pinHash: string | null; pinMustChange: boolean; pinLockedUntil: Date | null }
  readonly badgeId: string | null
}

/** The worker the credentials name, in the device's site, or null (unknown or revoked badge, unknown worker). */
async function candidateOf(auth: OfficeAuth, place: DeviceRequest, body: FloorCredentials): Promise<Candidate | null> {
  if ((body.badgeCode === undefined) === (body.workerId === undefined)) {
    throw new ValidationError('Scan a badge or pick your name, then enter your PIN.', [{ path: 'badgeCode', message: 'Send a badge code or a worker id, not both.' }])
  }
  return auth.database.withScope(siteScope(place.token), async (client) => {
    if (body.badgeCode !== undefined) {
      const code = normalizeBadgeCode(body.badgeCode)
      if (code === null) return null
      const badge = await client.badge.findUnique({ where: { codeHash: badgeCodeHash(code) }, select: { id: true, status: true, worker: { select: WORKER_SELECT } } })
      return badge && badge.status === 'ACTIVE' ? { worker: badge.worker, badgeId: badge.id } : null
    }
    const worker = await client.worker.findUnique({ where: { id: body.workerId! }, select: WORKER_SELECT })
    return worker ? { worker, badgeId: null } : null
  })
}

/** Counts a wrong PIN on the worker (the device is the actor: nobody is proved yet) and sets the lock at the fifth. */
async function recordWrongPin(auth: OfficeAuth, request: FastifyRequest, device: FloorDevice, workerId: string, actorId: string): Promise<void> {
  await floorCommand(auth, floorContext(request, device, actorId), { name: 'floor.signInFailed', input: { workerId } }, async ({ tx, now, audit }) => {
    const { failedPinAttempts } = await tx.worker.update({ where: { id: workerId }, data: { failedPinAttempts: { increment: 1 } }, select: { failedPinAttempts: true } })
    const until = pinLockUntil(failedPinAttempts, now)
    if (until) await tx.worker.updateMany({ where: { id: workerId }, data: { pinLockedUntil: until } })
    audit({ recordType: 'Worker', recordId: workerId, after: { wrong: 'pin', failedPinAttempts, lockedUntil: until ? toUtcIso(until) : null } })
    return null
  })
}

/** Checks the credentials: the worker, or a 401 after the wrong PIN was counted. */
async function provedWorker(auth: OfficeAuth, request: FastifyRequest, place: DeviceRequest, body: FloorCredentials, actorId: string) {
  const now = auth.clock.now()
  const candidate = await candidateOf(auth, place, body)
  const worker = candidate?.worker
  if (!candidate || !worker || worker.status !== 'ACTIVE' || worker.pinHash === null || isPinLocked(worker, now)) {
    await verifyPin(body.pin, null, auth.pins)
    throw wrongCredentials()
  }
  const check = await verifyPin(body.pin, worker.pinHash, auth.pins)
  if (!check.ok) {
    await recordWrongPin(auth, request, place.device, worker.id, actorId)
    throw wrongCredentials()
  }
  return { candidate, pinHash: worker.pinHash, rehash: check.needsRehash ? await hashPin(body.pin, auth.pins) : null }
}

/** The reason an expired session is closed with. */
const expiredReason = (state: ReturnType<typeof sessionState>): FloorSessionEndReason => (state === 'shift_end' ? 'SHIFT_END' : 'IDLE')

interface Started {
  readonly sessionId: string
  readonly startedAt: string
  readonly idleExpiresAt: string
  readonly endsAt: string
}

/**
 * The sign-in command: claims the worker (still active, same PIN, not locked meanwhile), re-checks the badge, locks the
 * device row, settles its current session (refuse, replace, switch or close), starts the new one and points the device
 * at it.
 */
async function startSession(
  auth: OfficeAuth,
  request: FastifyRequest,
  place: DeviceRequest,
  proved: Awaited<ReturnType<typeof provedWorker>>,
  token: string,
  mode: 'sign-in' | 'switch',
): Promise<Started> {
  const { device } = place
  const { worker, badgeId } = proved.candidate
  const name = mode === 'switch' ? 'floor.switchOperator' : 'floor.signIn'
  const { result } = await floorCommand(auth, floorContext(request, device, worker.id), { name, input: { workerId: worker.id, badgeId } }, async ({ tx, now, audit }) => {
    const claimed = await tx.worker.updateMany({
      where: { id: worker.id, status: 'ACTIVE', pinHash: proved.pinHash, OR: [{ pinLockedUntil: null }, { pinLockedUntil: { lte: now } }] },
      data: { failedPinAttempts: 0, pinLockedUntil: null, ...(proved.rehash ? { pinHash: proved.rehash } : {}) },
    })
    if (claimed.count !== 1) throw wrongCredentials()
    if (badgeId !== null && (await tx.badge.count({ where: { id: badgeId, status: 'ACTIVE' } })) !== 1) throw wrongCredentials()

    const locked = await tx.$queryRaw<{ currentSessionId: string | null }[]>`
      SELECT "currentSessionId"::text AS "currentSessionId" FROM "Device" WHERE "id" = ${device.id}::uuid AND "status" = 'ACTIVE' FOR UPDATE`
    if (locked.length !== 1) throw new UnauthenticatedError('This device was revoked.')
    const currentId = locked[0]!.currentSessionId
    if (currentId !== null) await settleCurrent(tx, currentId, worker.id, mode, now, audit)

    const timing = await siteTiming(tx, device.siteId)
    const endsAt = sessionEndsAt(now, timing)
    const idleExpiresAt = idleEndAt(now, timing.idleMinutes, endsAt)
    const sessionId = newId()
    await tx.floorSession.create({
      data: { id: sessionId, siteId: device.siteId, deviceId: device.id, workerId: worker.id, badgeId, tokenHash: floorHash(token), startedAt: now, lastSeenAt: now, idleExpiresAt, endsAt },
      select: { id: true },
    })
    await tx.device.updateMany({ where: { id: device.id }, data: { currentSessionId: sessionId, lastSeenAt: now } })
    audit({ recordType: 'FloorSession', recordId: sessionId, after: { workerId: worker.id, deviceId: device.id, method: badgeId ? 'badge' : 'name', endsAt: toUtcIso(endsAt) } })
    return { sessionId, startedAt: toUtcIso(now), idleExpiresAt: toUtcIso(idleExpiresAt), endsAt: toUtcIso(endsAt) }
  })
  return result
}

/** The device's current session before a new one starts: closed if expired, replaced, switched, or a 409. */
async function settleCurrent(
  tx: CommandTx,
  currentId: string,
  workerId: string,
  mode: 'sign-in' | 'switch',
  now: Date,
  audit: (entry: { action?: string; recordType: string; recordId: string; after?: unknown }) => void,
): Promise<void> {
  const current = await tx.floorSession.findUnique({ where: { id: currentId }, select: SESSION_SELECT })
  if (!current) return
  const state = sessionState(current, now)
  let reason: FloorSessionEndReason
  if (state === 'live') {
    if (current.workerId === workerId) reason = 'REPLACED'
    else if (mode === 'switch') reason = 'SWITCHED'
    else throw new ConflictError('Another operator is signed in on this device: use "switch operator", or ask them to sign out.')
  } else if (state === 'ended') {
    return
  } else {
    reason = expiredReason(state)
  }
  await endSessions(tx, { id: currentId }, reason, now)
  audit({ action: 'floor.endSession', recordType: 'FloorSession', recordId: currentId, after: { endReason: reason } })
}

async function answerStarted(auth: OfficeAuth, reply: FastifyReply, place: DeviceRequest, proved: Awaited<ReturnType<typeof provedWorker>>, token: string, started: Started) {
  const { worker: signedIn } = proved.candidate
  const notice = await auth.database.withScope({ audience: 'floor', tenantId: place.device.tenantId, siteId: place.device.siteId, actorId: signedIn.id }, (client) =>
    workerNoticeGate(client, place.device.siteId, signedIn.id),
  )
  const now = auth.clock.now()
  setFloorCookie(reply, token, new Date(started.endsAt), now)
  // Keep a device in use enrolled: its cookie's 400 days start again.
  setDeviceCookie(reply, place.token.value)
  const { worker } = proved.candidate
  return {
    status: 'signed_in' as const,
    worker: { id: worker.id, displayName: worker.displayName, locale: worker.locale },
    session: { startedAt: started.startedAt, idleExpiresAt: started.idleExpiresAt, endsAt: started.endsAt },
    pinMustChange: worker.pinMustChange,
    notice,
  }
}

export async function floorSignIn(auth: OfficeAuth, request: FastifyRequest, reply: FastifyReply, body: FloorCredentials) {
  assertCsrf(request)
  const place = await requireDevice(auth, request)
  const proved = await provedWorker(auth, request, place, body, place.device.id)
  const token = mintSessionToken()
  const started = await startSession(auth, request, place, proved, token, 'sign-in')
  return answerStarted(auth, reply, place, proved, token, started)
}

export async function switchOperator(auth: OfficeAuth, request: FastifyRequest, reply: FastifyReply, body: FloorCredentials) {
  const session = floorSessionOf(request)
  const place = await requireDevice(auth, request)
  if (place.device.id !== session.device.id) throw new UnauthenticatedError()
  const proved = await provedWorker(auth, request, place, body, session.workerId)
  const token = mintSessionToken()
  const started = await startSession(auth, request, place, proved, token, 'switch')
  return answerStarted(auth, reply, place, proved, token, started)
}

export async function floorSignOut(auth: OfficeAuth, request: FastifyRequest, reply: FastifyReply) {
  assertCsrf(request)
  const deviceToken = parseSiteToken(deviceCookieOf(request))
  const sessionToken = parseSessionToken(floorCookieOf(request))
  if (deviceToken && sessionToken) {
    const now = auth.clock.now()
    const found = await auth.database.withScope(siteScope(deviceToken), async (client) => {
      const device = await liveDevice(client, deviceToken)
      const session = device ? await client.floorSession.findUnique({ where: { tokenHash: floorHash(sessionToken) }, select: SESSION_SELECT }) : null
      return device && session && session.deviceId === device.id && session.endedAt === null ? { device, session } : null
    })
    if (found) {
      const state = sessionState(found.session, now)
      const reason: FloorSessionEndReason = state === 'live' ? 'SIGNED_OUT' : expiredReason(state)
      await floorCommand(auth, floorContext(request, found.device, found.session.workerId), { name: 'floor.signOut', input: null }, async ({ tx, now: at, audit }) => {
        const ended = await endSessions(tx, { id: found.session.id }, reason, at)
        audit({ recordType: 'FloorSession', recordId: found.session.id, after: { endReason: ended.length === 1 ? reason : 'already ended' } })
        return null
      })
    }
  }
  clearFloorCookie(reply)
  return { status: 'signed_out' as const }
}

export async function floorMe(request: FastifyRequest) {
  const context = requireContext(request)
  const session = floorSessionOf(request)
  const { device } = session
  const { site, station, notice } = await request.withClient(async (client) => ({
    site: await client.site.findUniqueOrThrow({ where: { id: device.siteId }, select: { id: true, code: true, name: true } }),
    station: device.stationId ? await client.station.findUnique({ where: { id: device.stationId }, select: { id: true, code: true, name: true } }) : null,
    notice: await workerNoticeGate(client, device.siteId, session.workerId),
  }))
  return {
    worker: { id: session.workerId, displayName: session.worker.displayName, locale: session.worker.locale },
    device: { id: device.id, name: device.name, station: stationRef(station) },
    site,
    session: { startedAt: toUtcIso(session.startedAt), idleExpiresAt: toUtcIso(session.idleExpiresAt), endsAt: toUtcIso(session.endsAt) },
    pinMustChange: session.worker.pinMustChange,
    notice,
    permissions: [...new Set(context.grants.flatMap((grant) => grant.permissions))].sort(),
  }
}

export async function changePin(auth: OfficeAuth, request: FastifyRequest, body: { currentPin: string; newPin: string }) {
  const session = floorSessionOf(request)
  const now = auth.clock.now()
  const worker = await request.withClient((client) =>
    client.worker.findUniqueOrThrow({ where: { id: session.workerId }, select: { pinHash: true, pinLockedUntil: true, employeeCode: true } }),
  )
  if (worker.pinHash === null || isPinLocked(worker, now)) {
    await verifyPin(body.currentPin, null, auth.pins)
    throw wrongCredentials()
  }
  const check = await verifyPin(body.currentPin, worker.pinHash, auth.pins)
  if (!check.ok) {
    await recordWrongPin(auth, request, session.device, session.workerId, session.workerId)
    throw wrongCredentials()
  }
  const problems = pinProblems(body.newPin, { employeeCode: worker.employeeCode })
  if (problems.length > 0) throw new ValidationError('Choose another PIN.', problems.map((issue) => ({ ...issue, path: 'newPin' })))
  if (body.newPin === body.currentPin) throw new ValidationError('Choose a PIN different from the current one.', [{ path: 'newPin', message: 'The same as the current PIN.' }])
  const pinHash = await hashPin(body.newPin, auth.pins)
  const oldHash = worker.pinHash
  await floorCommand(auth, floorContext(request, session.device, session.workerId), { name: 'floor.changePin', input: null }, async ({ tx, now: at, audit }) => {
    const { count } = await tx.worker.updateMany({
      where: { id: session.workerId, pinHash: oldHash },
      data: { pinHash, pinMustChange: false, pinChangedAt: at, failedPinAttempts: 0, pinLockedUntil: null },
    })
    if (count !== 1) throw new ConflictError('The PIN changed meanwhile. Sign in again.')
    audit({ recordType: 'Worker', recordId: session.workerId, after: { pinChanged: true, pinMustChange: false } })
    return null
  })
  return { status: 'changed' as const }
}
