import type { Issue } from '../../core/errors'
import { PURPOSE_RULES } from '../../links/purposes'
import type { TrackingStatus } from '../labels/tracking'
import type { ShipmentStatus } from '../shipments'

/**
 * Track an order (B-W2b-170; LOG-062 "Branded tracking page": a public tracking page comes with the portal; the carrier's
 * page is neither branded nor in the customer's language; design links.tracking, SCR-194). Pure rules for a
 * SHIPMENT_TRACK link of a Shipment (links/purposes: open only, never counted; no money grain) and for the public search
 * by the customer's order reference and the delivery postcode.
 *
 *   made       when the goods leave (the worker mails the party's ORDERS contacts once per address), by the office (mailed
 *              to a contact, or a link to pass on: its address once), from the portal ("Copy tracking link"), by the public
 *              search (a link for this visit only), or asked for again on a dead link (to the address it went to)
 *   lives      a link for a customer is made for the purpose's longest life (180 days); the page ends 60 days after the
 *              goods arrived (or came back): the design's "expiry 60 days after delivery" without moving W0's fixed expiry
 *   page       where it is (Packed · Collected · In transit · Out for delivery · Delivered, the furthest step reached is
 *              "now"), a pill (or Problem: delayed by the carrier, going back, back with us), the expected delivery while
 *              packed or on the way, the carrier and the parcels' numbers, the carrier's events as CODES (the page says them
 *              in the reader's language; the carrier's own text is never passed on: it may name the person who signed),
 *              the delivery town and postcode only, the papers (packing list, Declaration of Conformity, user information;
 *              never a price), "Something wrong?" to a claim link
 *   search     the order reference (theirs, or our order number) + the delivery postcode, both normalised; one answer for
 *              a miss whatever was wrong; a hit makes a one-day link per shipment found. A link found that way never shows
 *              the papers nor opens a claim (the search is weaker than a mailed link): it says to use our e-mail.
 */

export const TRACKING_LINK = Object.freeze({
  /** The page answers until this many days after the goods arrived or came back. */
  daysAfterDelivery: 60,
  /** A link made for a customer: the purpose's longest life (the page ends it earlier, above). */
  expiryDays: PURPOSE_RULES.SHIPMENT_TRACK.expiryDays.max,
  /** A link found by the public search: this visit only. */
  searchExpiryDays: 1,
  /** Live links copied in the portal per shipment, at most. */
  portalLinksPerShipment: 10,
  /** Asked for again within this time: no new link (no mail bombing). */
  renewCoalesceMs: 10 * 60_000,
  /** The public search answers no sooner (a hit and a miss take the same time). */
  searchAnswerFloorMs: 600,
  /** Shipments one search answers, at most (newest first). */
  searchMaxShipments: 5,
})

const DAY_MS = 24 * 60 * 60 * 1000

/** How a tracking link came to be (its audit row's `via`). */
export const TRACKING_VIAS = ['SHIPPED', 'OFFICE', 'PORTAL', 'SEARCH', 'RENEWED'] as const
export type TrackingVia = (typeof TRACKING_VIAS)[number]

/**
 * The link's note says how it came to be, in fixed words (the office reads it among the links; the page reads it back as
 * `via`: a link found by the search shows no papers). A link of another purpose, or a note of anything else: null.
 */
export const TRACKING_NOTES: Readonly<Record<TrackingVia, string>> = Object.freeze({
  SHIPPED: 'Tracking page: sent when the goods left.',
  OFFICE: 'Tracking page: made by the office.',
  PORTAL: 'Tracking page: copied in the portal.',
  SEARCH: 'Tracking page: found by the public search.',
  RENEWED: 'Tracking page: asked for again.',
})

export const viaOfNote = (note: string | null | undefined): TrackingVia | null => TRACKING_VIAS.find((via) => TRACKING_NOTES[via] === note) ?? null

/** The shipments a tracking page shows: packed, on the way, delivered or back with us. */
export const TRACKABLE_STATUSES: readonly ShipmentStatus[] = Object.freeze(['PACKED', 'SHIPPED', 'DELIVERED', 'RETURNED'])
export const isTrackable = (status: ShipmentStatus): boolean => TRACKABLE_STATUSES.includes(status)

export interface EndFacts {
  readonly deliveredAt: Date | null
  readonly returnedAt: Date | null
}

/** When the page stops answering: the link's own expiry, or 60 days after the goods arrived or came back, the earlier. */
export function trackingEndsAt(expiresAt: Date, shipment: EndFacts): Date {
  const ended = shipment.deliveredAt ?? shipment.returnedAt
  if (!ended) return expiresAt
  const after = new Date(ended.getTime() + TRACKING_LINK.daysAfterDelivery * DAY_MS)
  return after < expiresAt ? after : expiresAt
}

/** The page answers: the shipment is one it shows, and the end above has not passed. */
export function trackingOpen(shipment: EndFacts & { readonly status: ShipmentStatus }, expiresAt: Date, now: Date): boolean {
  return isTrackable(shipment.status) && trackingEndsAt(expiresAt, shipment).getTime() > now.getTime()
}

