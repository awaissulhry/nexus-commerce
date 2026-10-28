import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type FloorContext, type OfficeContext, type RequestContext, type SystemContext } from '../../../core/context'

/**
 * Who works on stock, and where (plan A1 §2.2, §3.11): the office over the companies and sites its grants reach, a floor
 * device at its own site only (can() pins it, row-level security too), and the system (the worker's handlers, imports)
 * for its tenant. Every stock row carries its site; the site's company is the scope company.
 */

export type StockContext = OfficeContext | FloorContext | SystemContext

export function stockContextOf(caller: CommandCaller): StockContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office' && context.audience !== 'floor' && context.audience !== 'system') throw new ForbiddenError()
  return context
}

export function officeContextOf(caller: CommandCaller): OfficeContext {
  const context = stockContextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

/** The caller holds the cost grain (A1 §2.6: values are shown only to it). */
export const seesCost = (context: RequestContext): boolean => heldGrains(actorOf(context)).has('cost')

export const SITE_SELECT = { id: true, companyId: true, code: true, name: true, status: true } as const
export interface SiteRow {
  readonly id: string
  readonly companyId: string
  readonly code: string
  readonly name: string
  readonly status: string
}

/**
 * The site the caller works at with this permission: a floor device's own site (another one is not found), an office
 * site its grants reach for the permission (else forbidden; one it may not see at all is not found). The system passes.
 */
export async function siteFor(caller: CommandCaller, siteId: string | undefined | null, permission: Permission, path = 'siteId'): Promise<SiteRow> {
  const context = stockContextOf(caller)
  const wanted = siteId ?? (context.audience === 'floor' ? context.siteId : null)
  if (!wanted) throw new NotFoundError(`Name the site (${path}).`)
  if (!isUuid(wanted) || (context.audience === 'floor' && wanted !== context.siteId)) throw new NotFoundError('Site not found.')
  const site = await caller.withClient((client) => client.site.findUnique({ where: { id: wanted }, select: SITE_SELECT }))
  if (!site) throw new NotFoundError('Site not found.')
  if (context.audience !== 'system' && !can(actorOf(context), permission, { companyId: site.companyId, siteId: site.id })) throw new ForbiddenError()
  return site
}

/** The site of a row the caller reads: may it, with this permission? (A row it may not see is not found.) */
export function mayAt(context: StockContext, permission: Permission, row: { readonly companyId: string; readonly siteId: string }): boolean {
  if (context.audience === 'system') return true
  return can(actorOf(context), permission, { companyId: row.companyId, siteId: row.siteId })
}

/** Who posted a row: the office user or the floor worker (with the device); the system is nobody. */
export function postedBy(context: StockContext): { readonly createdById: string | null; readonly deviceId: string | null; readonly audience: 'OFFICE' | 'FLOOR' | 'SYSTEM' } {
  if (context.audience === 'office') return { createdById: context.actorId, deviceId: null, audience: 'OFFICE' }
  if (context.audience === 'floor') return { createdById: context.actorId, deviceId: context.deviceId, audience: 'FLOOR' }
  return { createdById: null, deviceId: null, audience: 'SYSTEM' }
}
