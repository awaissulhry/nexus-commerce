import type { Issue } from '../../core/errors'

/**
 * The working-time limits a company keeps (B-W2b-42; MES-232; design people.settings "Working-time limits": rest between
 * shifts, the weekly average over its reference period, the yearly overtime cap, night work; per limit warn or block and
 * who is alerted), pure. The law's values are D.Lgs. 66/2003; a value looser than the law needs the CCNL that allows it
 * (art. 17 and the articles below): a limit recorded as the LAW's holds the law or something stricter.
 */

export const RULE_KINDS = ['DAILY_REST', 'WEEKLY_REST', 'WEEKLY_AVERAGE', 'BREAK_AFTER', 'OVERTIME_YEARLY_CAP', 'NIGHT_AVERAGE'] as const
export type RuleKind = (typeof RULE_KINDS)[number]
export const RULE_SOURCES = ['LAW', 'CCNL'] as const
export type RuleSource = (typeof RULE_SOURCES)[number]
export const RULE_ACTIONS = ['WARN', 'BLOCK'] as const
export type RuleAction = (typeof RULE_ACTIONS)[number]

export const RULE_LIMITS = Object.freeze({
  /** The roles one limit may alert. */
  alertRoles: 8,
  legalReferenceMax: 120,
  /** The longest reference period of the weekly average: 12 months with a CCNL (art. 4 c.4). */
  referenceMonthsMax: 12,
  /** The law's reference period (art. 4 c.3). */
  referenceMonthsLaw: 4,
  breakLawMinutes: 10,
})

interface LawValue {
  readonly limitMinutes: number
  readonly breakMinutes: number | null
  readonly referenceMonths: number | null
  readonly legalReference: string
  /** MINIMUM: the law asks at least this much (rest); MAXIMUM: at most this much. */
  readonly bound: 'MINIMUM' | 'MAXIMUM'
  readonly words: string
}

/** The law's value of every limit (D.Lgs. 66/2003; the same figures as the schema's comment and the seed). */
export const LAW_VALUES: Readonly<Record<RuleKind, LawValue>> = Object.freeze({
  DAILY_REST: { limitMinutes: 660, breakMinutes: null, referenceMonths: null, legalReference: 'D.Lgs. 66/2003 art. 7', bound: 'MINIMUM', words: 'Rest between shifts' },
  WEEKLY_REST: { limitMinutes: 1440, breakMinutes: null, referenceMonths: null, legalReference: 'D.Lgs. 66/2003 art. 9', bound: 'MINIMUM', words: 'Weekly rest' },
  WEEKLY_AVERAGE: { limitMinutes: 2880, breakMinutes: null, referenceMonths: RULE_LIMITS.referenceMonthsLaw, legalReference: 'D.Lgs. 66/2003 art. 4', bound: 'MAXIMUM', words: 'Weekly average' },
  BREAK_AFTER: { limitMinutes: 360, breakMinutes: RULE_LIMITS.breakLawMinutes, referenceMonths: null, legalReference: 'D.Lgs. 66/2003 art. 8', bound: 'MAXIMUM', words: 'Break after' },
  OVERTIME_YEARLY_CAP: { limitMinutes: 15000, breakMinutes: null, referenceMonths: null, legalReference: 'D.Lgs. 66/2003 art. 5', bound: 'MAXIMUM', words: 'Overtime in a year' },
  NIGHT_AVERAGE: { limitMinutes: 480, breakMinutes: null, referenceMonths: null, legalReference: 'D.Lgs. 66/2003 art. 13', bound: 'MAXIMUM', words: 'Night work' },
})

export interface RuleInput {
  readonly kind: RuleKind
  readonly limitMinutes: number
  readonly breakMinutes: number | null
  readonly referenceMonths: number | null
  readonly action: RuleAction
  readonly alertRoles: readonly string[]
  readonly source: RuleSource
  readonly legalReference: string
}

const ROLE_KEY = /^[a-z][a-z0-9_.-]*$/
const whole = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value)

/** Everything wrong with a limit, by field (the screen shows the words at the field). */
export function ruleProblems(rule: RuleInput): Issue[] {
  const problems: Issue[] = []
  const law = LAW_VALUES[rule.kind]
  if (!whole(rule.limitMinutes) || rule.limitMinutes <= 0) problems.push({ path: 'limitMinutes', message: 'A limit is a whole number of minutes above 0.' })
  if (rule.legalReference.trim() === '') problems.push({ path: 'legalReference', message: 'Name the law or the CCNL article it applies.' })
  if (rule.legalReference.length > RULE_LIMITS.legalReferenceMax) problems.push({ path: 'legalReference', message: `Keep the reference to ${RULE_LIMITS.legalReferenceMax} characters.` })
  if (rule.kind === 'BREAK_AFTER') {
    if (!whole(rule.breakMinutes) || rule.breakMinutes < 1 || rule.breakMinutes > rule.limitMinutes) problems.push({ path: 'breakMinutes', message: 'A break of 1 minute up to the limit.' })
    else if (rule.source === 'LAW' && rule.breakMinutes < law.breakMinutes!) problems.push({ path: 'breakMinutes', message: `The law asks at least ${law.breakMinutes} minutes (${law.legalReference}): less needs the CCNL article that allows it.` })
  } else if (rule.breakMinutes !== null) {
    problems.push({ path: 'breakMinutes', message: 'A break length belongs to the break limit only.' })
  }
  if (rule.kind === 'WEEKLY_AVERAGE') {
    if (!whole(rule.referenceMonths) || rule.referenceMonths < 1 || rule.referenceMonths > RULE_LIMITS.referenceMonthsMax) problems.push({ path: 'referenceMonths', message: `A reference period of 1 to ${RULE_LIMITS.referenceMonthsMax} months.` })
    else if (rule.source === 'LAW' && rule.referenceMonths > RULE_LIMITS.referenceMonthsLaw) problems.push({ path: 'referenceMonths', message: `The law says ${RULE_LIMITS.referenceMonthsLaw} months (${law.legalReference}): longer needs the CCNL article that allows it.` })
  } else if (rule.referenceMonths !== null) {
    problems.push({ path: 'referenceMonths', message: 'A reference period belongs to the weekly average only.' })
  }
  if (rule.source === 'LAW' && whole(rule.limitMinutes)) {
    const looser = law.bound === 'MINIMUM' ? rule.limitMinutes < law.limitMinutes : rule.limitMinutes > law.limitMinutes
    if (looser) problems.push({ path: 'limitMinutes', message: `This is looser than the law (${law.limitMinutes} minutes, ${law.legalReference}): a looser value needs the CCNL article that allows it.` })
  }
  if (rule.alertRoles.length > RULE_LIMITS.alertRoles) problems.push({ path: 'alertRoles', message: `At most ${RULE_LIMITS.alertRoles} roles.` })
  if (rule.alertRoles.some((key) => !ROLE_KEY.test(key))) problems.push({ path: 'alertRoles', message: 'Name the roles by their key.' })
  if (new Set(rule.alertRoles).size !== rule.alertRoles.length) problems.push({ path: 'alertRoles', message: 'Name each role once.' })
  return problems
}
