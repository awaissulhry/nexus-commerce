import { DomainError } from '@nexus/factory-domain/core/errors'
import { SUBSTANCES_VIEW } from '@nexus/factory-domain/compliance/substances/permissions'
import type { Actor, WhereClause } from '@nexus/factory-domain/core/permissions'
import { COMMAND_SETTINGS, type CommandSettings } from '../../../core/command'
import { serverClock, type Clock } from '../../../core/time'
import { companyReach } from '../register-of-rules/common'

/**
 * What the substance list's parts share (B-W2b-250; modules/compliance/substances): the module clock (the evaluator's
 * "today", the commands' time), the companies a person reads (the company is a column, not a policy key: the API keeps
 * staff to their companies, as Rules & markets does), and the last line of defence that turns the database's own refusal
 * of a write (B-W2b-217's …_substances_w2b_guards: `substances: …` check violations, the one ACTIVE substance per CAS
 * number, a unique key, a reference) into a 409 in words — never a 500. The office context, who may keep a tenant-wide row
 * and people's names are Rules & markets' (../register-of-rules/common.ts), reused as they are.
 */

let clock: Clock = serverClock
/** Test only: the module clock. */
export function useSubstancesClock(next: Clock | undefined): void {
  clock = next ?? serverClock
}
export const substancesClock = (): Clock => clock
export const substancesSettings = (): CommandSettings => ({ ...COMMAND_SETTINGS, clock: substancesClock() })

/** The rows a person may read: tenant-wide ones and those of the companies the view permission reaches. */
export const substanceReach = (actor: Actor): WhereClause => companyReach(actor, SUBSTANCES_VIEW)

type DriverCause = { originalCode?: unknown; originalMessage?: unknown; constraint?: unknown }
const causeOf = (error: unknown): DriverCause | undefined => (error as { meta?: { driverAdapterError?: { cause?: DriverCause } } } | null)?.meta?.driverAdapterError?.cause

const capital = (words: string): string => `${words.charAt(0).toUpperCase()}${words.slice(1)}`

/**
 * Runs a write; the database's refusal becomes a 409 in words: a substances guard's own sentence (its row ids left as they
 * are), a unique key (`taken`, the caller's words for it), or a reference that refuses (`named`). Anything else is
 * rethrown.
 */
export async function substancesGuarded<T>(work: () => Promise<T>, words: { readonly taken?: string; readonly named?: string } = {}): Promise<T> {
  try {
    return await work()
  } catch (error) {
    const cause = causeOf(error)
    const code = (error as { code?: unknown } | null)?.code
    if (cause?.originalCode === '23514' && typeof cause.originalMessage === 'string' && cause.originalMessage.startsWith('substances: ')) {
      const message = capital(cause.originalMessage.slice('substances: '.length))
      throw new DomainError('conflict', message.endsWith('.') ? message : `${message}.`, [{ path: 'refusal/DATABASE', message }])
    }
    if (code === 'P2002' || cause?.originalCode === '23505') throw new DomainError('conflict', words.taken ?? 'This clashes with a row that exists already.')
    if (code === 'P2003' || cause?.originalCode === '23503' || cause?.originalCode === '23001') throw new DomainError('conflict', words.named ?? 'Another record still names this one.')
    throw error
  }
}
