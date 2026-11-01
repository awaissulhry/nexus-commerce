import { holds, type Actor, type Permission } from '../../core/permissions'

/**
 * Money grains (plan A1 §2.6, §3.11; features PLT-034, PLT-035): who may see which money field. A role names the
 * grains it sees (Role.grains); a field of a contract is marked with its grain (`money.price()` …, src/money); the
 * API drops a marked field from an answer unless the caller holds its grain, and refuses a request that sends one.
 *
 *   grain    fields                                              staff without it   floor              partner
 *   price    unit prices, line amounts, totals                   hidden             hidden             own documents
 *   cost     unit cost, standard cost, BOM cost, PO prices       hidden             hidden             hidden
 *   margin   margin %, margin amount, waterfall cost lines       hidden             hidden             hidden
 *   wages    piece rates, earnings (W2)                          hidden             own records only   hidden
 *   pay      piece pay (W2b, B-W2b-34): rates per minute and     hidden             own records only   hidden
 *            per piece, earnings, guaranteed pay; HR and the
 *            worker only (no office template but the owner's)
 *
 * A grain travels in a session's grants as the permission `money.<grain>` (grainPermission): the grants come from
 * the role assignments, so `holds()` answers "does this caller see costs" like any other question, and a later step
 * can ask it per record with `can()` (wages: own records only). Role.permissions never lists a `money.*` permission;
 * it comes from Role.grains.
 *
 * The audiences cap what grants can give (fail closed, whatever a role says): a floor session sees at most wages,
 * a partner or link session at most price (its own documents: the party scope), the platform audience none. The
 * database wall for floor and partner (column grants without cost, margin and price columns, A1 §2.2) is the floor
 * and links steps' work; this is the API wall.
 */

export const GRAINS = ['price', 'cost', 'margin', 'wages', 'pay'] as const
export type Grain = (typeof GRAINS)[number]

export function isGrain(value: unknown): value is Grain {
  return typeof value === 'string' && (GRAINS as readonly string[]).includes(value)
}

/** The permission a grain travels as in a grant. */
export type GrainPermission = `money.${Grain}`
export const grainPermission = (grain: Grain): GrainPermission => `money.${grain}`
export const GRAIN_PERMISSIONS: readonly GrainPermission[] = GRAINS.map(grainPermission)

export function isGrainPermission(value: unknown): value is GrainPermission {
  return typeof value === 'string' && (GRAIN_PERMISSIONS as readonly string[]).includes(value)
}

/** What each grain covers, for the role screens and the permission registry. */
export const GRAIN_DESCRIPTIONS: Readonly<Record<Grain, string>> = {
  price: 'See selling prices: unit prices, line amounts and document totals.',
  cost: 'See costs: unit and standard costs, bill-of-materials cost and purchase prices.',
  margin: 'See margins: margin percentages and amounts, and the cost lines of a price waterfall.',
  wages: 'See wages: piece rates and earnings.',
  pay: "See piece pay: the rates per minute and per piece, earnings and guaranteed pay (HR and the worker; the floor sees a worker's own).",
}

/** The most each audience can see, whatever its grants say. */
const AUDIENCE_GRAINS: Readonly<Record<Actor['audience'], readonly Grain[]>> = {
  office: GRAINS,
  floor: ['wages', 'pay'],
  partner: ['price'],
  link: ['price'],
  platform: [],
  system: GRAINS,
}

/**
 * The grains a caller holds: the system (worker, scheduler) holds all; anyone else those its grants give, capped by
 * its audience. No actor (a public route) holds none.
 */
export function heldGrains(actor: Actor | null | undefined): ReadonlySet<Grain> {
  if (!actor) return new Set()
  if (actor.audience === 'system') return new Set(GRAINS)
  const allowed = AUDIENCE_GRAINS[actor.audience] ?? []
  return new Set(allowed.filter((grain) => holds(actor, grainPermission(grain) as Permission)))
}
