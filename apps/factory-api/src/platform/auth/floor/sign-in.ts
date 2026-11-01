import type { FastifyReply, FastifyRequest } from 'fastify'
import type { FloorSessionEndReason } from '@nexus/factory-db'
import { normalizeBadgeCode, badgeCodeHash } from '@nexus/factory-domain/auth/floor/badge'
import { CREW } from '@nexus/factory-domain/auth/floor/crew'
import { speechLang } from '@nexus/factory-domain/auth/floor/literacy'
import { signInRefusal } from '@nexus/factory-domain/auth/floor/modes'
import { hashPin, isPinLocked, pinLockUntil, pinProblems, verifyPin } from '@nexus/factory-domain/auth/floor/pin'
import { idleEndAt, sessionEndsAt, sessionState } from '@nexus/factory-domain/auth/floor/session'
import { ConflictError, ForbiddenError, UnauthenticatedError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import type { CommandTx } from '../../../core/command'
import { requireContext } from '../../../core/context'
import { workerNoticeGate } from '../../privacy/read'
import { assertCsrf } from '../sessions/cookies'
import type { OfficeAuth } from '../sessions/office-auth'
import { floorSessionOf } from './authenticator'
import { clearFloorCookie, deviceCookieOf, floorCookieOf, setDeviceCookie, setFloorCookie } from './cookies'
import type { FloorCredentials } from './contract'
import { arriveOnCrew, crewViewOf, type Started } from './crew-arrive'
import { readOpenCrew, settleCrew } from './crew-store'
import { modeRulesOf, requireDevice, shownLine, STATION_SELECT, stationRef, type DeviceRequest } from './device'
import { floorStepUpUntil } from './step-up'
import { badgeOnlySignIn, endSessions, floorCommand, floorContext, liveDevice, SESSION_SELECT, siteScope, siteTiming, type FloorDevice } from './store'
import { floorHash, mintSessionToken, parseSessionToken, parseSiteToken } from './tokens'

/**
 * Signing in and out on an enrolled device (plan A1 §3.10 "Floor"; features PLT-057, PLT-058, PLT-060, PLT-062; MES-276):
 *
 *   sign-in   a scanned badge (or the worker picked by name) and the worker's 6-digit PIN, on a device whose token the
 *             request carries. At a site whose floor settings say so (`badgeOnlySignIn`, Owner answer F1 a) a badge
 *             alone signs in: no PIN is checked, so the session has no proved PIN (`pinVerifiedAt` null) and signing
 *             acts and My day ask it first (step-up.ts); a badge alone never clears a count of wrong PINs, and a
 *             locked worker or one without a PIN is refused as with a PIN. A sign-in by name always needs the PIN, and
 *             a site without the setting answers 400 to a badge without one (independent of the badge: no oracle). The same answer for an unknown or revoked badge, an inactive worker, a worker without a
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
 *   step-up   the signed-in worker proves their PIN again (POST /floor/step-up): `pinVerifiedAt` = now; a wrong PIN
 *             counts towards the lockout as at sign-in; a locked worker gets a 403 (never a 401: they stay signed in).
 *   modes     B-W2b-52 (MES-181, MES-186): nobody signs in on a line board (403 before any PIN is checked); only its
 *             person on a personal phone (403 after the proof: a wrong PIN still counts).
 *   crews     B-W2b-52 (PLT-059): on a station tablet with an open crew (crew-arrive.ts), a sign-in or a switch makes a
 *             member still in the active one (their own session takes the new token) or adds the person to the crew;
 *             nobody's session ends. A sign-in while a member is active stays a 409 (switch instead), as without a crew.
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
export async function recordWrongPin(auth: OfficeAuth, request: FastifyRequest, device: FloorDevice, workerId: string, actorId: string): Promise<void> {
  await floorCommand(auth, floorContext(request, device, actorId), { name: 'floor.signInFailed', input: { workerId } }, async ({ tx, now, audit }) => {
    const { failedPinAttempts } = await tx.worker.update({ where: { id: workerId }, data: { failedPinAttempts: { increment: 1 } }, select: { failedPinAttempts: true } })
    const until = pinLockUntil(failedPinAttempts, now)
    if (until) await tx.worker.updateMany({ where: { id: workerId }, data: { pinLockedUntil: until } })
    audit({ recordType: 'Worker', recordId: workerId, after: { wrong: 'pin', failedPinAttempts, lockedUntil: until ? toUtcIso(until) : null } })
    return null
  })
}

const pinRequired = (message: string) => new ValidationError(message, [{ path: 'pin', message: 'Required.' }])

export interface Proved {
  readonly candidate: Candidate
  readonly pinHash: string
  readonly rehash: string | null
  /** The PIN was checked (false: a badge alone at a badge-only site). */
  readonly pinVerified: boolean
}