/** Why no tracking link can be made for a shipment now (null: one can). */
export const MAKE_HELD = ['NOT_PACKED', 'CANCELLED', 'RETURNED', 'ENDED'] as const
export type MakeHeld = (typeof MAKE_HELD)[number]

export function makeHeld(shipment: EndFacts & { readonly status: ShipmentStatus }, now: Date): MakeHeld | null {
  if (shipment.status === 'DRAFT') return 'NOT_PACKED'
  if (shipment.status === 'CANCELLED') return 'CANCELLED'
  if (shipment.status === 'RETURNED') return 'RETURNED'
  if (shipment.deliveredAt && shipment.deliveredAt.getTime() + TRACKING_LINK.daysAfterDelivery * DAY_MS <= now.getTime()) return 'ENDED'
  return null
}

export const MAKE_HELD_WORDS: Readonly<Record<MakeHeld, string>> = Object.freeze({
  NOT_PACKED: 'The shipment is not packed yet: a tracking link is made once it is packed.',
  CANCELLED: 'The shipment was cancelled: there is nothing to track.',
  RETURNED: 'The goods came back to us: no new tracking link is made.',
  ENDED: 'The goods arrived more than 60 days ago: the tracking page has ended.',
})

// ---- where it is ------------------------------------------------------------------------------------------------------

export const TRACKING_STEPS = ['PACKED', 'COLLECTED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'] as const
export type TrackingStep = (typeof TRACKING_STEPS)[number]

