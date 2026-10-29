import type { ShipmentStatus } from '../shipments'

/**
 * Tracking (B-W1-48; LOG-025, LOG-059; PLAN §4.7 stage 14-ship "tracking delivered"): the carrier's statuses mapped to
 * the factory's one list, which events are news, and the shipment moves they cause. Pure rules; apps/factory-api's
 * modules/shipping/labels records them (TrackingEvent rows, append-only) from Sendcloud's webhooks (the inbound ledger)
 * and from a poll of parcels with no news.
 *
 *   status   LABEL_CREATED → IN_TRANSIT → OUT_FOR_DELIVERY → DELIVERED; EXCEPTION (a delay, an address problem, a failed
 *            attempt); RETURNED (going or gone back to the sender)
 *   moves    a SHIPPED shipment becomes DELIVERED when the latest status of every tracked parcel is DELIVERED, RETURNED
 *            when every one is RETURNED; partly delivered, partly returned stays SHIPPED (a person sorts it out). A
 *            shipment not handed over yet (PACKED) never moves on tracking: the events are kept, the move waits.
 *   news     an event is recorded once: its id (one row per shipment and id, the database's key too), and the same
 *            status of the same parcel from the other source (a webhook and a poll) within a few hours is the same event
 */

export const TRACKING_STATUSES = ['LABEL_CREATED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'EXCEPTION', 'RETURNED'] as const
export type TrackingStatus = (typeof TRACKING_STATUSES)[number]
export const TRACKING_SOURCES = ['WEBHOOK', 'POLL', 'MANUAL'] as const
export type TrackingSource = (typeof TRACKING_SOURCES)[number]

/** The statuses after which a parcel needs no more polling. */
export const FINAL_TRACKING: readonly TrackingStatus[] = Object.freeze(['DELIVERED', 'RETURNED'])
export const isFinalTracking = (status: TrackingStatus): boolean => FINAL_TRACKING.includes(status)

// ---- Sendcloud's statuses -------------------------------------------------------------------------------------------

/**
 * Sendcloud's parcel status ids (the webhook's `parcel.status.id`; its list: GET /parcels/statuses), as the factory
 * reads them. Ids missing here are read from their message (below). `null`: not a tracking fact (no label yet, or the
 * label's own cancellation, which the void flow handles): the webhook is processed and nothing is recorded.
 * To check against the live account's list when it exists (Owner Q20).
 */
export const SENDCLOUD_STATUS_IDS: Readonly<Record<number, TrackingStatus | null>> = Object.freeze({
  1: 'LABEL_CREATED', // Announced
  3: 'IN_TRANSIT', // En route to sorting center
  4: 'EXCEPTION', // Delivery delayed
  5: 'IN_TRANSIT', // Sorted
  6: 'EXCEPTION', // Not sorted
  7: 'IN_TRANSIT', // Being sorted
  8: 'EXCEPTION', // Delivery attempt failed
  11: 'DELIVERED', // Delivered
  12: 'IN_TRANSIT', // Awaiting customer pickup
  13: 'LABEL_CREATED', // Announced: not collected
  15: 'EXCEPTION', // Error collecting
  22: 'IN_TRANSIT', // Shipment picked up by driver
  80: 'EXCEPTION', // Unable to deliver
  91: 'IN_TRANSIT', // Parcel en route
  92: 'OUT_FOR_DELIVERY', // Driver en route
  93: 'DELIVERED', // Shipment collected by customer
  999: null, // No label
  1000: 'LABEL_CREATED', // Ready to send
  1001: 'LABEL_CREATED', // Being announced
  1002: 'EXCEPTION', // Announcement failed
  1999: null, // Cancellation requested
  2000: null, // Cancelled
  2001: null, // Submitting cancellation request
  62989: 'EXCEPTION', // Exception
  62990: 'IN_TRANSIT', // At customs
  62991: 'IN_TRANSIT', // At sorting centre
  62992: 'EXCEPTION', // Refused by recipient
  62993: 'RETURNED', // Returned to sender
  62994: 'IN_TRANSIT', // Delivery method changed
  62995: 'IN_TRANSIT', // Delivery date changed
  62996: 'IN_TRANSIT', // Delivery address changed
})

/** A status by its message, for an id the table does not know (Sendcloud adds statuses). */
function byMessage(message: string): TrackingStatus | null {
  const words = message.toLowerCase()
  if (/cancel|no label/.test(words)) return null
  if (/return/.test(words)) return 'RETURNED'
  if (/delivered|collected by customer/.test(words)) return 'DELIVERED'
  if (/driver en route|out for delivery/.test(words)) return 'OUT_FOR_DELIVERY'
  if (/announc|ready to send/.test(words)) return 'LABEL_CREATED'
  if (/fail|delay|error|exception|refused|unable|not sorted|damaged|missing|unknown/.test(words)) return 'EXCEPTION'
  return 'IN_TRANSIT'
}

/** The factory's status of a Sendcloud webhook status (id, message); null: nothing to record. */
export function statusOfSendcloudId(id: number, message: string | null): TrackingStatus | null {
  if (Object.hasOwn(SENDCLOUD_STATUS_IDS, id)) return SENDCLOUD_STATUS_IDS[id]!
  return byMessage(message ?? 'unknown')
}

/** Sendcloud v3 tracking phases (GET /parcels/tracking/{tracking number}: `phase`). */
const PHASES: Readonly<Record<string, TrackingStatus | null>> = Object.freeze({
  no_label: null,
  announcing: 'LABEL_CREATED',
  announced: 'LABEL_CREATED',
  ready_to_send: 'LABEL_CREATED',
  labelled: 'LABEL_CREATED',
  dropped: 'IN_TRANSIT',
  accepted: 'IN_TRANSIT',
  sorted: 'IN_TRANSIT',
  in_transit: 'IN_TRANSIT',
  customs: 'IN_TRANSIT',
  in_delivery: 'OUT_FOR_DELIVERY',
  attempted: 'EXCEPTION',
  pup: 'IN_TRANSIT',
  delivered: 'DELIVERED',
  delivery_forced: 'DELIVERED',
  unknown: 'EXCEPTION',
})

/** Sendcloud v3 exceptions (`exception` when `phase` is `none`). */
const EXCEPTIONS_IGNORED = new Set(['cancelled', 'cancelled_upstream', 'cancelling', 'cancelling_upstream', 'cancellation_failed', 'claim', 'claimable'])
const EXCEPTIONS_RETURNED = new Set(['returned_sender'])
const EXCEPTIONS_TRANSIT = new Set(['changed', 'relabelled'])

/**
 * The factory's status of a Sendcloud v3 tracking event (the code the adapter reports: the phase, or `exception:<name>`
 * when the phase is `none`); null: nothing to record (a label's own cancellation, a claim).
 */
export function statusOfSendcloudCode(code: string): TrackingStatus | null {
  if (code.startsWith('exception:')) {
    const exception = code.slice('exception:'.length)
    if (EXCEPTIONS_IGNORED.has(exception)) return null
    if (EXCEPTIONS_RETURNED.has(exception)) return 'RETURNED'
    if (EXCEPTIONS_TRANSIT.has(exception)) return 'IN_TRANSIT'
    return 'EXCEPTION'
  }
  return Object.hasOwn(PHASES, code) ? PHASES[code]! : 'EXCEPTION'
}

// ---- news -----------------------------------------------------------------------------------------------------------

/** How far apart a webhook and a poll may report one carrier event and still be the same event. */
export const SAME_EVENT_WINDOW_MS = 6 * 60 * 60_000

/** An event as recorded or arriving. */
export interface TrackingFact {
  readonly parcelId: string | null
  readonly status: TrackingStatus
  readonly source: TrackingSource
  readonly occurredAt: Date
  readonly externalEventId: string | null
}

/**
 * Whether `incoming` is news for the shipment's recorded events: `duplicate` when its id is recorded already, or the
 * other source reported the same status of the same parcel within SAME_EVENT_WINDOW_MS; else `record`.
 */
export function trackingNews(recorded: readonly TrackingFact[], incoming: TrackingFact): 'record' | 'duplicate' {
  for (const event of recorded) {
    if (incoming.externalEventId !== null && event.externalEventId === incoming.externalEventId) return 'duplicate'
    if (
      event.parcelId === incoming.parcelId &&
      event.status === incoming.status &&
      event.source !== incoming.source &&
      event.source !== 'MANUAL' &&
      Math.abs(event.occurredAt.getTime() - incoming.occurredAt.getTime()) <= SAME_EVENT_WINDOW_MS
    ) {
      return 'duplicate'
    }
  }
  return 'record'
}

/** The latest event of each parcel (by when it happened, then by when it was recorded). */
export function latestByParcel<Fact extends TrackingFact & { readonly recordedAt?: Date }>(events: readonly Fact[]): Map<string, Fact> {
  const latest = new Map<string, Fact>()
  for (const event of events) {
    if (event.parcelId === null) continue
    const current = latest.get(event.parcelId)
    const later =
      !current ||
      event.occurredAt.getTime() > current.occurredAt.getTime() ||
      (event.occurredAt.getTime() === current.occurredAt.getTime() && (event.recordedAt?.getTime() ?? 0) >= (current.recordedAt?.getTime() ?? 0))
    if (later) latest.set(event.parcelId, event)
  }
  return latest
}

// ---- the shipment's move ---------------------------------------------------------------------------------------------

/** What tracking does to the shipment now. */
export type TrackingMove =
  | { readonly kind: 'move'; readonly to: 'DELIVERED' | 'RETURNED' }
  | { readonly kind: 'none' }
  /** The parcels are all delivered or returned but the shipment is not handed over yet (still PACKED): it waits. */
  | { readonly kind: 'waits'; readonly problem: string }
  /** Partly delivered, partly returned: a person decides. */
  | { readonly kind: 'mixed'; readonly problem: string }

/**
 * The move tracking causes (`labelled`: the parcels with a carrier label; `latest`: their latest status). Only a
 * SHIPPED shipment moves (the guards: SHIPPED → DELIVERED | RETURNED; both final).
 */
export function trackingMoveOf(status: ShipmentStatus, labelled: readonly { readonly id: string; readonly seq: number }[], latest: ReadonlyMap<string, TrackingStatus>): TrackingMove {
  if (labelled.length === 0) return { kind: 'none' }
  const statuses = labelled.map((parcel) => latest.get(parcel.id) ?? null)
  const all = (wanted: TrackingStatus) => statuses.every((value) => value === wanted)
  const target = all('DELIVERED') ? 'DELIVERED' : all('RETURNED') ? 'RETURNED' : null
  if (target === null) {
    if (statuses.every((value) => value !== null && isFinalTracking(value))) {
      const returned = labelled.filter((parcel) => latest.get(parcel.id) === 'RETURNED').map((parcel) => parcel.seq)
      return { kind: 'mixed', problem: `Partly delivered, partly returned (parcel ${returned.join(', ')} returned): the shipment stays SHIPPED until a person sorts it out.` }
    }
    return { kind: 'none' }
  }
  if (status === 'SHIPPED') return { kind: 'move', to: target }
  if (status === 'PACKED') {
    return { kind: 'waits', problem: `The carrier reports every parcel ${target.toLowerCase()}, but the shipment was not marked handed over: mark it shipped, and tracking moves it.` }
  }
  return { kind: 'none' }
}

// ---- the poll --------------------------------------------------------------------------------------------------------

/** A parcel with no news for this long is polled (the webhooks may have been lost). */
export const POLL_AFTER_HOURS = 12
/** The most shipments one tenant has polled per tick. */
export const POLL_BATCH = 200

/**
 * Whether a labelled parcel is due for a poll on this (hourly) tick: not delivered or returned, and no news (its latest
 * event recorded, else its label) for a whole multiple of POLL_AFTER_HOURS: 12, 24, 36 … hours of silence. A poll that
 * finds nothing records nothing, so the next one is POLL_AFTER_HOURS later, with no state kept.
 */
export function pollDue(parcel: { readonly labelledAt: Date | null; readonly latest: { readonly status: TrackingStatus; readonly recordedAt: Date } | null }, now: Date): boolean {
  if (parcel.labelledAt === null) return false
  if (parcel.latest && isFinalTracking(parcel.latest.status)) return false
  const since = parcel.latest ? parcel.latest.recordedAt : parcel.labelledAt
  const hours = Math.floor((now.getTime() - since.getTime()) / (60 * 60_000))
  return hours >= POLL_AFTER_HOURS && hours % POLL_AFTER_HOURS === 0
}
