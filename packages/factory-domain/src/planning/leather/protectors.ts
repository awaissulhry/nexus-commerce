import type { BusinessDate } from '../../core/time'
import { Dec, type DecimalInput } from '../../tax/decimal'

/**
 * Certified protector planning (B-W2b-132; PLN-114; design planning.leather "Certified protectors"), pure. Armour is planned
 * only from the part numbers certified for the style: the protector the style's BOM names (W1: the BOM names the certified
 * part) with a valid EN 1621 certificate in the register (compliance certificateCovering: VALID, in date, an ACTIVE coverage
 * of the item). Another protector in stock is never a substitute: it is not certified for the style, the DoC would be wrong
 * (Reg. (EU) 2016/425 Annex III; the EU type-examination names the components). The state of one order line's protector:
 *
 *   NO_CERTIFICATE       no valid certificate covers the part today (counted by the tile "Protectors without a valid
 *                        certificate"; the garments could not be released as PPE);
 *   EXPIRES_BEFORE_DUE   the certificate lapses before the order is due;
 *   SHORT                the released lots at the site hold less than the order still needs;
 *   OK                   certified, in date for the order, enough in stock.
 */

export const PROTECTOR_STATES = ['NO_CERTIFICATE', 'EXPIRES_BEFORE_DUE', 'SHORT', 'OK'] as const
export type ProtectorState = (typeof PROTECTOR_STATES)[number]

export interface ProtectorFacts {
  readonly certificate: { readonly validTo: BusinessDate } | null
  readonly dueDate: BusinessDate | null
  /** What the order line still needs, in the part's base unit. */
  readonly needed: DecimalInput
  /** What released lots at the site hold, in the part's base unit. */
  readonly available: DecimalInput
}

export function protectorState(facts: ProtectorFacts): ProtectorState {
  if (!facts.certificate) return 'NO_CERTIFICATE'
  if (facts.dueDate !== null && facts.certificate.validTo < facts.dueDate) return 'EXPIRES_BEFORE_DUE'
  if (new Dec(facts.available.toString()).lt(facts.needed.toString())) return 'SHORT'
  return 'OK'
}

/** The tile counts it: no valid certificate today, or one that lapses before the order is due. */
export const withoutValidCertificate = (state: ProtectorState): boolean => state === 'NO_CERTIFICATE' || state === 'EXPIRES_BEFORE_DUE'

/** Why another protector is never used instead (held, in words; the screen says its own words for the same reason). */
export const substituteRefusal = (styleCode: string): string => `Not certified for style ${styleCode} — the DoC would be wrong.`
