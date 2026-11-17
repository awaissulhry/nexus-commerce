import { localInstant } from '../calendars/dates'
import { addWorkingDays, type WorkingCalendar } from '../calendars/working-time'
import type { Issue } from '../core/errors'
import { can, type Actor } from '../core/permissions'
import { businessDate, type BusinessDate } from '../core/time'
import { WORKORDERS_VIEW } from '../production/work-orders/permissions'
import { SALES_MEASUREMENTS_VIEW } from '../sales/measure-link/permissions'
import { PRODUCTION_BRAND_MANAGE } from './permissions'
import { SUPERVISOR_REFUSAL_WORDS } from './words'

/**
 * B-PR-41 (production plan §3 "Supervisor", "Issues"; lead picks L21, L24; review fixes R-41, R-44, R-53): the production
 * supervisor of a customer and of its orders, pure.
 *
 *   who it is      an order's own supervisor (BrandOrderProduction.supervisorId, B-PR-15), else the customer's default
 *                  (PortalSettings.productionSupervisorId, B-PR-12). A work order's: its order's when all its cells come from
 *                  ONE order, else the customer's default (computed, no column)
 *   who may be     an ACTIVE office person who may work on that customer's production — production.brand.manage or
 *                  workorders.view over the company AND that customer — and who can open its measurement sheets
 *                  (sales.measurements.view over the company and that customer, given per person: plan §7.10); else refused
 *                  in words. A person whose grant does not reach the customer is never one (PW-14)
 *   escalation     an issue that needs an answer (ProductionIssue, B-PR-43b / B-PR-45) is due 1 working day after it was
 *                  raised: then it goes to the backup (else the production managers); 2 working days after it was raised,
 *                  to the Owner and Admin; each step at 08:00 company time on that working day, over the company's calendar
 *                  (R-44: one clock, the same words everywhere)
 *
 * The customer is never told who its supervisor is (R-41): whoever answers in the order's thread signs with their name, as
 * today. Lists say "Me / Someone else / Not set"; the name shows only inside one order (worker privacy).
 */

export const SUPERVISOR_SOURCES = ['ORDER', 'BRAND'] as const
export type SupervisorSource = (typeof SUPERVISOR_SOURCES)[number]

export interface EffectiveSupervisor {
  /** The office person (null: none set, neither on the order nor for the customer). */
  readonly userId: string | null
  /** Where it comes from: the order's own, or the customer's default (null with no one). */
  readonly from: SupervisorSource | null
}

/** An order's supervisor: its own (BrandOrderProduction.supervisorId), else the customer's default. */
export function effectiveSupervisor(own: string | null, customerDefault: string | null): EffectiveSupervisor {
  if (own !== null) return { userId: own, from: 'ORDER' }
  if (customerDefault !== null) return { userId: customerDefault, from: 'BRAND' }
  return { userId: null, from: null }
}

/**
 * A work order's supervisor: its order's (own or the customer's default) when every cell of it comes from ONE sales order;
 * else (cells of several orders, or none yet) the customer's default. A work order of no customer (one mixed before the
 * one-customer rule) is given no default by the caller: null.
 */
export function workOrderSupervisor(input: { readonly orders: readonly { readonly salesOrderId: string; readonly supervisorId: string | null }[]; readonly customerDefault: string | null }): EffectiveSupervisor {
  const distinct = new Map(input.orders.map((order) => [order.salesOrderId, order.supervisorId]))
  const [own] = [...distinct.values()]
  return effectiveSupervisor(distinct.size === 1 ? (own ?? null) : null, input.customerDefault)
}

/** How a list shows the supervisor to a viewer (never a name outside one order). */
export const SUPERVISOR_MARKS = ['ME', 'SOMEONE_ELSE', 'NOT_SET'] as const
export type SupervisorMark = (typeof SUPERVISOR_MARKS)[number]

export const supervisorMarkOf = (supervisor: EffectiveSupervisor, viewerId: string): SupervisorMark =>
  supervisor.userId === null ? 'NOT_SET' : supervisor.userId === viewerId ? 'ME' : 'SOMEONE_ELSE'

// ---- who may be a supervisor --------------------------------------------------------------------------------------------------

export const SUPERVISOR_REFUSALS = ['NOT_OFFICE', 'NOT_ACTIVE', 'NO_REACH', 'NO_MEASUREMENTS'] as const
export type SupervisorRefusal = (typeof SUPERVISOR_REFUSALS)[number]

/** The person a supervisor (or backup) would be: the User row and the actor its live role assignments make. */
export interface SupervisorCandidate {
  /** User.audience: OFFICE, PARTNER… */
  readonly audience: string
  /** User.status: ACTIVE, INVITED, SUSPENDED, DEACTIVATED. */
  readonly status: string
  /** The office actor of the person's live grants (an empty list of grants: none). */
  readonly actor: Actor
}

