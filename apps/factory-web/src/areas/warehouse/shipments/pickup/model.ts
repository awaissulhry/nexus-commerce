import { ISO_WEEKDAYS } from '@nexus/factory-domain/shipping/queue/cutoff'
import { words, type Read, type Words } from '../queue/shared/depth'
import type { BookBody, PickupDraft, PickupRow } from './api'
import { wallOf, type DispatchAbilities } from './dispatch'

/**
 * Book a pickup, pure (SCR-650; design warehouse.shipments pop-up sh-pickup "ready time · parcels or pallets · site address ·
 * recurring", opened from ⋯ and the selection row; the cut-off strip's "pickup booked 16:00"): the form and its problems in
 * this screen's words, the booking's body, what holds Book pickup, a pickup in words, the line a carrier's cut-off card says,
 * and what holds a move (confirm, failed, call off). The lists mirror factory-domain shipping/pickups/rules.ts (a server-only
 * module: it hashes with node:crypto); the tests hold them equal.
 */

export const PICKUP_VIAS = ['SENDCLOUD', 'PHONE'] as const
export type PickupVia = (typeof PICKUP_VIAS)[number]
export const PICKUP_STATUSES = ['REQUESTED', 'CONFIRMED', 'FAILED', 'CANCELLED'] as const
export type PickupStatus = (typeof PICKUP_STATUSES)[number]
export const PICKUP_REFUSALS = ['NO_CONNECTION', 'FINAL', 'NOT_REQUESTED', 'NO_SETTINGS'] as const
export const WEEKDAYS = ISO_WEEKDAYS
export type Weekday = (typeof WEEKDAYS)[number]

/** The API's limits (factory-domain PICKUP_LIMITS). */
export const PICKUP_MAX = Object.freeze({ count: 9999, note: 2000, words: 2000, reference: 100, weightKg: 99_999, aheadDays: 60, pastSkewMs: 15 * 60_000 })

const CARRIER_CODE = /^[^\s\p{Cc}]{1,40}$/u
const WEIGHT = /^\d{1,5}(\.\d{1,3})?$/

export const ADDRESS_PARTS = ['name', 'line1', 'postalCode', 'city', 'province', 'country', 'phone'] as const
export type AddressPart = (typeof ADDRESS_PARTS)[number]
const ADDRESS_REQUIRED: readonly AddressPart[] = ['name', 'line1', 'postalCode', 'city', 'country']
export const ADDRESS_MAX: Readonly<Record<AddressPart, number>> = { name: 120, line1: 200, postalCode: 20, city: 120, province: 40, country: 2, phone: 40 }

export interface PickupForm {
  readonly via: PickupVia
  readonly carrierCode: string
  /** When the goods are ready (ISO). */
  readonly readyAt: string
  readonly parcels: number
  readonly pallets: number
  /** Sendcloud only: kilograms told to the carrier ('' = none). */
  readonly weightKg: string
  /** Collect from another address than the site's sender address. */
  readonly otherAddress: boolean
  readonly address: Readonly<Record<AddressPart, string>>
  /** Phone only: the carrier's regular round on these weekdays. */
  readonly recurring: boolean
  readonly weekdays: readonly Weekday[]
  /** Phone: with whom it was booked (required). */
  readonly note: string
  /** Phone: the carrier's reference, when it gave one. */
  readonly reference: string
}

export type PickupField = 'carrierCode' | 'readyAt' | 'parcels' | 'weightKg' | 'weekdays' | 'note' | 'reference' | `address.${AddressPart}`

const EMPTY_ADDRESS: Record<AddressPart, string> = { name: '', line1: '', postalCode: '', city: '', province: '', country: '', phone: '' }

/** The way a booking starts: through Sendcloud when it may (test mode books the TEST pickup), else by phone. */
export function startVia(draft: PickupDraft): PickupVia {
  return draft.vias.SENDCLOUD.allowed ? 'SENDCLOUD' : 'PHONE'
}

/** The form the pop-up opens with, from the draft (the selection's counts, the next half hour, the site's address). */
export function formOf(draft: PickupDraft): PickupForm {
  return {
    via: startVia(draft),
    carrierCode: draft.carrierCode ?? '',
    readyAt: draft.readyAt,
    parcels: draft.parcels,
    pallets: draft.pallets,
    weightKg: draft.weightKg ? String(Number(draft.weightKg)) : '',
    otherAddress: draft.address === null,
    address: { ...EMPTY_ADDRESS },
    recurring: false,
    weekdays: [],
    note: '',
    reference: '',
  }
}

