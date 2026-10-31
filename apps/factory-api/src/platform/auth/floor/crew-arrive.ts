import { CREW_LOOK, crewMemberState, crewPlanFor } from '@nexus/factory-domain/auth/floor/crew'
import { MODE_RULES } from '@nexus/factory-domain/auth/floor/modes'
import { idleEndAt, sessionEndsAt, sessionState } from '@nexus/factory-domain/auth/floor/session'
import { ConflictError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { AuditEntry, CommandTx } from '../../../core/command'
import { memberFacts, membersIn, readOpenCrew, settleCrew, type CrewMemberRow, type OpenCrew } from './crew-store'
import { floorStepUpUntil } from './step-up'
import { siteTiming, type FloorDevice } from './store'
import { floorHash } from './tokens'

/**
 * A proved worker arriving on a station tablet with a crew (B-W2b-52; PLT-059; design floor.signin "Crew on this
 * station"), inside the sign-in's (or the crew route's) command, with the device row locked: a member still in becomes
 * the active one (their own floor session gets the new token: the one in the tablet's cookie now), anyone else joins
 * with a new floor session and becomes the active one, up to four; the one active before waits signed in. Every action
 * then books to the active member (the device's current session is theirs).
 */

/** What a started (or re-activated) floor session answers. */
export interface Started {
  readonly sessionId: string
  readonly startedAt: string
  readonly idleExpiresAt: string
  readonly endsAt: string
  readonly idleMinutes: number
  readonly stepUpUntil: string | null
}

export interface Arrival {
  readonly tx: CommandTx
  readonly now: Date
  readonly audit: (entry: AuditEntry) => void
  readonly device: FloorDevice
  readonly crew: OpenCrew
  readonly worker: { readonly id: string }
  readonly badgeId: string | null
  readonly pinVerified: boolean
  /** The new floor session token (minted before the command; only its hash is stored). */
  readonly token: string
  /**
   * Who may join: `always` (the crew's join, and "switch operator" on a crew tablet), `when-nobody-active` (a sign-in
   * on the tablet's sign-in screen: while a member is active it is a switch, as without a crew), `never` (the crew's
   * switch: only a member becomes active).
   */
  readonly join: 'always' | 'when-nobody-active' | 'never'
}

const employeeOf = async (tx: CommandTx, workerId: string): Promise<string | null> =>
  (await tx.worker.findUnique({ where: { id: workerId }, select: { employeeId: true } }))?.employeeId ?? null

/** The member becomes the active one: their session takes the new token and slides; the device points at it. */
async function activate(arrival: Arrival, member: CrewMemberRow): Promise<Started> {
  const { tx, now, device, crew, token, pinVerified } = arrival
  const session = member.floorSession!
  const timing = await siteTiming(tx, device.siteId)
  const idleExpiresAt = idleEndAt(now, timing.idleMinutes, session.endsAt)
  const moved = await tx.floorSession.updateMany({
    where: { id: session.id, endedAt: null },
    data: { tokenHash: floorHash(token), lastSeenAt: now, idleExpiresAt, ...(pinVerified ? { pinVerifiedAt: now } : {}) },
  })
  if (moved.count !== 1) throw new ConflictError('This sign-in ended meanwhile. Sign in again.')
  await tx.crewMember.updateMany({ where: { crewSessionId: crew.id, active: true, NOT: { id: member.id } }, data: { active: false, version: { increment: 1 } } })
  if (!member.active) await tx.crewMember.updateMany({ where: { id: member.id, leftAt: null }, data: { active: true, version: { increment: 1 } } })
  const before = await tx.device.findUnique({ where: { id: device.id }, select: { inUseSince: true } })
  await tx.device.updateMany({ where: { id: device.id }, data: { currentSessionId: session.id, lastSeenAt: now, inUseSince: before?.inUseSince ?? now } })
  arrival.audit({ action: 'floor.crewActivate', recordType: 'CrewMember', recordId: member.id, after: { crewId: crew.id, workerId: member.workerId, active: true, pin: pinVerified } })
  const pinAt = pinVerified ? now : session.pinVerifiedAt
  const stepUpUntil = floorStepUpUntil(pinAt)
  return {
    sessionId: session.id,
    startedAt: toUtcIso(session.startedAt),
    idleExpiresAt: toUtcIso(idleExpiresAt),
    endsAt: toUtcIso(session.endsAt),
    idleMinutes: timing.idleMinutes,
    stepUpUntil: stepUpUntil && stepUpUntil.getTime() > now.getTime() ? toUtcIso(stepUpUntil) : null,
  }
}

/** A worker still in the open crew of another tablet: settle it there first (they may have left by now), else a 409. */
async function refuseIfInAnotherCrew(tx: CommandTx, workerId: string, crewId: string, now: Date): Promise<void> {
  const elsewhere = await tx.crewMember.findFirst({ where: { workerId, leftAt: null, crewSessionId: { not: crewId }, crew: { endedAt: null } }, select: { crew: { select: { deviceId: true } } } })
  if (!elsewhere) return
  await settleCrew(tx, elsewhere.crew.deviceId, now)
  const still = await tx.crewMember.count({ where: { workerId, leftAt: null, crewSessionId: { not: crewId }, crew: { endedAt: null } } })
  if (still > 0) throw new ConflictError('You are signed in on the crew of another tablet: sign out there first.')
}

/** The arrival on a tablet with an open crew (see the file's comment). */
export async function arriveOnCrew(arrival: Arrival): Promise<Started> {
  const { tx, now, device, crew, worker, badgeId, token } = arrival
  const inCrew = membersIn(crew).filter((member) => crewMemberState(memberFacts(member), now) === 'in')
  const plan = crewPlanFor(inCrew, worker.id)
  if (plan.kind === 'activate') return activate(arrival, inCrew.find((member) => member.id === plan.memberId)!)
  if (arrival.join === 'never') throw new ConflictError('This person is not signed in on this crew: add them with their badge first.')
  if (arrival.join === 'when-nobody-active') {
    const current = await tx.device.findUnique({ where: { id: device.id }, select: { currentSession: { select: { endedAt: true, idleExpiresAt: true, endsAt: true } } } })
    if (current?.currentSession && sessionState(current.currentSession, now) === 'live') {
      throw new ConflictError('Another operator is signed in on this device: use "switch operator", or ask them to sign out.')
    }
  }
  if (plan.kind === 'full') throw new ConflictError('Four people are signed in on this tablet: one of them signs out first.')
  await refuseIfInAnotherCrew(tx, worker.id, crew.id, now)

  const timing = await siteTiming(tx, device.siteId)
  const endsAt = sessionEndsAt(now, timing)
  const idleExpiresAt = idleEndAt(now, timing.idleMinutes, endsAt)
  const sessionId = newId()
  const pinVerifiedAt = arrival.pinVerified ? now : null
  await tx.floorSession.create({
    data: { id: sessionId, siteId: device.siteId, deviceId: device.id, workerId: worker.id, badgeId, tokenHash: floorHash(token), startedAt: now, lastSeenAt: now, idleExpiresAt, endsAt, pinVerifiedAt },
    select: { id: true },
  })
  arrival.audit({ recordType: 'FloorSession', recordId: sessionId, after: { workerId: worker.id, deviceId: device.id, method: badgeId ? 'badge' : 'name', pin: arrival.pinVerified, endsAt: toUtcIso(endsAt), crewId: crew.id } })
  const memberId = newId()
  await tx.crewMember.create({
    data: { id: memberId, siteId: device.siteId, crewSessionId: crew.id, workerId: worker.id, employeeId: await employeeOf(tx, worker.id), floorSessionId: sessionId, active: false, joinedAt: now, createdAt: now, updatedAt: now, createdById: worker.id },
    select: { id: true },
  })
  arrival.audit({ action: 'floor.crewJoin', recordType: 'CrewMember', recordId: memberId, after: { crewId: crew.id, workerId: worker.id } })
  const joined = (await readOpenCrew(tx, device.id))!.members.find((member) => member.id === memberId)!
  return activate(arrival, joined)
}

/**
 * Opens a crew on the tablet with the person signed in now as its first, active member (the first join), inside the
 * command with the device row locked. Station tablets only (the database says the same).
 */
export async function openCrew(tx: CommandTx, now: Date, audit: (entry: AuditEntry) => void, device: FloorDevice, starter: { readonly sessionId: string; readonly workerId: string }): Promise<OpenCrew> {
  if (!MODE_RULES[device.mode].crew) throw new ConflictError('Crews sign in on a station tablet only.')
  const crewId = newId()
  await tx.crewSession.create({ data: { id: crewId, siteId: device.siteId, deviceId: device.id, startedAt: now, createdAt: now, updatedAt: now, createdById: starter.workerId }, select: { id: true } })
  audit({ action: 'floor.crewStart', recordType: 'CrewSession', recordId: crewId, after: { deviceId: device.id } })
  const memberId = newId()
  await tx.crewMember.create({
    data: { id: memberId, siteId: device.siteId, crewSessionId: crewId, workerId: starter.workerId, employeeId: await employeeOf(tx, starter.workerId), floorSessionId: starter.sessionId, active: true, joinedAt: now, createdAt: now, updatedAt: now, createdById: starter.workerId },
    select: { id: true },
  })
  audit({ action: 'floor.crewJoin', recordType: 'CrewMember', recordId: memberId, after: { crewId, workerId: starter.workerId, active: true } })
  return (await readOpenCrew(tx, device.id))!
}

/** The crew strip: the members signed in now, by joining, the active one marked (null: no crew, or nobody in). */
export function crewViewOf(crew: OpenCrew | null, now: Date, max: number) {
  if (!crew) return null
  const members = membersIn(crew).filter((member) => crewMemberState(memberFacts(member), now) === 'in')
  if (members.length === 0) return null
  return {
    id: crew.id,
    startedAt: toUtcIso(crew.startedAt),
    max,
    members: members.map((member) => ({
      workerId: member.workerId,
      displayName: member.worker.displayName,
      locale: member.worker.locale,
      active: member.active,
      joinedAt: toUtcIso(member.joinedAt),
      look: member.active ? CREW_LOOK.active : CREW_LOOK.waiting,
    })),
  }
}
