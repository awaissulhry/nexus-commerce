import type { FactoryClient, FloorSessionEndReason, Prisma } from '@nexus/factory-db'
import { crewEndOf, crewLeaveOf, crewMemberState, crewOrder, type CrewEndReason, type CrewMemberFacts } from '@nexus/factory-domain/auth/floor/crew'
import type { CommandTx } from '../../../core/command'

/**
 * THE seam of the crew tables (B-W2b-52; PLT-059 crew mode; factory-db labour.prisma CrewSession, CrewMember): the open
 * crew of a station tablet with its members and their floor sessions, members leaving when their session ends (every
 * path that ends sessions: store.ts endSessions), and the crew ending when its last member left. The …_floor_work_w2b
 * guards stay the last word (one open crew per device, four in at most, one active, a worker in one open crew).
 * Inside a command (floor or office scope) or a read in the device's floor scope.
 */

type Reader = FactoryClient | CommandTx

const MEMBER_SELECT = {
  id: true,
  crewSessionId: true,
  workerId: true,
  employeeId: true,
  floorSessionId: true,
  active: true,
  joinedAt: true,
  leftAt: true,
  version: true,
  worker: { select: { displayName: true, locale: true } },
  floorSession: { select: { id: true, endedAt: true, idleExpiresAt: true, endsAt: true, endReason: true, startedAt: true, pinVerifiedAt: true } },
} as const satisfies Prisma.CrewMemberSelect

export type CrewMemberRow = Prisma.CrewMemberGetPayload<{ select: typeof MEMBER_SELECT }>

export interface OpenCrew {
  readonly id: string
  readonly deviceId: string
  readonly startedAt: Date
  readonly version: number
  /** Every member, in or left, by joining. */
  readonly members: readonly CrewMemberRow[]
}

/** The facts the domain's crew rules read of a member row. */
export function memberFacts(row: CrewMemberRow): CrewMemberFacts {
  const session = row.floorSession
  return {
    id: row.id,
    workerId: row.workerId,
    active: row.active,
    joinedAt: row.joinedAt,
    leftAt: row.leftAt,
    session: session ? { endedAt: session.endedAt, idleExpiresAt: session.idleExpiresAt, endsAt: session.endsAt, endReason: session.endReason as CrewEndReason | null } : null,
  }
}

/** The device's open crew with every member, or null. */
export async function readOpenCrew(db: Reader, deviceId: string): Promise<OpenCrew | null> {
  const crew = await db.crewSession.findFirst({ where: { deviceId, endedAt: null }, select: { id: true, deviceId: true, startedAt: true, version: true } })
  if (!crew) return null
  const members = await db.crewMember.findMany({ where: { crewSessionId: crew.id }, select: MEMBER_SELECT })
  return { ...crew, members: crewOrder(members) }
}

/** The members still in (leftAt empty), by joining. */
export const membersIn = (crew: OpenCrew): CrewMemberRow[] => crew.members.filter((member) => member.leftAt === null)

/**
 * The crew ends once every member left (inside the command that made the last one leave): when the last one left, with
 * the reason of those leaving now (earlier leavers keep the fallback's). Returns whether it ended.
 */
async function endIfEmpty(tx: CommandTx, crewId: string, leaving: readonly { readonly leftAt: Date; readonly reason: CrewEndReason }[], fallback: { readonly at: Date; readonly reason: CrewEndReason }): Promise<boolean> {
  const members = await tx.crewMember.findMany({ where: { crewSessionId: crewId }, select: { id: true, leftAt: true } })
  if (members.some((member) => member.leftAt === null)) return false
  const earlier = members.map((member) => ({ leftAt: member.leftAt!, reason: fallback.reason }))
  const end = crewEndOf([...earlier, ...leaving], fallback)
  await tx.crewSession.updateMany({ where: { id: crewId, endedAt: null }, data: { endedAt: end.endedAt, endReason: end.reason as FloorSessionEndReason, version: { increment: 1 } } })
  return true
}

/**
 * The members whose floor session just ended (store.ts endSessions: a sign-out, a switch, a revoke, a deactivated worker,
 * a PIN reset) leave their crew now; a crew whose last member left ends with the same reason.
 */
