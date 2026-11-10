import type { Issue } from '../../core/errors'
import { GATE_WORDS, OVERRIDE_DAYS_MAX, type ComplianceGate, type RequirementRow } from '../requirements/rules'

/**
 * Overriding a gate (B-W2b-254; PRD-272; design compliance.status › cs-override "Override a gate"), pure: a person whose
 * role the requirement names lets ONE subject (this work order, this shipment) pass ONE requirement at ONE gate, with a
 * written reason, a fresh step-up and an end at most the requirement's days away (at most 7). Never at a gate the law
 * locks, never from the floor (the database refuses both too). The override names the refusal it lifts (a REFUSED event
 * of the same gate, subject and requirement); it is itself a GateEvent (OVERRIDDEN), and the gate lets the subject pass
 * while it is in force.
 */

export const OVERRIDE_REASON_MIN = 10
export const OVERRIDE_REASON_MAX = 2000
const DAY_MS = 24 * 60 * 60 * 1000

export interface RefusalFacts {
  readonly id: string
  readonly outcome: 'REFUSED' | 'OVERRIDDEN'
  readonly gate: ComplianceGate
  readonly subjectType: string
  readonly subjectId: string
  readonly requirementId: string
}

export interface OverrideAsk {
  readonly requirement: Pick<RequirementRow, 'code' | 'blocks' | 'lockedBlocks' | 'overrideRoleKeys' | 'overrideMaxDays' | 'status' | 'switchedOn'>
  readonly refusal: RefusalFacts
  /** The person's live role keys over the subject's company. */
  readonly roles: readonly string[]
  readonly reason: string
  readonly until: Date
  readonly now: Date
  /** An override already in force for this gate, subject and requirement (its end), if any. */
  readonly inForceUntil: Date | null
}

export const latestUntil = (now: Date, maxDays: number): Date => new Date(now.getTime() + Math.min(maxDays, OVERRIDE_DAYS_MAX) * DAY_MS)

export type OverrideRefusalCode = 'NOT_A_REFUSAL' | 'LOCKED' | 'NO_ROLE_MAY' | 'NOT_YOUR_ROLE' | 'NOT_BLOCKING' | 'REASON' | 'UNTIL' | 'IN_FORCE'

export interface OverrideRefusal {
  readonly code: OverrideRefusalCode
  readonly message: string
  readonly issues: readonly Issue[]
}

const refusal = (code: OverrideRefusalCode, message: string, path = `refusal/${code}`): OverrideRefusal => ({ code, message, issues: [{ path, message }] })

/** Why this override is refused, in words (null: it may be written). Checked in this order: the first reason wins. */
export function overrideRefusal(ask: OverrideAsk): OverrideRefusal | null {
  const { requirement, refusal: refused } = ask
  const place = GATE_WORDS[refused.gate].place
  if (refused.outcome !== 'REFUSED') return refusal('NOT_A_REFUSAL', 'Only a refusal is overridden: this event is itself an override.')
  if (requirement.lockedBlocks.includes(refused.gate)) return refusal('LOCKED', `The law locks requirement ${requirement.code} at the ${place}: it is never overridden there.`)
  if (requirement.status !== 'ACTIVE' || !requirement.switchedOn || !requirement.blocks.includes(refused.gate)) {
    return refusal('NOT_BLOCKING', `Requirement ${requirement.code} no longer blocks the ${place}: nothing to override (try the step again).`)
  }
  if (requirement.overrideRoleKeys.length === 0) return refusal('NO_ROLE_MAY', `No role may override requirement ${requirement.code}: fix what is missing instead.`)
  if (!ask.roles.some((role) => requirement.overrideRoleKeys.includes(role))) {
    return refusal('NOT_YOUR_ROLE', `Only ${requirement.overrideRoleKeys.join(', ')} may override requirement ${requirement.code}; your roles are ${ask.roles.join(', ') || 'none'}.`)
  }
  if (ask.inForceUntil && ask.inForceUntil.getTime() > ask.now.getTime()) {
    return refusal('IN_FORCE', `An override of requirement ${requirement.code} at the ${place} is in force until ${ask.inForceUntil.toISOString()}.`)
  }
  const reason = ask.reason.trim()
  if (reason.length < OVERRIDE_REASON_MIN || reason.length > OVERRIDE_REASON_MAX) {
    return refusal('REASON', `Write why the gate is overridden (${OVERRIDE_REASON_MIN} to ${OVERRIDE_REASON_MAX} characters): it goes in the PPE register's audit view.`, 'body/reason')
  }
  const latest = latestUntil(ask.now, requirement.overrideMaxDays)
  if (ask.until.getTime() <= ask.now.getTime()) return refusal('UNTIL', 'The override ends in the future.', 'body/until')
  if (ask.until.getTime() > latest.getTime()) {
    return refusal('UNTIL', `An override of requirement ${requirement.code} lasts at most ${requirement.overrideMaxDays} day(s): until ${latest.toISOString()} at the latest.`, 'body/until')
  }
  return null
}
