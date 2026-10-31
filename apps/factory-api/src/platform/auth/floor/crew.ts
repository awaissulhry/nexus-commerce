import type { FastifyReply, FastifyRequest } from 'fastify'
import { CREW } from '@nexus/factory-domain/auth/floor/crew'
import { MODE_RULES } from '@nexus/factory-domain/auth/floor/modes'
import { sessionState } from '@nexus/factory-domain/auth/floor/session'
import { ConflictError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import type { CommandTx } from '../../../core/command'
import { floorSessionOf } from './authenticator'
import { clearFloorCookie } from './cookies'
import type { FloorCredentials } from './contract'
import { arriveOnCrew, crewViewOf, openCrew } from './crew-arrive'
import { membersIn, readOpenCrew, settleCrew } from './crew-store'
import { requireDevice, type DeviceRequest } from './device'
import { answerStarted, claimProved, provedWorker, refuseByMode } from './sign-in'
import { endSessions, floorCommand, floorContext, SESSION_SELECT, siteScope } from './store'
import { mintSessionToken } from './tokens'
import type { OfficeAuth } from '../sessions/office-auth'

/**
 * Crew mode on a station tablet (B-W2b-52; PLT-059, Owner question 24; design floor.signin "Crew on this station"): the
 * routes of the crew strip, from a signed-in tablet. The rules are factory-domain auth/floor/crew; the in-command work is
 * crew-arrive.ts (arrive, open) and crew-store.ts (settle, leave, slide).
 *
 *   GET  /floor/crew          the open crew (null: one operator) and whether this tablet takes a crew (STATION mode)
 *   POST /floor/crew/join     the next person's badge (or name and PIN): the first join opens the crew with the person
 *                             signed in now; the new one joins and becomes the active one (up to four; 409 when full,
 *                             when they are in another tablet's crew, or on a tablet that is not a station's)
 *   POST /floor/crew/switch   a member proves it is them (badge, or PIN; a badge alone where the site allows it): they
 *                             become the active one (409 for a person not on the crew)
 *   POST /floor/crew/leave    the active member signs out of the crew (their session ends SIGNED_OUT; the cookie goes);
 *                             nobody is active until a member signs in again on the tablet
 *   POST /floor/crew/end      everyone signs out: every member's session ends, the crew ends
 * Each write is one floor command with its audit rows, the device row locked (FOR UPDATE) first, the crew settled (gone
 * members leave) before anything else; a badge code, a PIN and a token never reach a command's input, result or audit.
 */

async function lockDevice(tx: CommandTx, deviceId: string): Promise<{ currentSessionId: string | null }> {
  const locked = await tx.$queryRaw<{ currentSessionId: string | null }[]>`
    SELECT "currentSessionId"::text AS "currentSessionId" FROM "Device" WHERE "id" = ${deviceId}::uuid AND "status" = 'ACTIVE' FOR UPDATE`
  if (locked.length !== 1) throw new UnauthenticatedError('This device was revoked.')
  return locked[0]!
}

/** The signed-in tablet of the request (its session is the device's current one: the authenticator checked it). */
async function signedInTablet(auth: OfficeAuth, request: FastifyRequest): Promise<{ place: DeviceRequest; session: ReturnType<typeof floorSessionOf> }> {
  const session = floorSessionOf(request)
  const place = await requireDevice(auth, request)
  if (place.device.id !== session.device.id) throw new UnauthenticatedError()
  return { place, session }
}

export async function getCrew(auth: OfficeAuth, request: FastifyRequest) {
  const { place } = await signedInTablet(auth, request)
  const crew = await auth.database.withScope(siteScope(place.token), (client) => readOpenCrew(client, place.device.id))
  return { crew: crewViewOf(crew, auth.clock.now(), CREW.maxMembers), allowed: MODE_RULES[place.device.mode].crew }
}

async function crewAnswer(auth: OfficeAuth, place: DeviceRequest) {
  const crew = await auth.database.withScope(siteScope(place.token), (client) => readOpenCrew(client, place.device.id))
  return crewViewOf(crew, auth.clock.now(), CREW.maxMembers)
}

export async function joinCrew(auth: OfficeAuth, request: FastifyRequest, reply: FastifyReply, body: FloorCredentials) {
  const { place, session } = await signedInTablet(auth, request)
  if (!MODE_RULES[place.device.mode].crew) throw new ConflictError('Crews sign in on a station tablet only.')
  refuseByMode(place, null)
  const proved = await provedWorker(auth, request, place, body, session.workerId)
  const token = mintSessionToken()
  const { worker, badgeId } = proved.candidate
  const { result: started } = await floorCommand(auth, floorContext(request, place.device, session.workerId), { name: 'floor.crewJoin', input: { workerId: worker.id, badgeId } }, async ({ tx, now, audit }) => {
    const locked = await lockDevice(tx, place.device.id)
    await claimProved(tx, place.device, proved, now)
    let crew = (await settleCrew(tx, place.device.id, now)).crew
    if (!crew) {
      // The first join: the person signed in now opens the crew (their session must still be the device's live one).
      const current = locked.currentSessionId ? await tx.floorSession.findUnique({ where: { id: locked.currentSessionId }, select: SESSION_SELECT }) : null
      if (!current || current.id !== session.id || sessionState(current, now) !== 'live') throw new UnauthenticatedError('This sign-in ended meanwhile. Sign in again.')
      crew = await openCrew(tx, now, audit, place.device, { sessionId: session.id, workerId: session.workerId })
    }
    return arriveOnCrew({ tx, now, audit, device: place.device, crew, worker, badgeId, pinVerified: proved.pinVerified, token, join: 'always' })
  })
  const answer = await answerStarted(auth, reply, place, proved, token, started)
  return { ...answer, crew: (await crewAnswer(auth, place))! }
}

export async function switchCrew(auth: OfficeAuth, request: FastifyRequest, reply: FastifyReply, body: FloorCredentials) {
  const { place, session } = await signedInTablet(auth, request)
  const proved = await provedWorker(auth, request, place, body, session.workerId)
  const token = mintSessionToken()
  const { worker, badgeId } = proved.candidate
  const { result: started } = await floorCommand(auth, floorContext(request, place.device, session.workerId), { name: 'floor.crewSwitch', input: { workerId: worker.id, badgeId } }, async ({ tx, now, audit }) => {
    await lockDevice(tx, place.device.id)
    await claimProved(tx, place.device, proved, now)
    const crew = (await settleCrew(tx, place.device.id, now)).crew
    if (!crew) throw new ConflictError('There is no crew on this tablet: use "switch operator".')
    return arriveOnCrew({ tx, now, audit, device: place.device, crew, worker, badgeId, pinVerified: proved.pinVerified, token, join: 'never' })
  })
  const answer = await answerStarted(auth, reply, place, proved, token, started)
  return { ...answer, crew: (await crewAnswer(auth, place))! }
}

export async function leaveCrew(auth: OfficeAuth, request: FastifyRequest, reply: FastifyReply) {
  const { place, session } = await signedInTablet(auth, request)
  await floorCommand(auth, floorContext(request, place.device, session.workerId), { name: 'floor.crewLeave', input: null }, async ({ tx, now, audit }) => {
    await lockDevice(tx, place.device.id)
    await settleCrew(tx, place.device.id, now)
    const ended = await endSessions(tx, { id: session.id }, 'SIGNED_OUT', now)
    audit({ recordType: 'FloorSession', recordId: session.id, after: { endReason: ended.length === 1 ? 'SIGNED_OUT' : 'already ended', crew: 'left' } })
    return null
  })
  clearFloorCookie(reply)
  return { status: 'left' as const, crew: await crewAnswer(auth, place) }
}

export async function endCrew(auth: OfficeAuth, request: FastifyRequest, reply: FastifyReply) {
  const { place, session } = await signedInTablet(auth, request)
  await floorCommand(auth, floorContext(request, place.device, session.workerId), { name: 'floor.crewEnd', input: null }, async ({ tx, now, audit }) => {
    await lockDevice(tx, place.device.id)
    const crew = (await settleCrew(tx, place.device.id, now)).crew
    if (!crew) throw new ConflictError('There is no crew on this tablet: sign out instead.')
    const sessionIds = membersIn(crew).flatMap((member) => (member.floorSessionId ? [member.floorSessionId] : []))
    const ended = await endSessions(tx, { id: { in: sessionIds } }, 'SIGNED_OUT', now)
    audit({ recordType: 'CrewSession', recordId: crew.id, after: { endReason: 'SIGNED_OUT', sessionsEnded: ended.length } })
    return null
  })
  clearFloorCookie(reply)
  return { status: 'ended' as const }
}
