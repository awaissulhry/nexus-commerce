import { boughtInCheck, type BoughtInCheck, type PartCoverage } from '../../compliance/certificates-depth/bought-in'
import { daysBetween, type CertificateStatus } from '../../compliance/certificates/rules'
import type { BusinessDate } from '../../core/time'

/**
 * A protector's purchase order line names its certificate (B-W2b-328; SCM-077: "W1 checks protector certificates at
 * receipt; certificate on the PO later"; design purchasing.orders "protectors: certificate reference EN 1621"), pure. The
 * certificate is one of the PPE register's (compliance.prisma Certificate) with an ACTIVE coverage of the line's material;
 * B-W2b-255's bought-in rule decides whether it covers the part from this supplier (a coverage naming the supplier, or
 * naming none: W1's "any supplier"), on a day.
 *
 *   who        a PPE component's line: a PROTECTOR, or a material marked isPpeComponent (the database's rule).
 *   default    a new line names the certificate the incoming check would pick today (boughtInCheck: the supplier's own
 *              coverage first, then one for any supplier; the longest valid), when there is one.
 *   send       a line without one stops the send while the register has a certificate that covers it from this supplier
 *              (a warning when it has none, or on a sample order); a named one that no longer holds stops it too; one that
 *              ends before the need date is a warning.
 *   receipt    checked again on the day the goods come: when it no longer holds, the lots wait in quarantine with the reason
 *              in words (a PPE component is always tracked by lot), never silently released.
 */

export const isPpeLine = (item: { readonly kind: string; readonly isPpeComponent: boolean }): boolean => item.kind === 'PROTECTOR' || item.isPpeComponent

export type LineCertificateState = 'HOLDS' | 'NOT_VALID' | 'OTHER_SUPPLIER' | 'NOT_COVERING'

export interface NamedCertificate {
  readonly id: string
  readonly number: string
  readonly standard: string
  readonly status: CertificateStatus
  readonly validFrom: BusinessDate
  readonly validTo: BusinessDate
}

export interface LineCertificateCheck {
  readonly state: LineCertificateState
  /** NOT_VALID: why it does not hold on the day. */
  readonly why: BoughtInCheck['why']
  /** The coverage that answers (HOLDS) or comes nearest (NOT_VALID). */
  readonly coverageId: string | null
}

/**
 * Does the certificate a line names cover its material from this supplier on that day? `coverages` are the material's
 * coverages (any certificate, ACTIVE or not); only the named certificate's count.
 */
export function lineCertificateCheck(coverages: readonly PartCoverage[], certificateId: string, supplierPartyId: string, day: BusinessDate): LineCertificateCheck {
  const check = boughtInCheck(
    coverages.filter((coverage) => coverage.certificate.id === certificateId),
    supplierPartyId,
    day,
  )
  switch (check.state) {
    case 'COVERED':
    case 'COVERED_ANY_SUPPLIER':
      return { state: 'HOLDS', why: null, coverageId: check.coverage!.coverageId }
    case 'NOT_VALID':
      return { state: 'NOT_VALID', why: check.why, coverageId: check.coverage!.coverageId }
    case 'OTHER_SUPPLIER':
      return { state: 'OTHER_SUPPLIER', why: null, coverageId: null }
    default:
      return { state: 'NOT_COVERING', why: null, coverageId: null }
  }
}

/** The certificate a new line of this material from this supplier names by default today, or null. */
export function defaultCertificateOf(coverages: readonly PartCoverage[], supplierPartyId: string, day: BusinessDate): string | null {
  const check = boughtInCheck(coverages, supplierPartyId, day)
  return check.state === 'COVERED' || check.state === 'COVERED_ANY_SUPPLIER' ? check.coverage!.certificate.id : null
}

const WHY_WORDS: Readonly<Record<NonNullable<BoughtInCheck['why']>, (certificate: NamedCertificate) => string>> = {
  NOT_REGISTERED: () => 'is a draft, not registered yet',
  SUSPENDED: () => 'is suspended by the notified body',
  WITHDRAWN: () => 'was withdrawn',
  EXPIRED: (certificate) => `expired (valid to ${certificate.validTo})`,
  NOT_YET: (certificate) => `is valid only from ${certificate.validFrom}`,
}

/** The check in words: "Certificate SEED-CERT-0002 (EN 1621-1:2012) holds until 2030-05-31." */
export function certificateWords(check: LineCertificateCheck, certificate: NamedCertificate | null, itemCode: string): string {
  const named = certificate ? `Certificate ${certificate.number} (${certificate.standard})` : 'The certificate named'
  switch (check.state) {
    case 'HOLDS':
      return `${named} holds until ${certificate?.validTo ?? 'its end'}.`
    case 'NOT_VALID':
      return `${named} ${check.why && certificate ? WHY_WORDS[check.why](certificate) : 'no longer holds'}.`
    case 'OTHER_SUPPLIER':
      return `${named} covers ${itemCode} only as bought from another supplier, not from this one.`
    default:
      return `${named} does not cover ${itemCode} (no active coverage of the material).`
  }
}

/** The certificate ends before the line is needed (a warning: the goods may come after its last day). */
export const endsBefore = (certificate: Pick<NamedCertificate, 'validTo'>, needDate: BusinessDate): boolean => daysBetween(certificate.validTo, needDate) > 0

/** The reason a line's lots wait in quarantine when its certificate no longer holds on the day they come. */
export function receiptHoldWords(check: LineCertificateCheck, certificate: NamedCertificate | null, itemCode: string): string | null {
  if (check.state === 'HOLDS') return null
  return `${certificateWords(check, certificate, itemCode)} The order named it for these protectors: check them against a certificate that holds before they are released.`
}
