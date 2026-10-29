import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import type { CommandCaller } from '../../core/command'
import { actorOf, type OfficeContext } from '../../core/context'
import { SITE_COLUMNS, type Reader, type SiteRow } from './store'

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
