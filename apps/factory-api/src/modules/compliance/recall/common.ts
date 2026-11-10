import type { FactoryClient } from '@nexus/factory-db'
import { REGISTER_VIEW } from '@nexus/factory-domain/compliance/register/permissions'
import { RECALL_MANAGE } from '@nexus/factory-domain/compliance/recall/permissions'
import { DomainError, ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate, type Clock } from '@nexus/factory-domain/core/time'
import { COMMAND_SETTINGS, type CommandCaller, type CommandSettings, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { namesFor, officeOf as rulesOfficeOf } from '../register-of-rules/common'
import { readEntry, type EntryRecord } from '../register/store'

/**
 * What recall, withdrawal and authority's parts share (B-W2b-260; modules/compliance/recall): the office context, the module
 * clock and "today" in Rome, who may read or keep a row (what hangs on a register entry follows the entry: its company and
 * the party that reported it; an authority request its company), people's names, and the last line of defence that turns
 * the database's own refusal (B-W2b-222's `recall: …` guards, W1's `quality: …` register guard, a unique key, a reference)
 * into a 409 in words — never a 500.
 */

export type Reader = FactoryClient | CommandTx
export { namesFor }

export const officeOf = (caller: CommandCaller): OfficeContext => rulesOfficeOf(caller)

let clock: Clock = serverClock
/** Test only: the module clock (today, the commands' time). */
export function useRecallClock(next: Clock | undefined): void {
  clock = next ?? serverClock
}
export const recallClock = (): Clock => clock
export const settings = (): CommandSettings => ({ ...COMMAND_SETTINGS, clock })
/** Today in Rome. */
export const todayOf = (now: Date = clock.now()): BusinessDate => businessDate(now)
export const dayOf = (value: Date | null): BusinessDate | null => (value === null ? null : value.toISOString().slice(0, 10))
export const dateOfDay = (day: BusinessDate): Date => new Date(`${day}T00:00:00.000Z`)

type DriverCause = { originalCode?: unknown; originalMessage?: unknown }
const causeOf = (error: unknown): DriverCause | undefined => (error as { meta?: { driverAdapterError?: { cause?: DriverCause } } } | null)?.meta?.driverAdapterError?.cause
const capital = (words: string): string => `${words.charAt(0).toUpperCase()}${words.slice(1)}`
const PREFIXES = ['recall: ', 'quality: ', 'compliance: '] as const

/**
 * Runs a write; the database's refusal becomes a 409 in words: a guard's own sentence (`recall:`, `quality:`, `compliance:`),
 * a unique key (`taken`, the caller's words), or a reference that refuses. Anything else is rethrown.
 */
export async function guarded<T>(work: () => Promise<T>, words: { readonly taken?: string; readonly named?: string } = {}): Promise<T> {
  try {
    return await work()
  } catch (error) {
    const cause = causeOf(error)
    const code = (error as { code?: unknown } | null)?.code
    if ((cause?.originalCode === '23514' || cause?.originalCode === '23001') && typeof cause.originalMessage === 'string') {
      const prefix = PREFIXES.find((value) => (cause.originalMessage as string).startsWith(value))
      if (prefix) {
        const message = capital(cause.originalMessage.slice(prefix.length))
        throw new DomainError('conflict', message.endsWith('.') ? message : `${message}.`, [{ path: 'refusal/DATABASE', message }])
      }
    }
    if (code === 'P2002' || cause?.originalCode === '23505') throw new DomainError('conflict', words.taken ?? 'This clashes with a row that exists already.')
    if (code === 'P2003' || cause?.originalCode === '23503') throw new DomainError('conflict', words.named ?? 'Another record still names this one, or this one names a record that is not there.')
    throw error
  }
}

/** The scope of what hangs on a register entry: the entry's company and the party that reported it (none: every party). */
export const entryScope = (entry: Pick<EntryRecord, 'companyId' | 'partyId'>) => ({ companyId: entry.companyId, partyId: entry.partyId })

export const ENTRY_NOT_FOUND = 'Register entry not found.'

/** A register entry the caller may view (the register's view permission over its company and reporting party), or the one 404. */
export async function visibleEntry(db: Reader, context: OfficeContext, entryId: string): Promise<EntryRecord> {
  if (!isUuid(entryId)) throw new NotFoundError(ENTRY_NOT_FOUND)
  const entry = await readEntry(db, entryId)
  if (!entry || !can(actorOf(context), REGISTER_VIEW, entryScope(entry))) throw new NotFoundError(ENTRY_NOT_FOUND)
  return entry
}

/** The permission over a scope, or a 403 in words. */
export function assertMay(context: OfficeContext, permission: Permission, scope: { readonly companyId: string; readonly partyId?: string | null }, what?: string): void {
  if (!can(actorOf(context), permission, { companyId: scope.companyId, ...(scope.partyId ? { partyId: scope.partyId } : {}) })) {
    throw new ForbiddenError(what ? `${what} needs ${permission} over this company.` : undefined)
  }
}

export const mayOn = (context: OfficeContext, permission: Permission, scope: { readonly companyId: string; readonly partyId?: string | null }): boolean =>
  can(actorOf(context), permission, { companyId: scope.companyId, ...(scope.partyId ? { partyId: scope.partyId } : {}) })

export const mayManage = (context: OfficeContext, scope: { readonly companyId: string; readonly partyId?: string | null }): boolean => mayOn(context, RECALL_MANAGE, scope)

export const uuidOr404 = (value: string, notFound: string): string => {
  if (!isUuid(value)) throw new NotFoundError(notFound)
  return value
}

/** The office person of the command (a notice's sender, a recall's starter): never the system. */
export const personOf = (context: OfficeContext): string => context.actorId

/** Words of a person's own text, trimmed; empty → null. */
export const textOrNull = (value: string | null | undefined): string | null => (value === null || value === undefined ? null : value.trim() || null)

/** The company's name and the style's code and name, for the drafts. */
export async function draftNames(db: Reader, companyId: string, styleId: string): Promise<{ companyName: string; styleCode: string; styleName: string }> {
  const company = await db.company.findUnique({ where: { id: companyId }, select: { legalName: true, tradeName: true } })
  const style = await db.style.findUnique({ where: { id: styleId }, select: { code: true, name: true } })
  return { companyName: company?.tradeName ?? company?.legalName ?? '', styleCode: style?.code ?? '', styleName: style?.name ?? '' }
}
