import { isEuMemberState } from '../tax/eu'
import { viesErrorMeaning } from '../ports/vies'
import { countryOfVatPrefix, splitEuVatNumber, type TaxIdentityFields } from './tax'

/**
 * The VIES proof (features SAL-006, SCM-003; art. 41 DL 331/1993: since the 2020 "quick fixes" a valid VAT number of
 * the buyer, registered in VIES, is a substantive condition of a zero-rated intra-EU supply of goods), pure.
 *
 * What is checked: the VAT number of a party's tax identity issued by an EU member state other than Italy (an EU
 * customer's, an EU supplier's). An Italian number is SDI's and the tax register's business, not VIES's: VIES only says
 * whether an Italian business opted into intra-EU trade.
 *
 * What proves it: a VALID check WITH a consultation number (an identified check: our company named as the requester)
 * of exactly the identity's current number (same member state, same digits), made at most
 * VIES_PROOF_MAX_AGE_DAYS before the moment the proof is needed (the sale, the invoice), and no INVALID check of that
 * number after it. The window is 30 days: long enough that a quote, its order and the invoice usually share one check,
 * short enough that a number withdrawn since is caught; the scheduled re-check (a later step) keeps the customers in
 * use inside it. A check that gave no answer (ERROR: VIES or a member state down, the connection paused) is neither a
 * proof nor a refusal: when no current proof exists the party is HELD, and a sale is never zero-rated on it.
 *
 *   NOT_APPLICABLE  no EU VAT number outside Italy to check
 *   UNCHECKED       never checked (this number)
 *   VALID           proven: `proof` is the check, `validUntil` when the window ends
 *   EXPIRED         the last valid check is older than the window: check again
 *   INVALID         the last answer was "not valid": not zero-rated (Italian VAT, or ask the customer)
 *   HELD            the last check(s) gave no answer and no current proof exists: check again later
 */

export const VIES_PROOF_MAX_AGE_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

export const VIES_STATES = ['NOT_APPLICABLE', 'UNCHECKED', 'VALID', 'EXPIRED', 'INVALID', 'HELD'] as const
export type ViesState = (typeof VIES_STATES)[number]
export const VIES_RESULTS = ['VALID', 'INVALID', 'ERROR'] as const
export type ViesResult = (typeof VIES_RESULTS)[number]

/** A check as the rules read it (a ViesCheck row). */
export interface ViesCheckFacts {
  readonly id: string
  readonly countryCode: string
  readonly vatNumber: string
  readonly requestedAt: Date
  readonly result: ViesResult
  readonly consultationNumber: string | null
  readonly errorCode: string | null
}

/** What a check of this identity sends: the member-state code and the number without it; null when VIES does not apply. */
export function viesTargetOf(identity: Pick<TaxIdentityFields, 'country' | 'vatNumber'> | null): { readonly countryCode: string; readonly vatNumber: string } | null {
  if (identity === null || identity.vatNumber === null) return null
  const split = splitEuVatNumber(identity.vatNumber)
  if (!split) return null
  const country = countryOfVatPrefix(split.prefix)
  if (country === 'IT' || !isEuMemberState(country) || country !== identity.country) return null
  return { countryCode: split.prefix, vatNumber: split.number }
}

/** Why an identity is not checked with VIES, in words for the person; null when it is. */
export function viesNotApplicableReason(identity: Pick<TaxIdentityFields, 'country' | 'vatNumber'> | null): string | null {
  if (identity === null) return 'The party has no tax identity in force.'
  if (identity.vatNumber === null) return 'The tax identity has no VAT number.'
  if (identity.country === 'IT') return 'VIES checks EU VAT numbers outside Italy; an Italian Partita IVA is checked by SDI and the tax register.'
  if (viesTargetOf(identity) === null) return 'VIES checks VAT numbers of EU member states only.'
  return null
}

/** Our company's VAT number as the requester of an identified check; null when it has none in a VIES format. */
export function viesRequesterOf(companyVatNumber: string | null): { readonly countryCode: string; readonly vatNumber: string } | null {
  if (companyVatNumber === null) return null
  const split = splitEuVatNumber(companyVatNumber.replace(/\s+/g, '').toUpperCase())
  return split && split.number !== '' ? { countryCode: split.prefix, vatNumber: split.number } : null
}

