import { DomainError } from '@nexus/factory-domain/core/errors'

/**
 * Subcontracting in depth (B-W2b-331): the last line of defence that turns the database's own refusal of a write this
 * module makes — B-W2b-285's SubcontractConsumption and SubcontractCostEntry checks (`supply: …`), B-W2b-287's
 * SubcontractAgreement guard and its one-signed index (`suppliers: …`) — into a 409 in its words. The commands check the
 * same rules first, in words; a database refusal never reaches a person as a 500.
 */

type DriverCause = { originalCode?: unknown; originalMessage?: unknown }
const causeOf = (error: unknown): DriverCause | undefined => (error as { meta?: { driverAdapterError?: { cause?: DriverCause } } } | null)?.meta?.driverAdapterError?.cause
const capital = (words: string): string => `${words.charAt(0).toUpperCase()}${words.slice(1)}`
const PREFIXES = ['supply: ', 'suppliers: '] as const

/** The database's refusal as a 409 in its words, or null for any other error. */
export function refusalInWords(error: unknown): DomainError | null {
  const cause = causeOf(error)
  const message = typeof cause?.originalMessage === 'string' ? cause.originalMessage : null
  if (message && (cause?.originalCode === '23514' || cause?.originalCode === '23001')) {
    const prefix = PREFIXES.find((start) => message.startsWith(start))
    if (prefix) {
      const words = capital(message.slice(prefix.length))
      const sentence = words.endsWith('.') ? words : `${words}.`
      return new DomainError('conflict', sentence, [{ path: 'refusal/DATABASE', message: sentence }])
    }
  }
  // The one-signed index (SubcontractAgreement_one_signed): another revision was signed meanwhile.
  if (cause?.originalCode === '23505' && message?.includes('SubcontractAgreement_one_signed')) {
    const sentence = 'Another revision of these terms was signed meanwhile: read them again.'
    return new DomainError('conflict', sentence, [{ path: 'refusal/DATABASE', message: sentence }])
  }
  return null
}

/** Runs a write; a refusal of the database becomes a 409 in words, anything else is rethrown. */
export async function inWords<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw refusalInWords(error) ?? error
  }
}
