import type { Issue } from '../../core/errors'
import { isBusinessDate, type BusinessDate } from '../../core/time'
import { daysBetween, type CertificateStatus } from '../certificates/rules'

/**
 * Own-brand (private label) certificates (B-W2b-255; PRD-287; Reg. (EU) 2016/425 recital 19 and art. 10: a brand that
 * places PPE on the market under its own name is its manufacturer). A B2B brand that sells our style under its name holds
 * its own EU type-examination certificate, issued by the notified body on the factory's own certificate of the same
 * type. W1's Certificate.holderPartyId is that brand; B-W2b-216's baseCertificateId links the factory's base certificate
 * (held by one of our companies, resting on nothing itself). Pure.
 *
 *   ownBrandProblems   whether this certificate may rest on that base (the database's Certificate_w2b4_rules, said first
 *                      in words, plus: a withdrawn or expired base is not linked)
 *   baseStanding       whether the base still holds on a day: the gate (B-W1-12's certificateGate, B-W2b-255's seam)
 *                      refuses what the brand's certificate covers while its base is not valid — "check both are valid
 *                      before labelling" (design, B-W2b-216's note)
 */

export interface BaseFacts {
  readonly id: string
  readonly number: string
  readonly standard: string
  readonly companyId: string | null
  readonly holderPartyId: string | null
  readonly baseCertificateId: string | null
  readonly status: CertificateStatus
  readonly validFrom: BusinessDate
  readonly validTo: BusinessDate
}

export interface OwnBrandFacts {
  readonly certificate: { readonly id: string; readonly number: string; readonly standard: string; readonly holderPartyId: string | null }
  /** The holder party has the BRAND role. */
  readonly holderIsBrand: boolean
  /** Other own-brand certificates already rest on this one. */
  readonly restingOnThis: number
  readonly base: BaseFacts
}

/** Why this certificate may not rest on that base (path `baseCertificateId`); empty when it may. */
export function ownBrandProblems(facts: OwnBrandFacts): Issue[] {
  const { certificate, base } = facts
  const at = (message: string): Issue => ({ path: 'baseCertificateId', message })
  if (base.id === certificate.id) return [at(`Certificate ${certificate.number} does not rest on itself.`)]
  const problems: Issue[] = []
  if (!certificate.holderPartyId || !facts.holderIsBrand) problems.push(at(`Only an own-brand certificate, held by a brand, rests on a base certificate: ${certificate.number} is held by one of our companies.`))
  if (base.holderPartyId !== null || base.companyId === null) problems.push(at(`The base certificate is the factory's own, held by one of our companies: ${base.number} is held by a brand.`))
  if (base.baseCertificateId !== null) problems.push(at(`${base.number} is itself an own-brand certificate resting on another: the base is the factory's own certificate.`))
  if (facts.restingOnThis > 0) problems.push(at(`Own-brand certificates rest on ${certificate.number}: it takes no base of its own.`))
  if (base.status === 'WITHDRAWN' || base.status === 'EXPIRED') problems.push(at(`${base.number} is ${base.status === 'WITHDRAWN' ? 'withdrawn' : 'expired'}: a brand's certificate rests on a base that still holds.`))
  return problems
}

/** Whether the two name the same harmonised standard (the brand's certificate is issued on the same type). */
export const sameStandard = (a: string, b: string): boolean => a.trim().toUpperCase().replace(/\s+/g, ' ') === b.trim().toUpperCase().replace(/\s+/g, ' ')

export type BaseState = 'HOLDS' | 'NOT_REGISTERED' | 'SUSPENDED' | 'WITHDRAWN' | 'EXPIRED' | 'NOT_YET'

export interface BaseStanding {
  readonly state: BaseState
  /** The base's number and its last valid day, for the words. */
  readonly number: string
  readonly validFrom: BusinessDate
  readonly validTo: BusinessDate
}

/** Whether the base certificate holds on a day (VALID and inside its validity). */
export function baseStanding(base: Pick<BaseFacts, 'number' | 'status' | 'validFrom' | 'validTo'>, day: BusinessDate): BaseStanding {
  const of = (state: BaseState): BaseStanding => ({ state, number: base.number, validFrom: base.validFrom, validTo: base.validTo })
  if (base.status === 'DRAFT') return of('NOT_REGISTERED')
  if (base.status === 'WITHDRAWN') return of('WITHDRAWN')
  if (base.status === 'EXPIRED' || (isBusinessDate(base.validTo) && daysBetween(base.validTo, day) > 0)) return of('EXPIRED')
  if (base.status === 'SUSPENDED') return of('SUSPENDED')
  if (isBusinessDate(base.validFrom) && daysBetween(day, base.validFrom) > 0) return of('NOT_YET')
  return of('HOLDS')
}

/** The gate's sentence when the base does not hold (the API's words, English), or null when it holds. */
export function baseGateWords(named: string, standing: BaseStanding): string | null {
  const base = `the factory's certificate ${standing.number}`
  switch (standing.state) {
    case 'HOLDS':
      return null
    case 'NOT_REGISTERED':
      return `${named} rests on ${base}, which is a draft, not registered yet.`
    case 'SUSPENDED':
      return `${named} rests on ${base}, which is suspended by the notified body.`
    case 'WITHDRAWN':
      return `${named} rests on ${base}, which was withdrawn.`
    case 'EXPIRED':
      return `${named} rests on ${base}, which expired: its last valid day was ${standing.validTo}.`
    case 'NOT_YET':
      return `${named} rests on ${base}, which is valid from ${standing.validFrom}.`
  }
}

/**
 * The days the brand's certificate outlives its base (its last valid day after the base's), or 0: from the base's end the
 * gate refuses what the brand's certificate covers (a renewal of the base, then the brand's, is the way on).
 */
export function outlivesBase(own: { readonly validTo: BusinessDate }, base: { readonly validTo: BusinessDate }): number {
  if (!isBusinessDate(own.validTo) || !isBusinessDate(base.validTo)) return 0
  return Math.max(0, daysBetween(base.validTo, own.validTo))
}