export interface ViesStanding {
  readonly state: ViesState
  /** The VALID check that proves the number (VALID), or the last one that did (EXPIRED). */
  readonly proof: ViesCheckFacts | null
  /** The newest check of this number (any result). */
  readonly latest: ViesCheckFacts | null
  /** VALID: when the proof stops counting. */
  readonly validUntil: Date | null
  readonly maxAgeDays: number
  /** In words, for the record's banner. */
  readonly message: string
}

const proves = (check: ViesCheckFacts): boolean => check.result === 'VALID' && check.consultationNumber !== null
const decides = (check: ViesCheckFacts): boolean => proves(check) || check.result === 'INVALID'

/**
 * Where an identity stands with VIES at `at` (default: the checks as they are): see the module comment. Only checks of
 * the identity's current number made at or before `at` count; the newest first.
 */
export function viesStanding(
  identity: Pick<TaxIdentityFields, 'country' | 'vatNumber'> | null,
  checks: readonly ViesCheckFacts[],
  at: Date,
  maxAgeDays: number = VIES_PROOF_MAX_AGE_DAYS,
): ViesStanding {
  const base = { maxAgeDays }
  const target = viesTargetOf(identity)
  if (target === null) return { ...base, state: 'NOT_APPLICABLE', proof: null, latest: null, validUntil: null, message: viesNotApplicableReason(identity) ?? 'VIES does not apply.' }
  const relevant = checks
    .filter((check) => check.countryCode === target.countryCode && check.vatNumber === target.vatNumber && check.requestedAt.getTime() <= at.getTime())
    .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime() || (a.id < b.id ? 1 : -1))
  const latest = relevant[0] ?? null
  if (latest === null) return { ...base, state: 'UNCHECKED', proof: null, latest, validUntil: null, message: 'Not checked with VIES yet: a sale is not zero-rated until a check answers valid.' }
  const decisive = relevant.find(decides) ?? null
  if (decisive?.result === 'INVALID') {
    return { ...base, state: 'INVALID', proof: null, latest, validUntil: null, message: 'VIES answered that this VAT number is not valid: no zero-rated sale; Italian VAT applies until a new check answers valid.' }
  }
  if (decisive !== null) {
    const validUntil = new Date(decisive.requestedAt.getTime() + maxAgeDays * DAY_MS)
    if (at.getTime() <= validUntil.getTime()) {
      return { ...base, state: 'VALID', proof: decisive, latest, validUntil, message: `Valid in VIES (consultation ${decisive.consultationNumber}); the proof counts for ${maxAgeDays} days after the check.` }
    }
    if (latest.result === 'ERROR') {
      return { ...base, state: 'HELD', proof: decisive, latest, validUntil: null, message: `The last valid check is older than ${maxAgeDays} days and the newest one gave no answer (${viesErrorMeaning(latest.errorCode ?? '')}): held, check again.` }
    }
    return { ...base, state: 'EXPIRED', proof: decisive, latest, validUntil: null, message: `The last valid check is older than ${maxAgeDays} days: check again before a zero-rated sale.` }
  }
  const why = latest.result === 'VALID' ? 'VIES answered valid without a consultation number (an anonymous check), which is no proof' : viesErrorMeaning(latest.errorCode ?? '')
  return { ...base, state: 'HELD', proof: null, latest, validUntil: null, message: `No proof yet: ${why}. Held: a sale is not zero-rated until a check answers valid.` }
}

/** The proof a zero-rated EU sale at `at` rests on, or why there is none (the invoicing and quoting steps ask this). */
export function zeroRatingProof(
  identity: Pick<TaxIdentityFields, 'country' | 'vatNumber'> | null,
  checks: readonly ViesCheckFacts[],
  at: Date,
  maxAgeDays: number = VIES_PROOF_MAX_AGE_DAYS,
): { readonly ok: true; readonly check: ViesCheckFacts } | { readonly ok: false; readonly state: ViesState; readonly message: string } {
  const standing = viesStanding(identity, checks, at, maxAgeDays)
  return standing.state === 'VALID' && standing.proof ? { ok: true, check: standing.proof } : { ok: false, state: standing.state, message: standing.message }
}
