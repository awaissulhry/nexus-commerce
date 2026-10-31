import type { Issue } from '../../core/errors'
import { PEOPLE_DATA_PURPOSES, PURPOSE_RULES, type PeopleDataPurpose } from './purposes'

/**
 * A person decides (B-W2b-27; feature MES-281 "suggestions (skill level, assignment, hoarding alerts) never act on a
 * worker alone; if any automated system decides, the information pack is produced"; D.Lgs. 152/1997 art. 1-bis; GDPR
 * art. 22; AI Act Annex III 4(b)) and the people data rules (design admin.privacy "People data rules": purpose tags,
 * personal-field tags and "a person decides", PLT-207, PLT-209).
 *
 * Every decision about a worker (a skill level or a trainee's sign-off, a machine authorisation, a dispatch assignment,
 * an attendance day approved or corrected, a labour record corrected, a scan pattern reviewed, a pay period locked)
 * names the person who made it: the worker, the scheduler or a rule may SUGGEST, never decide. The API asks
 * `personDecidesProblems` (apps/factory-api modules/people/privacy decide.ts `assertPersonDecides`) inside the writing
 * command; the database keeps the person on the rows that record such decisions (EmployeeSkill.assessedById,
 * ScanPatternFinding's reviewer, …).
 *
 * AUTOMATED_DECISIONS lists the automated systems that decide about workers: none. While it is empty no information
 * pack is due (art. 1-bis c.1); a step that adds one must add it here, and the pack becomes a duty the rules say.
 */

/** Decisions about a worker that a person makes (the later People and floor steps name theirs). */
export const PERSON_DECISIONS = [
  'SKILL_LEVEL',
  'TRAINEE_SIGN_OFF',
  'MACHINE_AUTHORISATION',
  'DISPATCH_ASSIGNMENT',
  'ATTENDANCE_APPROVAL',
  'ATTENDANCE_CORRECTION',
  'LABOUR_CORRECTION',
  'SCAN_FINDING_REVIEW',
  'PAY_PERIOD_LOCK',
] as const
export type PersonDecision = (typeof PERSON_DECISIONS)[number]

/** The automated systems that decide about workers (D.Lgs. 152/1997 art. 1-bis): none. */
export const AUTOMATED_DECISIONS: readonly { readonly system: string; readonly decides: string }[] = Object.freeze([])

/** The decision's maker as the API knows it. */
export interface DecisionMaker {
  /** The audience of the caller: only office and floor sessions are people. */
  readonly audience: string
  /** The person's id (office user or floor worker); the system actor is no person. */
  readonly actorId: string | null | undefined
  /** The system actor's id (apps/factory-api core/context SYSTEM_ACTOR_ID). */
  readonly systemActorId: string
}

export const PERSON_DECIDES_WORDS =
  'A decision about a worker is made by a person, never by the system: the system may only suggest (D.Lgs. 152/1997 art. 1-bis; GDPR art. 22).'

/** Refuses a decision about a worker that no person makes (the scheduler, a rule, a link or a portal session). */
export function personDecidesProblems(decision: PersonDecision, maker: DecisionMaker, at = 'decidedBy'): Issue[] {
  const person = (maker.audience === 'office' || maker.audience === 'floor') && typeof maker.actorId === 'string' && maker.actorId !== '' && maker.actorId !== maker.systemActorId
  return person ? [] : [{ path: `${at}/${decision}`, message: PERSON_DECIDES_WORDS }]
}

/** The information pack is due only when an automated system decides about workers. */
export const informationPackDue = (): boolean => AUTOMATED_DECISIONS.length > 0

export interface PeopleDataFact {
  readonly key: string
  readonly words: string
  readonly law: string
}

/** The facts of the People data rules panel (Admin › Privacy & notices), in words. */
export function peopleDataFacts(): PeopleDataFact[] {
  return [
    {
      key: 'PURPOSE_TAGS',
      words: 'Every personal field of the People and floor records carries the purposes it may be used for; a use outside them is refused, and a new use needs a new purpose decided by a person.',
      law: 'GDPR art. 5(1)(b); Statuto dei Lavoratori art. 4',
    },
    {
      key: 'FIELD_TAGS',
      words: 'The tags drive who reads each field: portal and link sessions never read a personal field, the floor only for production, attendance and safety.',
      law: 'GDPR art. 25',
    },
    {
      key: 'LEGAL_GATE',
      words: "Attendance and one person's work figures open per site only with their legal basis, the worker notice and the impact assessment on record; every site starts with both off.",
      law: 'Statuto dei Lavoratori art. 4 c.1-3; GDPR arts. 13, 35',
    },
    {
      key: 'GROUPS',
      words: "People figures show per line, team or shift, never per person; a group under the minimum size shows '—'.",
      law: 'Statuto dei Lavoratori art. 4; GDPR art. 5(1)(c)',
    },
    {
      key: 'ONE_PERSON',
      words: "One person's figures: the worker and the roles People settings name (HR), and the team lead only where the site's basis covers leads; every opening is recorded.",
      law: 'Statuto dei Lavoratori art. 4; Owner answer H3',
    },
    {
      key: 'PERSON_DECIDES',
      words: informationPackDue()
        ? 'An automated system decides about workers: the information pack is due.'
        : 'No automated system decides about a worker: suggestions never act alone, a person decides, so no information pack is due.',
      law: 'D.Lgs. 152/1997 art. 1-bis; GDPR art. 22; AI Act Annex III 4(b)',
    },
  ]
}

/** The purposes in the order the rules panel lists them. */
export const purposesInOrder = (): { readonly purpose: PeopleDataPurpose; readonly rule: (typeof PURPOSE_RULES)[PeopleDataPurpose] }[] =>
  PEOPLE_DATA_PURPOSES.map((purpose) => ({ purpose, rule: PURPOSE_RULES[purpose] }))
