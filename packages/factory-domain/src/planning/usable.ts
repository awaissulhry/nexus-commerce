import type { LotQualityStatus } from '../inventory/stock/overview'

/**
 * Which stock the plan may use (PLN-065; REACH Annex XVII entry 47; A1 §2.5 "Lot"), pure. Only a RELEASED lot is usable
 * stock, and a lot that needs the chromium VI test only with a PASS (the …_supply_guards trigger already refuses a
 * RELEASED lot without one; the rule is checked here too, so the plan never leans on that alone). Stock of an item that
 * is not traced by lot has no lot and is usable. Everything else is on hand but NOT counted, each with its reason, so
 * "short although stock exists" is never a mystery (design 02 "What to buy & make", Notices and the Why drawer):
 *
 *   CR_VI_PENDING   in quarantine, its chromium VI result not in yet
 *   CR_VI_FAILED    its chromium VI result is a FAIL (at or above the limit)
 *   QUALITY_HOLD    in quarantine for another reason (the incoming check)
 *   BLOCKED         held after a release (a later finding, a recall)
 *   REJECTED        rejected: going back to the supplier or to scrap
 *
 * `held` is the stock MaterialRequirement.heldStock sums: QUARANTINE and BLOCKED lots (they may still become usable);
 * a REJECTED lot never will, so it is listed, not held. Stock of the same material in ANOTHER colour is not a lot's
 * reason: the line explanation lists it as OTHER_COLOUR. Customer-owned stock and a shade asked by the order have no
 * column yet (not W1): nothing here can name them.
 */

export const CR_VI_STATUSES = ['NOT_REQUIRED', 'PENDING', 'PASS', 'FAIL'] as const
export type CrViStatus = (typeof CR_VI_STATUSES)[number]

export const UNUSABLE_REASONS = ['CR_VI_PENDING', 'CR_VI_FAILED', 'QUALITY_HOLD', 'BLOCKED', 'REJECTED'] as const
export type UnusableReason = (typeof UNUSABLE_REASONS)[number]

/** Why stock is not counted for a line: a lot's reason, or another colour of the material. */
export const NOT_COUNTED_REASONS = [...UNUSABLE_REASONS, 'OTHER_COLOUR'] as const
export type NotCountedReason = (typeof NOT_COUNTED_REASONS)[number]

/** What the rule reads of a lot. */
export interface LotQuality {
  readonly qualityStatus: LotQualityStatus
  readonly requiresCrViTest: boolean
  readonly crViStatus: CrViStatus
}

export type Usability = { readonly usable: true } | { readonly usable: false; readonly reason: UnusableReason; readonly held: boolean }

const USABLE: Usability = Object.freeze({ usable: true })

/** Whether a lot's stock is usable, and if not, why (no lot: usable). */
export function usabilityOf(lot: LotQuality | null | undefined): Usability {
  if (!lot) return USABLE
  const crVi: UnusableReason | null = lot.requiresCrViTest && lot.crViStatus !== 'PASS' ? (lot.crViStatus === 'FAIL' ? 'CR_VI_FAILED' : 'CR_VI_PENDING') : null
  switch (lot.qualityStatus) {
    case 'RELEASED':
      return crVi ? { usable: false, reason: crVi, held: true } : USABLE
    case 'QUARANTINE':
      return { usable: false, reason: crVi ?? 'QUALITY_HOLD', held: true }
    case 'BLOCKED':
      return { usable: false, reason: crVi === 'CR_VI_FAILED' ? 'CR_VI_FAILED' : 'BLOCKED', held: true }
    default:
      return { usable: false, reason: 'REJECTED', held: false }
  }
}

/** The reason in plain words, for the Why drawer and the notices. */
export const NOT_COUNTED_WORDS: Readonly<Record<NotCountedReason, string>> = Object.freeze({
  CR_VI_PENDING: 'no chromium VI test result yet',
  CR_VI_FAILED: 'failed the chromium VI test',
  QUALITY_HOLD: 'on quality hold',
  BLOCKED: 'blocked after release',
  REJECTED: 'rejected',
  OTHER_COLOUR: 'another colour than the orders need',
})
