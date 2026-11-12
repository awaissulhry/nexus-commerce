import type { Permission } from '../../core/permissions'
import type { BusinessDate } from '../../core/time'
import { MANUAL_STAGES, type SampleStage } from '../samples/rules'
import { OPEN_REPAIR_STAGES, type RepairStage } from '../repairs/rules'

/**
 * Customer 360 (B-W2b-324; SAL-019 "Customer 360 page"; design sales.customers record › Overview: Key numbers, Now and the
 * side panel), pure. The office opens a customer many times a day: the record's Overview says, without opening a tab,
 * what is open with the customer and what stops or waits. W1 reads the customer's quotes and orders and W2a its money late
 * and its returns and claims (they stay those reads); the 360 read (apps/factory-api modules/sales/customer-360) adds, in
 * ONE call for the screen's company:
 *
 *   status        the party's status and the account holds in force for the company (its own and every company's): the
 *                 status pill and the hold reason of the side panel (B-W2b-290's PartyHold rows)
 *   requirements  how many of the customer's requirements are in force for the company, and the first few
 *   promises      the open orders' promises: how many are late (the promise before today, the order not shipped), the
 *                 next promise (orders.view)
 *   credit        free credit with the company: the limit less what is used (price grain; sales.credit.view) — the
 *                 reading of B-W2b-304; no limit set: NONE
 *   samples       sample rounds in progress (not decided, not cancelled), the earliest due first (sales.samples.view)
 *   profiles      the measurement profiles kept for the customer, the newest revision per rider and garment type, never
 *                 the measurements themselves (sales.measurements.view)
 *   riders        a team's or dealer's riders (PERSON parties under it, parties.view) with how many profiles each has
 *   repairs       repairs and alterations in progress (sales.repairs.view): the service cases of today (B-W2b-345's
 *                 warranty and service cases are not on main yet)
 *
 * A part whose permission the reader lacks is not read: it is named in `withheld` and the screen says so. Personal data
 * (a rider's name, a profile's rider) stays inside the one record (W2b-5 rule: never a filter or a total).
 */

/** The parts of the read, in the order the screen draws them. */
export const GLANCE_PARTS = ['promises', 'credit', 'samples', 'profiles', 'riders', 'repairs'] as const
export type GlancePart = (typeof GLANCE_PARTS)[number]

/** What each part needs besides parties.view (the route's permission). Credit's amounts also need the price grain. */
export const PART_PERMISSIONS: Readonly<Record<GlancePart, readonly Permission[]>> = Object.freeze({
  promises: ['orders.view'],
  credit: ['sales.credit.view'],
  samples: ['sales.samples.view'],
  profiles: ['sales.measurements.view'],
  riders: [],
  repairs: ['sales.repairs.view'],
})

/** How many rows of each part the read gives (the screen links to the full list for the rest). */
export const GLANCE_LIMITS = Object.freeze({ rows: 5, profiles: 10, riders: 10, requirements: 3 })

/** The orders whose promise still stands (W1's Now: confirmed, in production, ready, partly shipped). */
export const PROMISE_STATUSES = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'] as const

/** Sample rounds in progress: every stage a person moves by hand (not DECIDED, not CANCELLED). */
export const SAMPLE_OPEN_STAGES: readonly SampleStage[] = MANUAL_STAGES

/** Repairs and alterations in progress (not shipped back, not cancelled). */
export const REPAIR_OPEN_STAGES: readonly RepairStage[] = OPEN_REPAIR_STAGES

/** Whole days from `due` to `today` (positive: late), or null without a due day. */
export function daysLate(due: BusinessDate | null, today: BusinessDate): number | null {
  if (!due) return null
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86_400_000)
}

export interface PromiseFacts {
  readonly promiseDate: BusinessDate | null
}

export interface Promises {
  /** Open orders (PROMISE_STATUSES). */
  readonly open: number
  /** Open orders whose promise is before today. */
  readonly late: number
  /** Open orders without a promise. */
  readonly noPromise: number
  /** The earliest promise from today on, or null. */
  readonly next: BusinessDate | null
}

/** The promises of the customer's open orders, as of today. */
export function promisesOf(orders: readonly PromiseFacts[], today: BusinessDate): Promises {
  const dated = orders.flatMap((order) => (order.promiseDate ? [order.promiseDate] : []))
  const coming = dated.filter((day) => day >= today).sort()
  return { open: orders.length, late: dated.filter((day) => day < today).length, noPromise: orders.length - dated.length, next: coming[0] ?? null }
}

export interface ProfileFacts {
  readonly id: string
  readonly partyId: string
  readonly riderName: string
  readonly garmentType: string
  readonly revision: number
  readonly takenAt: string
}

/** The newest revision per party, rider (as written, case and spaces aside) and garment type, the newest measured first. */
export function latestProfiles<Profile extends ProfileFacts>(rows: readonly Profile[]): Profile[] {
  const newest = new Map<string, Profile>()
  for (const row of rows) {
    const key = [row.partyId, row.riderName.trim().replace(/\s+/g, ' ').toLocaleLowerCase('it'), row.garmentType].join('|')
    const kept = newest.get(key)
    if (!kept || row.revision > kept.revision) newest.set(key, row)
  }
  return [...newest.values()].sort((a, b) => (a.takenAt === b.takenAt ? a.id.localeCompare(b.id) : b.takenAt.localeCompare(a.takenAt)))
}

/** Where a customer's credit with the company stands: no limit set, within it, or over it (what is used is more). */
export type CreditState = 'NONE' | 'WITHIN' | 'OVER'

export function creditStateOf(reading: { readonly limit: number | null; readonly available: number | null } | null): CreditState {
  if (!reading || reading.limit === null || reading.available === null) return 'NONE'
  return reading.available < 0 ? 'OVER' : 'WITHIN'
}

/** The parts the reader may not read (each named by the screen with what is missing), in GLANCE_PARTS order. */
export function withheldParts(holds: (permission: Permission) => boolean): GlancePart[] {
  return GLANCE_PARTS.filter((part) => !PART_PERMISSIONS[part].every(holds))
}
