import { businessDate, type BusinessDate } from '../../core/time'
import { isFinalTracking, type TrackingStatus } from '../labels/tracking'
import { isTestLabel } from '../test-mode/rules'

/**
 * Tracking problems (B-W2b-398; LOG-063 "Tracking exception alerts"; design warehouse.shipments "Tracking": "no event for
 * 3 days: a warning line (W2b task)"; plan rule 1: deliveries are checked every day), pure. apps/factory-api's
 * modules/shipping/exceptions raises one TrackingException (factory-db customs.prisma) per shipment and kind, each with
 * the Task a person works it in, and resolves it once.
 *
 *   DELAYED           the carrier says a delay (Sendcloud "Delivery delayed", "Not sorted", an unknown problem), or the day
 *                     the carrier expected passed and the goods still travel
 *   ADDRESS_PROBLEM   the carrier cannot deliver to the address as given
 *   FAILED_DELIVERY   the carrier tried and failed: nobody there, refused, unable to deliver
 *   NO_SCAN           no news from the carrier for NO_SCAN_DAYS days while the goods travel
 *
 * Only a shipment that travels (SHIPPED) with carrier labels is checked: a TEST label (B-W2b-390, provider id `test:`)
 * was never sent to a carrier, so it has no news to miss and raises nothing; our own van and a carrier booked by hand
 * have no carrier tracking either. One open problem per shipment and kind (the database's TrackingException_one_open);
 * a resolved one may be raised again.
 */

export const TRACKING_EXCEPTION_KINDS = ['DELAYED', 'ADDRESS_PROBLEM', 'FAILED_DELIVERY', 'NO_SCAN'] as const
export type TrackingExceptionKind = (typeof TRACKING_EXCEPTION_KINDS)[number]

/** The design's warning line: no carrier event for this many days. */
export const NO_SCAN_DAYS = 3
const DAY_MS = 86_400_000

/** Sendcloud's webhook status ids (factory-domain labels/tracking SENDCLOUD_STATUS_IDS) that name the problem. */
const STATUS_ID_KINDS: Readonly<Record<string, TrackingExceptionKind>> = Object.freeze({
  '4': 'DELAYED', // Delivery delayed
  '6': 'DELAYED', // Not sorted
  '8': 'FAILED_DELIVERY', // Delivery attempt failed
  '15': 'DELAYED', // Error collecting
  '80': 'FAILED_DELIVERY', // Unable to deliver
  '1002': 'DELAYED', // Announcement failed
  '62989': 'DELAYED', // Exception
  '62992': 'FAILED_DELIVERY', // Refused by recipient
})

/**
 * The kind of a carrier's EXCEPTION event, from its code (a webhook's Sendcloud status id, or a poll's v3 phase or
 * `exception:<name>`), else its words; anything not named is a delay (the goods are late either way).
 */
export function exceptionKindOf(carrierStatusCode: string | null, description: string | null): Exclude<TrackingExceptionKind, 'NO_SCAN'> {
  const code = (carrierStatusCode ?? '').trim().toLowerCase()
  if (Object.hasOwn(STATUS_ID_KINDS, code)) return STATUS_ID_KINDS[code] as Exclude<TrackingExceptionKind, 'NO_SCAN'>
  const words = `${code} ${(description ?? '').toLowerCase()}`
  if (/address/.test(words)) return 'ADDRESS_PROBLEM'
  if (/attempt|fail|refus|unable|not_home|not home|absent|undeliver/.test(words)) return 'FAILED_DELIVERY'
  return 'DELAYED'
}

/** A parcel as the check reads it. */
export interface CheckedParcel {
  readonly id: string
  /** Its carrier's id of the label (`test:` marks a TEST label). */
  readonly carrierParcelId: string | null
  readonly trackingNumber: string | null
  readonly labelledAt: Date | null
}

/** A parcel's newest carrier news. */
export interface ParcelNews {
  readonly status: TrackingStatus
  readonly occurredAt: Date
  readonly carrierStatusCode: string | null
  readonly description: string | null
}

export interface ExceptionFacts {
  readonly status: string
  readonly shippedAt: Date | null
  /** The carrier's expected delivery (B-W2b-F14), when it said one. */
  readonly expectedDeliveryAt: Date | null
  readonly parcels: readonly CheckedParcel[]
  /** Each parcel's newest news, by parcel id. */
  readonly latest: ReadonlyMap<string, ParcelNews>
  /** The kinds open now. */
  readonly open: readonly TrackingExceptionKind[]
}

/** A problem to raise: its kind and when it happened (the carrier's time, or now for what the check found). */
export interface ExceptionDue {
  readonly kind: TrackingExceptionKind
  readonly raisedAt: Date
}

