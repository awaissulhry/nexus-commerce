import type { Issue } from '../../core/errors'
import { depthRefusal, type DepthRefusal } from './refusals'

/**
 * Where a machine request goes and when it escalates (B-W2b-96; QHS-179; design plant.settings "Request routing and
 * escalation", plant.requests "Routed to", "request.escalated → Age tone"). Pure: the API reads the site's rules and the
 * request inside its command; the …_plant_care_w2b_guards triggers stay the last word.
 *
 *   rules      per site, in order (seq, then id): a class of machine (null: every class, the fallback, usually last) →
 *              a team of the site or one technician (an employee of the company), exactly one; push on or off; escalate
 *              when not acknowledged after N minutes to a person, and again after M minutes (M > N) to another; on or off.
 *   routing    at the report (floor or office): the first ACTIVE rule whose class is the machine's or every class; the
 *              request keeps the rule, the team or the person it went to, so a rule edited later never rewrites it. No rule:
 *              the triage queue only.
 *   escalation while the request is NEW and nobody acknowledged it, by its rule while that rule is active: level 1 at the
 *              report's time + N minutes, level 2 at + M minutes (a late tick goes straight to the highest level due);
 *              never down, each later than the last; a triaged request is never escalated.
 */

export const ROUTING_LIMITS = Object.freeze({ minMinutes: 1, maxMinutes: 1440, rules: 100, seq: 10_000 })

export interface RoutingRuleFacts {
  readonly id: string
  readonly seq: number
  readonly machineClassId: string | null
  readonly teamId: string | null
  readonly technicianId: string | null
  readonly active: boolean
  readonly escalateAfterMinutes: number | null
  readonly escalateToId: string | null
  readonly escalateAgainAfterMinutes: number | null
  readonly escalateAgainToId: string | null
}

/** The site's rules in their order: seq, then id. */
export const ruleOrder = <T extends Pick<RoutingRuleFacts, 'seq' | 'id'>>(rules: readonly T[]): T[] => [...rules].sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

/** The rule a request of a machine of this class follows: the first active one for its class or for every class; null: none. */
export function pickRule<T extends Pick<RoutingRuleFacts, 'id' | 'seq' | 'machineClassId' | 'active'>>(rules: readonly T[], classId: string): T | null {
  return ruleOrder(rules).find((rule) => rule.active && (rule.machineClassId === null || rule.machineClassId === classId)) ?? null
}

/** What the request keeps of the rule it followed (the API writes it in the request's INSERT). */
export function routingOf(rule: Pick<RoutingRuleFacts, 'id' | 'teamId' | 'technicianId'> | null): { readonly routingRuleId: string | null; readonly routedTeamId: string | null; readonly routedEmployeeId: string | null } {
  if (!rule) return { routingRuleId: null, routedTeamId: null, routedEmployeeId: null }
  return { routingRuleId: rule.id, routedTeamId: rule.teamId, routedEmployeeId: rule.teamId ? null : rule.technicianId }
}

export interface RuleDraft {
  readonly seq?: number | undefined
  readonly teamId?: string | null | undefined
  readonly technicianId?: string | null | undefined
  readonly escalateAfterMinutes?: number | null | undefined
  readonly escalateToId?: string | null | undefined
  readonly escalateAgainAfterMinutes?: number | null | undefined
  readonly escalateAgainToId?: string | null | undefined
}

const minutesOk = (value: number) => Number.isInteger(value) && value >= ROUTING_LIMITS.minMinutes && value <= ROUTING_LIMITS.maxMinutes

/** A rule as it will stand after a change (the API merges the change onto the row first); paths without `body/`. */
export function ruleProblems(rule: RuleDraft): Issue[] {
  const problems: Issue[] = []
  if (rule.seq !== undefined && (!Number.isInteger(rule.seq) || rule.seq < 0 || rule.seq > ROUTING_LIMITS.seq)) problems.push({ path: 'seq', message: `A place in the list from 0 to ${ROUTING_LIMITS.seq}.` })
  const team = rule.teamId ?? null
  const technician = rule.technicianId ?? null
  if ((team === null) === (technician === null)) problems.push({ path: team === null ? 'teamId' : 'technicianId', message: 'A rule sends requests to one team of the site or one technician: name exactly one.' })
  const after = rule.escalateAfterMinutes ?? null
  const to = rule.escalateToId ?? null
  const again = rule.escalateAgainAfterMinutes ?? null
  const againTo = rule.escalateAgainToId ?? null
  if ((after === null) !== (to === null)) problems.push({ path: after === null ? 'escalateAfterMinutes' : 'escalateToId', message: 'An escalation names both the minutes and the person, or neither.' })
  if (after !== null && !minutesOk(after)) problems.push({ path: 'escalateAfterMinutes', message: `From ${ROUTING_LIMITS.minMinutes} to ${ROUTING_LIMITS.maxMinutes} minutes.` })
  if ((again === null) !== (againTo === null)) problems.push({ path: again === null ? 'escalateAgainAfterMinutes' : 'escalateAgainToId', message: 'A second escalation names both the minutes and the person, or neither.' })
  if (again !== null && !minutesOk(again)) problems.push({ path: 'escalateAgainAfterMinutes', message: `From ${ROUTING_LIMITS.minMinutes} to ${ROUTING_LIMITS.maxMinutes} minutes.` })
  if (again !== null && after === null) problems.push({ path: 'escalateAgainAfterMinutes', message: 'A second escalation comes only after a first one.' })
  if (again !== null && after !== null && again <= after) problems.push({ path: 'escalateAgainAfterMinutes', message: 'The second escalation comes later than the first.' })
  return problems
}