/** Every problem of the form, by field, in this screen's words (the API applies the same rules again). */
export function formProblems(form: PickupForm, now: number = Date.now()): Partial<Record<PickupField, Words>> {
  const problems: Partial<Record<PickupField, Words>> = {}
  if (!CARRIER_CODE.test(form.carrierCode.trim())) problems.carrierCode = words('pickup.problem.carrier')
  const ready = Date.parse(form.readyAt)
  if (!form.readyAt || Number.isNaN(ready)) problems.readyAt = words('pickup.problem.readyAt')
  else if (ready < now - PICKUP_MAX.pastSkewMs) problems.readyAt = words('pickup.problem.readyPast')
  else if (ready > now + PICKUP_MAX.aheadDays * 86_400_000) problems.readyAt = words('pickup.problem.readyAhead', { days: PICKUP_MAX.aheadDays })
  if (form.parcels + form.pallets <= 0) problems.parcels = words('pickup.problem.nothing')
  if (form.via === 'SENDCLOUD' && form.weightKg.trim() !== '' && !(WEIGHT.test(form.weightKg.trim()) && Number(form.weightKg) > 0 && Number(form.weightKg) <= PICKUP_MAX.weightKg)) problems.weightKg = words('pickup.problem.weight', { max: PICKUP_MAX.weightKg })
  if (form.via === 'PHONE') {
    if (form.note.trim() === '') problems.note = words('pickup.problem.note')
    else if (form.note.trim().length > PICKUP_MAX.note) problems.note = words('pickup.problem.long', { max: PICKUP_MAX.note })
    if (form.reference.trim().length > PICKUP_MAX.reference || /[\r\n]/.test(form.reference)) problems.reference = words('pickup.problem.reference', { max: PICKUP_MAX.reference })
    if (form.recurring && form.weekdays.length === 0) problems.weekdays = words('pickup.problem.weekdays')
  }
  if (form.otherAddress) {
    for (const part of ADDRESS_PARTS) {
      const value = form.address[part].trim()
      if (ADDRESS_REQUIRED.includes(part) && value === '') problems[`address.${part}`] = words('pickup.problem.required')
      else if (value.length > ADDRESS_MAX[part]) problems[`address.${part}`] = words('pickup.problem.long', { max: ADDRESS_MAX[part] })
    }
    if (form.address.country.trim() !== '' && !/^[A-Z]{2}$/.test(form.address.country.trim())) problems['address.country'] = words('pickup.problem.country')
  }
  return problems
}

/** What POST /shipping/pickups takes from the form (a field another way does not keep is left out). */
export function bookBody(form: PickupForm, draft: Pick<PickupDraft, 'siteId'>): BookBody {
  const optional = (value: string): string | null => (value.trim() === '' ? null : value.trim())
  const body: BookBody = {
    siteId: draft.siteId,
    via: form.via,
    carrierCode: form.carrierCode.trim(),
    readyAt: new Date(form.readyAt).toISOString(),
    parcels: form.parcels,
    pallets: form.pallets,
  }
  if (form.otherAddress) {
    body.address = {
      name: form.address.name.trim(),
      line1: form.address.line1.trim(),
      line2: null,
      postalCode: form.address.postalCode.trim(),
      city: form.address.city.trim(),
      province: optional(form.address.province),
      country: form.address.country.trim().toUpperCase(),
      phone: optional(form.address.phone),
      email: null,
    }
  }
  if (form.via === 'PHONE') {
    body.note = form.note.trim()
    if (optional(form.reference)) body.providerReference = form.reference.trim()
    if (form.recurring) body.repeatWeekdays = WEEKDAYS.filter((day) => form.weekdays.includes(day))
  } else if (optional(form.weightKg)) {
    body.weightKg = form.weightKg.trim()
  }
  return body
}

/** Why a way of booking is held (null: it may be used), in words from the API's code. */
export function viaHeld(draft: PickupDraft, via: PickupVia): Words | null {
  const allowance = draft.vias[via]
  if (allowance.allowed) return null
  return words(`pickup.refusal.${allowance.refusal?.code ?? 'NO_CONNECTION'}`)
}

/** Why Book pickup is held (null: it may be pressed). */
export function bookHeld(form: PickupForm, draft: PickupDraft, can: Pick<DispatchAbilities, 'bookPickups'>, busy: boolean): Words | null {
  if (!can.bookPickups) return words('pickup.held.noRight')
  if (busy) return words('pickup.held.busy')
  const via = viaHeld(draft, form.via)
  if (via) return via
  const count = Object.keys(formProblems(form)).length
  return count > 0 ? words('pickup.held.problems', { count }) : null
}