/**
 * Checks the credentials: the worker, or a 401 after the wrong PIN was counted. Without a PIN: a 400 for a sign-in by
 * name or at a site that wants the PIN (decided before the badge is looked up), else the badge alone.
 */
export async function provedWorker(auth: OfficeAuth, request: FastifyRequest, place: DeviceRequest, body: FloorCredentials, actorId: string): Promise<Proved> {
  if ((body.badgeCode === undefined) === (body.workerId === undefined)) {
    throw new ValidationError('Scan a badge or pick your name, then enter your PIN.', [{ path: 'badgeCode', message: 'Send a badge code or a worker id, not both.' }])
  }
  const now = auth.clock.now()
  if (body.pin === undefined) {
    if (body.workerId !== undefined) throw pinRequired('Enter your PIN: a sign-in by name always needs it.')
    const badgeOnly = await auth.database.withScope(siteScope(place.token), (client) => badgeOnlySignIn(client, place.device.siteId))
    if (!badgeOnly) throw pinRequired('Enter your PIN: this site signs in with a badge and a PIN.')
    const candidate = await candidateOf(auth, place, body)
    const worker = candidate?.worker
    if (!candidate || !worker || worker.status !== 'ACTIVE' || worker.pinHash === null || isPinLocked(worker, now)) throw wrongCredentials()
    return { candidate, pinHash: worker.pinHash, rehash: null, pinVerified: false }
  }
  const pin = body.pin
  const candidate = await candidateOf(auth, place, body)
  const worker = candidate?.worker
  if (!candidate || !worker || worker.status !== 'ACTIVE' || worker.pinHash === null || isPinLocked(worker, now)) {
    await verifyPin(pin, null, auth.pins)
    throw wrongCredentials()
  }
  const check = await verifyPin(pin, worker.pinHash, auth.pins)
  if (!check.ok) {
    await recordWrongPin(auth, request, place.device, worker.id, actorId)
    throw wrongCredentials()
  }
  return { candidate, pinHash: worker.pinHash, rehash: check.needsRehash ? await hashPin(pin, auth.pins) : null, pinVerified: true }
}

/**
 * Inside the sign-in's (or a crew route's) command: the proved worker is still active, with the same PIN, not locked
 * meanwhile; a proved PIN clears the count of wrong ones (and re-hashes an older hash); a badge alone leaves the count as
 * it is (else a badge could clear wrong PINs between guesses) and the site must still allow it; the badge is still active.
 */
export async function claimProved(tx: CommandTx, device: Pick<FloorDevice, 'siteId'>, proved: Proved, now: Date): Promise<void> {
  const { worker, badgeId } = proved.candidate
  const still = { id: worker.id, status: 'ACTIVE' as const, pinHash: proved.pinHash, OR: [{ pinLockedUntil: null }, { pinLockedUntil: { lte: now } }] }
  if (proved.pinVerified) {
    const claimed = await tx.worker.updateMany({ where: still, data: { failedPinAttempts: 0, pinLockedUntil: null, ...(proved.rehash ? { pinHash: proved.rehash } : {}) } })
    if (claimed.count !== 1) throw wrongCredentials()
  } else {
    if ((await tx.worker.count({ where: still })) !== 1) throw wrongCredentials()
    if (!(await badgeOnlySignIn(tx, device.siteId))) throw pinRequired('Enter your PIN: this site signs in with a badge and a PIN.')
  }
  if (badgeId !== null && (await tx.badge.count({ where: { id: badgeId, status: 'ACTIVE' } })) !== 1) throw wrongCredentials()
}

/** The reason an expired session is closed with. */
const expiredReason = (state: ReturnType<typeof sessionState>): FloorSessionEndReason => (state === 'shift_end' ? 'SHIFT_END' : 'IDLE')

/**
 * The sign-in command: claims the worker (still active, same PIN, not locked meanwhile), re-checks the badge, locks the
 * device row, settles its current session (refuse, replace, switch or close), starts the new one and points the device
 * at it.
 */