export interface EscalationFacts {
  readonly status: string
  readonly acknowledgedAt: Date | null
  readonly reportedAt: Date
  readonly escalationLevel: number
  readonly escalatedAt: Date | null
}

export interface EscalationDue {
  readonly level: 1 | 2
  /** The employee it escalates to. */
  readonly toId: string
  /** When it fell due. */
  readonly dueAt: Date
}

const plus = (at: Date, minutes: number) => new Date(at.getTime() + minutes * 60_000)

/** The highest escalation due now for a request by its rule, or null (not due, not NEW, acknowledged, rule off or done). */
export function escalationDue(request: EscalationFacts, rule: Pick<RoutingRuleFacts, 'active' | 'escalateAfterMinutes' | 'escalateToId' | 'escalateAgainAfterMinutes' | 'escalateAgainToId'>, now: Date): EscalationDue | null {
  if (request.status !== 'NEW' || request.acknowledgedAt !== null || !rule.active || request.escalationLevel >= 2) return null
  if (rule.escalateAgainAfterMinutes !== null && rule.escalateAgainToId !== null) {
    const dueAt = plus(request.reportedAt, rule.escalateAgainAfterMinutes)
    if (dueAt.getTime() <= now.getTime()) return { level: 2, toId: rule.escalateAgainToId, dueAt }
  }
  if (request.escalationLevel < 1 && rule.escalateAfterMinutes !== null && rule.escalateToId !== null) {
    const dueAt = plus(request.reportedAt, rule.escalateAfterMinutes)
    if (dueAt.getTime() <= now.getTime()) return { level: 1, toId: rule.escalateToId, dueAt }
  }
  return null
}

/** When the request is escalated: now, but always later than the last escalation (the database's rule). */
export const escalatedAtOf = (previous: Date | null, now: Date): Date => (previous !== null && previous.getTime() >= now.getTime() ? new Date(previous.getTime() + 1) : now)

/** How far back the escalation looks for NEW requests: the longest escalation plus a margin (a request older is left alone). */
export const ESCALATION_LOOK_BACK_MINUTES = ROUTING_LIMITS.maxMinutes + 60

export interface RoutingWordsInput {
  /** The symptom's words, or null (any problem). */
  readonly symptom: string | null
  /** The machine class's words. */
  readonly machineClass: string
  readonly site: string
  /** The team or technician it goes to, in words; null: no rule matches. */
  readonly target: string | null
  readonly escalate: { readonly minutes: number; readonly to: string } | null
  readonly again: { readonly minutes: number; readonly to: string } | null
}

/** The worked example in words (design plant.settings "Preview in words"), in English (the screens have their own words). */
export function routingWords(input: RoutingWordsInput): string {
  const what = `A ${input.symptom ? `${input.symptom.toLowerCase()} ` : ''}request on a ${input.machineClass.toLowerCase()} at ${input.site}`
  if (input.target === null) return `${what} goes to no team or technician: no rule matches, so it waits in the triage queue.`
  const parts = [`${what} goes to ${input.target}`]
  if (input.escalate) parts.push(`not acknowledged in ${input.escalate.minutes} min → ${input.escalate.to}`)
  if (input.again) parts.push(`in ${input.again.minutes} min → ${input.again.to}`)
  return `${parts.join('; ')}.`
}

/** A new order of the site's rules: every rule of the site named once. */
export function orderRefusal(current: readonly string[], asked: readonly string[]): DepthRefusal | null {
  const known = new Set(current)
  if (asked.length !== current.length || new Set(asked).size !== asked.length || asked.some((id) => !known.has(id))) {
    return depthRefusal('ORDER_INCOMPLETE', 'A new order names every rule of the site once, and only those.', 'Read the rules again and send the whole list in its new order.')
  }
  return null
}
