import { ConflictError, ForbiddenError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import type { DispatchRefusal } from '@nexus/factory-domain/production/dispatch/rules'
import type { CommandCaller } from '../../../core/command'
import type { FloorContext, OfficeContext } from '../../../core/context'
import { may } from '../calls/access'
import { systemView } from '../scans/access'
import { siteRowOf } from './store'
import type { SiteRow } from '../../planning/store'

/**
 * Who may do what with dispatch (B-W2b-49): each site, line and station is checked with can() against its company and
 * site; a floor device only at its own site (can() pins it, row-level security too). A rule's refusal is a 409 whose
 * issues are `refusal/<CODE>` (the words) and `fix` (the one thing to do), as the floor's task screens read them.
 *
 * The floor's reads are checked as the floor session, then read in the tenant's system view (`readerOf`): load counts from
 * the working calendars and the planning settings, who is in from the clock and the roster, which the floor role does not
 * read. What goes back to the floor is its own site's only, and no name: the answers are the line's and the stations'.
 */

export type DispatchContext = OfficeContext | FloorContext

export function contextOf(caller: Pick<CommandCaller, 'factoryContext'>): DispatchContext {
  const context = caller.factoryContext
  if (!context || (context.audience !== 'office' && context.audience !== 'floor')) throw new ForbiddenError()
  return context
}

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

export function floorOf(caller: Pick<CommandCaller, 'factoryContext'>): FloorContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'floor') throw new ForbiddenError()
  return context
}

export { may }

/** The caller's reads: the office as itself, the floor through the tenant's system view (after its checks). */
export const readerOf = (caller: CommandCaller, context: DispatchContext): CommandCaller => (context.audience === 'floor' ? systemView(caller) : caller)

/** A site the caller may reach with the permission (else not found). */
export async function knownSite(caller: CommandCaller, context: DispatchContext, siteId: string, permission: Permission): Promise<SiteRow> {
  const site = await readerOf(caller, context).withClient((db) => siteRowOf(db, siteId))
  if (!site || !may(context, permission, { companyId: site.companyId, siteId: site.id })) throw new NotFoundError('Site not found.')
  return site
}

export class DispatchRefusedError extends ConflictError {
  override name = 'DispatchRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: DispatchRefusal, detail?: string) {
    const message = detail ? `${refusal.message} (${detail})` : refusal.message
    super(message)
    this.issues = [
      { path: `refusal/${refusal.code}`, message },
      { path: 'fix', message: refusal.fix },
    ]
  }
}

export const refuse = (refusal: DispatchRefusal, detail?: string): never => {
  throw new DispatchRefusedError(refusal, detail)
}
