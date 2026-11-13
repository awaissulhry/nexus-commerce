import type { DocumentUnits } from '../../../mtm/api'
import { MTM_PERMISSIONS, recordHref } from '../../../mtm/model'

/**
 * "Waits for the factory review" on the order record (B-W2b-368, XF1:02; design SCR-039; B-W2b-358's rule): an order made with a
 * made-to-measure unit whose measures the factory has not confirmed is made waiting (PENDING_APPROVAL) and goes on by itself at the
 * review's CONFIRM. The banner says so with the reason MEASUREMENTS (the order read's `waitsForReview`: GET
 * /sales/orders/:id/made-to-measure) and, per unit still waiting, a link to its review (the rider profile, `?do=review`); without
 * the right to see measurements the link is held with the reason. Pure: the container reads, this decides what is said.
 */

export const NAMESPACE = 'sales-mtm-followups'

/** A key of this catalogue and its values (the view translates it). */
export interface Phrase {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}
const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

/** One unit the order waits for. */
export interface WaitingUnit {
  readonly lineId: string
  readonly line: Phrase
  readonly review: Phrase
  /** The rider profile's review, or null when held. */
  readonly href: string | null
  readonly held: Phrase | null
  /** Made-to-measure stopped for its template since the order was made (GATE-MTM, said in words). */
  readonly off: Phrase | null
}

export type ReviewBannerModel =
  | { readonly state: 'loading' }
  | { readonly state: 'error'; readonly problem: Phrase }
  | { readonly state: 'ready'; readonly waits: false }
  | { readonly state: 'ready'; readonly waits: true; readonly units: readonly WaitingUnit[] }

/** Whether the record asks the order's units at all: it waits, and it has a made-to-measure unit. */
export function asksUnits(order: { readonly status: string; readonly lines: readonly { readonly kind: string }[] }): boolean {
  return order.status === 'PENDING_APPROVAL' && order.lines.some((line) => line.kind === 'MADE_TO_MEASURE')
}

/** The banner from the order read's answer: the units whose measures are not CONFIRMED, each with its review. */
export function reviewBannerOf(made: Pick<DocumentUnits, 'waitsForReview' | 'units'>, permissions: readonly string[], prefix: string): ReviewBannerModel {
  if (!made.waitsForReview) return { state: 'ready', waits: false }
  const mayOpen = permissions.includes(MTM_PERMISSIONS.view)
  const units = made.units
    .filter((unit) => unit.profile.review !== 'CONFIRMED')
    .map((unit): WaitingUnit => ({
      lineId: unit.lineId,
      line: phrase('banner.unit', { seq: unit.seq, style: unit.style.code, colourway: unit.colourway.code, rider: unit.profile.riderName }),
      review: phrase(`banner.review.${unit.profile.review}`, { garment: unit.profile.garmentType, revision: unit.profile.revision }),
      href: mayOpen ? recordHref(prefix, unit.profile.id, 'measurements', 'review') : null,
      held: mayOpen ? null : phrase('banner.held.right'),
      off: unit.findings.some((finding) => finding.code === 'MTM_NOT_STARTED') ? phrase('banner.off', { garment: unit.profile.garmentType }) : null,
    }))
  return { state: 'ready', waits: true, units }
}

/** A failed read in this catalogue's words. */
export function bannerProblem(kind: string | null): Phrase {
  return phrase(kind === 'forbidden' ? 'banner.problem.forbidden' : kind === 'unavailable' ? 'banner.problem.unavailable' : 'banner.problem.internal')
}
