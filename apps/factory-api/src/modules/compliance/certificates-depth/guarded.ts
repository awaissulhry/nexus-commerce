import { DomainError, ValidationError } from '@nexus/factory-domain/core/errors'

/**
 * Certificates in depth (B-W2b-255): the last line of defence that turns the database's own refusal of a certificate
 * write — B-W2b-216's Certificate_w2b4_rules, NotifiedBody_check and CertificateCoverage_supplier, W1's certificate and
 * coverage guards: a `compliance: …` check or restrict violation — into a 409 in words. A database refusal never
 * reaches a person as a 500 (lead note 11-10). A unique key is left to the caller (W1 answers its own duplicate words).
 */

type DriverCause = { originalCode?: unknown; originalMessage?: unknown }
const causeOf = (error: unknown): DriverCause | undefined => (error as { meta?: { driverAdapterError?: { cause?: DriverCause } } } | null)?.meta?.driverAdapterError?.cause

const capital = (words: string): string => `${words.charAt(0).toUpperCase()}${words.slice(1)}`

/** The database's compliance refusal as a 409 in its own words, or null for any other error. */
export function refusalInWords(error: unknown): DomainError | null {
  const cause = causeOf(error)
  if ((cause?.originalCode === '23514' || cause?.originalCode === '23001') && typeof cause.originalMessage === 'string' && cause.originalMessage.startsWith('compliance: ')) {
    const message = capital(cause.originalMessage.slice('compliance: '.length))
    const sentence = message.endsWith('.') ? message : `${message}.`
    return new DomainError('conflict', sentence, [{ path: 'refusal/DATABASE', message: sentence }])
  }
  return null
}

/** Runs a write; a compliance refusal of the database becomes a 409 in words, anything else is rethrown. */
export async function inWords<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw refusalInWords(error) ?? error
  }
}

/** W1's draft edit that would change the typed number of a certificate naming a directory body (said before the database). */
export const bodyNumberKept = (certificateNumber: string, bodyNumber: string): ValidationError =>
  new ValidationError('The certificate is not valid.', [
    {
      path: 'body/notifiedBodyNumber',
      message: `Certificate ${certificateNumber} names notified body ${bodyNumber} from the directory, so its typed number stays ${bodyNumber}. To change the body, pick another one (or none) on the Notified body tab first.`,
    },
  ])
