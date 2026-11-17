import { plusDays } from '../calendars/dates'
import type { Issue } from '../core/errors'
import type { BusinessDate } from '../core/time'
import { worstRisk, type RiskState } from '../planning/promise-keep/risk'
import type { PromiseReasonCode } from '../sales/portal-orders/promise'

/**
 * B-PR-13 (production plan §4 "Health"; review fix R-10, decision D3): the health a customer reads of its order, pure. Two
 * signals:
 *
 *   computed   per open line of its own the planning risk (planning/promise-keep/risk riskOf: the promise against the day
 *              the plan says it is ready), the worst line wins: LATE (promise passed, pieces open) · AT_RISK (planned
 *              finish after the promise, or nothing says when) · NO_DATE (pieces open, never promised) · ON_TRACK; a gate
 *              still waiting after its target day makes a better state AT_RISK (an early warning)
 *   raised     a person of the factory may RAISE it to AT_RISK with one reason code from a curated list (and an office-only
 *              note); never lower it: a typed "on track" cannot hide a computed "Late". The raise drops after 7 days or
 *              as soon as the computed health changes
 *
 * The customer reads the chip and the reason code in its words (the promise's own curated reasons,
 * sales/portal-orders/promise), never the note: free text goes through the order's thread. No health names a line, a
 * worker, a supplier, a workshop or another customer.
 */
export const BRAND_HEALTHS = ['LATE', 'AT_RISK', 'NO_DATE', 'ON_TRACK'] as const
export type BrandHealth = (typeof BRAND_HEALTHS)[number]

/** Worst first: LATE 0 … ON_TRACK 3 (the order of riskOf's states). */
export const healthRank = (health: BrandHealth): number => BRAND_HEALTHS.indexOf(health)

const OF_RISK: Readonly<Record<RiskState, BrandHealth>> = Object.freeze({ LATE: 'LATE', AT_RISK: 'AT_RISK', NOT_PROMISED: 'NO_DATE', ON_TIME: 'ON_TRACK' })

/** The health planning's risk state reads as. */
export const healthOfRisk = (risk: RiskState): BrandHealth => OF_RISK[risk]

/**
 * The computed health of an order from its own open lines' risks (null: nothing open, no health). `gateOverdue`: a gate of
 * the order still WAITING after its target day.
 */
export function computedHealth(input: { readonly lineRisks: readonly (RiskState | null)[]; readonly gateOverdue: boolean }): BrandHealth | null {
  const worst = worstRisk(input.lineRisks)
  if (worst === null) return null
  const health = healthOfRisk(worst)
  return input.gateOverdue && healthRank(health) > healthRank('AT_RISK') ? 'AT_RISK' : health
}

// ---- the factory's raise ----------------------------------------------------------------------------------------------------

/**
 * The reasons a raise may give (the database's HealthReason, B-PR-15): the promise's curated reasons that explain a risk —
 * "Ready earlier than planned" (EARLIER) never does. The customer reads them in the promise's own words.
 */
export const HEALTH_REASON_CODES = ['MATERIAL_LATE', 'CAPACITY', 'QUALITY', 'YOUR_CHANGE', 'TRANSPORT', 'PLANNING'] as const satisfies readonly PromiseReasonCode[]
export type HealthReasonCode = (typeof HEALTH_REASON_CODES)[number]

/** A raise stands this many days at most. */
export const HEALTH_RAISE_DAYS = 7
/** The office-only note beside a raise: one line. */
export const HEALTH_NOTE_MAX = 200
const ONE_LINE = /^[^\r\n]+$/

/** The first day a raise set on `setOn` no longer stands (setOn + 7 days). */
export const raiseUntil = (setOn: BusinessDate): BusinessDate => plusDays(setOn, HEALTH_RAISE_DAYS)

/** What a raise as asked would break (the order's computed health now; paths under `at`). */
export function raiseProblems(input: { readonly computed: BrandHealth | null; readonly reasonCode: string; readonly note?: string | null | undefined }, at = 'body'): Issue[] {
  const issues: Issue[] = []
  if (input.computed === null) issues.push({ path: `${at}/reasonCode`, message: 'Nothing is left to make on this order: there is no health to raise.' })
  else if (input.computed === 'LATE') issues.push({ path: `${at}/reasonCode`, message: 'The order is already late: raising it to At risk would change nothing.' })
  else if (input.computed === 'AT_RISK') issues.push({ path: `${at}/reasonCode`, message: 'The order is already at risk.' })
  if (!(HEALTH_REASON_CODES as readonly string[]).includes(input.reasonCode)) issues.push({ path: `${at}/reasonCode`, message: `Expected one of ${HEALTH_REASON_CODES.join(', ')}.` })
  const note = input.note?.trim() ?? ''
  if (note !== '' && (note.length > HEALTH_NOTE_MAX || !ONE_LINE.test(note))) issues.push({ path: `${at}/note`, message: `The note is one line of at most ${HEALTH_NOTE_MAX} characters.` })
  return issues
}

/** A raise as kept on the order (BrandOrderProduction.healthReasonCode, healthSetUntil). */
export interface HealthRaise {
  readonly reasonCode: HealthReasonCode
  /** The first day it no longer stands (`raiseUntil`). */
  readonly until: BusinessDate
}

/** Does the raise still stand after a recompute? Not once 7 days passed, nor when the computed health changed. */
export const raiseStands = (raise: HealthRaise, input: { readonly computedBefore: BrandHealth | null; readonly computedNow: BrandHealth | null; readonly today: BusinessDate }): boolean =>
  input.computedBefore === input.computedNow && input.today < raise.until

export interface EffectiveHealth {
  readonly health: BrandHealth | null
  /** The reason the customer reads (only with a raise that counts). */
  readonly reasonCode: HealthReasonCode | null
  /** A person raised it. */
  readonly raised: boolean
}

/** The health the customer reads: the computed one, raised to AT_RISK by a standing raise when it is better (never lowered). */
export function effectiveHealth(computed: BrandHealth | null, raise: HealthRaise | null): EffectiveHealth {
  if (raise !== null && computed !== null && healthRank(computed) > healthRank('AT_RISK')) return { health: 'AT_RISK', reasonCode: raise.reasonCode, raised: true }
  return { health: computed, reasonCode: null, raised: false }
}
