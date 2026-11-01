import type { BusinessDate } from '../../core/time'
import { authorisationStateOf, isTrainee, traineeStateOf, type SkillLevel } from './rules'

/**
 * The qualification check (B-W2b-39; MES-024 "assigning or starting an operation the operator is not qualified for is
 * blocked or warned (per setting); a lead can override with PIN and reason"; MES-246 "dangerous machines accept sign-in
 * only from trained, authorised people"; design floor.operation "Checks before it counts": "not qualified → held, team
 * leader overrides with PIN and a reason"; production.dispatch: "a missing skill is a held drop with its reason, or a
 * warning with an override reason (site rule)"). Pure: apps/factory-api modules/people/skills check.ts reads the facts
 * (in the office's or the floor's own scope) and dispatch (B-W2b-49) and the tablet (B-W2b-46 / -69) act on the answer.
 *
 * What one person needs for one operation on one machine (or at one station):
 *   the operation        a level in one of the operation's skills (the active OPERATION skills about the library
 *                        operation); none kept for it: nothing to check
 *   the machine's class  a level in one of the class's skills (the active MACHINE skills about it), when one is kept; and
 *                        an authorisation in force, when the class is kept under authorisation (`kept`, read by the API)
 *
 * A level is QUALIFIED (Can do, Expert, Trainer), TRAINEE (a trainee period not signed off: the work goes on and carries
 * the trainee mark, MES-244), LEARNING (Learning, not a trainee) or NONE. A missing or Learning-only skill follows the
 * site's rule (FREE: not checked; WARN: it goes on, a reason is asked in dispatch and the team leader is told on the floor;
 * STRICT: held, a team leader may override it with their PIN and a reason). A missing, ended or not-yet-valid
 * authorisation always holds and is never overridden (D.Lgs. 81/2008 art. 71 c.7; MES-246).
 *
 * Nothing here is a figure about one person's work: the check reads levels (a person's judgement, MES-281) and
 * authorisations, never output, speed or a score; it decides nothing about the person (a person assigns, a team leader
 * overrides).
 */

export const QUALIFICATION_MODES = ['FREE', 'WARN', 'STRICT'] as const
export type QualificationMode = (typeof QUALIFICATION_MODES)[number]

/**
 * The rule while a site has none of its own (no column yet: Production › Floor rules per site, B-W2b-53, will hold it):
 * WARN, so a site whose matrix is still being filled is told, not stopped.
 */
export const DEFAULT_QUALIFICATION_MODE: QualificationMode = 'WARN'

export interface HeldLevel {
  readonly levelId: string
  readonly level: SkillLevel
  readonly since: BusinessDate
  readonly traineeUntil: BusinessDate | null
  readonly signedOffOn: BusinessDate | null
}

/** One skill about the operation or the class, with the person's level in force in it (null: none). */
export interface SkillNeed {
  readonly skillId: string
  readonly code: string
  readonly name: string
  readonly held: HeldLevel | null
}

export interface OperationNeed {
  readonly operationId: string
  readonly code: string
  readonly name: string
  readonly skills: readonly SkillNeed[]
}

export interface HeldAuthorisation {
  readonly authorisationId: string
  readonly authorisedOn: BusinessDate
  readonly validUntil: BusinessDate | null
}

export interface MachineNeed {
  readonly machineClassId: string
  readonly code: string
  readonly label: string
  /** The machines of the class concerned (asset numbers), for the words. */
  readonly assetNumbers: readonly string[]
  /** The class is kept under authorisation (see the API's rule). */
  readonly kept: boolean
  /** The person's authorisation not revoked (in force, ended or starting later); null: none. */
  readonly authorisation: HeldAuthorisation | null
  readonly skills: readonly SkillNeed[]
}

export interface QualificationFacts {
  readonly today: BusinessDate
  readonly mode: QualificationMode
  /** The person (their name as the caller may see it); `hasRecord` false: a floor worker with no employee record. */
  readonly person: { readonly name: string; readonly active: boolean; readonly hasRecord: boolean }
  readonly operation: OperationNeed | null
  readonly machines: readonly MachineNeed[]
}

export const SKILL_STATES = ['QUALIFIED', 'TRAINEE', 'LEARNING', 'NONE', 'NOT_KEPT'] as const
export type SkillState = (typeof SKILL_STATES)[number]
export const AUTHORISATION_NEED_STATES = ['AUTHORISED', 'NOT_YET', 'EXPIRED', 'NONE', 'NOT_KEPT'] as const
export type AuthorisationNeedState = (typeof AUTHORISATION_NEED_STATES)[number]

