import { ForbiddenError, NotFoundError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { ScopeFilter, Viewer } from '@nexus/factory-domain/insights/attention'
import type { CommandCaller } from '../../core/command'
import { actorOf, type OfficeContext } from '../../core/context'
import { serverClock } from '../../core/time'

/**
 * Who Today is for (B-W1-52): an office person, at this moment. Floor, portal and link sessions are refused by the
 * manifest's audience; the system never calls these routes.
 */
export function officeContextOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

export function viewerOf(caller: CommandCaller): Viewer {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  const now = serverClock.now()
  return { actor: actorOf(context), personId: context.actorId, today: businessDate(now), now }
}

/** The page's company and site filters; a site is read for its company (a site of another tenant is not found). */
export async function scopeFilterOf(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly siteId?: string | undefined }): Promise<ScopeFilter> {
  if (!query.siteId) return { companyId: query.companyId }
  const siteId = query.siteId
  const site = isUuid(siteId) ? await caller.withClient((db) => db.site.findUnique({ where: { id: siteId }, select: { id: true, companyId: true } })) : null
  if (!site) throw new NotFoundError('Site not found.')
  return { companyId: query.companyId, site }
}
