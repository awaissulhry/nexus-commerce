import type { FloorLook } from './literacy'
import { sessionState } from './session'

/**
 * Crew mode on one station tablet (B-W2b-52; PLT-059, Owner question 24: a shared tablet per line needs crew mode;
 * design floor.signin "Crew on this station"; factory-db labour.prisma CrewSession, CrewMember). Several workers are
 * signed in on one STATION tablet, up to four, exactly one of them active: every action books to the active member
 * (the device's current floor session is theirs). Each member keeps their own floor session on the device for the
 * crew; the others wait signed in.
 *
 *   join     from a signed-in tablet, the next person's badge (or name and PIN): they join and become the active one.
 *            The first join opens the crew with the person already signed in.
 *   switch   a member taps their chip and proves it is them (badge, or PIN): they become the active one. Never without
 *            a proof (a chip alone switches nothing): an action never books to someone who is not at the tablet.
 *   leave    the active member signs out of the crew; nobody is active until a member proves it is them again.
 *   end      everyone signs out (the end of a shift); the crew ends.
 * A member whose session ended or ran out (idle for the whole crew, past the shift end) has left at that moment; the
 * crew ends when its last member has left. The crew's sessions stay alive together while the tablet is used.
 *
 * Statuto dei Lavoratori art. 4: a crew records who was signed in on which tablet when (traceability, as a floor
 * session does), never how fast; the line's views say "signed in" or "nobody", never who (Owner answer F2).
 * Pure: the facts come in.
 */

export const CREW = Object.freeze({
  /** Workers signed in on one tablet at once (the database holds the same). */
  maxMembers: 4,
})

/** Why a member left or a crew ended (factory-db FloorSessionEndReason). */
export type CrewEndReason = 'SIGNED_OUT' | 'SWITCHED' | 'REPLACED' | 'IDLE' | 'SHIFT_END' | 'DEVICE_REVOKED' | 'BADGE_REVOKED' | 'WORKER_DEACTIVATED' | 'PIN_RESET'

export interface CrewSessionFacts {
  readonly endedAt: Date | null
  readonly idleExpiresAt: Date
  readonly endsAt: Date
  readonly endReason: CrewEndReason | null
}

export interface CrewMemberFacts {
  readonly id: string
  readonly workerId: string
  readonly active: boolean
  readonly joinedAt: Date
  readonly leftAt: Date | null
  /** The member's floor session on the crew's device (null: none, which counts as gone). */
  readonly session: CrewSessionFacts | null
}

/** in: signed in on the crew; gone: their session ended or ran out (they leave at the next look); left: recorded. */
export type CrewMemberState = 'in' | 'gone' | 'left'

export function crewMemberState(member: CrewMemberFacts, now: Date): CrewMemberState {
  if (member.leftAt !== null) return 'left'
  if (member.session === null) return 'gone'
  return sessionState(member.session, now) === 'live' ? 'in' : 'gone'
}

/** When and why a gone member left: when their session ended or ran out (never before they joined, never after now). */
export function crewLeaveOf(member: CrewMemberFacts, now: Date): { readonly leftAt: Date; readonly reason: CrewEndReason } {
  const session = member.session
  let at = now
  let reason: CrewEndReason = 'SIGNED_OUT'
  if (session) {
    const state = sessionState(session, now)
    if (state === 'ended') {
      at = session.endedAt!
      reason = session.endReason ?? 'SIGNED_OUT'
    } else if (state === 'shift_end') {
      at = session.endsAt
      reason = 'SHIFT_END'
    } else if (state === 'idle') {
      at = session.idleExpiresAt
      reason = 'IDLE'
    }
  }
  const clamped = Math.min(now.getTime(), Math.max(member.joinedAt.getTime(), at.getTime()))
  return { leftAt: new Date(clamped), reason }
}

/** What a proved worker's arrival does on a tablet with an open crew. */
export type CrewPlan = { readonly kind: 'activate'; readonly memberId: string } | { readonly kind: 'join' } | { readonly kind: 'full' }

/** A member still in becomes the active one; anyone else joins while there is room. */
export function crewPlanFor(membersIn: readonly Pick<CrewMemberFacts, 'id' | 'workerId'>[], workerId: string): CrewPlan {
  const member = membersIn.find((row) => row.workerId === workerId)
  if (member) return { kind: 'activate', memberId: member.id }
  return membersIn.length >= CREW.maxMembers ? { kind: 'full' } : { kind: 'join' }
}

/** The chips' order: who joined first, first. */
export function crewOrder<Member extends Pick<CrewMemberFacts, 'id' | 'joinedAt'>>(members: readonly Member[]): Member[] {
  return [...members].sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** When and why a crew ends once every member has left: the last one's leaving. */
export function crewEndOf(left: readonly { readonly leftAt: Date; readonly reason: CrewEndReason }[], fallback: { readonly at: Date; readonly reason: CrewEndReason }): { readonly endedAt: Date; readonly reason: CrewEndReason } {
  let last: { readonly leftAt: Date; readonly reason: CrewEndReason } | null = null
  for (const row of left) if (last === null || row.leftAt.getTime() >= last.leftAt.getTime()) last = row
  return last ? { endedAt: last.leftAt, reason: last.reason } : { endedAt: fallback.at, reason: fallback.reason }
}

/** Icon and tone first (MES-188): the active member's chip ("Now") and the others'. */
export const CREW_LOOK: Readonly<Record<'active' | 'waiting', FloorLook>> = Object.freeze({
  active: { icon: 'user-check', tone: 'success' },
  waiting: { icon: 'user', tone: 'neutral' },
})