export interface SkillRequirement {
  readonly kind: 'OPERATION' | 'MACHINE_SKILL'
  /** The operation's or the class's code and words. */
  readonly code: string
  readonly label: string
  readonly state: SkillState
  /** The skill that decided (the best held one, else the first kept), its level and trainee period. */
  readonly skill: { readonly id: string; readonly code: string; readonly name: string } | null
  readonly level: SkillLevel | null
  readonly levelId: string | null
  readonly traineeUntil: BusinessDate | null
  readonly overdue: boolean
}

export interface AuthorisationRequirement {
  readonly kind: 'AUTHORISATION'
  readonly code: string
  readonly label: string
  readonly state: AuthorisationNeedState
  readonly authorisationId: string | null
  readonly authorisedOn: BusinessDate | null
  readonly validUntil: BusinessDate | null
}

export type Requirement = SkillRequirement | AuthorisationRequirement

export const QUALIFICATION_FINDINGS = ['PERSON_LEFT', 'NO_SKILL', 'LEARNING_ONLY', 'NOT_AUTHORISED', 'AUTHORISATION_EXPIRED', 'AUTHORISATION_NOT_YET'] as const
export type QualificationFindingCode = (typeof QUALIFICATION_FINDINGS)[number]

export interface QualificationFinding {
  readonly code: QualificationFindingCode
  readonly kind: 'SKILL' | 'AUTHORISATION' | 'PERSON'
  /** STRICT holds; WARN lets it go on (a reason asked in dispatch, the team leader told on the floor). */
  readonly mode: 'WARN' | 'STRICT'
  /** A team leader may override it with their PIN and a reason (skills only; never an authorisation). */
  readonly overridable: boolean
  /** The requirement's code (operation or class), null for the person. */
  readonly requirement: string | null
  readonly message: string
  readonly fix: string
}

export const QUALIFICATION_OUTCOMES = ['QUALIFIED', 'TRAINEE', 'NOT_QUALIFIED', 'NOT_CHECKED'] as const
export type QualificationOutcome = (typeof QUALIFICATION_OUTCOMES)[number]
export const QUALIFICATION_DECISIONS = ['ALLOW', 'WARN', 'HOLD'] as const
export type QualificationDecision = (typeof QUALIFICATION_DECISIONS)[number]

export interface QualificationResult {
  /** What the person holds against what the work needs (whatever the site's rule). */
  readonly outcome: QualificationOutcome
  /** What the caller does: ALLOW, WARN (goes on; a reason or the team leader told) or HOLD. */
  readonly decision: QualificationDecision
  /** A HOLD a team leader may override with their PIN and a reason (every holding finding is a skill). */
  readonly overridable: boolean
  /** The work carries the trainee mark (MES-244). */
  readonly trainee: boolean
  readonly mode: QualificationMode
  readonly requirements: readonly Requirement[]
  readonly findings: readonly QualificationFinding[]
  readonly message: string
}

const RANK: Readonly<Record<SkillState, number>> = { QUALIFIED: 4, TRAINEE: 3, LEARNING: 2, NONE: 1, NOT_KEPT: 0 }

/** A level's state for the check. */
export function skillStateOf(held: HeldLevel | null): Exclude<SkillState, 'NOT_KEPT'> {
  if (held === null) return 'NONE'
  if (isTrainee(held)) return 'TRAINEE'
  return held.level === 'LEARNING' ? 'LEARNING' : 'QUALIFIED'
}

function skillRequirement(kind: SkillRequirement['kind'], code: string, label: string, skills: readonly SkillNeed[], today: BusinessDate): SkillRequirement {
  if (skills.length === 0) return { kind, code, label, state: 'NOT_KEPT', skill: null, level: null, levelId: null, traineeUntil: null, overdue: false }
  let best: SkillNeed = skills[0]!
  for (const need of skills) if (RANK[skillStateOf(need.held)] > RANK[skillStateOf(best.held)]) best = need
  const held = best.held
  return {
    kind,
    code,
    label,
    state: skillStateOf(held),
    skill: { id: best.skillId, code: best.code, name: best.name },
    level: held?.level ?? null,
    levelId: held?.levelId ?? null,
    traineeUntil: held && isTrainee(held) ? held.traineeUntil : null,
    overdue: held !== null && traineeStateOf(held, today) === 'OVERDUE',
  }
}

function authorisationRequirement(machine: MachineNeed, today: BusinessDate): AuthorisationRequirement {
  const base = { kind: 'AUTHORISATION' as const, code: machine.code, label: machine.label }
  const row = machine.authorisation
  if (!machine.kept) return { ...base, state: 'NOT_KEPT', authorisationId: row?.authorisationId ?? null, authorisedOn: row?.authorisedOn ?? null, validUntil: row?.validUntil ?? null }
  if (row === null) return { ...base, state: 'NONE', authorisationId: null, authorisedOn: null, validUntil: null }
  const state = authorisationStateOf({ authorisedOn: row.authorisedOn, validUntil: row.validUntil, revoked: false }, today)
  return { ...base, state: state === 'REVOKED' ? 'NONE' : state, authorisationId: row.authorisationId, authorisedOn: row.authorisedOn, validUntil: row.validUntil }
}

