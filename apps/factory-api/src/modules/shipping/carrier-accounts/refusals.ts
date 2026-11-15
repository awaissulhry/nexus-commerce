import { DomainError } from '@nexus/factory-domain/core/errors'
import type { ContractRefusalCode, CustomerAccountRefusalCode } from '@nexus/factory-domain/shipping/carrier-accounts/rules'
import type { ServiceRefusalCode } from '@nexus/factory-domain/shipping/services/booking'

/**
 * Refusals of carrier contracts and services in words (B-W2b-400): 409 with the issue path `refusal/<CODE>`. The commands
 * check every rule first; a write that still reaches the database's own rule (…_carriers_w2b_guards: check_violation
 * 'carriers: …' or 'parties: …'; the partial unique CarrierAccount_one_live when two people add the same contract at once)
 * answers 409 in the database's words, never a 500.
 */

export const refusedFor = (code: ContractRefusalCode | CustomerAccountRefusalCode | ServiceRefusalCode, message: string): DomainError => new DomainError('conflict', message, [{ path: `refusal/${code}`, message }])

const causeOf = (error: unknown) => (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause

/** The database's carrier or party refusal as a 409 in words, or null for anything else. */
export function carriersRefusal(error: unknown): DomainError | null {
  const cause = causeOf(error)
  const message = typeof cause?.originalMessage === 'string' ? cause.originalMessage : ''
  if (cause?.originalCode === '23514') {
    const words = /^(carriers|parties): (.+)$/s.exec(message)?.[2]
    if (words) return refusedFor('DATABASE', `${words.charAt(0).toUpperCase()}${words.slice(1)}.`)
  }
  const target = String((error as { meta?: { target?: unknown } } | null)?.meta?.target ?? '')
  if ((cause?.originalCode === '23505' || (error as { code?: unknown } | null)?.code === 'P2002') && (/CarrierAccount_one_live/.test(message) || /CarrierAccount_one_live/.test(target))) {
    return refusedFor('LIVE_EXISTS', 'A live contract with this carrier for the same site (or every site) was just added: switch it off or replace its number instead.')
  }
  return null
}

/** Runs a write and turns the database's carrier refusals into 409s in words. */
export async function refusingInWords<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw carriersRefusal(error) ?? error
  }
}