async function startSession(
  auth: OfficeAuth,
  request: FastifyRequest,
  place: DeviceRequest,
  proved: Proved,
  token: string,
  mode: 'sign-in' | 'switch',
): Promise<Started> {
  const { device } = place
  const { worker, badgeId } = proved.candidate
  const name = mode === 'switch' ? 'floor.switchOperator' : 'floor.signIn'
  const { result } = await floorCommand(auth, floorContext(request, device, worker.id), { name, input: { workerId: worker.id, badgeId } }, async ({ tx, now, audit }) => {
    await claimProved(tx, device, proved, now)

    const locked = await tx.$queryRaw<{ currentSessionId: string | null }[]>`
      SELECT "currentSessionId"::text AS "currentSessionId" FROM "Device" WHERE "id" = ${device.id}::uuid AND "status" = 'ACTIVE' FOR UPDATE`
    if (locked.length !== 1) throw new UnauthenticatedError('This device was revoked.')
    // B-W2b-52 (PLT-059): a tablet with an open crew: the person becomes its active member (or joins it); nobody's session ends.
    const settled = await settleCrew(tx, device.id, now)
    if (settled.crew) {
      return arriveOnCrew({ tx, now, audit, device, crew: settled.crew, worker, badgeId, pinVerified: proved.pinVerified, token, join: mode === 'switch' ? 'always' : 'when-nobody-active' })
    }
    const currentId = locked[0]!.currentSessionId
    if (currentId !== null) await settleCurrent(tx, currentId, worker.id, mode, now, audit)

    const timing = await siteTiming(tx, device.siteId)
    const endsAt = sessionEndsAt(now, timing)
    const idleExpiresAt = idleEndAt(now, timing.idleMinutes, endsAt)
    const sessionId = newId()
    const pinVerifiedAt = proved.pinVerified ? now : null
    await tx.floorSession.create({
      data: {
        id: sessionId,
        siteId: device.siteId,
        deviceId: device.id,
        workerId: worker.id,
        badgeId,
        tokenHash: floorHash(token),
        startedAt: now,
        lastSeenAt: now,
        idleExpiresAt,
        endsAt,
        pinVerifiedAt,
      },
      select: { id: true },
    })
    await tx.device.updateMany({ where: { id: device.id }, data: { currentSessionId: sessionId, inUseSince: now, lastSeenAt: now } })
    audit({ recordType: 'FloorSession', recordId: sessionId, after: { workerId: worker.id, deviceId: device.id, method: badgeId ? 'badge' : 'name', pin: proved.pinVerified, endsAt: toUtcIso(endsAt) } })
    const stepUpUntil = floorStepUpUntil(pinVerifiedAt)
    return {
      sessionId,
      startedAt: toUtcIso(now),
      idleExpiresAt: toUtcIso(idleExpiresAt),
      endsAt: toUtcIso(endsAt),
      idleMinutes: timing.idleMinutes,
      stepUpUntil: stepUpUntil ? toUtcIso(stepUpUntil) : null,
    }
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

export async function answerStarted(auth: OfficeAuth, reply: FastifyReply, place: DeviceRequest, proved: Proved, token: string, started: Started) {
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
    session: { startedAt: started.startedAt, idleExpiresAt: started.idleExpiresAt, endsAt: started.endsAt, idleMinutes: started.idleMinutes, stepUpUntil: started.stepUpUntil },
    pinMustChange: worker.pinMustChange,
    notice,
  }
}

/** B-W2b-52: nobody signs in on a line board (before any PIN work); only its person on a phone (after the proof). */
export function refuseByMode(place: DeviceRequest, workerId: string | null): void {
  const refusal = signInRefusal(place.device, workerId)
  if (refusal) throw new ForbiddenError(refusal.message)
}

export async function floorSignIn(auth: OfficeAuth, request: FastifyRequest, reply: FastifyReply, body: FloorCredentials) {
  assertCsrf(request)
  const place = await requireDevice(auth, request)
  refuseByMode(place, null)
  const proved = await provedWorker(auth, request, place, body, place.device.id)
  refuseByMode(place, proved.candidate.worker.id)
  const token = mintSessionToken()
  const started = await startSession(auth, request, place, proved, token, 'sign-in')
  return answerStarted(auth, reply, place, proved, token, started)
}

export async function switchOperator(auth: OfficeAuth, request: FastifyRequest, reply: FastifyReply, body: FloorCredentials) {
  const session = floorSessionOf(request)
  const place = await requireDevice(auth, request)
  if (place.device.id !== session.device.id) throw new UnauthenticatedError()
  refuseByMode(place, null)
  const proved = await provedWorker(auth, request, place, body, session.workerId)
  refuseByMode(place, proved.candidate.worker.id)
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

export async function floorMe(auth: OfficeAuth, request: FastifyRequest) {
  const context = requireContext(request)
  const session = floorSessionOf(request)
  const { device } = session
  const { site, station, notice, timing, line, crew } = await request.withClient(async (client) => ({
    site: await client.site.findUniqueOrThrow({ where: { id: device.siteId }, select: { id: true, code: true, name: true } }),
    station: device.stationId ? await client.station.findUnique({ where: { id: device.stationId }, select: STATION_SELECT }) : null,
    notice: await workerNoticeGate(client, device.siteId, session.workerId),
    timing: await siteTiming(client, device.siteId),
    line: await shownLine(client, device),
    crew: await readOpenCrew(client, device.id),
  }))
  const stepUpUntil = floorStepUpUntil(session.pinVerifiedAt)
  return {
    worker: { id: session.workerId, displayName: session.worker.displayName, locale: session.worker.locale },
    device: { id: device.id, name: device.name, station: stationRef(station), mode: device.mode },
    rules: modeRulesOf(device.mode),
    line,
    crew: crewViewOf(crew, auth.clock.now(), CREW.maxMembers),
    speech: { lang: speechLang(session.worker.locale) },
    site,
    scanTag: tenantTag(device.tenantId),
    session: {
      startedAt: toUtcIso(session.startedAt),
      idleExpiresAt: toUtcIso(session.idleExpiresAt),
      endsAt: toUtcIso(session.endsAt),
      idleMinutes: timing.idleMinutes,
      stepUpUntil: stepUpUntil ? toUtcIso(stepUpUntil) : null,
    },
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

/** The signed-in worker proves their PIN again (step-up.ts): signing acts and My day open for a short while. */
export async function floorStepUp(auth: OfficeAuth, request: FastifyRequest, body: { pin: string }): Promise<{ stepUpUntil: string }> {
  const session = floorSessionOf(request)
  const now = auth.clock.now()
  const wrong = () => new ValidationError('The PIN is wrong.', [{ path: 'pin', message: 'Wrong PIN.' }])
  const worker = await request.withClient((client) => client.worker.findUniqueOrThrow({ where: { id: session.workerId }, select: { pinHash: true, pinLockedUntil: true } }))
  if (worker.pinHash === null || isPinLocked(worker, now)) {
    await verifyPin(body.pin, null, auth.pins)
    if (worker.pinHash === null) throw wrong()
    throw new ForbiddenError('Too many wrong PINs: wait a few minutes, or ask your team leader to reset your PIN.')
  }
  const check = await verifyPin(body.pin, worker.pinHash, auth.pins)
  if (!check.ok) {
    await recordWrongPin(auth, request, session.device, session.workerId, session.workerId)
    throw wrong()
  }
  const rehash = check.needsRehash ? await hashPin(body.pin, auth.pins) : null
  const oldHash = worker.pinHash
  const { result } = await floorCommand(auth, floorContext(request, session.device, session.workerId), { name: 'floor.stepUp', input: null }, async ({ tx, now: at, audit }) => {
    // The same PIN, not locked meanwhile: the proof clears the count of wrong ones, as a sign-in with the PIN does.
    const claimed = await tx.worker.updateMany({
      where: { id: session.workerId, pinHash: oldHash, OR: [{ pinLockedUntil: null }, { pinLockedUntil: { lte: at } }] },
      data: { failedPinAttempts: 0, pinLockedUntil: null, ...(rehash ? { pinHash: rehash } : {}) },
    })
    if (claimed.count !== 1) throw new ConflictError('The PIN changed meanwhile. Sign in again.')
    const marked = await tx.floorSession.updateMany({ where: { id: session.id, endedAt: null }, data: { pinVerifiedAt: at } })
    if (marked.count !== 1) throw new ConflictError('This sign-in ended meanwhile. Sign in again.')
    audit({ recordType: 'FloorSession', recordId: session.id, after: { pinVerifiedAt: toUtcIso(at) } })
    return toUtcIso(floorStepUpUntil(at)!)
  })
  return { stepUpUntil: result }
}