const machinesOf = (machine: MachineNeed): string => (machine.assetNumbers.length > 0 ? ` (${machine.assetNumbers.join(', ')})` : '')

/** The check of one person for one operation and the machines it runs on. */
export function qualificationOf(facts: QualificationFacts): QualificationResult {
  const { today, mode, person } = facts
  const requirements: Requirement[] = []
  const findings: QualificationFinding[] = []
  const skillMode: 'WARN' | 'STRICT' | null = mode === 'FREE' ? null : mode
  const noRecord = person.hasRecord ? '' : ' (no employee record: no skill is on record)'

  const skillFinding = (requirement: SkillRequirement, what: string) => {
    if (skillMode === null) return
    if (requirement.state === 'NONE') {
      findings.push({ code: 'NO_SKILL', kind: 'SKILL', mode: skillMode, overridable: true, requirement: requirement.code, message: `${person.name} has no level in ${what}${noRecord}.`, fix: 'A lead records the level in People › Skills, or another person takes the work.' })
    } else if (requirement.state === 'LEARNING') {
      findings.push({ code: 'LEARNING_ONLY', kind: 'SKILL', mode: skillMode, overridable: true, requirement: requirement.code, message: `${person.name} is learning ${what} and is not a trainee on it.`, fix: 'A lead gives a trainee period or sets the level in People › Skills.' })
    }
  }

  if (!person.active) {
    findings.push({ code: 'PERSON_LEFT', kind: 'PERSON', mode: 'STRICT', overridable: false, requirement: null, message: `${person.name} has left: they take no work.`, fix: 'Give the work to another person.' })
  }
  if (facts.operation) {
    const requirement = skillRequirement('OPERATION', facts.operation.code, facts.operation.name, facts.operation.skills, today)
    requirements.push(requirement)
    skillFinding(requirement, `the operation ${facts.operation.name}`)
  }
  for (const machine of facts.machines) {
    const skill = skillRequirement('MACHINE_SKILL', machine.code, machine.label, machine.skills, today)
    requirements.push(skill)
    skillFinding(skill, `${machine.label} machines`)
    const authorisation = authorisationRequirement(machine, today)
    requirements.push(authorisation)
    const fix = 'Only a person authorised on it works on it: the office authorises in People › Skills; meanwhile another person takes the work.'
    if (authorisation.state === 'NONE') {
      findings.push({ code: 'NOT_AUTHORISED', kind: 'AUTHORISATION', mode: 'STRICT', overridable: false, requirement: machine.code, message: `${person.name} is not authorised on ${machine.label} machines${machinesOf(machine)}.`, fix })
    } else if (authorisation.state === 'EXPIRED') {
      findings.push({ code: 'AUTHORISATION_EXPIRED', kind: 'AUTHORISATION', mode: 'STRICT', overridable: false, requirement: machine.code, message: `${person.name}'s authorisation on ${machine.label} machines ended on ${authorisation.validUntil}.`, fix })
    } else if (authorisation.state === 'NOT_YET') {
      findings.push({ code: 'AUTHORISATION_NOT_YET', kind: 'AUTHORISATION', mode: 'STRICT', overridable: false, requirement: machine.code, message: `${person.name}'s authorisation on ${machine.label} machines starts on ${authorisation.authorisedOn}.`, fix })
    }
  }

  const kept = requirements.filter((requirement) => requirement.state !== 'NOT_KEPT')
  const short = !person.active || kept.some((requirement) => requirement.state === 'NONE' || requirement.state === 'LEARNING' || requirement.state === 'EXPIRED' || requirement.state === 'NOT_YET')
  const trainee = kept.some((requirement) => requirement.state === 'TRAINEE')
  const outcome: QualificationOutcome = short ? 'NOT_QUALIFIED' : kept.length === 0 ? 'NOT_CHECKED' : trainee ? 'TRAINEE' : 'QUALIFIED'
  const strict = findings.filter((finding) => finding.mode === 'STRICT')
  const decision: QualificationDecision = strict.length > 0 ? 'HOLD' : findings.length > 0 ? 'WARN' : 'ALLOW'
  const overridable = decision === 'HOLD' && strict.every((finding) => finding.overridable)
  return { outcome, decision, overridable, trainee, mode, requirements, findings, message: messageOf(facts, outcome, decision, overridable, findings, kept) }
}