/** A pickup in words: its time, how it was booked, its state (a failure keeps its words beside). */
export function pickupLine(row: Pick<PickupRow, 'status' | 'readyTime' | 'via' | 'test' | 'recurring'>): Words {
  return words(`pickup.line.${row.status}`, { time: row.readyTime })
}

/** How a pickup was booked, in words. */
export const viaWords = (row: Pick<PickupRow, 'via' | 'test'>): Words => words(row.test ? 'pickup.via.test' : `pickup.via.${row.via}`)

/** The pickups of the day by carrier code, by ready time (what the cut-off strip shows). */
export function pickupsByCarrier(rows: readonly PickupRow[]): Map<string, PickupRow[]> {
  const byCarrier = new Map<string, PickupRow[]>()
  for (const row of [...rows].sort((a, b) => a.readyTime.localeCompare(b.readyTime))) {
    if (row.status === 'CANCELLED') continue
    byCarrier.set(row.carrierCode, [...(byCarrier.get(row.carrierCode) ?? []), row])
  }
  return byCarrier
}

/** What a carrier's cut-off card says of its pickups today ("Pickup booked 16:00"; a failure first); null: none. */
export function cardPickup(rows: readonly PickupRow[] | undefined): { words: Words; tone: 'success' | 'info' | 'danger' } | null {
  const live = (rows ?? []).filter((row) => row.status !== 'CANCELLED')
  if (live.length === 0) return null
  const failed = live.find((row) => row.status === 'FAILED')
  if (failed) return { words: words('pickup.card.failed', { time: failed.readyTime }), tone: 'danger' }
  const times = live.map((row) => row.readyTime).join(', ')
  const waiting = live.some((row) => row.status === 'REQUESTED')
  if (live.length > 1) return { words: words(waiting ? 'pickup.card.manyWaiting' : 'pickup.card.many', { count: live.length, times }), tone: waiting ? 'info' : 'success' }
  return { words: words(waiting ? 'pickup.card.waiting' : 'pickup.card.booked', { time: times }), tone: waiting ? 'info' : 'success' }
}

export type PickupMove = 'CONFIRMED' | 'FAILED' | 'CANCELLED'

/** Why a move of a pickup is held (null: it may be made), from the API's `may` and the person's right. */
export function moveHeld(row: PickupRow, move: PickupMove, can: Pick<DispatchAbilities, 'bookPickups'>, busy: boolean): Words | null {
  if (!can.bookPickups) return words('pickup.held.noRight')
  const allowance = move === 'CONFIRMED' ? row.may.confirm : move === 'FAILED' ? row.may.fail : row.may.cancel
  if (!allowance.allowed) return words(`pickup.refusal.${allowance.refusal?.code ?? 'FINAL'}`)
  if (busy) return words('pickup.held.busy')
  return null
}

/** The ready time of a draft on the site's clock, in words. */
export const readyOnSite = (form: Pick<PickupForm, 'readyAt'>, timeZone: string): { day: string; time: string } | null => (form.readyAt && !Number.isNaN(Date.parse(form.readyAt)) ? wallOf(form.readyAt, timeZone) : null)

// ---- the pop-up's view model -------------------------------------------------------------------------------------------------

export type PickupMoveDialog = null | { readonly pickupId: string; readonly move: PickupMove; readonly text: string }

export interface PickupDialogModel {
  /** The selection the pickup is for (empty: from ⋯, the site's parcels typed by hand). */
  readonly shipmentIds: readonly string[]
  readonly draft: Read<PickupDraft>
  readonly form: PickupForm | null
  /** Show every field's problem (after a press). */
  readonly tried: boolean
  readonly busy: boolean
  readonly problem: Words | null
  /** The booking as the API answered (CONFIRMED, REQUESTED, or FAILED with its words). */
  readonly booked: PickupRow | null
  /** A move of a pickup coming today, being asked. */
  readonly move: PickupMoveDialog
  /** The last move, in words (and "call the carrier" when Sendcloud was not told). */
  readonly moved: Words | null
  readonly can: Pick<DispatchAbilities, 'bookPickups'>
  readonly timeZone: string
}

export interface PickupDialogActions {
  onForm?: (next: Partial<PickupForm>) => void
  onBook?: () => void
  onClose?: () => void
  onRetry?: () => void
  onMove?: (move: PickupMoveDialog) => void
  onMoveGo?: () => void
}
