import { createHash } from 'node:crypto'
import type { Issue } from '../../core/errors'
import { businessDate, businessDayRange, type BusinessDate } from '../../core/time'
import { CARRIER_CODE, ISO_WEEKDAYS, weekdayOf, type IsoWeekday } from '../queue/cutoff'
import { shippingAddressProblems, type ShippingAddress } from '../settings'

/**
 * A carrier pickup (B-W2b-395; LOG-048 "book a carrier pickup"; factory-db PickupRequest, B-W2b-367), pure. The dispatch desk
 * asks a carrier to come for the goods: the site, the carrier, when they are ready, how many parcels and pallets, the address
 * (the site's sender address unless another is given) and, for a carrier's regular round, the weekdays it repeats on.
 *
 *   SENDCLOUD  booked through the company's Sendcloud connection (where the carrier offers pickups: Sendcloud answers in
 *              words when it does not): the request is kept REQUESTED first, then Sendcloud's answer moves it to CONFIRMED
 *              (its reference) or FAILED (why, in words): a failure stays visible on the request. One pickup at a time:
 *              Sendcloud books a time slot, not a round. A site in test mode books nothing: the TEST pickup answers in the
 *              process (CONFIRMED, reference TEST-PU-…), as test mode's labels do.
 *   PHONE      booked by phone (or mail) with the carrier: kept CONFIRMED at once with the note of with whom (the note marks
 *              a phone booking), the carrier's reference when it gave one; the only way to keep a recurring pickup (the
 *              carrier's regular round, agreed with the carrier).
 *
 * What was asked never changes (a change is a new request). After the booking: confirmed by hand (REQUESTED → CONFIRMED, the
 * carrier said yes outside Sendcloud), failed (REQUESTED or CONFIRMED → FAILED, why in words: the carrier said no, the driver
 * did not come) or called off (REQUESTED or CONFIRMED → CANCELLED). FAILED and CANCELLED are final: a new try is a new
 * request. Refusals are 409 with the issue path `refusal/<CODE>`; the screens word the code (`PICKUP_WORDS`).
 */

export const PICKUP_VIAS = ['SENDCLOUD', 'PHONE'] as const
export type PickupVia = (typeof PICKUP_VIAS)[number]

export const PICKUP_STATUSES = ['REQUESTED', 'CONFIRMED', 'FAILED', 'CANCELLED'] as const
export type PickupStatus = (typeof PICKUP_STATUSES)[number]

/** The moves after the booking. */
export const PICKUP_MOVES = ['CONFIRMED', 'FAILED', 'CANCELLED'] as const
export type PickupMove = (typeof PICKUP_MOVES)[number]

export const PICKUP_LIMITS = Object.freeze({
  /** Parcels and pallets, each (factory-db's guard). */
  count: 9999,
  note: 2000,
  words: 2000,
  reference: 100,
  /** The total weight told to Sendcloud, kilograms. */
  weightKg: 99_999,
  /** A ready time may lie this far in the past (the form was open a while). */
  pastSkewMs: 15 * 60_000,
  /** And at most this many days ahead. */
  aheadDays: 60,
  /** The window Sendcloud is asked for: from the ready time, this long (within the site's day). */
  windowMinutes: 240,
})

/** Why a pickup write is refused (409 `refusal/<CODE>`). */
export const PICKUP_REFUSALS = ['NO_CONNECTION', 'FINAL', 'NOT_REQUESTED', 'NO_SETTINGS'] as const
export type PickupRefusalCode = (typeof PICKUP_REFUSALS)[number]

export const pickupRefusalPath = (code: PickupRefusalCode): string => `refusal/${code}`

/** The words of each refusal (English; the screens word the code themselves). */
export const PICKUP_WORDS: Readonly<Record<PickupRefusalCode, string>> = Object.freeze({
  NO_CONNECTION: "A pickup is booked through the company's own Sendcloud connection, which is missing or not usable: book it by phone and note it here.",
  FINAL: 'The pickup failed or was called off: nothing changes on it any more. A new try is a new request.',
  NOT_REQUESTED: 'Only a pickup still waiting for an answer is confirmed by hand.',
  NO_SETTINGS: 'The site has no shipping settings, so no address to collect from: give the address, or set the sender address in the shipping settings.',
})

/** The prefix of a TEST pickup's reference (test mode: nothing was booked). */
export const TEST_PICKUP_PREFIX = 'TEST-PU-'

/** The TEST pickup's reference of a request (deterministic: the same request answers the same reference). */
export const testPickupReference = (pickupId: string): string => `${TEST_PICKUP_PREFIX}${createHash('sha256').update(pickupId).digest('hex').slice(0, 10).toUpperCase()}`

