import { ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { PRIVACY_VIEW } from '@nexus/factory-domain/privacy/permissions'
import type { CommandCaller, CommandTools } from '../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../core/context'

/**
 * Who may do what in the privacy pack (B-W1-36): office routes are scoped by record (the company of the notice, DPIA or
 * activity; can() on privacy.view to know it exists, then on the route's permission); a worker's acknowledgement also
 * on the worker's site. Floor routes read the device's site and company only.
 */

export function officeOf(caller: CommandCaller): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

export function floorOf(caller: CommandCaller): FloorContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'floor') throw new ForbiddenError()
  return context
}

export const mayOn = (context: OfficeContext, permission: Permission, companyId: string, siteId?: string | null): boolean =>
  can(actorOf(context), permission, { companyId, ...(siteId ? { siteId } : {}) })

/** 404 when the caller may not know the company's privacy records, 403 when it may not do `permission` on them. */
export function assertMay(context: OfficeContext, permission: Permission, companyId: string, what = 'Not found.'): void {
  if (!mayOn(context, PRIVACY_VIEW, companyId)) throw new NotFoundError(what)
  if (!mayOn(context, permission, companyId)) throw new ForbiddenError()
}

export interface CompanyRef {
  readonly id: string
  readonly code: string
  readonly name: string
}

/** The company, when the caller may do `permission` on its privacy records (404 / 403 otherwise). */
export async function companyFor(caller: CommandCaller, companyId: string, permission: Permission): Promise<{ context: OfficeContext; company: CompanyRef }> {
  const context = officeOf(caller)
  const row = isUuid(companyId) ? await caller.withClient((client) => client.company.findUnique({ where: { id: companyId }, select: { id: true, code: true, legalName: true, tradeName: true } })) : null
  if (!row) throw new NotFoundError('Company not found.')
  assertMay(context, permission, row.id, 'Company not found.')
  return { context, company: { id: row.id, code: row.code, name: row.tradeName ?? row.legalName } }
}

/** One writer at a time per company and kind of record (a version number, the version in force), inside the command. */
export async function lockPrivacy(tools: Pick<CommandTools, 'tx'>, what: string, companyId: string): Promise<void> {
  await tools.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`factory.privacy|${what}|${companyId}`}::text, 0))`
}

export function refuse(problems: readonly Issue[], message: string): void {
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : message, problems)
}

/** A date column as YYYY-MM-DD, or null. */
export const dayOf = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null)
/** YYYY-MM-DD as the Date a @db.Date column takes. */
export const dateOf = (day: string): Date => new Date(`${day}T00:00:00.000Z`)
