import type { Issue } from '../../core/errors'
import { isBusinessDate, type BusinessDate } from '../../core/time'
import { daysBetween, type CertificateStatus } from '../certificates/rules'

/**
 * Certificates of bought-in parts (B-W2b-255; QHS-106: protector (EN 1621) certificates per supplier part, checked at
 * incoming). A certificate's coverage of an item (W1's CertificateCoverage with itemId) names the supplier it buys the
 * certified part from and that supplier's article code (B-W2b-216's supplierPartyId, a SUPPLIER party named once, and
 * supplierArticleCode). An incoming lot of the part from a supplier is covered when an active coverage of the item names
 * that supplier (or names none: W1's coverage of the part from any supplier) on a certificate valid on the day. Pure.
 */

export const ARTICLE_CODE_MAX = 100

export interface SupplierDraft {
  /** The coverage is of an item (a bought-in part), not of a style. */
  readonly isItem: boolean
  /** The supplier named on the coverage now (named once, never changed after). */
  readonly current: string | null
  readonly supplierPartyId: string | null
  readonly supplierArticleCode: string | null
  /** The party has the SUPPLIER role. */
  readonly isSupplier: boolean
}

/** Why the coverage may not name this supplier and article code (paths `supplierPartyId`, `supplierArticleCode`). */
export function supplierProblems(draft: SupplierDraft): Issue[] {
  const problems: Issue[] = []
  if (!draft.isItem) problems.push({ path: 'supplierPartyId', message: 'A supplier is named only on the coverage of a bought-in part (an item), not of a style.' })
  if (draft.current !== null && draft.supplierPartyId !== draft.current) problems.push({ path: 'supplierPartyId', message: 'The coverage names its supplier once: it never changes. A part bought from another supplier is another coverage (its own certificate).' })
  if (draft.supplierPartyId === null && draft.supplierArticleCode) problems.push({ path: 'supplierArticleCode', message: "The supplier's article code comes with its supplier." })
  if (draft.supplierPartyId !== null && !draft.isSupplier) problems.push({ path: 'supplierPartyId', message: 'The party is not one of our suppliers (it has no supplier role).' })
  const code = draft.supplierArticleCode
  if (code !== null && (code.trim() === '' || code.length > ARTICLE_CODE_MAX || /\p{Cc}/u.test(code))) problems.push({ path: 'supplierArticleCode', message: `The supplier's article code as the certificate names it, at most ${ARTICLE_CODE_MAX} characters.` })
  return problems
}

export interface PartCoverage {
  readonly coverageId: string
  readonly supplierPartyId: string | null
  readonly supplierArticleCode: string | null
  readonly status: 'ACTIVE' | 'ARCHIVED'
  readonly certificate: {
    readonly id: string
    readonly number: string
    readonly standard: string
    readonly ppeClass: string | null
    readonly status: CertificateStatus
    readonly validFrom: BusinessDate
    readonly validTo: BusinessDate
  }
}

export type BoughtInState = 'COVERED' | 'COVERED_ANY_SUPPLIER' | 'OTHER_SUPPLIER' | 'NOT_VALID' | 'NO_CERTIFICATE'

export interface BoughtInCheck {
  readonly state: BoughtInState
  /** The coverage that answers (COVERED, COVERED_ANY_SUPPLIER; NOT_VALID: the one nearest to holding). */
  readonly coverage: PartCoverage | null
  /** NOT_VALID: why the certificate does not hold on the day. */
  readonly why: 'NOT_REGISTERED' | 'SUSPENDED' | 'WITHDRAWN' | 'EXPIRED' | 'NOT_YET' | null
  /** OTHER_SUPPLIER: the suppliers the item's certificates name. */
  readonly otherSuppliers: readonly string[]
}

function whyNot(certificate: PartCoverage['certificate'], day: BusinessDate): BoughtInCheck['why'] {
  if (certificate.status === 'DRAFT') return 'NOT_REGISTERED'
  if (certificate.status === 'WITHDRAWN') return 'WITHDRAWN'
  if (certificate.status === 'EXPIRED' || (isBusinessDate(certificate.validTo) && daysBetween(certificate.validTo, day) > 0)) return 'EXPIRED'
  if (certificate.status === 'SUSPENDED') return 'SUSPENDED'
  if (isBusinessDate(certificate.validFrom) && daysBetween(day, certificate.validFrom) > 0) return 'NOT_YET'
  return null
}

const longest = (a: PartCoverage, b: PartCoverage): number => (a.certificate.validTo !== b.certificate.validTo ? (a.certificate.validTo < b.certificate.validTo ? 1 : -1) : a.certificate.number.localeCompare(b.certificate.number))

/**
 * The incoming check of a bought-in part: is a lot of this item from this supplier covered on that day? A coverage that
 * names the supplier wins over one that names none (W1's, the part from any supplier); a coverage naming another
 * supplier never covers it.
 */
export function boughtInCheck(coverages: readonly PartCoverage[], supplierPartyId: string | null, day: BusinessDate): BoughtInCheck {
  const active = coverages.filter((coverage) => coverage.status === 'ACTIVE')
  if (active.length === 0) return { state: 'NO_CERTIFICATE', coverage: null, why: null, otherSuppliers: [] }
  const named = supplierPartyId ? active.filter((coverage) => coverage.supplierPartyId === supplierPartyId) : []
  const anyone = active.filter((coverage) => coverage.supplierPartyId === null)
  const holding = (list: readonly PartCoverage[]) => [...list].filter((coverage) => whyNot(coverage.certificate, day) === null).sort(longest)[0] ?? null
  const exact = holding(named)
  if (exact) return { state: 'COVERED', coverage: exact, why: null, otherSuppliers: [] }
  const open = holding(anyone)
  if (open) return { state: 'COVERED_ANY_SUPPLIER', coverage: open, why: null, otherSuppliers: [] }
  const candidates = [...named, ...anyone].sort(longest)
  if (candidates.length > 0) return { state: 'NOT_VALID', coverage: candidates[0]!, why: whyNot(candidates[0]!.certificate, day), otherSuppliers: [] }
  const others = [...new Set(active.map((coverage) => coverage.supplierPartyId).filter((id): id is string => id !== null))].sort()
  return { state: 'OTHER_SUPPLIER', coverage: null, why: null, otherSuppliers: others }
}

/** Whether a coverage counts for a lot of this supplier (the incoming check's filter: its own supplier, or none named). */
export const countsForSupplier = (coverage: { readonly supplierPartyId: string | null }, supplierPartyId: string | null): boolean => coverage.supplierPartyId === null || coverage.supplierPartyId === supplierPartyId
