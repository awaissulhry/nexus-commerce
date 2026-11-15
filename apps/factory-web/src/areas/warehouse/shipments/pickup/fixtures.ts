import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { zonedInstant, zonedToday } from '../model'
import type { PickupDraft, PickupRow } from './api'
import { formOf, type PickupDialogModel, type PickupForm } from './model'
import { PickupDialog } from './view/PickupDialog'

/**
 * SCR-650 — Book a pickup (B-W2b-412 on B-W2b-395; design warehouse.shipments pop-up sh-pickup, opened from ⋯ and the selection
 * row): through Sendcloud (a site in test mode books the TEST pickup) or booked by phone with the carrier's regular round, the
 * selection's parcels and pallets, the ready time on the site's clock, the address; the carrier's answer; the pickups already
 * coming today. Made-up data only (site "Stabilimento Demo", carrier "Demo Express", a driver round "Giro Demo").
 */

const uid = (n: number) => `0190f0e2-7412-7000-8000-${String(n).padStart(12, '0')}`
const SITE = uid(1)
// Tomorrow at 10:00 on the site's clock: the same instant on the server and in the browser (no hydration drift), always ahead.
const tomorrow = new Date(Date.parse(`${zonedToday()}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
const READY = zonedInstant(tomorrow, '10:00') ?? `${tomorrow}T08:00:00.000Z`

export const pickupRow = (n: number, over: Partial<PickupRow> = {}): PickupRow => ({
  id: uid(100 + n),
  siteId: SITE,
  site: { code: 'A1', name: 'Stabilimento Demo' },
  carrierCode: 'demo-express',
  carrierName: 'Demo Express',
  readyAt: READY,
  readyTime: '16:00',
  parcels: 4,
  pallets: 0,
  repeatWeekdays: [],
  recurring: false,
  status: 'CONFIRMED',
  via: 'SENDCLOUD',
  test: false,
  providerReference: 'FPU-DEMO00042',
  errorWords: null,
  note: null,
  version: 1,
  createdAt: '2030-06-14T09:12:00.000Z',
  may: { confirm: { allowed: false, refusal: { code: 'NOT_REQUESTED' } }, fail: { allowed: true, refusal: null }, cancel: { allowed: true, refusal: null } },
  ...over,
})

const draft = (over: Partial<PickupDraft> = {}): PickupDraft => ({
  siteId: SITE,
  companyId: uid(2),
  site: { code: 'A1', name: 'Stabilimento Demo', timeZone: 'Europe/Rome' },
  address: { name: 'Stabilimento Demo', line1: 'Via dell’Esempio 1', line2: null, postalCode: '20100', city: 'Milano', province: 'MI', country: 'IT', phone: '+39 02 0000000', email: null },
  carrierCode: 'demo-express',
  carrierName: 'Demo Express',
  parcels: 6,
  pallets: 0,
  weightKg: '23.400',
  readyAt: READY,
  shipments: [
    { id: uid(201), number: 'SH-26-0101', parcels: 2, pallets: 0 },
    { id: uid(202), number: 'SH-26-0104', parcels: 4, pallets: 0 },
  ],
  skipped: [],
  testMode: true,
  vias: { SENDCLOUD: { allowed: true, refusal: null, test: true, recurring: false }, PHONE: { allowed: true, refusal: null, recurring: true } },
  alreadyToday: [],
  ...over,
})

const dialog = (value: PickupDraft | null, over: Partial<PickupDialogModel> = {}, form: Partial<PickupForm> = {}): PickupDialogModel => ({
  shipmentIds: value?.shipments.map((row) => row.id) ?? [],
  draft: value ? { state: 'ready', value } : { state: 'loading' },
  form: value ? { ...formOf(value), ...form } : null,
  tried: false,
  busy: false,
  problem: null,
  booked: null,
  move: null,
  moved: null,
  can: { bookPickups: true },
  timeZone: 'Europe/Rome',
  ...over,
})

const LIVE = draft({ testMode: false, vias: { SENDCLOUD: { allowed: true, refusal: null, test: false, recurring: false }, PHONE: { allowed: true, refusal: null, recurring: true } } })
const NO_CONNECTION = draft({ testMode: false, vias: { SENDCLOUD: { allowed: false, refusal: { code: 'NO_CONNECTION' }, test: false, recurring: false }, PHONE: { allowed: true, refusal: null, recurring: true } } })
const TODAY = draft({
  alreadyToday: [
    pickupRow(1, { status: 'REQUESTED', providerReference: null, may: { confirm: { allowed: true, refusal: null }, fail: { allowed: true, refusal: null }, cancel: { allowed: true, refusal: null } } }),
    pickupRow(2, { via: 'PHONE', readyTime: '10:00', recurring: true, repeatWeekdays: ['TUESDAY', 'THURSDAY'], pallets: 1, parcels: 0, providerReference: null, note: 'Giro Demo, booked with the depot desk' }),
  ],
})

export const designScreen = defineDesignScreen<PickupDialogModel>({
  screen: 'SCR-650',
  title: 'Book a pickup: Sendcloud or by phone, the selection, the ready time, the address, today\'s pickups',
  view: PickupDialog,
  cases: [
    { id: 'test-mode', label: 'From two picked shipments, the site in test mode: the TEST pickup (nothing is booked)', model: dialog(draft()), note: 'Typing, the way and the weekdays work for real; nothing is sent.' },
    { id: 'live', label: 'The site live: booked through the company\'s Sendcloud connection', model: dialog(LIVE) },
    { id: 'phone-round', label: 'By phone: the carrier\'s regular round on Tuesday and Thursday, a pallet', model: dialog(LIVE, {}, { via: 'PHONE', parcels: 0, pallets: 1, recurring: true, weekdays: ['TUESDAY', 'THURSDAY'], note: 'Giro Demo, with the depot desk' }) },
    { id: 'problems', label: 'Book pressed with problems: the note, a ready time past, no parcels', model: dialog(LIVE, { tried: true }, { via: 'PHONE', parcels: 0, pallets: 0, readyAt: '2020-01-01T08:00:00.000Z', recurring: true }) },
    { id: 'no-connection', label: 'No usable Sendcloud connection: Sendcloud held with why, by phone offered', model: dialog(NO_CONNECTION, {}, { via: 'PHONE' }) },
    { id: 'no-settings', label: 'The site has no sender address: collect from another address', model: dialog(draft({ address: null }), {}, { otherAddress: true, address: { name: 'Magazzino Demo', line1: 'Via Fittizia 9', postalCode: '40100', city: 'Bologna', province: 'BO', country: 'IT', phone: '' } }) },
    { id: 'skipped', label: 'Picked shipments left out, each with why', model: dialog(draft({ skipped: [{ id: uid(203), number: 'SH-26-0107', words: 'Our own van carries it: no carrier pickup.' }, { id: uid(204), number: 'SH-26-0099', words: 'It has left the dock already.' }] })) },
    { id: 'by-hand', label: 'From ⋯ (nothing picked): the parcels typed by hand', model: dialog(draft({ shipments: [], parcels: 0, weightKg: null })) },
    { id: 'booked', label: 'Booked: the TEST pickup answered at once', model: dialog(draft(), { booked: pickupRow(3, { test: true, providerReference: 'TEST-PU-0A1B2C3D4E', parcels: 6 }) }) },
    { id: 'failed', label: 'The carrier said no: FAILED with its words (the request stays visible)', model: dialog(LIVE, { booked: pickupRow(4, { status: 'FAILED', providerReference: null, errorWords: 'The carrier does not collect on Saturdays from this address.', may: { confirm: { allowed: false, refusal: { code: 'FINAL' } }, fail: { allowed: false, refusal: { code: 'FINAL' } }, cancel: { allowed: false, refusal: { code: 'FINAL' } } } }) }) },
    { id: 'coming-today', label: 'Pickups already coming today: confirm by hand, failed, call off', model: dialog(TODAY) },
    { id: 'move-failed', label: 'Marking one failed: the words why', model: dialog(TODAY, { move: { pickupId: uid(101), move: 'FAILED', text: '' } }) },
    { id: 'moved', label: 'A Sendcloud pickup called off: call the carrier (Sendcloud was not told)', model: dialog(TODAY, { moved: { key: 'pickup.moved.callCarrier', params: { time: '16:00', carrier: 'Demo Express' } } }) },
    { id: 'no-right', label: 'Without shipping.pickups.book: Book held with why', model: dialog(LIVE, { can: { bookPickups: false } }) },
    { id: 'refused', label: 'A refusal from the API, in words', model: dialog(LIVE, { problem: { key: 'pickup.refusal.NO_CONNECTION' } }) },
    { id: 'loading', label: 'Reading the start', model: dialog(null) },
    { id: 'error', label: 'The start could not be read: Try again', model: dialog(null, { draft: { state: 'error', problem: { key: 'problem.read.unavailable' } } }) },
  ],
})