function messageOf(facts: QualificationFacts, outcome: QualificationOutcome, decision: QualificationDecision, overridable: boolean, findings: readonly QualificationFinding[], kept: readonly Requirement[]): string {
  const what = facts.operation ? `the operation ${facts.operation.name}` : facts.machines.length > 0 ? facts.machines.map((machine) => `${machine.label} machines`).join(' and ') : 'this work'
  if (decision === 'HOLD') return `${findings.filter((finding) => finding.mode === 'STRICT').map((finding) => finding.message).join(' ')}${overridable ? ' A team leader may override it with their PIN and a reason.' : ''}`
  if (decision === 'WARN') return `${findings.map((finding) => finding.message).join(' ')} The work may go on with a reason; the team leader is told.`
  if (outcome === 'NOT_CHECKED') return `No skill or authorisation is kept for ${what}: nothing to check.`
  if (outcome === 'NOT_QUALIFIED') return `${facts.person.name} holds no level for ${what}; this site does not check skills.`
  if (outcome === 'TRAINEE') {
    const until = kept.find((requirement): requirement is SkillRequirement => requirement.kind !== 'AUTHORISATION' && requirement.state === 'TRAINEE')?.traineeUntil
    return `${facts.person.name} works on ${what} as a trainee${until ? ` (until ${until})` : ''}: the work carries the trainee mark.`
  }
  return `${facts.person.name} is qualified for ${what}.`
}

// ---- for the callers ----------------------------------------------------------------------------------------------------

export type AssignmentOutcome =
  | { readonly assignable: true; readonly override: { readonly reason: string; readonly codes: readonly QualificationFindingCode[] } | null }
  | { readonly assignable: false; readonly refusal: 'NOT_QUALIFIED' | 'NOT_AUTHORISED' | 'OVERRIDE_REASON_NEEDED'; readonly message: string }

/**
 * An assignment in dispatch (B-W2b-49; design production.dispatch): ALLOW assigns; WARN assigns only with an override
 * reason (kept on the assignment with who); HOLD is a held drop with its words (an authorisation: NOT_AUTHORISED).
 */
export function assignmentOutcome(result: QualificationResult, overrideReason: string | null | undefined): AssignmentOutcome {
  if (result.decision === 'ALLOW') return { assignable: true, override: null }
  if (result.decision === 'HOLD') {
    const authorisation = result.findings.some((finding) => finding.mode === 'STRICT' && finding.kind === 'AUTHORISATION')
    return { assignable: false, refusal: authorisation ? 'NOT_AUTHORISED' : 'NOT_QUALIFIED', message: result.findings.filter((finding) => finding.mode === 'STRICT').map((finding) => finding.message).join(' ') }
  }
  const reason = overrideReason?.trim() ?? ''
  if (reason === '') return { assignable: false, refusal: 'OVERRIDE_REASON_NEEDED', message: `${result.findings.map((finding) => finding.message).join(' ')} Give the reason to assign anyway.` }
  return { assignable: true, override: { reason, codes: result.findings.map((finding) => finding.code) } }
}

// ---- the loan dialog's skill check --------------------------------------------------------------------------------------

export interface LineSkills {
  readonly operations: readonly { readonly operationId: string; readonly code: string; readonly name: string; readonly state: SkillState }[]
  /** Operations kept with a skill the person may work on (QUALIFIED or TRAINEE), of them as a trainee, of all kept. */
  readonly canDo: number
  readonly asTrainee: number
  readonly kept: number
  /** Operations the line does that keep no skill. */
  readonly notKept: number
  readonly message: string
}

/** "Can do 3 of 5 operations on Line B" (design people.employees "Loan to another line"): the operations a line does. */
export function lineSkillsOf(lineCode: string, operations: readonly OperationNeed[], today: BusinessDate): LineSkills {
  const rows = operations.map((operation) => ({ operationId: operation.operationId, code: operation.code, name: operation.name, state: skillRequirement('OPERATION', operation.code, operation.name, operation.skills, today).state }))
  const kept = rows.filter((row) => row.state !== 'NOT_KEPT')
  const canDo = kept.filter((row) => row.state === 'QUALIFIED' || row.state === 'TRAINEE').length
  const asTrainee = kept.filter((row) => row.state === 'TRAINEE').length
  const notKept = rows.length - kept.length
  const tail = [asTrainee > 0 ? `${asTrainee} as a trainee` : null, notKept > 0 ? `${notKept} more ${notKept === 1 ? 'keeps' : 'keep'} no skill` : null].filter(Boolean).join('; ')
  const message = kept.length === 0 ? `No operation on line ${lineCode} keeps a skill: nothing to check.` : `Can do ${canDo} of ${kept.length} operations on line ${lineCode}${tail ? ` (${tail})` : ''}.`
  return { operations: rows, canDo, asTrainee, kept: kept.length, notKept, message }
}
