import type { BusinessDate } from '../../core/time'
import type { Words } from '../../portal/tasks/kinds'

/**
 * Conformity per style received (B-W2b-178; SAL-087; design portal.customer.documents "Conformity per style you received"):
 * for each style the customer received, per shipment that left, the EU declaration of conformity and the user information
 * that travelled with it (the copies on the shipment: the style revision the work orders froze, B-W1-49) and the EU
 * type-examination certificate valid on the shipping date (the one the declaration cites, else one covering the style),
 * pure. Reg. (EU) 2016/425 art. 8(8) is met in W1 by the shipment's document link; the portal is the customer's library.
 */

/** A certificate as the customer is told of it: what the declaration cites (Annex IX 7), never the office's notes. */
export interface CertificateFacts {
  readonly id: string
  readonly number: string
  readonly standard: string
  readonly ppeClass: string | null
  readonly notifiedBodyName: string
  readonly notifiedBodyNumber: string
  readonly validFrom: BusinessDate
  readonly validTo: BusinessDate
  /** CertificateStatus. */
  readonly status: string
  /** The day its status last moved (a suspension or withdrawal after the shipping day leaves it valid on that day). */
  readonly statusChangedOn: BusinessDate | null
}

/**
 * Was the certificate valid on that day? A draft never; otherwise inside its dates, and a suspension or withdrawal counts
 * only from the day it happened (one after the shipping day leaves it valid then). An expired one by its dates.
 */
export function certificateValidOn(certificate: CertificateFacts, day: BusinessDate): boolean {
  if (certificate.status === 'DRAFT') return false
  if (day < certificate.validFrom || day > certificate.validTo) return false
  if (certificate.status === 'SUSPENDED' || certificate.status === 'WITHDRAWN') return certificate.statusChangedOn !== null && certificate.statusChangedOn > day
  return true
}

/**
 * The certificate to name for goods shipped on a day: the one the declaration cites when it was valid then; else the first
 * covering the style that was valid then; else the cited one (shown as not valid on that day); else none.
 */
export function certificateFor(cited: CertificateFacts | null, covering: readonly CertificateFacts[], day: BusinessDate): CertificateFacts | null {
  if (cited && certificateValidOn(cited, day)) return cited
  const valid = [...covering].sort((a, b) => b.validFrom.localeCompare(a.validFrom) || a.id.localeCompare(b.id)).find((certificate) => certificateValidOn(certificate, day))
  return valid ?? cited ?? null
}

export const RECEIVED_STATES = ['COMPLETE', 'INCOMPLETE', 'NOT_REQUIRED'] as const
export type ReceivedState = (typeof RECEIVED_STATES)[number]

export const RECEIVED_WORDS: Readonly<Record<ReceivedState, Words>> = Object.freeze({
  COMPLETE: { it: 'Dichiarazione e nota informativa condivise; certificato valido alla data di spedizione', en: 'Declaration and user information shared; certificate valid on the shipping date' },
  INCOMPLETE: { it: 'Manca un documento: chiedicelo', en: 'A document is missing: ask us for it' },
  NOT_REQUIRED: { it: 'Non è un DPI: nessuna dichiarazione richiesta', en: 'Not personal protective equipment: no declaration needed' },
})

/**
 * A shipment's row of a style: complete when the declaration and the leaflet that travelled are shared and, for category II
 * and III (a notified body's certificate), a certificate was valid on the shipping day; category I is self-certified.
 */
export function receivedStateOf(input: {
  readonly ppe: boolean
  readonly certificateRequired: boolean
  readonly declaration: boolean
  readonly userInformation: boolean
  readonly certificateValid: boolean
}): ReceivedState {
  if (!input.ppe) return 'NOT_REQUIRED'
  return input.declaration && input.userInformation && (!input.certificateRequired || input.certificateValid) ? 'COMPLETE' : 'INCOMPLETE'
}
