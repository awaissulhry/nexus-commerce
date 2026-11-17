import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { can, EVERY_PARTY_WORDS, NO_ROWS, reachesEveryParty, scopeWhere, type Actor, type Permission, type WhereClause } from '@nexus/factory-domain/core/permissions'

/**
 * B-PR-03 (production plan §2, the brand wall; Owner rule 2026-11-16: "One brand must not be able to see anything related to
 * any other brand. But we, as the production unit, should be able to see it all. And manage it all as well."): the ONE place
 * production asks which work orders an office person reaches. The office's database role is walled by tenant only, so the
 * wall for a person limited to some customers (a grant's `parties` list) is this API wall; the database guards the shape (one
 * customer per work order, B-PR-01), which keeps it simple and true:
 *
 *   - a work order of a customer reaches a person whose grant (holding the permission, at its company and site) reaches that
 *     customer;
 *   - a work order of NO customer (a SAMPLE of a round for no customer, or a mixed one made before the rule: "Mixed brands
 *     (made before the rule)") reaches only a person whose grant reaches EVERY customer (fail closed: can() alone lets a
 *     record without a party through a party-limited grant);
 *   - what mixes customers (a cut order of two, capacity, the Line TV) needs every customer, or shows only when every part
 *     is reachable.
 *
 * Each helper answers in the Prisma `where` shape of core/permissions' scopeWhere; combine with the caller's own filter as
 * `{ AND: [helper(…), filter] }`, never by spreading.
 */

const WORK_ORDER = { company: 'companyId', site: 'siteId', party: 'partyId' } as const

/** A work order's scope: its company, site and one customer (null: a sample of no customer, or mixed before the rule). */
export interface WorkOrderReach {
  readonly companyId: string
  readonly siteId: string
  readonly partyId: string | null
}

/**
 * The work orders `permission` reaches (a list, a count, an export, a bulk read): its companies and sites, and its customers
 * (a plain column: `partyId IN (…)` leaves out a work order of no customer unless a grant reaches every customer).
 */
export function workOrderWhere(actor: Actor, permission: Permission): Prisma.WorkOrderWhereInput {
  return nullSafe(scopeWhere(actor, permission, WORK_ORDER)) as Prisma.WorkOrderWhereInput // B-PR-09: null-safe
}

// ── B-PR-09 ──
/**
 * B-PR-09 (found by PW-04's cut order file): a customer clause `partyId IN (…)` made null-safe (`… AND partyId IS NOT NULL`).
 * Asked as it is, nothing changes (a work order of no customer is left out either way); under a negation — `every` (allPartsWhere:
 * a cut order, a trolley), `none`, `NOT` — SQL's NULL made `partyId IN (…)` neither true nor false, so a part whose work order
 * names no customer did not count as missed: a person limited to brand B saw the cut order of a work order mixed before the rule.
 * Now such a part counts as not reached (fail closed); a grant over every customer has no customer clause, so it still reaches it.
 * The same object comes back when nothing changes (NO_ROWS is compared by reference).
 */
function nullSafe(where: unknown): unknown {
  if (where === null || typeof where !== 'object') return where
  if (Array.isArray(where)) {
    const items = where.map(nullSafe)
    return items.some((item, index) => item !== where[index]) ? items : where
  }
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(where)) {
    const party = key === WORK_ORDER.party && value !== null && typeof value === 'object' && !Array.isArray(value) && 'in' in value && !('not' in value)
    const safe = party ? { ...value, not: null } : nullSafe(value)
    if (safe !== value) changed = true
    out[key] = safe
  }
  return changed ? out : where
}
// ── end B-PR-09 ──

/**
 * A row of a work order (an operation, a bundle, a call on a work order): reached through its work order, by the relation
 * `relation` (`workOrder` unless named). A row whose work order is not set is not matched: a caller that lists such rows too
 * adds them with its own OR.
 */
export function viaWorkOrder(actor: Actor, permission: Permission, relation = 'workOrder'): WhereClause {
  return { [relation]: { is: workOrderWhere(actor, permission) } }
}

/**
 * A row of one cell (a ticket, a release per cell, a cut order's line): reached through the cell's work order (the relation
 * `relation`, `workOrderSize` unless named). The one-customer rule makes a cell's customer its work order's; a cell of a
 * mixed work order made before the rule reaches only people who reach every customer, as its work order does.
 */
export function viaCell(actor: Actor, permission: Permission, relation = 'workOrderSize'): WhereClause {
  return { [relation]: { is: { workOrder: { is: workOrderWhere(actor, permission) } } } }
}

/**
 * An object shared by several work orders (a cut order, a lay, a trolley, a hold group): shown only when EVERY one of its
 * parts (`parts`, a to-many relation) is reached; `through` says how a part is reached (by its cell unless named). A person
 * who reaches every work order gets no filter. The object's own company and site stay the caller's filter.
 */
export function allPartsWhere(actor: Actor, permission: Permission, parts: string, through: (actor: Actor, permission: Permission) => WhereClause = viaCell): WhereClause {
  const reach = workOrderWhere(actor, permission)
  if (reach === NO_ROWS) return NO_ROWS
  if (Object.keys(reach).length === 0) return {}
  return { [parts]: { every: through(actor, permission) } }
}

/** True when `permission` reaches this work order (its company, site and customer; no customer: every customer). */
export function reachesWorkOrder(actor: Actor, permission: Permission, row: WorkOrderReach): boolean {
  const place = { companyId: row.companyId, siteId: row.siteId }
  return row.partyId === null ? reachesEveryParty(actor, permission, place) : can(actor, permission, { ...place, partyId: row.partyId })
}

/**
 * A view that mixes customers (capacity, the Line TV, a daily report, a board's line totals): 403 in words that name no
 * customer unless `permission` reaches every customer (at the record's company and site, when given).
 */
export function assertEveryParty(actor: Actor, permission: Permission, record: { readonly companyId?: string; readonly siteId?: string } = {}): void {
  if (!reachesEveryParty(actor, permission, record)) throw new ForbiddenError(EVERY_PARTY_WORDS.en)
}

// ── B-PR-07 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * B-PR-07 (production plan §2: "A view that mixes brands (capacity, Line TV, daily report, board line totals) needs access to
 * every brand"). Of `sites` (the sites a person reads with `permission`), the ones where it reaches every customer: a view
 * that mixes customers over several sites reads only those. None left of some: 403 in the words of assertEveryParty (they
 * name no customer).
 */
export function everyPartySites<T extends { readonly companyId: string; readonly id: string }>(actor: Actor, permission: Permission, sites: readonly T[]): T[] {
  const kept = sites.filter((site) => reachesEveryParty(actor, permission, { companyId: site.companyId, siteId: site.id }))
  if (sites.length > 0 && kept.length === 0) throw new ForbiddenError(EVERY_PARTY_WORDS.en)
  return kept
}

/**
 * The company and site scope of a view that mixes customers when it names no site: only the grants of `permission` that reach
 * every customer count (a person of every customer at site 1 and of one customer at site 2 reads site 1 only). No such grant:
 * 403 in the words of assertEveryParty.
 */
export function everyPartyActor(actor: Actor, permission: Permission): Actor {
  assertEveryParty(actor, permission)
  return { ...actor, grants: actor.grants.filter((grant) => grant.parties === 'all') }
}
// ── end B-PR-07 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