/** The request was answered by the TEST pickup of test mode (no carrier was asked). */
export const isTestPickup = (reference: string | null | undefined): boolean => typeof reference === 'string' && reference.startsWith(TEST_PICKUP_PREFIX)

/** How a kept request was booked: the note marks a phone booking (the API writes a note only then). */
export const pickupViaOf = (row: { readonly note: string | null }): PickupVia => (row.note !== null ? 'PHONE' : 'SENDCLOUD')

const filled = (value: string | null | undefined): value is string => typeof value === 'string' && value.trim() !== ''
const oneLine = (value: string): boolean => !/[\r\n]/.test(value)
const wholeIn = (value: unknown, max: number): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max

/** A booking as the office sends it (the contract checked the types). */
export interface PickupBooking {
  readonly via: PickupVia
  readonly carrierCode: string
  readonly readyAt: Date
  readonly parcels: number
  readonly pallets: number
  /** null: the site's sender address. */
  readonly address: ShippingAddress | null
  readonly repeatWeekdays: readonly string[]
  /** PHONE: with whom it was booked (required). */
  readonly note: string | null
  /** PHONE: the carrier's reference, when it gave one. */
  readonly providerReference: string | null
  /** SENDCLOUD: the total weight told to the carrier (a decimal string, kilograms), when known. */
  readonly weightKg: string | null
}

/** Every field problem of a booking (400; empty: none). `now` is the server's time. */
export function bookingProblems(booking: PickupBooking, now: Date): Issue[] {
  const problems: Issue[] = []
  if (!CARRIER_CODE.test(booking.carrierCode)) problems.push({ path: 'body/carrierCode', message: "Expected the carrier's code: 1 to 40 characters, no spaces." })
  if (Number.isNaN(booking.readyAt.getTime())) problems.push({ path: 'body/readyAt', message: 'Expected a time.' })
  else if (booking.readyAt.getTime() < now.getTime() - PICKUP_LIMITS.pastSkewMs) problems.push({ path: 'body/readyAt', message: 'The ready time has passed: a pickup is booked for a time to come.' })
  else if (booking.readyAt.getTime() > now.getTime() + PICKUP_LIMITS.aheadDays * 86_400_000) problems.push({ path: 'body/readyAt', message: `A pickup is booked at most ${PICKUP_LIMITS.aheadDays} days ahead.` })
  if (!wholeIn(booking.parcels, PICKUP_LIMITS.count)) problems.push({ path: 'body/parcels', message: `Expected a whole number from 0 to ${PICKUP_LIMITS.count}.` })
  if (!wholeIn(booking.pallets, PICKUP_LIMITS.count)) problems.push({ path: 'body/pallets', message: `Expected a whole number from 0 to ${PICKUP_LIMITS.count}.` })
  if (wholeIn(booking.parcels, PICKUP_LIMITS.count) && wholeIn(booking.pallets, PICKUP_LIMITS.count) && booking.parcels + booking.pallets === 0) {
    problems.push({ path: 'body/parcels', message: 'Say how many parcels or pallets the driver collects (at least one).' })
  }
  if (booking.address !== null) problems.push(...shippingAddressProblems(booking.address, 'body/address'))
  const days = new Set<string>()
  for (const [index, day] of booking.repeatWeekdays.entries()) {
    if (!(ISO_WEEKDAYS as readonly string[]).includes(day)) problems.push({ path: `body/repeatWeekdays/${index}`, message: `Expected a weekday: ${ISO_WEEKDAYS.join(', ')}.` })
    else if (days.has(day)) problems.push({ path: `body/repeatWeekdays/${index}`, message: 'Each weekday once.' })
    days.add(day)
  }
  if (booking.via === 'PHONE') {
    if (!filled(booking.note)) problems.push({ path: 'body/note', message: 'Say with whom the pickup was booked (a phone booking keeps its note).' })
    else if (booking.note.trim().length > PICKUP_LIMITS.note) problems.push({ path: 'body/note', message: `At most ${PICKUP_LIMITS.note} characters.` })
    if (booking.providerReference !== null) problems.push(...referenceProblems(booking.providerReference, 'body/providerReference'))
    if (booking.weightKg !== null) problems.push({ path: 'body/weightKg', message: 'The weight is told to Sendcloud only: a phone booking keeps none.' })
  } else {
    if (booking.repeatWeekdays.length > 0) problems.push({ path: 'body/repeatWeekdays', message: "Sendcloud books one pickup at a time: a recurring pickup is the carrier's regular round, agreed with the carrier: keep it as booked by phone." })
    if (booking.note !== null) problems.push({ path: 'body/note', message: 'A note marks a pickup booked by phone: a Sendcloud booking keeps none.' })
    if (booking.providerReference !== null) problems.push({ path: 'body/providerReference', message: "Sendcloud gives the reference: it is not typed." })
    if (booking.weightKg !== null && !weightOk(booking.weightKg)) problems.push({ path: 'body/weightKg', message: `Expected kilograms above 0, at most ${PICKUP_LIMITS.weightKg}.` })
  }
  return problems
}