export const TRACKING_PILLS = ['PACKED', 'COLLECTED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'PROBLEM'] as const
export type TrackingPill = (typeof TRACKING_PILLS)[number]

/** What went wrong, when the pill says Problem: the carrier reports a delay or a failed attempt; going back; back with us. */
export const TRACKING_PROBLEMS = ['DELAYED', 'RETURNING', 'RETURNED'] as const
export type TrackingProblem = (typeof TRACKING_PROBLEMS)[number]

export const STEP_STATES = ['DONE', 'CURRENT', 'TODO'] as const
export type StepState = (typeof STEP_STATES)[number]

export interface TrackerFacts {
  readonly status: ShipmentStatus
  readonly packedAt: Date | null
  readonly shippedAt: Date | null
  readonly deliveredAt: Date | null
  readonly returnedAt: Date | null
  /** Every carrier event of the shipment, any order. */
  readonly events: readonly { readonly status: TrackingStatus; readonly occurredAt: Date; readonly parcelId: string | null }[]
}

export interface StepView {
  readonly code: TrackingStep
  readonly state: StepState
  /** When it was reached, when known (a step passed without its own scan has none). */
  readonly at: Date | null
}

export interface Tracker {
  readonly pill: TrackingPill
  readonly problem: TrackingProblem | null
  readonly steps: readonly StepView[]
}

const left = (status: ShipmentStatus): boolean => status === 'SHIPPED' || status === 'DELIVERED' || status === 'RETURNED'

/** The first time one of these statuses was reported, or null. */
function firstOf(events: TrackerFacts['events'], statuses: readonly TrackingStatus[]): Date | null {
  let first: Date | null = null
  for (const event of events) if (statuses.includes(event.status) && (first === null || event.occurredAt < first)) first = event.occurredAt
  return first
}

/** The latest status of each parcel (an event of the whole shipment counts for every parcel). */
export function latestByParcel(events: TrackerFacts['events']): TrackingStatus[] {
  const latest = new Map<string, { status: TrackingStatus; at: number }>()
  for (const event of events) {
    const key = event.parcelId ?? '*'
    const at = event.occurredAt.getTime()
    const known = latest.get(key)
    if (!known || at >= known.at) latest.set(key, { status: event.status, at })
  }
  return [...latest.values()].map((entry) => entry.status)
}

/** Packed · Collected · In transit · Out for delivery · Delivered, the pill and the problem (see the file's comment). */
export function trackerOf(facts: TrackerFacts): Tracker {
  const out = left(facts.status)
  const delivered = facts.status === 'DELIVERED'
  const onTheWay = firstOf(facts.events, ['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'])
  const outForDelivery = firstOf(facts.events, ['OUT_FOR_DELIVERY'])
  const deliveredScan = firstOf(facts.events, ['OUT_FOR_DELIVERY', 'DELIVERED'])
  const reached: Readonly<Record<TrackingStep, { done: boolean; at: Date | null }>> = {
    PACKED: { done: facts.packedAt !== null || out || facts.status === 'PACKED', at: facts.packedAt },
    COLLECTED: { done: out, at: out ? facts.shippedAt : null },
    IN_TRANSIT: { done: delivered || (out && onTheWay !== null), at: onTheWay },
    OUT_FOR_DELIVERY: { done: delivered || (out && deliveredScan !== null && facts.status !== 'RETURNED'), at: outForDelivery },
    DELIVERED: { done: delivered, at: delivered ? facts.deliveredAt : null },
  }
  let furthest = -1
  TRACKING_STEPS.forEach((step, index) => {
    if (reached[step].done) furthest = index
  })
  const steps = TRACKING_STEPS.map((code, index): StepView => ({
    code,
    state: index < furthest ? 'DONE' : index === furthest ? (code === 'DELIVERED' ? 'DONE' : 'CURRENT') : 'TODO',
    at: reached[code].done ? reached[code].at : null,
  }))
  const latest = latestByParcel(facts.events)
  const problem: TrackingProblem | null =
    facts.status === 'RETURNED' ? 'RETURNED' : facts.status === 'SHIPPED' && latest.includes('RETURNED') ? 'RETURNING' : facts.status === 'SHIPPED' && latest.includes('EXCEPTION') ? 'DELAYED' : null
  const pill: TrackingPill = problem ? 'PROBLEM' : furthest < 0 ? 'PACKED' : TRACKING_STEPS[furthest]!
  return { pill, problem, steps }
}

/** The carrier's expected delivery the page shows: while the goods are packed or on the way only. */
export const expectedDeliveryOf = (status: ShipmentStatus, expectedDeliveryAt: Date | null): Date | null => (status === 'PACKED' || status === 'SHIPPED' ? expectedDeliveryAt : null)

// ---- where it goes, without the full address ------------------------------------------------------------------------

export interface DeliveryPlace {
  readonly city: string | null
  readonly postcode: string | null
  readonly country: string | null
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

/** The town, postcode and country of the shipment's delivery address: never a name, a street, a phone. */
export function deliveryPlaceOf(shipTo: unknown): DeliveryPlace {
  const value = shipTo && typeof shipTo === 'object' ? (shipTo as Record<string, unknown>) : {}
  const country = text(value.country)
  return { city: text(value.city), postcode: text(value.postalCode), country: country ? country.toUpperCase() : null }
}

// ---- papers and the claim ---------------------------------------------------------------------------------------------

/** What the page lists as papers: the packing list and, per style, the Declaration of Conformity and the user information. */
export const PAPER_KINDS = ['PACKING_LIST', 'DECLARATION_OF_CONFORMITY', 'USER_INFORMATION'] as const
export type PaperKind = (typeof PAPER_KINDS)[number]

/** A link found by the public search shows no papers (the packing list carries the full address): our e-mail's link does. */
export const papersShown = (via: TrackingVia | null): boolean => via !== 'SEARCH'

/** Why "Report a problem with this delivery" is held (null: it opens a claim link). */
export const CLAIM_HELD = ['SEARCH', 'NOT_LEFT', 'RETURNED'] as const
export type ClaimHeld = (typeof CLAIM_HELD)[number]

export function claimHeld(status: ShipmentStatus, via: TrackingVia | null): ClaimHeld | null {
  if (via === 'SEARCH') return 'SEARCH'
  if (status === 'PACKED') return 'NOT_LEFT'
  if (status === 'RETURNED') return 'RETURNED'
  return null
}

// ---- the public search ------------------------------------------------------------------------------------------------

export const SEARCH_LIMITS = Object.freeze({ reference: 60, postcode: 16 })

/** The reference as typed, trimmed, inner spaces as one (compared without case). */
export const normalReference = (value: string): string => value.trim().replace(/\s+/g, ' ')
/** The postcode without spaces and dashes, upper case ("40 100" = "40100", "sw1a 1aa" = "SW1A1AA"). */
export const normalPostcode = (value: string): string => value.toUpperCase().replace(/[\s-]+/g, '')

/** What is wrong with a search before anything is looked up, per field. */
export function searchProblems(input: { readonly reference: string; readonly postcode: string }): Issue[] {
  const issues: Issue[] = []
  const reference = normalReference(input.reference)
  const postcode = normalPostcode(input.postcode)
  if (reference === '') issues.push({ path: 'body/reference', message: 'Type your order reference.' })
  else if (reference.length > SEARCH_LIMITS.reference) issues.push({ path: 'body/reference', message: `An order reference has at most ${SEARCH_LIMITS.reference} characters.` })
  if (postcode === '') issues.push({ path: 'body/postcode', message: 'Type the delivery postcode.' })
  else if (postcode.length > SEARCH_LIMITS.postcode || !/^[A-Z0-9]+$/.test(postcode)) issues.push({ path: 'body/postcode', message: 'Type the postcode as it is on the delivery address.' })
  return issues
}

/** The shipment goes to the typed postcode (both normalised). */
export const postcodeMatches = (shipTo: unknown, typed: string): boolean => {
  const place = deliveryPlaceOf(shipTo)
  return place.postcode !== null && normalPostcode(place.postcode) === normalPostcode(typed) && normalPostcode(typed) !== ''
}

/** The one answer of a search that found nothing, whatever was wrong. */
export const SEARCH_MISS = 'No shipment found for these details.'