/** The parcels the carrier tracks: labelled with a real (not TEST) label. */
export function carrierTracked(parcels: readonly CheckedParcel[]): CheckedParcel[] {
  return parcels.filter((parcel) => parcel.trackingNumber !== null && parcel.carrierParcelId !== null && !isTestLabel(parcel.carrierParcelId))
}

/** Whether any parcel of the shipment carries a TEST label (nothing about it is ever sent to a customer). */
export const hasTestLabel = (parcels: readonly Pick<CheckedParcel, 'carrierParcelId' | 'trackingNumber'>[]): boolean =>
  parcels.some((parcel) => isTestLabel(parcel.carrierParcelId) || (parcel.trackingNumber ?? '').startsWith('TEST-'))

/**
 * The problems to raise now, one per kind, never one already open: each tracked parcel's newest news an EXCEPTION (its
 * kind, at the carrier's time); no news for NO_SCAN_DAYS days (its newest news, else its label, else when it left);
 * the carrier's expected day passed (Rome's day before `today`). Only while SHIPPED, only carrier-tracked parcels, never
 * a shipment with a TEST label.
 */
export function exceptionsDue(facts: ExceptionFacts, now: Date, today: BusinessDate = businessDate(now)): ExceptionDue[] {
  if (facts.status !== 'SHIPPED' || hasTestLabel(facts.parcels)) return []
  const tracked = carrierTracked(facts.parcels)
  if (tracked.length === 0) return []
  const due = new Map<TrackingExceptionKind, Date>()
  const add = (kind: TrackingExceptionKind, at: Date) => {
    if (facts.open.includes(kind)) return
    const when = at.getTime() > now.getTime() ? now : at
    const known = due.get(kind)
    if (!known || when.getTime() < known.getTime()) due.set(kind, when)
  }
  for (const parcel of tracked) {
    const news = facts.latest.get(parcel.id) ?? null
    if (news && isFinalTracking(news.status)) continue
    if (news?.status === 'EXCEPTION') add(exceptionKindOf(news.carrierStatusCode, news.description), news.occurredAt)
    const since = news?.occurredAt ?? parcel.labelledAt ?? facts.shippedAt
    if (since && now.getTime() - since.getTime() >= NO_SCAN_DAYS * DAY_MS) add('NO_SCAN', now)
  }
  const travelling = tracked.some((parcel) => {
    const news = facts.latest.get(parcel.id)
    return !news || !isFinalTracking(news.status)
  })
  if (travelling && facts.expectedDeliveryAt && businessDate(facts.expectedDeliveryAt) < today) add('DELAYED', now)
  return TRACKING_EXCEPTION_KINDS.flatMap((kind) => (due.has(kind) ? [{ kind, raisedAt: due.get(kind)! }] : []))
}

/** The words of each kind, for the task a person works it in (stored text, in the company's language). */
export const EXCEPTION_WORDS: Readonly<Record<'en' | 'it', Readonly<Record<TrackingExceptionKind, string>>>> = Object.freeze({
  en: { DELAYED: 'Delayed', ADDRESS_PROBLEM: 'Address problem', FAILED_DELIVERY: 'Failed delivery', NO_SCAN: `No carrier news for ${NO_SCAN_DAYS} days` },
  it: { DELAYED: 'In ritardo', ADDRESS_PROBLEM: 'Problema di indirizzo', FAILED_DELIVERY: 'Consegna non riuscita', NO_SCAN: `Nessuna notizia dal vettore da ${NO_SCAN_DAYS} giorni` },
})

const TASK_WORDS = {
  en: {
    title: (shipment: string, kind: string) => `Tracking problem on ${shipment}: ${kind}`,
    body: 'Check the carrier\'s tracking, call the carrier or the customer, then resolve the problem on the shipment (Tracking & delivery).',
  },
  it: {
    title: (shipment: string, kind: string) => `Problema di tracciamento su ${shipment}: ${kind}`,
    body: 'Controlla il tracciamento del vettore, chiama il vettore o il cliente, poi risolvi il problema sulla spedizione (Tracciamento e consegna).',
  },
} as const

/** The task's title (at most 200 characters) and description, in the company's language. */
export function exceptionTaskOf(shipmentNumber: string, kind: TrackingExceptionKind, locale: string | null): { readonly title: string; readonly description: string } {
  const language = locale?.toLowerCase().startsWith('it') ? 'it' : 'en'
  return { title: TASK_WORDS[language].title(shipmentNumber, EXCEPTION_WORDS[language][kind]).slice(0, 200), description: TASK_WORDS[language].body }
}

/** Why a problem cannot be resolved now (409 `refusal/<CODE>`). */
export const EXCEPTION_REFUSALS = ['RESOLVED'] as const
export type ExceptionRefusal = (typeof EXCEPTION_REFUSALS)[number]
export const exceptionRefusalPath = (code: ExceptionRefusal): string => `refusal/${code}`