const weightOk = (text: string): boolean => /^\d{1,5}(\.\d{1,3})?$/.test(text.trim()) && Number(text) > 0 && Number(text) <= PICKUP_LIMITS.weightKg

/** A carrier's reference: 1 to 100 characters on one line. */
export function referenceProblems(reference: string, at: string): Issue[] {
  const text = reference.trim()
  if (text === '') return [{ path: at, message: 'Required.' }]
  if (text.length > PICKUP_LIMITS.reference || !oneLine(text)) return [{ path: at, message: `At most ${PICKUP_LIMITS.reference} characters on one line.` }]
  return []
}

/** A move after the booking, as asked. */
export interface PickupMoveInput {
  readonly status: PickupMove
  /** CONFIRMED: the carrier's reference, when the request has none yet. */
  readonly providerReference: string | null
  /** FAILED: why (required); CONFIRMED / CANCELLED: optional words, kept on the audit row. */
  readonly words: string | null
}

/** The state refusal of a move (null: allowed). */
export function moveRefusal(status: PickupStatus, move: PickupMove): { code: PickupRefusalCode; message: string } | null {
  if (status === 'FAILED' || status === 'CANCELLED') return { code: 'FINAL', message: PICKUP_WORDS.FINAL }
  if (move === 'CONFIRMED' && status !== 'REQUESTED') return { code: 'NOT_REQUESTED', message: PICKUP_WORDS.NOT_REQUESTED }
  return null
}

/** The field problems of a move (400). `kept` is the reference the request has. */
export function moveProblems(input: PickupMoveInput, kept: string | null): Issue[] {
  const problems: Issue[] = []
  if (input.words !== null && (input.words.trim() === '' || input.words.trim().length > PICKUP_LIMITS.words)) problems.push({ path: 'body/words', message: `1 to ${PICKUP_LIMITS.words} characters.` })
  if (input.status === 'FAILED' && !filled(input.words)) problems.push({ path: 'body/words', message: 'Say why the pickup failed: the request keeps it, visible to everyone.' })
  if (input.providerReference !== null) {
    if (input.status !== 'CONFIRMED') problems.push({ path: 'body/providerReference', message: 'A reference comes with the confirmation only.' })
    else if (kept !== null && kept !== input.providerReference.trim()) problems.push({ path: 'body/providerReference', message: 'The request has its reference already: it is set once.' })
    else problems.push(...referenceProblems(input.providerReference, 'body/providerReference'))
  }
  return problems
}

/** A kept request, as the day's view reads it. */
export interface PickupOnDay {
  readonly readyAt: Date
  readonly repeatWeekdays: readonly string[]
  readonly status: PickupStatus
}

/**
 * The request comes on that day (the site's zone): a one-off on its own day (a failed one too: a failure stays visible), a
 * recurring one (REQUESTED or CONFIRMED) on each of its weekdays from its first day on. Never a cancelled one.
 */
export function comesOn(pickup: PickupOnDay, day: BusinessDate, timeZone: string): boolean {
  if (pickup.status === 'CANCELLED') return false
  const first = businessDate(pickup.readyAt, timeZone)
  if (pickup.repeatWeekdays.length === 0) return first === day
  if (pickup.status === 'FAILED') return false
  return first <= day && pickup.repeatWeekdays.includes(weekdayOf(day))
}

/** The time of day it is ready, "HH:MM" on the site's clock. */
export function readyTimeOf(readyAt: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(readyAt)
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '00'
  return `${value('hour')}:${value('minute')}`
}

/** The window Sendcloud is asked for: from the ready time, PICKUP_LIMITS.windowMinutes long, never past the site's day. */
export function pickupWindow(readyAt: Date, timeZone: string): { readonly from: Date; readonly until: Date } {
  const end = businessDayRange(businessDate(readyAt, timeZone), timeZone).end
  const until = new Date(Math.min(readyAt.getTime() + PICKUP_LIMITS.windowMinutes * 60_000, end.getTime() - 60_000))
  return { from: readyAt, until: until.getTime() > readyAt.getTime() ? until : new Date(readyAt.getTime() + 60_000) }
}

/** The weekdays in their order (a recurring request's days as the screens list them). */
export const weekdaysInOrder = (days: readonly string[]): IsoWeekday[] => ISO_WEEKDAYS.filter((day) => days.includes(day))
