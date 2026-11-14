import type { FactoryClient } from '@nexus/factory-db'
import { DomainError, ForbiddenError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { can, grantsFor, type Actor, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { databaseTemplateRefusal, TEMPLATE_REFUSAL_WORDS, type TemplateRefusal } from '@nexus/factory-domain/templates/refusals'
import type { CommandCaller, CommandTx } from '../../core/command'
import type { OfficeContext } from '../../core/context'

/**
 * What the template routes share (B-W2b-422): the office caller, who may act over a company or every company, the names of
 * people, refusals as 409 in words (`refusal/<CODE>`), and the last net for the database's own template guards.
 */

export type Reader = FactoryClient | CommandTx

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

/** The permission over the company, or (companyId null: every company's) a grant of it over every company. */
export const mayOver = (actor: Actor, permission: Permission, companyId: string | null): boolean =>
  companyId === null ? grantsFor(actor, permission).some((grant) => grant.companies === 'all') : can(actor, permission, { companyId })

export const refused = (code: TemplateRefusal, message: string = TEMPLATE_REFUSAL_WORDS[code]): DomainError => new DomainError('conflict', message, [{ path: `refusal/${code}`, message }])

export function refuseProblems(problems: readonly Issue[], message: string): void {
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : message, problems)
}

type DriverCause = { originalCode?: unknown; originalMessage?: unknown }

/** The last net: a template guard's check_violation or a one-in-use index reached in a race is a 409 in words. */
export function templateRefusal(error: unknown): never {
  const cause = (error as { meta?: { driverAdapterError?: { cause?: DriverCause } } } | null)?.meta?.driverAdapterError?.cause
  const refusal = databaseTemplateRefusal(cause?.originalCode, typeof cause?.originalMessage === 'string' ? cause.originalMessage : '')
  if (refusal) throw refused(refusal)
  throw error
}

/** People by id: their display name, else their address's local part. */
export async function namesOf(db: Reader, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))]
  if (unique.length === 0) return new Map()
  const rows = await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, displayName: true, email: true } })
  return new Map(rows.map((row) => [row.id, row.displayName?.trim() || row.email.split('@')[0]!]))
}

export const person = (names: ReadonlyMap<string, string>, id: string | null): { id: string; name: string } | null => (id ? { id, name: names.get(id) ?? '—' } : null)

export const iso = (date: Date | null): string | null => (date ? toUtcIso(date) : null)

/** Locks the versions of one template series for the rest of the transaction (the next version number is taken once). */
export async function lockSeries(tx: CommandTx, series: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`factory.templates|${series}`}::text, 0))`
}
