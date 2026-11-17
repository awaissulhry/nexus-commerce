import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import type { CommandCaller } from '../../core/command'
import { actorOf, type OfficeContext } from '../../core/context'
import { SITE_COLUMNS, type Reader, type SiteRow } from './store'
// B-PR-07: a view that mixes customers needs every customer.
import { assertEveryParty, workOrderWhere } from '../production/work-orders/scope'

/**
 * Who plans, and where (plan A1 §2.2, §3.11): the office, over the sites its grants reach (a site's company and the
 * site). Planning has no floor, portal or link route. A site (or a run, or a line) the caller may not see is not found;
 * one it sees but may not act on is forbidden.
 */

export function officeContextOf(caller: CommandCaller): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

/** The caller holds the cost grain (A1 §2.6): only it gets a line's expected cost. */
export const seesCost = (context: OfficeContext): boolean => heldGrains(actorOf(context)).has('cost')

export const mayAt = (context: OfficeContext, permission: Permission, row: { readonly companyId: string; readonly siteId: string }): boolean =>
  can(actorOf(context), permission, { companyId: row.companyId, siteId: row.siteId })

/** The row is seen with planning.view (else not found) and `permission` is held over it (else forbidden). */
export function assertMayAt(context: OfficeContext, permission: Permission, row: { readonly companyId: string; readonly siteId: string } | null, what: string): asserts row is { companyId: string; siteId: string } {
  if (!row || !mayAt(context, PLANNING_VIEW, row)) throw new NotFoundError(`${what} not found.`)
  if (!mayAt(context, permission, row)) throw new ForbiddenError()
}

/** The site the caller plans at with this permission. */
export async function siteFor(caller: CommandCaller, siteId: string, permission: Permission, db?: Reader): Promise<SiteRow> {
  const context = officeContextOf(caller)
  const read = (client: Reader) => (isUuid(siteId) ? client.site.findUnique({ where: { id: siteId }, select: SITE_COLUMNS }) : Promise.resolve(null))
  const site = db ? await read(db) : await caller.withClient(read)
  assertMayAt(context, permission, site ? { companyId: site.companyId, siteId: site.id } : null, 'Site')
  return site!
}

// ── B-PR-07 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * B-PR-07 (production plan §2: "A view that mixes brands (capacity, Line TV, daily report, board line totals) needs access to
 * every brand"): the site, as siteFor, for a view that mixes customers (capacity, the heatmap, the material plan, its action
 * messages, a whole-site placement): a person limited to some customers gets 403 in words that name none.
 */
export async function everyPartySiteFor(caller: CommandCaller, siteId: string, permission: Permission, db?: Reader): Promise<SiteRow> {
  const site = await siteFor(caller, siteId, permission, db)
  assertEveryParty(actorOf(officeContextOf(caller)), permission, { companyId: site.companyId, siteId: site.id })
  return site
}

/** A row of a view that mixes customers (a planning run, an action message): its place reached with every customer, else 403. */
export function assertEveryPartyAt(context: OfficeContext, permission: Permission, row: { readonly companyId: string; readonly siteId: string }): void {
  assertEveryParty(actorOf(context), permission, { companyId: row.companyId, siteId: row.siteId })
}
/**
 * Of the work orders `ids`, the ones `permission` reaches (their company, site and customer; a work order of no customer only
 * with every customer): what a planning list of work orders keeps for a person limited to some customers.
 */
export async function reachedWorkOrders(db: Reader, context: OfficeContext, permission: Permission, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const rows = await db.workOrder.findMany({ where: { AND: [workOrderWhere(actorOf(context), permission), { id: { in: [...new Set(ids)] } }] }, select: { id: true } })
  return new Set(rows.map((row) => row.id))
}
// ── end B-PR-07 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