export async function leaveCrewsOf(tx: CommandTx, sessionIds: readonly string[], reason: FloorSessionEndReason, now: Date): Promise<void> {
  if (sessionIds.length === 0) return
  const leaving = await tx.crewMember.findMany({ where: { floorSessionId: { in: [...sessionIds] }, leftAt: null }, select: { id: true, crewSessionId: true, joinedAt: true } })
  if (leaving.length === 0) return
  for (const member of leaving) {
    const leftAt = new Date(Math.max(now.getTime(), member.joinedAt.getTime()))
    await tx.crewMember.updateMany({ where: { id: member.id, leftAt: null }, data: { leftAt, active: false, version: { increment: 1 } } })
  }
  for (const crewId of new Set(leaving.map((member) => member.crewSessionId))) {
    await endIfEmpty(tx, crewId, [{ leftAt: now, reason: reason as CrewEndReason }], { at: now, reason: reason as CrewEndReason })
  }
}

export interface Settled {
  /** The crew still open after the settling, or null (none, or it ended). */
  readonly crew: OpenCrew | null
  /** The members who left now (their session ran out or ended), by id. */
  readonly left: readonly string[]
}

/**
 * The device's open crew, settled at `now`: members whose session ended or ran out (idle for the whole crew, past the
 * shift end) leave at that moment, their running-out sessions are closed (IDLE, SHIFT_END) and the device lets go of an
 * active one among them; the crew ends when nobody is left. Inside a command, with the device row locked.
 */
export async function settleCrew(tx: CommandTx, deviceId: string, now: Date): Promise<Settled> {
  const crew = await readOpenCrew(tx, deviceId)
  if (!crew) return { crew: null, left: [] }
  const gone = membersIn(crew).filter((member) => crewMemberState(memberFacts(member), now) === 'gone')
  if (gone.length === 0) return { crew, left: [] }
  const leaving: { leftAt: Date; reason: CrewEndReason }[] = []
  for (const member of gone) {
    const leave = crewLeaveOf(memberFacts(member), now)
    leaving.push(leave)
    await tx.crewMember.updateMany({ where: { id: member.id, leftAt: null }, data: { leftAt: leave.leftAt, active: false, version: { increment: 1 } } })
    if (member.floorSessionId && member.floorSession && member.floorSession.endedAt === null) {
      await tx.floorSession.updateMany({ where: { id: member.floorSessionId, endedAt: null }, data: { endedAt: now, endReason: leave.reason as FloorSessionEndReason } })
    }
  }
  const sessionIds = gone.flatMap((member) => (member.floorSessionId ? [member.floorSessionId] : []))
  if (sessionIds.length > 0) await tx.device.updateMany({ where: { id: deviceId, currentSessionId: { in: sessionIds } }, data: { currentSessionId: null, inUseSince: null } })
  const ended = await endIfEmpty(tx, crew.id, leaving, { at: now, reason: leaving.at(-1)!.reason })
  return { crew: ended ? null : await readOpenCrew(tx, deviceId), left: gone.map((member) => member.id) }
}

/**
 * The crew's sessions stay alive together while the tablet is used (the authenticator's slide of the active one): the
 * other members' idle ends move with it. Bookkeeping, like the slide itself (not audited). Never past a session's end.
 */
export async function slideCrew(db: Reader, deviceId: string, activeSessionId: string, idleExpiresAt: Date, now: Date): Promise<void> {
  const crew = await db.crewSession.findFirst({ where: { deviceId, endedAt: null }, select: { id: true } })
  if (!crew) return
  const others = await db.crewMember.findMany({
    where: { crewSessionId: crew.id, leftAt: null, floorSessionId: { not: null }, NOT: { floorSessionId: activeSessionId } },
    select: { floorSession: { select: { id: true, endsAt: true, endedAt: true, idleExpiresAt: true } } },
  })
  for (const { floorSession: session } of others) {
    if (!session || session.endedAt !== null || session.idleExpiresAt.getTime() <= now.getTime() || session.endsAt.getTime() <= now.getTime()) continue
    const until = new Date(Math.min(idleExpiresAt.getTime(), session.endsAt.getTime()))
    if (until.getTime() > session.idleExpiresAt.getTime()) await db.floorSession.updateMany({ where: { id: session.id, endedAt: null }, data: { idleExpiresAt: until, lastSeenAt: now } })
  }
}
