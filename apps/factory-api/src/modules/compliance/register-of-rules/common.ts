import type { FactoryClient } from '@nexus/factory-db'
import { DomainError, ForbiddenError } from '@nexus/factory-domain/core/errors'
import { can, scopeWhere, type Actor, type Permission, type WhereClause } from '@nexus/factory-domain/core/permissions'
import { RULES_LIBRARY_VIEW } from '@nexus/factory-domain/compliance/register-of-rules/permissions'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock, type Clock } from '../../../core/time'
import { peopleNames } from '../../../platform/alerts/store'
import { mayWrite } from '../../product/materials/store'
import { officeOf as labelsOfficeOf } from '../labels/store'

/**
 * What Rules & markets' four parts share (B-W2b-249; modules/compliance/{register-of-rules,markets,operators,phrases}):
 * the office context, who may keep a row (a tenant-wide row needs a grant over every company), the companies a person's
 * grants reach (the company is a column here, not a policy key: the API keeps staff to their companies), the module
 * clock, people's names, and the last line of defence that turns the database's own refusal of a write (the compliance
 * rules guards of B-W2b-216: `compliance: …` check and restrict violations, a unique key, a reference) into a 409 in
 * words — never a 500.
 */

export type Reader = FactoryClient | CommandTx

export const officeOf = (caller: CommandCaller): OfficeContext => labelsOfficeOf(caller)

let clock: Clock = serverClock
/** Test only: the module clock (the watch's "today", the commands' time). */
export function useRulesClock(next: Clock | undefined): void {
  clock = next ?? serverClock
}
export const rulesClock = (): Clock => clock

/** The permission over the row's company; a tenant-wide row (null) needs a grant over every company. 403 in words. */
export function assertMayKeep(context: OfficeContext, permission: Permission, companyId: string | null, what: string): void {
  if (!mayWrite(actorOf(context), permission, companyId)) {
    throw new ForbiddenError(companyId === null ? `${what} for every company is kept only by a role over every company.` : undefined)
  }
}

/** The rows a person may read: tenant-wide ones and those of the companies the view permission reaches. */
export const companyReach = (actor: Actor, permission: Permission = RULES_LIBRARY_VIEW): WhereClause => scopeWhere(actor, permission, { company: { field: 'companyId', nullable: true } })

export const mayReadCompany = (actor: Actor, companyId: string | null, permission: Permission = RULES_LIBRARY_VIEW): boolean => companyId === null || can(actor, permission, { companyId })

/** `{ id, name }` of office people (null stays null). */
export async function namesFor(db: Reader, ids: Iterable<string | null | undefined>): Promise<(id: string | null) => { id: string; name: string } | null> {
  const names = await peopleNames(db as FactoryClient, ids)
  return (id) => (id ? { id, name: names.get(id) ?? '?' } : null)
}

type DriverCause = { originalCode?: unknown; originalMessage?: unknown }
const causeOf = (error: unknown): DriverCause | undefined => (error as { meta?: { driverAdapterError?: { cause?: DriverCause } } } | null)?.meta?.driverAdapterError?.cause

const capital = (words: string): string => `${words.charAt(0).toUpperCase()}${words.slice(1)}`

/**
 * Runs a write; the database's refusal becomes a 409 in words: a compliance guard's own sentence, a unique key (`taken`,
 * the caller's words for it), or a reference that refuses (a row still named elsewhere). Anything else is rethrown.
 */
export async function rulesGuarded<T>(work: () => Promise<T>, words: { readonly taken?: string; readonly named?: string } = {}): Promise<T> {
  try {
    return await work()
  } catch (error) {
    const cause = causeOf(error)
    const code = (error as { code?: unknown } | null)?.code
    if ((cause?.originalCode === '23514' || cause?.originalCode === '23001') && typeof cause.originalMessage === 'string' && cause.originalMessage.startsWith('compliance: ')) {
      const message = capital(cause.originalMessage.slice('compliance: '.length))
      throw new DomainError('conflict', message.endsWith('.') ? message : `${message}.`, [{ path: 'refusal/DATABASE', message }])
    }
    if (code === 'P2002' || cause?.originalCode === '23505') throw new DomainError('conflict', words.taken ?? 'This clashes with a row that exists already.')
    if (code === 'P2003' || cause?.originalCode === '23503' || cause?.originalCode === '23001') throw new DomainError('conflict', words.named ?? 'Another record still names this one.')
    throw error
  }
}