/** Why the person may not supervise this customer's production at this company (every reason; empty: eligible). */
export function supervisorRefusals(candidate: SupervisorCandidate, scope: { readonly companyId: string; readonly partyId: string }): SupervisorRefusal[] {
  if (candidate.audience !== 'OFFICE' || candidate.actor.audience !== 'office') return ['NOT_OFFICE']
  const refusals: SupervisorRefusal[] = []
  if (candidate.status !== 'ACTIVE') refusals.push('NOT_ACTIVE')
  const record = { companyId: scope.companyId, partyId: scope.partyId }
  if (!can(candidate.actor, PRODUCTION_BRAND_MANAGE, record) && !can(candidate.actor, WORKORDERS_VIEW, record)) refusals.push('NO_REACH')
  if (!can(candidate.actor, SALES_MEASUREMENTS_VIEW, record)) refusals.push('NO_MEASUREMENTS')
  return refusals
}

/** The refusals in the office's words (paths under `at`; the first is the dialog's message). */
export function supervisorProblems(candidate: SupervisorCandidate, scope: { readonly companyId: string; readonly partyId: string }, at = 'body/supervisorId'): Issue[] {
  return supervisorRefusals(candidate, scope).map((refusal) => ({ path: at, message: SUPERVISOR_REFUSAL_WORDS[refusal].en }))
}

/** The backup beside a supervisor: only with one, never the same person (the database's rule too, B-PR-12). */
export function backupProblems(input: { readonly supervisorId: string | null; readonly backupId: string | null }, at = 'body/backupId'): Issue[] {
  if (input.backupId === null) return []
  if (input.supervisorId === null) return [{ path: at, message: 'A backup is named only beside a supervisor.' }]
  if (input.backupId === input.supervisorId) return [{ path: at, message: 'The backup is another person than the supervisor.' }]
  return []
}

// ---- the escalation clock (R-44) --------------------------------------------------------------------------------------------

/** The step an unanswered issue reached (ProductionIssue.escalationStep): 0 none, 1 the backup, 2 the Owner and Admin. */
export const ESCALATION_STEPS = [0, 1, 2] as const
export type EscalationStep = (typeof ESCALATION_STEPS)[number]

/** Working days after the raise each step comes (the due day is the first). */
export const ESCALATION_WORKING_DAYS: Readonly<Record<1 | 2, number>> = Object.freeze({ 1: 1, 2: 2 })
/** Each step at 08:00 company time (minutes after midnight). */
export const ESCALATION_MINUTE = 8 * 60

export interface EscalationClock {
  /** The day the issue is due (the Task's due day): 1 working day after the raise. */
  readonly dueOn: BusinessDate
  /** Step 1, to the backup (else the production managers): 08:00 company time on the due day. */
  readonly backupAt: Date
  /** Step 2, to the Owner and Admin: 08:00 company time on the 2nd working day after the raise. */
  readonly ownerAt: Date
}

/**
 * The escalation clock of an issue raised at `raisedAt`, over the company's calendar (loaded by the caller for a window that
 * holds the raise day and the days after it). `{ beyond }`: the window ran out first (load a longer one).
 */
export function escalationClock(calendar: WorkingCalendar, raisedAt: Date): EscalationClock | { readonly beyond: BusinessDate } {
  const raisedOn = businessDate(raisedAt, calendar.timeZone)
  const first = addWorkingDays(calendar, raisedOn, ESCALATION_WORKING_DAYS[1])
  if (first.date === undefined) return { beyond: first.beyond ?? raisedOn }
  const second = addWorkingDays(calendar, raisedOn, ESCALATION_WORKING_DAYS[2])
  if (second.date === undefined) return { beyond: second.beyond ?? raisedOn }
  return { dueOn: first.date, backupAt: localInstant(first.date, ESCALATION_MINUTE, calendar.timeZone), ownerAt: localInstant(second.date, ESCALATION_MINUTE, calendar.timeZone) }
}

/** The step an issue has reached by `now` on its clock (the scan escalates through each step it has not taken yet). */
export function escalationStepAt(clock: EscalationClock, now: Date): EscalationStep {
  if (now.getTime() >= clock.ownerAt.getTime()) return 2
  if (now.getTime() >= clock.backupAt.getTime()) return 1
  return 0
}

/** The steps still to take: from the one after `taken` to the one reached by `now` (none once answered: the caller stops). */
export function escalationStepsDue(clock: EscalationClock, taken: EscalationStep, now: Date): (1 | 2)[] {
  const reached = escalationStepAt(clock, now)
  return ([1, 2] as const).filter((step) => step > taken && step <= reached)
}
